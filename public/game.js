const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const healthFill = document.getElementById('healthFill');
const teamInfo = document.getElementById('teamInfo');
const scoreInfo = document.getElementById('scoreInfo');
const gameOverScreen = document.getElementById('gameOverScreen');
const winnerText = document.getElementById('winnerText');
const restartBtn = document.getElementById('restartBtn');

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ----------------- ISOMETRIC AYARLARI -----------------
const TILE_W = 64;
const TILE_H = 32;

function gridToScreen(gx, gy) {
  return {
    x: (gx - gy) * (TILE_W / 2),
    y: (gx + gy) * (TILE_H / 2)
  };
}

function screenToGrid(sx, sy) {
  const gx = (sx / (TILE_W / 2) + sy / (TILE_H / 2)) / 2;
  const gy = (sy / (TILE_H / 2) - sx / (TILE_W / 2)) / 2;
  return { x: gx, y: gy };
}

// ----------------- DURUM -----------------
let socket = io();
let myId = null;
let gridSize = 50;
let grid = [];
let teams = {};
let players = {};
let bullets = [];
let pickups = {}; // id -> {id,x,y,type}
let gameOver = null;

const ITEM_LABELS = {
  paint5: { text: '5x5', color: '#a3e635' },
  paint10: { text: '10x10', color: '#22d3ee' },
  paint30: { text: '30x30', color: '#f59e0b' },
  aoeDamage20: { text: 'HASAR', color: '#dc2626' }
};

const keys = { up: false, down: false, left: false, right: false };
let aimAngle = 0;
let mouseScreen = { x: 0, y: 0 };

// ----------------- SOCKET EVENTLERI -----------------
socket.on('init', (data) => {
  myId = data.you;
  gridSize = data.gridSize;
  grid = data.grid;
  teams = data.teams;
  gameOver = data.gameOver;
  players = {};
  data.players.forEach(p => players[p.id] = p);
  pickups = {};
  data.pickups.forEach(p => pickups[p.id] = p);
  updateTeamInfo();
  if (players[myId]) updateInventoryUI(players[myId].inventory);
  if (gameOver) showGameOver(gameOver);
});

socket.on('fullState', (data) => {
  gridSize = data.gridSize;
  grid = data.grid;
  teams = data.teams;
  gameOver = data.gameOver;
  players = {};
  data.players.forEach(p => players[p.id] = p);
  pickups = {};
  data.pickups.forEach(p => pickups[p.id] = p);
  hideGameOver();
});

socket.on('pickupSpawned', (pk) => { pickups[pk.id] = pk; });
socket.on('pickupTaken', (data) => {
  delete pickups[data.id];
  if (data.by === myId) {
    updateInventoryUI(data.inventory);
    flashSlot(data.slot);
  }
});
socket.on('itemUsed', (data) => {
  if (data.by === myId) updateInventoryUI(data.inventory);
});

socket.on('cellUpdate', ({ x, y, team }) => {
  if (grid[y]) grid[y][x] = team;
});

socket.on('cellsUpdate', (cells) => {
  cells.forEach(({ x, y, team }) => {
    if (grid[y]) grid[y][x] = team;
  });
});

socket.on('playerJoined', (p) => { players[p.id] = p; });
socket.on('playerLeft', (id) => { delete players[id]; });

socket.on('state', (data) => {
  data.players.forEach(p => {
    players[p.id] = { ...players[p.id], ...p };
  });
  bullets = data.bullets;
  if (players[myId]) {
    const hp = Math.max(0, players[myId].health);
    healthFill.style.width = hp + '%';
    healthFill.style.background = hp > 50 ? '#22c55e' : hp > 20 ? '#eab308' : '#ef4444';
  }
});

socket.on('playerRespawn', (p) => { players[p.id] = { ...players[p.id], ...p }; });

socket.on('gameOver', (data) => {
  gameOver = data;
  showGameOver(data);
});

function showGameOver(data) {
  const teamName = data.winner === 'blue' ? 'MAVI TAKIM' : 'KIRMIZI TAKIM';
  winnerText.textContent = `${teamName} KAZANDI!`;
  winnerText.style.color = teams[data.winner] ? teams[data.winner].color : '#fff';
  gameOverScreen.classList.remove('hidden');
}
function hideGameOver() {
  gameOverScreen.classList.add('hidden');
}

restartBtn.addEventListener('click', () => {
  socket.emit('requestRestart');
});

function updateTeamInfo() {
  if (players[myId]) {
    const t = players[myId].team;
    teamInfo.textContent = 'Takim: ' + (t === 'blue' ? 'Mavi' : 'Kirmizi');
    teamInfo.style.color = teams[t] ? teams[t].color : '#fff';
  }
}

// ----------------- ENVANTER ARAYUZU -----------------
function updateInventoryUI(inventory) {
  for (let i = 1; i <= 3; i++) {
    const el = document.getElementById('slot' + i);
    const type = inventory[i];
    const label = el.querySelector('.slotLabel');
    if (type && ITEM_LABELS[type]) {
      el.classList.remove('empty');
      el.classList.add('filled');
      label.textContent = ITEM_LABELS[type].text;
      el.style.borderColor = ITEM_LABELS[type].color;
    } else {
      el.classList.add('empty');
      el.classList.remove('filled');
      label.textContent = '-';
      el.style.borderColor = '';
    }
  }
}

function flashSlot(index) {
  const el = document.getElementById('slot' + index);
  if (!el) return;
  el.classList.add('used-flash');
  setTimeout(() => el.classList.remove('used-flash'), 150);
}

// ----------------- INPUT -----------------
window.addEventListener('keydown', (e) => {
  handleKey(e.code, true);
});
window.addEventListener('keyup', (e) => {
  handleKey(e.code, false);
});
function handleKey(code, isDown) {
  let changed = true;
  if (code === 'KeyW') keys.up = isDown;
  else if (code === 'KeyS') keys.down = isDown;
  else if (code === 'KeyA') keys.left = isDown;
  else if (code === 'KeyD') keys.right = isDown;
  else changed = false;
  if (changed) sendInput();

  // sayi tuslariyla envanter kullanimi (sadece basildigi anda, birakildiginda degil)
  if (isDown) {
    if (code === 'Digit2') socket.emit('useItem', { slot: 1 });
    else if (code === 'Digit3') socket.emit('useItem', { slot: 2 });
    else if (code === 'Digit4') socket.emit('useItem', { slot: 3 });
  }
}

canvas.addEventListener('mousemove', (e) => {
  mouseScreen.x = e.clientX;
  mouseScreen.y = e.clientY;
  updateAim();
});

canvas.addEventListener('mousedown', () => {
  socket.emit('shoot');
});

function updateAim() {
  const me = players[myId];
  if (!me) return;
  const cam = getCameraOffset();
  const worldScreenX = mouseScreen.x - cam.x;
  const worldScreenY = mouseScreen.y - cam.y;
  const g = screenToGrid(worldScreenX, worldScreenY);
  aimAngle = Math.atan2(g.y - me.y, g.x - me.x);
  sendInput();
}

let lastSent = 0;
function sendInput() {
  const now = Date.now();
  if (now - lastSent < 33) return; // ~30hz sinirla
  lastSent = now;
  socket.emit('input', { ...keys, aimAngle });
}
setInterval(sendInput, 50); // input degismese bile aim guncel kalsin

// ----------------- YUMUSAK GECIS (INTERPOLATION) -----------------
// Sunucu pozisyonu saniyede ~20 kez gonderiyor ama ekran cok daha sik ciziliyor.
// Bu yuzden dogrudan sunucu pozisyonuna zoplamak yerine, her karede hedefe
// dogru yumusakca kayarak "cit" hissini ortadan kaldiriyoruz.
let renderPos = {}; // id -> {x, y}

function updateRenderPositions(dt) {
  for (const id in players) {
    const p = players[id];
    if (!renderPos[id]) renderPos[id] = { x: p.x, y: p.y };
    const rp = renderPos[id];
    const smoothing = 1 - Math.pow(0.00002, dt);
    rp.x += (p.x - rp.x) * smoothing;
    rp.y += (p.y - rp.y) * smoothing;
  }
  for (const id in renderPos) {
    if (!players[id]) delete renderPos[id];
  }
}

// ----------------- KAMERA -----------------
function getCameraOffset() {
  const rp = renderPos[myId];
  if (!rp) return { x: canvas.width / 2, y: canvas.height / 2 };
  const screenPos = gridToScreen(rp.x, rp.y);
  return {
    x: canvas.width / 2 - screenPos.x,
    y: canvas.height / 2 - screenPos.y
  };
}

// ----------------- RENDER -----------------
let lastFrameTime = performance.now();
function draw() {
  const now = performance.now();
  let dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  dt = Math.min(dt, 0.1);

  updateRenderPositions(dt);

  ctx.fillStyle = '#0f0f23';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cam = getCameraOffset();
  ctx.save();
  ctx.translate(cam.x, cam.y);

  drawGrid();
  drawEntities();

  ctx.restore();
  requestAnimationFrame(draw);
}

function drawGrid() {
  for (let sum = 0; sum <= 2 * (gridSize - 1); sum++) {
    for (let gx = 0; gx <= sum; gx++) {
      const gy = sum - gx;
      if (gx >= gridSize || gy >= gridSize) continue;
      const owner = grid[gy] ? grid[gy][gx] : null;
      drawTile(gx, gy, owner);
    }
  }
}

function drawTile(gx, gy, owner) {
  const p = gridToScreen(gx, gy);
  const hw = TILE_W / 2;
  const hh = TILE_H / 2;

  ctx.beginPath();
  ctx.moveTo(p.x, p.y - hh);
  ctx.lineTo(p.x + hw, p.y);
  ctx.lineTo(p.x, p.y + hh);
  ctx.lineTo(p.x - hw, p.y);
  ctx.closePath();

  if (owner && teams[owner]) {
    ctx.fillStyle = teams[owner].color + '55';
  } else {
    ctx.fillStyle = ((gx + gy) % 2 === 0) ? '#22223a' : '#282846';
  }
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawEntities() {
  const entities = [];
  Object.values(players).forEach(p => {
    const rp = renderPos[p.id] || p;
    entities.push({ type: 'player', data: p, depth: rp.x + rp.y });
  });
  bullets.forEach(b => entities.push({ type: 'bullet', data: b, depth: b.x + b.y }));
  Object.values(pickups).forEach(pk => entities.push({ type: 'pickup', data: pk, depth: pk.x + pk.y }));
  entities.sort((a, b) => a.depth - b.depth);
  entities.forEach(e => {
    if (e.type === 'player') drawPlayer(e.data);
    else if (e.type === 'pickup') drawPickup(e.data);
    else drawBullet(e.data);
  });
}

function drawPlayer(p) {
  if (!p.alive) return;
  const rp = renderPos[p.id] || p;
  const pos = gridToScreen(rp.x, rp.y);
  const color = teams[p.team] ? teams[p.team].color : '#fff';

  ctx.beginPath();
  ctx.ellipse(pos.x, pos.y + 4, 12, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(pos.x, pos.y - 10, 12, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();

  const dirX = Math.cos(p.aimAngle);
  const dirY = Math.sin(p.aimAngle);
  const dirScreen = gridToScreen(rp.x + dirX * 0.6, rp.y + dirY * 0.6);
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y - 10);
  ctx.lineTo(dirScreen.x, dirScreen.y - 10);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.stroke();

  const hpPct = Math.max(0, p.health) / 100;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(pos.x - 16, pos.y - 32, 32, 5);
  ctx.fillStyle = hpPct > 0.5 ? '#22c55e' : hpPct > 0.2 ? '#eab308' : '#ef4444';
  ctx.fillRect(pos.x - 16, pos.y - 32, 32 * hpPct, 5);

  if (p.id === myId) {
    ctx.fillStyle = '#fff';
    ctx.font = '11px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('SEN', pos.x, pos.y - 38);
  }
}

function drawBullet(b) {
  const pos = gridToScreen(b.x, b.y);
  ctx.beginPath();
  ctx.arc(pos.x, pos.y - 10, 4, 0, Math.PI * 2);
  ctx.fillStyle = teams[b.team] ? teams[b.team].color : '#fff';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawPickup(pk) {
  const pos = gridToScreen(pk.x + 0.5, pk.y + 0.5);
  const info = ITEM_LABELS[pk.type] || { text: '?', color: '#fff' };
  const bobOffset = Math.sin(Date.now() / 300 + pk.id) * 3;

  ctx.beginPath();
  ctx.ellipse(pos.x, pos.y + 4, 14, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill();

  const boxY = pos.y - 16 + bobOffset;
  ctx.save();
  ctx.translate(pos.x, boxY);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = info.color;
  ctx.fillRect(-11, -11, 22, 22);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(-11, -11, 22, 22);
  ctx.restore();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 9px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(info.text, pos.x, boxY - 20);
}

draw();
