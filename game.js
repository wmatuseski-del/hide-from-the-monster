/*
  Hide From The Monster
  - Canvas + simple collision
  - Monster chases if it has line-of-sight (LOS), otherwise patrols
  - Walls block LOS (segment vs AABB)
*/

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const statusEl = document.getElementById('status');
const timeEl = document.getElementById('time');
const goalEl = document.getElementById('goal');

const W = canvas.width;
const H = canvas.height;

const GOAL_SECONDS = 30;
goalEl.textContent = String(GOAL_SECONDS);

const keys = new Set();
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (['arrowup','arrowdown','arrowleft','arrowright','w','a','s','d','r'].includes(k)) {
    e.preventDefault();
  }
  keys.add(k);
  if (k === 'r') reset();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function len(x, y) { return Math.hypot(x, y); }
function norm(x, y) {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

// Axis-aligned rectangle
function rect(x, y, w, h) { return { x, y, w, h }; }

function intersectsAABB(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Resolve moving AABB vs static AABB by separating on the smallest overlap
function resolveStaticCollision(mover, stat) {
  if (!intersectsAABB(mover, stat)) return;

  const ax1 = mover.x, ax2 = mover.x + mover.w;
  const ay1 = mover.y, ay2 = mover.y + mover.h;
  const bx1 = stat.x, bx2 = stat.x + stat.w;
  const by1 = stat.y, by2 = stat.y + stat.h;

  const overlapX = Math.min(ax2, bx2) - Math.max(ax1, bx1);
  const overlapY = Math.min(ay2, by2) - Math.max(ay1, by1);

  if (overlapX < overlapY) {
    // push left/right
    if (ax1 < bx1) mover.x -= overlapX;
    else mover.x += overlapX;
  } else {
    // push up/down
    if (ay1 < by1) mover.y -= overlapY;
    else mover.y += overlapY;
  }
}

function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

// Segment vs AABB: Liang-Barsky style clipping
function segmentIntersectsRect(x1, y1, x2, y2, r) {
  // If either endpoint inside, it intersects
  if (pointInRect(x1, y1, r) || pointInRect(x2, y2, r)) return true;

  const dx = x2 - x1;
  const dy = y2 - y1;

  let t0 = 0;
  let t1 = 1;

  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, (r.x + r.w) - x1, y1 - r.y, (r.y + r.h) - y1];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }

  return true;
}

const walls = [
  // outer border as thick walls
  rect(0, 0, W, 16),
  rect(0, H - 16, W, 16),
  rect(0, 0, 16, H),
  rect(W - 16, 0, 16, H),

  // interior walls (feel free to tweak)
  rect(140, 80, 520, 18),
  rect(140, 80, 18, 250),
  rect(320, 160, 18, 260),
  rect(480, 250, 320, 18),
  rect(650, 120, 18, 210),
  rect(210, 360, 260, 18),
  rect(760, 360, 18, 120),
  rect(90, 420, 180, 18),
];

function hasLineOfSight(ax, ay, bx, by) {
  // If the segment between points hits any wall, LOS is blocked
  for (const w of walls) {
    if (segmentIntersectsRect(ax, ay, bx, by, w)) return false;
  }
  return true;
}

const player = {
  x: 60,
  y: 60,
  w: 18,
  h: 18,
  speed: 210, // px/sec
};

const monster = {
  x: W - 90,
  y: H - 90,
  w: 22,
  h: 22,
  speedChase: 175,
  speedPatrol: 110,
  wander: { x: W / 2, y: H / 2, until: 0 },
};

let startTs = 0;
let lastTs = 0;
let elapsed = 0;
let state = 'running'; // running | won | lost

function reset() {
  player.x = 60;
  player.y = 60;
  monster.x = W - 90;
  monster.y = H - 90;
  monster.wander = { x: W / 2, y: H / 2, until: 0 };
  startTs = 0;
  lastTs = 0;
  elapsed = 0;
  state = 'running';
  statusEl.textContent = 'running';
}

function moveEntity(ent, vx, vy, dt) {
  ent.x += vx * dt;
  ent.y += vy * dt;

  // collide with walls
  for (const w of walls) resolveStaticCollision(ent, w);

  // clamp within bounds just in case
  ent.x = clamp(ent.x, 0, W - ent.w);
  ent.y = clamp(ent.y, 0, H - ent.h);
}

function updatePlayer(dt) {
  let dx = 0, dy = 0;
  if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
  if (keys.has('arrowright') || keys.has('d')) dx += 1;
  if (keys.has('arrowup') || keys.has('w')) dy -= 1;
  if (keys.has('arrowdown') || keys.has('s')) dy += 1;

  if (dx || dy) {
    const n = norm(dx, dy);
    moveEntity(player, n.x * player.speed, n.y * player.speed, dt);
  }
}

function pickWanderTarget(now) {
  // choose a random point not inside walls
  for (let i = 0; i < 40; i++) {
    const x = 40 + Math.random() * (W - 80);
    const y = 40 + Math.random() * (H - 80);
    const probe = rect(x - 6, y - 6, 12, 12);
    let ok = true;
    for (const w of walls) {
      if (intersectsAABB(probe, w)) { ok = false; break; }
    }
    if (ok) {
      monster.wander.x = x;
      monster.wander.y = y;
      monster.wander.until = now + 1100 + Math.random() * 1300;
      return;
    }
  }
  monster.wander.x = W / 2;
  monster.wander.y = H / 2;
  monster.wander.until = now + 1000;
}

function updateMonster(dt, now) {
  const pcx = player.x + player.w / 2;
  const pcy = player.y + player.h / 2;
  const mcx = monster.x + monster.w / 2;
  const mcy = monster.y + monster.h / 2;

  const sees = hasLineOfSight(mcx, mcy, pcx, pcy);

  if (sees) {
    const v = norm(pcx - mcx, pcy - mcy);
    moveEntity(monster, v.x * monster.speedChase, v.y * monster.speedChase, dt);
  } else {
    if (now > monster.wander.until) pickWanderTarget(now);
    const v = norm(monster.wander.x - mcx, monster.wander.y - mcy);
    moveEntity(monster, v.x * monster.speedPatrol, v.y * monster.speedPatrol, dt);
  }

  // lose condition: touching
  if (intersectsAABB(player, monster)) {
    state = 'lost';
    statusEl.textContent = 'lost (press R)';
  }
}

function draw() {
  ctx.clearRect(0, 0, W, H);

  // background grid
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = '#8aa0ff';
  for (let x = 0; x <= W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.restore();

  // walls
  for (const w of walls) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
  }

  // LOS indicator (subtle)
  const pcx = player.x + player.w / 2;
  const pcy = player.y + player.h / 2;
  const mcx = monster.x + monster.w / 2;
  const mcy = monster.y + monster.h / 2;
  const sees = hasLineOfSight(mcx, mcy, pcx, pcy);

  ctx.save();
  ctx.globalAlpha = sees ? 0.25 : 0.10;
  ctx.strokeStyle = sees ? '#ff5b5b' : '#9aa6ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mcx, mcy);
  ctx.lineTo(pcx, pcy);
  ctx.stroke();
  ctx.restore();

  // player
  ctx.fillStyle = '#4da3ff';
  ctx.fillRect(player.x, player.y, player.w, player.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.strokeRect(player.x + 0.5, player.y + 0.5, player.w - 1, player.h - 1);

  // monster
  ctx.fillStyle = '#ff4d4d';
  ctx.fillRect(monster.x, monster.y, monster.w, monster.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.strokeRect(monster.x + 0.5, monster.y + 0.5, monster.w - 1, monster.h - 1);

  // text overlays
  if (state !== 'running') {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
    ctx.textAlign = 'center';
    ctx.fillText(state === 'won' ? 'YOU SURVIVED' : 'YOU GOT GOT', W / 2, H / 2 - 10);
    ctx.font = '16px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
    ctx.fillStyle = '#cfd6ff';
    ctx.fillText('Press R to restart', W / 2, H / 2 + 24);
    ctx.restore();
  }
}

function tick(ts) {
  if (!startTs) startTs = ts;
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.033, (ts - lastTs) / 1000);
  lastTs = ts;

  if (state === 'running') {
    elapsed = (ts - startTs) / 1000;
    timeEl.textContent = elapsed.toFixed(1);

    updatePlayer(dt);
    updateMonster(dt, ts);

    if (elapsed >= GOAL_SECONDS) {
      state = 'won';
      statusEl.textContent = 'won (press R)';
    }
  }

  draw();
  requestAnimationFrame(tick);
}

reset();
requestAnimationFrame(tick);
