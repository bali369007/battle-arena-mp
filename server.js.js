const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

/* ========== CONFIG ========== */
const MAP_SIZE = 300;
const ROOM_MAX = 20;         // Max real players per room
const MIN_PLAYERS_TO_START = 2;
const START_DELAY_MS = 8000; // Wait 8s for more players before starting
const TICK_RATE = 20;        // State broadcast per second
const PHYSICS_RATE = 10;     // Server physics per second

const WEAPONS = {
  pistol:  { damage: 22, range: 60,  fireRate: 0.28 },
  smg:     { damage: 18, range: 55,  fireRate: 0.075 },
  ar:      { damage: 30, range: 100, fireRate: 0.11 },
  shotgun: { damage: 20, range: 25,  fireRate: 0.85 },
  sniper:  { damage: 95, range: 250, fireRate: 1.5 },
};

const BOT_NAMES = ['R4VEN','NINJA_X','SHADOW','PHANTOM','VIPER','GHOST','BLAZE','STORM','HAWK','WOLF','TITAN','REAPER','ACE','JOKER','OMEGA','ZERO','NOVA','ECHO','FROST','KRAKEN','SPECTRE','BOLT','CIPHER','RUSH'];

/* ========== ROOMS ========== */
const rooms = new Map();
let roomCounter = 0;

function createRoom() {
  const id = 'room_' + (++roomCounter);
  const room = {
    id,
    players: new Map(),  // socketId -> player
    bots: [],
    loot: [],
    zone: {
      radius: 230, targetRadius: 230,
      cx: 0, cz: 0, tcx: 0, tcz: 0,
      phase: 0, timer: 30
    },
    started: false,
    startTimer: null
  };
  rooms.set(id, room);
  console.log('Room created:', id);
  return room;
}

function findOrCreateRoom() {
  for (const room of rooms.values()) {
    if (!room.started && room.players.size < ROOM_MAX) return room;
  }
  return createRoom();
}

/* ========== WORLD GENERATION (server sends to client) ========== */
function generateWorldSeed() {
  const walls = [];
  const buildings = [];
  
  // Buildings
  for (let i = 0; i < 34; i++) {
    const w = 9 + Math.random() * 8;
    const d = 9 + Math.random() * 8;
    const h = 5 + Math.random() * 5;
    let x, z, tries = 0;
    do {
      x = (Math.random() - 0.5) * MAP_SIZE * 1.6;
      z = (Math.random() - 0.5) * MAP_SIZE * 1.6;
      tries++;
    } while (tries < 20 && (Math.hypot(x, z) < 25 || buildings.some(b => Math.hypot(b.x - x, b.z - z) < 20)));
    if (tries >= 20) continue;
    buildings.push({ x, z, w, d, h });
    // Add walls for collision
    walls.push({ minX: x - w/2, minZ: z - d/2, maxX: x + w/2, maxZ: z + d/2, height: h });
  }
  
  // Trees (simple collision)
  const trees = [];
  for (let i = 0; i < 110; i++) {
    const x = (Math.random() - 0.5) * MAP_SIZE * 1.85;
    const z = (Math.random() - 0.5) * MAP_SIZE * 1.85;
    if (Math.hypot(x, z) < 10) continue;
    trees.push({ x, z, scale: 0.8 + Math.random() * 0.5 });
    walls.push({ minX: x - 0.5, minZ: z - 0.5, maxX: x + 0.5, maxZ: z + 0.5, height: 3 });
  }
  
  return { walls, buildings, trees };
}

/* ========== BOT AI ========== */
function spawnBot(room) {
  const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + '_' + Math.floor(Math.random() * 99);
  const bot = {
    id: 'bot_' + Math.random().toString(36).slice(2, 9),
    name,
    x: (Math.random() - 0.5) * MAP_SIZE * 1.5,
    y: 0,
    z: (Math.random() - 0.5) * MAP_SIZE * 1.5,
    yaw: Math.random() * Math.PI * 2,
    health: 100,
    alive: true,
    weapon: ['pistol', 'smg', 'ar', 'shotgun'][Math.floor(Math.random() * 4)],
    kills: 0,
    cooldown: 1 + Math.random() * 2,
    strafe: Math.random() < 0.5 ? 1 : -1,
    strafeTimer: 0
  };
  room.bots.push(bot);
}

/* ========== LOOT ========== */
function generateLoot(room, count = 80) {
  const types = ['pistol', 'smg', 'ar', 'shotgun', 'sniper'];
  for (let i = 0; i < count; i++) {
    const loot = {
      id: 'loot_' + Math.random().toString(36).slice(2, 9),
      type: 'weapon',
      weapon: types[Math.floor(Math.random() * types.length)],
      x: (Math.random() - 0.5) * MAP_SIZE * 1.6,
      y: 0.5,
      z: (Math.random() - 0.5) * MAP_SIZE * 1.6
    };
    room.loot.push(loot);
  }
  // Ammo + healing loot
  for (let i = 0; i < 40; i++) {
    room.loot.push({
      id: 'loot_' + Math.random().toString(36).slice(2, 9),
      type: 'ammo',
      amount: 60,
      x: (Math.random() - 0.5) * MAP_SIZE * 1.6,
      y: 0.5,
      z: (Math.random() - 0.5) * MAP_SIZE * 1.6
    });
  }
  for (let i = 0; i < 20; i++) {
    room.loot.push({
      id: 'loot_' + Math.random().toString(36).slice(2, 9),
      type: 'medkit',
      amount: 50,
      x: (Math.random() - 0.5) * MAP_SIZE * 1.6,
      y: 0.5,
      z: (Math.random() - 0.5) * MAP_SIZE * 1.6
    });
  }
}

/* ========== MATCH START ========== */
function startMatch(room) {
  if (room.started) return;
  room.started = true;
  room.startTime = Date.now();
  
  // Fill bots to 20
  while (room.players.size + room.bots.length < 20) {
    spawnBot(room);
  }
  
  // Generate loot
  generateLoot(room);
  
  // Generate world
  const world = generateWorldSeed();
  
  console.log(`Match started in ${room.id} with ${room.players.size} players + ${room.bots.length} bots`);
  
  // Send match info to all players
  io.to(room.id).emit('matchStart', {
    world,
    bots: room.bots,
    loot: room.loot,
    zone: room.zone,
    mapSize: MAP_SIZE
  });
}

/* ========== RAY-AABB INTERSECTION ========== */
function rayAABB(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tmin = 0, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const mins = [minX, minY, minZ], maxs = [maxX, maxY, maxZ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < mins[i] || o[i] > maxs[i]) return null;
    } else {
      let t1 = (mins[i] - o[i]) / d[i];
      let t2 = (maxs[i] - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin > 0 ? { dist: tmin, y: oy + dy * tmin } : null;
}

/* ========== HANDLE SHOOT ========== */
function handleShoot(room, shooterId, data) {
  const shooter = room.players.get(shooterId);
  if (!shooter || !shooter.alive) return;
  
  const wd = WEAPONS[data.weapon] || WEAPONS.pistol;
  const { origin, dir } = data;
  let closest = null, closestDist = wd.range;
  
  // Check players
  for (const p of room.players.values()) {
    if (p.id === shooterId || !p.alive) continue;
    const hit = rayAABB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
      p.x - 0.5, 0.2, p.z - 0.5, p.x + 0.5, 2.6, p.z + 0.5);
    if (hit && hit.dist < closestDist) {
      closestDist = hit.dist;
      closest = { type: 'player', target: p, isHead: hit.y > 2.05 };
    }
  }
  
  // Check bots
  for (const b of room.bots) {
    if (!b.alive) continue;
    const hit = rayAABB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
      b.x - 0.5, 0.2, b.z - 0.5, b.x + 0.5, 2.6, b.z + 0.5);
    if (hit && hit.dist < closestDist) {
      closestDist = hit.dist;
      closest = { type: 'bot', target: b, isHead: hit.y > 2.05 };
    }
  }
  
  if (!closest) return;
  
  const dmg = closest.isHead ? wd.damage * 2.2 : wd.damage;
  closest.target.health -= dmg;
  
  if (closest.type === 'player') {
    io.to(closest.target.id).emit('damaged', {
      amount: Math.round(dmg),
      by: shooter.name
    });
    if (closest.target.health <= 0) {
      closest.target.alive = false;
      shooter.kills++;
      io.to(room.id).emit('kill', {
        killer: shooter.name,
        killerId: shooter.id,
        victim: closest.target.name,
        victimId: closest.target.id,
        weapon: data.weapon
      });
      checkMatchEnd(room);
    }
  } else {
    if (closest.target.health <= 0) {
      closest.target.alive = false;
      shooter.kills++;
      io.to(room.id).emit('kill', {
        killer: shooter.name,
        killerId: shooter.id,
        victim: closest.target.name,
        victimId: closest.target.id,
        weapon: data.weapon
      });
      checkMatchEnd(room);
    }
  }
}

/* ========== MATCH END CHECK ========== */
function checkMatchEnd(room) {
  const alivePlayers = [...room.players.values()].filter(p => p.alive);
  const aliveBots = room.bots.filter(b => b.alive);
  
  if (alivePlayers.length + aliveBots.length <= 1) {
    const winner = alivePlayers[0] || aliveBots[0];
    if (!winner) return;
    io.to(room.id).emit('matchEnd', {
      winnerId: winner.id,
      winnerName: winner.name,
      stats: [
        ...[...room.players.values()].map(p => ({ name: p.name, kills: p.kills, isYou: true, id: p.id })),
        ...room.bots.map(b => ({ name: b.name, kills: b.kills, isYou: false, id: b.id }))
      ].sort((a, b) => b.kills - a.kills)
    });
    // Cleanup after 30 sec
    setTimeout(() => {
      rooms.delete(room.id);
      console.log('Room deleted:', room.id);
    }, 30000);
  }
}

/* ========== SOCKET.IO ========== */
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  
  const room = findOrCreateRoom();
  const player = {
    id: socket.id,
    name: 'Player' + Math.floor(Math.random() * 9000 + 1000),
    x: 0, y: 0, z: 0,
    yaw: 0, pitch: 0,
    health: 100,
    kills: 0,
    alive: true,
    weapon: 'pistol',
    ads: false,
    isBot: false
  };
  room.players.set(socket.id, player);
  socket.join(room.id);
  socket.roomId = room.id;
  
  // Send init
  socket.emit('init', {
    playerId: socket.id,
    playerName: player.name,
    roomId: room.id,
    mapSize: MAP_SIZE,
    playersInRoom: room.players.size,
    minPlayers: MIN_PLAYERS_TO_START
  });
  
  // Notify room
  io.to(room.id).emit('playerJoined', {
    id: socket.id,
    name: player.name,
    count: room.players.size
  });
  
  // Auto start timer
  if (!room.started) {
    if (room.startTimer) clearTimeout(room.startTimer);
    room.startTimer = setTimeout(() => {
      if (room.players.size >= MIN_PLAYERS_TO_START && !room.started) {
        startMatch(room);
      } else if (room.players.size > 0) {
        // Not enough players, wait a bit more or start with bots
        startMatch(room);
      }
    }, START_DELAY_MS);
    
    // Send countdown
    io.to(room.id).emit('countdown', { seconds: START_DELAY_MS / 1000 });
  }
  
  /* ---- Player state update (position, rotation) ---- */
  socket.on('state', (data) => {
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    p.x = data.x;
    p.y = data.y;
    p.z = data.z;
    p.yaw = data.yaw;
    p.pitch = data.pitch;
    p.weapon = data.weapon;
    p.ads = data.ads;
  });
  
  /* ---- Shoot request ---- */
  socket.on('shoot', (data) => {
    if (!room.started) return;
    handleShoot(room, socket.id, data);
  });
  
  /* ---- Pickup loot ---- */
  socket.on('pickup', (data) => {
    const idx = room.loot.findIndex(l => l.id === data.lootId);
    if (idx < 0) return;
    const loot = room.loot[idx];
    room.loot.splice(idx, 1);
    io.to(room.id).emit('lootRemoved', { lootId: loot.id, byId: socket.id });
    socket.emit('lootPicked', loot);
  });
  
  /* ---- Set player name ---- */
  socket.on('setName', (data) => {
    const p = room.players.get(socket.id);
    if (!p) return;
    p.name = (data.name || '').slice(0, 16) || p.name;
    io.to(room.id).emit('nameUpdate', { id: socket.id, name: p.name });
  });
  
  /* ---- Disconnect ---- */
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    room.players.delete(socket.id);
    io.to(room.id).emit('playerLeft', { id: socket.id });
    
    // If room empty, delete after grace period
    if (room.players.size === 0) {
      setTimeout(() => {
        if (room.players.size === 0) {
          rooms.delete(room.id);
          console.log('Empty room deleted:', room.id);
        }
      }, 10000);
    }
  });
});

/* ========== SERVER TICK — BOT AI + ZONE ========== */
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started) continue;
    const dt = 1 / PHYSICS_RATE;
    
    // Zone shrink
    if (room.zone.radius !== room.zone.targetRadius) {
      const diff = room.zone.targetRadius - room.zone.radius;
      room.zone.radius += Math.sign(diff) * Math.min(Math.abs(diff), 0.5);
    }
    // Zone center drift
    if (Math.abs(room.zone.cx - room.zone.tcx) > 0.1 || Math.abs(room.zone.cz - room.zone.tcz) > 0.1) {
      room.zone.cx += (room.zone.tcx - room.zone.cx) * 0.5 * dt;
      room.zone.cz += (room.zone.tcz - room.zone.cz) * 0.5 * dt;
    }
    
    // Zone timer / phases
    room.zone.timer -= dt;
    if (room.zone.timer <= 0 && room.zone.phase < 4) {
      room.zone.phase++;
      const radii = [230, 150, 95, 55, 30];
      const delays = [30, 25, 22, 18, 0];
      room.zone.targetRadius = radii[room.zone.phase];
      room.zone.timer = delays[room.zone.phase] || 0;
      // New center inside old zone
      const ang = Math.random() * Math.PI * 2;
      const off = Math.random() * (room.zone.radius - room.zone.targetRadius) * 0.4;
      room.zone.tcx = room.zone.cx + Math.cos(ang) * off;
      room.zone.tcz = room.zone.cz + Math.sin(ang) * off;
    }
    
    // Zone damage on players
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - room.zone.cx, p.z - room.zone.cz);
      if (d > room.zone.radius) {
        p.health -= 8 * dt;
        if (p.health <= 0) {
          p.alive = false;
          io.to(room.id).emit('kill', { killer: 'ZONE', killerId: null, victim: p.name, victimId: p.id, weapon: null });
          checkMatchEnd(room);
        }
      }
    }
    
    // Bots AI
    const alivePlayers = [...room.players.values()].filter(p => p.alive);
    for (const bot of room.bots) {
      if (!bot.alive) continue;
      
      // Zone damage on bots
      const bd = Math.hypot(bot.x - room.zone.cx, bot.z - room.zone.cz);
      if (bd > room.zone.radius) {
        bot.health -= 12 * dt;
        if (bot.health <= 0) {
          bot.alive = false;
          io.to(room.id).emit('kill', { killer: 'ZONE', killerId: null, victim: bot.name, victimId: bot.id, weapon: null });
          checkMatchEnd(room);
          continue;
        }
      }
      
      // Find nearest target
      let nearest = null, nd = 60;
      for (const p of alivePlayers) {
        const d = Math.hypot(p.x - bot.x, p.z - bot.z);
        if (d < nd) { nd = d; nearest = p; }
      }
      for (const other of room.bots) {
        if (other === bot || !other.alive) continue;
        const d = Math.hypot(other.x - bot.x, other.z - bot.z);
        if (d < nd) { nd = d; nearest = other; }
      }
      
      if (nearest) {
        const dx = nearest.x - bot.x;
        const dz = nearest.z - bot.z;
        const d = Math.hypot(dx, dz) || 1;
        bot.yaw = Math.atan2(dx, dz);
        
        const idealDist = bot.weapon === 'shotgun' ? 8 : (bot.weapon === 'sniper' ? 40 : 18);
        if (d > idealDist + 4) {
          bot.x += (dx / d) * 4 * dt;
          bot.z += (dz / d) * 4 * dt;
        } else if (d < idealDist - 4) {
          bot.x -= (dx / d) * 2 * dt;
          bot.z -= (dz / d) * 2 * dt;
        }
        
        // Strafe
        bot.strafeTimer -= dt;
        if (bot.strafeTimer <= 0) { bot.strafeTimer = 1 + Math.random(); bot.strafe *= -1; }
        bot.x += -(dz / d) * bot.strafe * 2 * dt;
        bot.z += (dx / d) * bot.strafe * 2 * dt;
        
        // Shoot
        bot.cooldown -= dt;
        if (bot.cooldown <= 0 && d < WEAPONS[bot.weapon].range) {
          bot.cooldown = WEAPONS[bot.weapon].fireRate * (1 + Math.random());
          const chance = Math.max(0.05, (1 - d / WEAPONS[bot.weapon].range)) * 0.35;
          if (Math.random() < chance) {
            const dmg = WEAPONS[bot.weapon].damage * (0.7 + Math.random() * 0.6);
            nearest.health -= dmg;
            if (nearest.id && room.players.has(nearest.id)) {
              io.to(nearest.id).emit('damaged', { amount: Math.round(dmg), by: bot.name });
            }
            if (nearest.health <= 0) {
              nearest.alive = false;
              bot.kills++;
              io.to(room.id).emit('kill', {
                killer: bot.name,
                killerId: bot.id,
                victim: nearest.name,
                victimId: nearest.id,
                weapon: bot.weapon
              });
              checkMatchEnd(room);
            }
          }
        }
      } else {
        // Wander
        bot.x += Math.cos(bot.yaw) * 2 * dt;
        bot.z += Math.sin(bot.yaw) * 2 * dt;
        if (Math.random() < 0.02) bot.yaw += (Math.random() - 0.5) * 2;
      }
      
      // Boundary clamp
      const b = MAP_SIZE - 5;
      bot.x = Math.max(-b, Math.min(b, bot.x));
      bot.z = Math.max(-b, Math.min(b, bot.z));
    }
  }
}, 1000 / PHYSICS_RATE);

/* ========== BROADCAST STATE AT 20Hz ========== */
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started) continue;
    
    io.to(room.id).emit('state', {
      players: [...room.players.values()].map(p => ({
        id: p.id, name: p.name,
        x: p.x, y: p.y, z: p.z,
        yaw: p.yaw, pitch: p.pitch,
        health: p.health, alive: p.alive,
        weapon: p.weapon, kills: p.kills, ads: p.ads
      })),
      bots: room.bots.map(b => ({
        id: b.id, name: b.name,
        x: b.x, z: b.z, yaw: b.yaw,
        alive: b.alive, weapon: b.weapon
      })),
      zone: {
        radius: room.zone.radius,
        cx: room.zone.cx, cz: room.zone.cz,
        targetRadius: room.zone.targetRadius,
        tcx: room.zone.tcx, tcz: room.zone.tcz,
        timer: Math.max(0, Math.ceil(room.zone.timer)),
        phase: room.zone.phase
      }
    });
  }
}, 1000 / TICK_RATE);

/* ========== START SERVER ========== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Battle Arena MP server running on port ${PORT}`);
});