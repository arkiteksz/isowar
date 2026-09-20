const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ----------------- OYUN AYARLARI -----------------
const GRID_SIZE = 50;          // 50x50 kare harita
const TICK_RATE = 20;          // saniyede 20 kez sunucu guncellemesi
const PLAYER_SPEED = 6;        // grid birimi / saniye
const PLAYER_RADIUS = 0.35;    // carpisma / boyama yaricapi
const MAX_HEALTH = 100;
const BULLET_SPEED = 20;       // grid birimi / saniye
const BULLET_DAMAGE = 20;
const BULLET_LIFETIME = 1.2;   // saniye
const SHOOT_COOLDOWN = 0.35;   // saniye
const WIN_PERCENT = 0.70;

// ----------------- OZEL ESYALAR -----------------
const ITEM_TYPES = {
  paint5:      { size: 5,  kind: 'paint',  weight: 40 },
  paint10:     { size: 10, kind: 'paint',  weight: 28 },
  paint30:     { size: 30, kind: 'paint',  weight: 10 },
  aoeDamage20: { size: 20, kind: 'damage', damage: 50, weight: 22 }
};
const ITEM_TYPE_LIST = Object.entries(ITEM_TYPES).map(([type, cfg]) => ({ type, ...cfg }));
const TOTAL_ITEM_WEIGHT = ITEM_TYPE_LIST.reduce((sum, it) => sum + it.weight, 0);
const MAX_PICKUPS = 15;
const PICKUP_PICKUP_RADIUS = 0.6;
const PICKUP_MIN_INTERVAL_MS = 3000;
const PICKUP_MAX_INTERVAL_MS = 8000;

function pickRandomItemType() {
  let r = Math.random() * TOTAL_ITEM_WEIGHT;
  for (const it of ITEM_TYPE_LIST) {
    if (r < it.weight) return it.type;
    r -= it.weight;
  }
  return ITEM_TYPE_LIST[0].type;
}

const TEAMS = {
  blue: { id: 'blue', color: '#3b82f6', spawn: { x: 3, y: 3 } },
  red:  { id: 'red',  color: '#ef4444', spawn: { x: GRID_SIZE - 4, y: GRID_SIZE - 4 } }
};

// grid[y][x] = null | 'blue' | 'red'
let grid = [];
function resetGrid() {
  grid = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));
}
resetGrid();

let players = {}; // socketId -> player
let bullets = []; // {id,x,y,vx,vy,team,ownerId,life}
let bulletIdCounter = 0;
let gameOver = null; // {winner} | null

let pickups = {}; // id -> {id,x,y,type}
let pickupIdCounter = 0;

function trySpawnPickup() {
  if (Object.keys(pickups).length >= MAX_PICKUPS) return;
  let attempts = 0;
  while (attempts < 20) {
    attempts++;
    const x = Math.floor(Math.random() * (GRID_SIZE - 4)) + 2;
    const y = Math.floor(Math.random() * (GRID_SIZE - 4)) + 2;
    const occupied = Object.values(pickups).some(p => p.x === x && p.y === y);
    if (!occupied) {
      pickupIdCounter++;
      const type = pickRandomItemType();
      const pickup = { id: pickupIdCounter, x, y, type };
      pickups[pickup.id] = pickup;
      io.emit('pickupSpawned', pickup);
      return;
    }
  }
}

function scheduleNextPickupSpawn() {
  const delay = PICKUP_MIN_INTERVAL_MS + Math.random() * (PICKUP_MAX_INTERVAL_MS - PICKUP_MIN_INTERVAL_MS);
  setTimeout(() => {
    trySpawnPickup();
    scheduleNextPickupSpawn();
  }, delay);
}
scheduleNextPickupSpawn();

function teamCounts() {
  return Object.values(players).reduce((acc, p) => {
    acc[p.team] = (acc[p.team] || 0) + 1;
    return acc;
  }, {});
}

function pickTeamForNewPlayer() {
  const counts = teamCounts();
  const blueCount = counts.blue || 0;
  const redCount = counts.red || 0;
  return blueCount <= redCount ? 'blue' : 'red';
}

function spawnPlayer(socketId, name) {
  const team = pickTeamForNewPlayer();
  const spawn = TEAMS[team].spawn;
  players[socketId] = {
    id: socketId,
    name: name || ('Oyuncu' + socketId.slice(0, 4)),
    team,
    x: spawn.x + 0.5,
    y: spawn.y + 0.5,
    health: MAX_HEALTH,
    aimAngle: 0,
    input: { up: false, down: false, left: false, right: false },
    lastShot: 0,
    alive: true,
    inventory: ['default', null, null, null] // 0. slot sabit varsayilan silah
  };
  return players[socketId];
}

function respawnPlayer(p) {
  const spawn = TEAMS[p.team].spawn;
  p.x = spawn.x + 0.5;
  p.y = spawn.y + 0.5;
  p.health = MAX_HEALTH;
  p.alive = true;
}

function paintCellUnder(p) {
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  if (cx < 0 || cy < 0 || cx >= GRID_SIZE || cy >= GRID_SIZE) return;
  if (grid[cy][cx] !== p.team) {
    grid[cy][cx] = p.team;
    io.emit('cellUpdate', { x: cx, y: cy, team: p.team });
  }
}

function paintArea(p, size) {
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const half = Math.floor(size / 2);
  const startX = cx - half;
  const endX = startX + size - 1;
  const startY = cy - half;
  const endY = startY + size - 1;
  const changed = [];
  for (let yy = startY; yy <= endY; yy++) {
    for (let xx = startX; xx <= endX; xx++) {
      if (xx < 0 || yy < 0 || xx >= GRID_SIZE || yy >= GRID_SIZE) continue;
      if (grid[yy][xx] !== p.team) {
        grid[yy][xx] = p.team;
        changed.push({ x: xx, y: yy, team: p.team });
      }
    }
  }
  if (changed.length) io.emit('cellsUpdate', changed);
}

function damageArea(p, size, damage) {
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const half = size / 2;
  for (const other of Object.values(players)) {
    if (!other.alive || other.team === p.team) continue;
    if (Math.abs(other.x - (cx + 0.5)) <= half && Math.abs(other.y - (cy + 0.5)) <= half) {
      other.health -= damage;
      if (other.health <= 0) {
        other.alive = false;
        io.emit('playerKilled', { id: other.id, by: p.id });
        setTimeout(() => {
          if (players[other.id]) {
            respawnPlayer(players[other.id]);
            io.emit('playerRespawn', publicPlayer(players[other.id]));
          }
        }, 1500);
      }
    }
  }
}

function applyItemEffect(p, type) {
  const info = ITEM_TYPES[type];
  if (!info) return;
  if (info.kind === 'paint') paintArea(p, info.size);
  else if (info.kind === 'damage') damageArea(p, info.size, info.damage);
}

function checkWinCondition() {
  if (gameOver) return;
  const totalCells = GRID_SIZE * GRID_SIZE;
  const counts = { blue: 0, red: 0 };
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const owner = grid[y][x];
      if (owner) counts[owner]++;
    }
  }
  for (const team of Object.keys(TEAMS)) {
    if (counts[team] / totalCells >= WIN_PERCENT) {
      gameOver = { winner: team, counts };
      io.emit('gameOver', gameOver);
    }
  }
}

function resetMatch() {
  resetGrid();
  gameOver = null;
  bullets = [];
  pickups = {};
  Object.values(players).forEach(p => {
    respawnPlayer(p);
    p.inventory = ['default', null, null, null];
  });
  io.emit('fullState', buildFullState());
}

function buildFullState() {
  return {
    gridSize: GRID_SIZE,
    grid,
    teams: TEAMS,
    players: Object.values(players).map(publicPlayer),
    pickups: Object.values(pickups),
    gameOver
  };
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    team: p.team,
    x: p.x,
    y: p.y,
    health: p.health,
    aimAngle: p.aimAngle,
    alive: p.alive,
    inventory: p.inventory
  };
}

io.on('connection', (socket) => {
  const player = spawnPlayer(socket.id);
  socket.emit('init', { you: socket.id, ...buildFullState() });
  socket.broadcast.emit('playerJoined', publicPlayer(player));

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p) return;
    p.input.up = !!data.up;
    p.input.down = !!data.down;
    p.input.left = !!data.left;
    p.input.right = !!data.right;
    if (typeof data.aimAngle === 'number') p.aimAngle = data.aimAngle;
  });

  socket.on('shoot', () => {
    const p = players[socket.id];
    if (!p || !p.alive || gameOver) return;
    const now = Date.now() / 1000;
    if (now - p.lastShot < SHOOT_COOLDOWN) return;
    p.lastShot = now;
    bulletIdCounter++;
    bullets.push({
      id: bulletIdCounter,
      x: p.x,
      y: p.y,
      vx: Math.cos(p.aimAngle) * BULLET_SPEED,
      vy: Math.sin(p.aimAngle) * BULLET_SPEED,
      team: p.team,
      ownerId: p.id,
      life: BULLET_LIFETIME
    });
  });

  socket.on('requestRestart', () => {
    if (gameOver) resetMatch();
  });

  socket.on('useItem', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive || gameOver) return;
    const slotIndex = data && data.slot;
    if (!Number.isInteger(slotIndex) || slotIndex < 1 || slotIndex > 3) return;
    const type = p.inventory[slotIndex];
    if (!type) return;
    applyItemEffect(p, type);
    p.inventory[slotIndex] = null;
    io.emit('itemUsed', { by: p.id, slot: slotIndex, type, inventory: p.inventory });
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// ----------------- OYUN DONGUSU -----------------
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  if (!gameOver) {
    // oyuncu hareketi
    for (const p of Object.values(players)) {
      if (!p.alive) continue;
      // NOT: bu bir isometric oyun, bu yuzden WASD'yi grid eksenine gore degil
      // EKRANDA gorunen yone gore hesapliyoruz (W = ekranda yukari, D = ekranda sag, vb.)
      let dx = 0, dy = 0;
      if (p.input.up)    { dx -= 1; dy -= 1; } // ekranda yukari
      if (p.input.down)  { dx += 1; dy += 1; } // ekranda asagi
      if (p.input.left)  { dx -= 1; dy += 1; } // ekranda sola
      if (p.input.right) { dx += 1; dy -= 1; } // ekranda saga
      if (dx !== 0 || dy !== 0) {
        const len = Math.sqrt(dx * dx + dy * dy);
        dx /= len; dy /= len;
        p.x += dx * PLAYER_SPEED * dt;
        p.y += dy * PLAYER_SPEED * dt;
        p.x = Math.max(0.1, Math.min(GRID_SIZE - 0.1, p.x));
        p.y = Math.max(0.1, Math.min(GRID_SIZE - 0.1, p.y));
        paintCellUnder(p);
      }
    }

    // mermi hareketi + carpisma
    const remainingBullets = [];
    for (const b of bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      let hit = false;
      if (b.life > 0 && b.x >= 0 && b.y >= 0 && b.x <= GRID_SIZE && b.y <= GRID_SIZE) {
        for (const p of Object.values(players)) {
          if (!p.alive || p.team === b.team || p.id === b.ownerId) continue;
          const ddx = p.x - b.x;
          const ddy = p.y - b.y;
          if (Math.sqrt(ddx * ddx + ddy * ddy) < PLAYER_RADIUS + 0.2) {
            p.health -= BULLET_DAMAGE;
            hit = true;
            if (p.health <= 0) {
              p.alive = false;
              io.emit('playerKilled', { id: p.id, by: b.ownerId });
              setTimeout(() => {
                if (players[p.id]) {
                  respawnPlayer(players[p.id]);
                  io.emit('playerRespawn', publicPlayer(players[p.id]));
                }
              }, 1500);
            }
            break;
          }
        }
        if (!hit) remainingBullets.push(b);
      }
    }
    bullets = remainingBullets;

    // pickup toplama
    for (const p of Object.values(players)) {
      if (!p.alive) continue;
      for (const pk of Object.values(pickups)) {
        const ddx = p.x - (pk.x + 0.5);
        const ddy = p.y - (pk.y + 0.5);
        if (Math.sqrt(ddx * ddx + ddy * ddy) < PICKUP_PICKUP_RADIUS) {
          const emptyIndex = p.inventory.findIndex((slot, idx) => idx > 0 && slot === null);
          if (emptyIndex !== -1) {
            p.inventory[emptyIndex] = pk.type;
            delete pickups[pk.id];
            io.emit('pickupTaken', { id: pk.id, by: p.id, slot: emptyIndex, type: pk.type, inventory: p.inventory });
          }
          // slotlar doluysa esya yerde kalir, oyuncu bosluk acinca alabilir
        }
      }
    }

    checkWinCondition();
  }

  // durumu tum oyunculara yayinla
  io.emit('state', {
    players: Object.values(players).map(publicPlayer),
    bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y, team: b.team }))
  });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda calisiyor`);
});
