/*
  Hide From The Monster
  - Canvas + simple collision
  - Dragon chases if it has line-of-sight (LOS), otherwise patrols
  - Walls block LOS and flame breath
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
  if (['arrowup','arrowdown','arrowleft','arrowright','w','a','s','d','r','shift',' '].includes(k)) {
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
    if (ax1 < bx1) mover.x -= overlapX;
    else mover.x += overlapX;
  } else {
    if (ay1 < by1) mover.y -= overlapY;
    else mover.y += overlapY;
  }
}

function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

// Segment vs AABB: Liang-Barsky style clipping
function segmentIntersectsRect(x1, y1, x2, y2, r) {
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
  rect(0, 0, W, 16),
  rect(0, H - 16, W, 16),
  rect(0, 0, 16, H),
  rect(W - 16, 0, 16, H),

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
  for (const w of walls) {
    if (segmentIntersectsRect(ax, ay, bx, by, w)) return false;
  }
  return true;
}

const player = {
  x: 60,
  y: 60,
  w: 18,
  h: 26,
  speed: 210,
  sprintMult: 1.65,
  stamina: 100,
  staminaMax: 100,
  staminaDrainPerSec: 38,
  staminaRegenPerSec: 22,
  shield: {
    active: false,
    durability: 100,
    max: 100,
    hitCost: 26,
    regenPerSec: 14,
    brokenUntil: 0,
    breakCooldownMs: 2400,
  },
};

const monster = {
  x: W - 110,
  y: H - 100,
  w: 34,
  h: 24,
  speedChase: 220, // faster
  speedPatrol: 125,
  wander: { x: W / 2, y: H / 2, until: 0 },

  // flame breath
  breathCooldownMs: 900,
  breathDurationMs: 700,
  breathActiveUntil: 0,
  lastBreathAt: 0,
  coneAngle: Math.PI / 5.5, // total cone width ~33deg
};

// flame particles
const flames = [];

let startTs = 0;
let lastTs = 0;
let elapsed = 0;
let state = 'running';

function reset() {
  player.x = 60;
  player.y = 60;
  player.stamina = player.staminaMax;
  player.shield.active = false;
  player.shield.durability = player.shield.max;
  player.shield.brokenUntil = 0;

  monster.x = W - 110;
  monster.y = H - 100;
  monster.wander = { x: W / 2, y: H / 2, until: 0 };
  monster.breathActiveUntil = 0;
  monster.lastBreathAt = 0;

  flames.length = 0;
  startTs = 0;
  lastTs = 0;
  elapsed = 0;
  state = 'running';
  statusEl.textContent = 'running';
}

function moveEntity(ent, vx, vy, dt) {
  ent.x += vx * dt;
  ent.y += vy * dt;

  for (const w of walls) resolveStaticCollision(ent, w);

  ent.x = clamp(ent.x, 0, W - ent.w);
  ent.y = clamp(ent.y, 0, H - ent.h);
}

function shieldIsUp(now) {
  if (!player.shield.active) return false;
  if (now < player.shield.brokenUntil) return false;
  return player.shield.durability > 0;
}

function updatePlayer(dt, now) {
  // shield hold
  player.shield.active = keys.has(' ');

  // stamina
  const wantsSprint = keys.has('shift');
  const canSprint = wantsSprint && player.stamina > 1;

  let dx = 0, dy = 0;
  if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
  if (keys.has('arrowright') || keys.has('d')) dx += 1;
  if (keys.has('arrowup') || keys.has('w')) dy -= 1;
  if (keys.has('arrowdown') || keys.has('s')) dy += 1;

  const moving = !!(dx || dy);
  let speed = player.speed;
  if (moving && canSprint) {
    speed *= player.sprintMult;
    player.stamina = clamp(player.stamina - player.staminaDrainPerSec * dt, 0, player.staminaMax);
  } else {
    player.stamina = clamp(player.stamina + player.staminaRegenPerSec * dt, 0, player.staminaMax);
  }

  // shield regen (only when not broken)
  if (now >= player.shield.brokenUntil && !shieldIsUp(now)) {
    player.shield.durability = clamp(player.shield.durability + player.shield.regenPerSec * dt, 0, player.shield.max);
  }

  if (moving) {
    const n = norm(dx, dy);
    moveEntity(player, n.x * speed, n.y * speed, dt);
  }
}

function pickWanderTarget(now) {
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

function emitConeFlames(fromX, fromY, dirX, dirY, now) {
  const baseAng = Math.atan2(dirY, dirX);
  const count = 9;
  const speed = 520;

  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * 2 - 1; // -1..1
    const ang = baseAng + t * (monster.coneAngle / 2);
    const jitter = (Math.random() - 0.5) * 0.10;
    const a = ang + jitter;

    const vx = Math.cos(a) * speed * (0.75 + Math.random() * 0.35);
    const vy = Math.sin(a) * speed * (0.75 + Math.random() * 0.35);

    flames.push({
      x: fromX + Math.cos(a) * 22,
      y: fromY + Math.sin(a) * 22,
      vx,
      vy,
      r: 4.5 + Math.random() * 2.5,
      bornAt: now,
      ttlMs: 520 + Math.random() * 260,
    });
  }
}

function updateFlames(dt, now) {
  for (let i = flames.length - 1; i >= 0; i--) {
    const f = flames[i];
    f.x += f.vx * dt;
    f.y += f.vy * dt;

    if (now - f.bornAt > f.ttlMs) {
      flames.splice(i, 1);
      continue;
    }

    // extinguish on wall
    const fr = rect(f.x - f.r, f.y - f.r, f.r * 2, f.r * 2);
    let hitWall = false;
    for (const w of walls) {
      if (intersectsAABB(fr, w)) { hitWall = true; break; }
    }
    if (hitWall) {
      flames.splice(i, 1);
      continue;
    }

    // hit player
    const pr = rect(player.x, player.y, player.w, player.h);
    const hit = pointInRect(f.x, f.y, pr) || intersectsAABB(fr, pr);
    if (hit) {
      if (shieldIsUp(now)) {
        player.shield.durability = clamp(player.shield.durability - player.shield.hitCost, 0, player.shield.max);
        if (player.shield.durability <= 0.001) {
          player.shield.brokenUntil = now + player.shield.breakCooldownMs;
        }
        flames.splice(i, 1);
        continue;
      }

      state = 'lost';
      statusEl.textContent = 'burned (press R)';
      flames.splice(i, 1);
    }
  }
}

function updateMonster(dt, now) {
  const pcx = player.x + player.w / 2;
  const pcy = player.y + player.h / 2;
  const mcx = monster.x + monster.w / 2;
  const mcy = monster.y + monster.h / 2;

  const sees = hasLineOfSight(mcx, mcy, pcx, pcy);

  if (sees) {
    const toP = norm(pcx - mcx, pcy - mcy);
    const dist = len(pcx - mcx, pcy - mcy);

    // chase harder (keep a little distance so the cone matters)
    if (dist > 110) {
      moveEntity(monster, toP.x * monster.speedChase, toP.y * monster.speedChase, dt);
    } else if (dist < 75) {
      // back up a touch so you can maybe dodge
      moveEntity(monster, -toP.x * (monster.speedChase * 0.55), -toP.y * (monster.speedChase * 0.55), dt);
    }

    // start a breath burst
    if (now - monster.lastBreathAt >= monster.breathCooldownMs) {
      monster.lastBreathAt = now;
      monster.breathActiveUntil = now + monster.breathDurationMs;
    }

    // while active, emit a cone each frame
    if (now < monster.breathActiveUntil) {
      emitConeFlames(mcx, mcy, toP.x, toP.y, now);
    }
  } else {
    if (now > monster.wander.until) pickWanderTarget(now);
    const v = norm(monster.wander.x - mcx, monster.wander.y - mcy);
    moveEntity(monster, v.x * monster.speedPatrol, v.y * monster.speedPatrol, dt);
  }

  // still lose if you touch the dragon
  if (intersectsAABB(player, monster)) {
    state = 'lost';
    statusEl.textContent = 'mauled (press R)';
  }
}

function drawStickFigure() {
  const x = player.x;
  const y = player.y;
  const cx = x + player.w / 2;
  const top = y + 2;
  const headR = 5;

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#e9ecff';

  // head
  ctx.beginPath();
  ctx.arc(cx, top + headR, headR, 0, Math.PI * 2);
  ctx.stroke();

  // body
  const neckY = top + headR * 2 + 1;
  const hipY = y + player.h - 6;
  ctx.beginPath();
  ctx.moveTo(cx, neckY);
  ctx.lineTo(cx, hipY);
  ctx.stroke();

  // arms
  const armY = neckY + 7;
  ctx.beginPath();
  ctx.moveTo(cx - 7, armY);
  ctx.lineTo(cx + 7, armY);
  ctx.stroke();

  // legs
  ctx.beginPath();
  ctx.moveTo(cx, hipY);
  ctx.lineTo(cx - 6, hipY + 10);
  ctx.moveTo(cx, hipY);
  ctx.lineTo(cx + 6, hipY + 10);
  ctx.stroke();

  ctx.restore();
}

function drawShield(now) {
  if (!shieldIsUp(now)) return;

  const cx = player.x + player.w / 2;
  const cy = player.y + player.h / 2 + 2;
  const pct = player.shield.durability / player.shield.max;

  ctx.save();
  ctx.globalAlpha = 0.35 + pct * 0.35;
  ctx.strokeStyle = 'rgba(90,200,255,0.95)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 18, 0, Math.PI * 2);
  ctx.stroke();

  // durability arc
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = 'rgba(90,200,255,0.65)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
  ctx.stroke();
  ctx.restore();
}

function drawDragon() {
  const x = monster.x;
  const y = monster.y;
  const cx = x + monster.w / 2;
  const cy = y + monster.h / 2;

  ctx.save();

  // body
  ctx.fillStyle = '#ff4d4d';
  ctx.beginPath();
  ctx.ellipse(cx - 2, cy + 2, 14, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  // head
  ctx.beginPath();
  ctx.ellipse(cx + 14, cy - 3, 7, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // snout horn
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.moveTo(cx + 19, cy - 9);
  ctx.lineTo(cx + 27, cy - 6);
  ctx.lineTo(cx + 19, cy - 4);
  ctx.closePath();
  ctx.fill();

  // wing
  ctx.fillStyle = 'rgba(255,77,77,0.78)';
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy - 2);
  ctx.lineTo(cx - 22, cy - 18);
  ctx.lineTo(cx - 16, cy + 5);
  ctx.closePath();
  ctx.fill();

  // eye
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.arc(cx + 16, cy - 4, 1.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawFlames(now) {
  for (const f of flames) {
    const age = clamp((now - f.bornAt) / f.ttlMs, 0, 1);
    const r = f.r * (1.25 - age * 0.55);

    ctx.save();
    const grad = ctx.createRadialGradient(f.x, f.y, 1, f.x, f.y, r * 3.0);
    grad.addColorStop(0, 'rgba(255,255,210,0.95)');
    grad.addColorStop(0.25, 'rgba(255,195,30,0.85)');
    grad.addColorStop(0.55, 'rgba(255,90,0,0.55)');
    grad.addColorStop(1, 'rgba(255,60,0,0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r * 3.0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,120,0,0.85)';
    ctx.beginPath();
    ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawHUD(now) {
  // stamina + shield meters (top-left)
  const pad = 14;
  const x = pad;
  const y = pad;

  const barW = 170;
  const barH = 8;

  const staminaPct = player.stamina / player.staminaMax;
  const shieldPct = player.shield.durability / player.shield.max;
  const shieldBroken = now < player.shield.brokenUntil;

  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x - 6, y - 6, barW + 12, 48);

  // stamina
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x, y, barW, barH);
  ctx.fillStyle = 'rgba(90,200,255,0.9)';
  ctx.fillRect(x, y, barW * staminaPct, barH);
  ctx.fillStyle = 'rgba(233,236,255,0.85)';
  ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
  ctx.fillText('Sprint (Shift)', x, y + 22);

  // shield
  const y2 = y + 26;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x, y2, barW, barH);
  ctx.fillStyle = shieldBroken ? 'rgba(255,100,100,0.85)' : 'rgba(120,255,200,0.85)';
  ctx.fillRect(x, y2, barW * shieldPct, barH);
  ctx.fillStyle = 'rgba(233,236,255,0.85)';
  ctx.fillText(shieldBroken ? 'Shield (Space) BROKEN' : 'Shield (Space)', x, y2 + 22);

  ctx.restore();
}

function draw(now) {
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

  // LOS indicator
  const pcx = player.x + player.w / 2;
  const pcy = player.y + player.h / 2;
  const mcx = monster.x + monster.w / 2;
  const mcy = monster.y + monster.h / 2;
  const sees = hasLineOfSight(mcx, mcy, pcx, pcy);

  ctx.save();
  ctx.globalAlpha = sees ? 0.20 : 0.07;
  ctx.strokeStyle = sees ? '#ff8a3d' : '#9aa6ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mcx, mcy);
  ctx.lineTo(pcx, pcy);
  ctx.stroke();
  ctx.restore();

  // flames
  drawFlames(now);

  // player + shield
  drawStickFigure();
  drawShield(now);

  // dragon
  drawDragon();

  // meters
  drawHUD(now);

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

    updatePlayer(dt, ts);
    updateMonster(dt, ts);
    updateFlames(dt, ts);

    if (elapsed >= GOAL_SECONDS) {
      state = 'won';
      statusEl.textContent = 'won (press R)';
    }
  }

  draw(ts);
  requestAnimationFrame(tick);
}

reset();
requestAnimationFrame(tick);
