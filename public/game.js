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
let gameOver = null;

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
  updateTeamInfo();
  if (gameOver) showGameOver(gameOver);
});

socket.on('fullState', (data) => {
  gridSize = data.gridSize;
  grid = data.grid;
  teams = data.teams;
  gameOver = data.gameOver;
  players = {};
  data.players.forEach(p => players[p.id] = p);
  hideGameOver();
});

socket.on('cellUpdate', ({ x, y, team }) => {
  if (grid[y]) grid[y][x] = team;
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

// ----------------- KAMERA -----------------
function getCameraOffset() {
  const me = players[myId];
  if (!me) return { x: canvas.width / 2, y: canvas.height / 2 };
  const screenPos = gridToScreen(me.x, me.y);
  return {
    x: canvas.width / 2 - screenPos.x,
    y: canvas.height / 2 - screenPos.y
  };
}

// ----------------- RENDER -----------------
function draw() {
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
  Object.values(players).forEach(p => entities.push({ type: 'player', data: p, depth: p.x + p.y }));
  bullets.forEach(b => entities.push({ type: 'bullet', data: b, depth: b.x + b.y }));
  entities.sort((a, b) => a.depth - b.depth);
  entities.forEach(e => {
    if (e.type === 'player') drawPlayer(e.data);
    else drawBullet(e.data);
  });
}

function drawPlayer(p) {
  if (!p.alive) return;
  const pos = gridToScreen(p.x, p.y);
  const color = teams[p.team] ? teams[p.team].color : '#fff';

  // golge
  ctx.beginPath();
  ctx.ellipse(pos.x, pos.y + 4, 12, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();

  // govde
  ctx.beginPath();
  ctx.arc(pos.x, pos.y - 10, 12, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // nisan yonu
  const dirX = Math.cos(p.aimAngle);
  const dirY = Math.sin(p.aimAngle);
  const dirScreen = gridToScreen(p.x + dirX * 0.6, p.y + dirY * 0.6);
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y - 10);
  ctx.lineTo(dirScreen.x, dirScreen.y - 10);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.stroke();

  // can bari (rakipler icin de gorunsun)
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

draw();
