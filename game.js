/*
  Hide From The Monster
  - Canvas + simple collision
  - Dragon uses grid A* pathfinding to reach the stick figure efficiently
  - Walls block line-of-sight (LOS) and flame breath

  Controls:
  - Move: arrows / WASD
  - Sprint: Shift (stamina)
  - Shield: hold Space (durability)
  - Restart: R
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
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', 'r', 'shift', ' '].includes(k)) {
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
  speedChase: 235,
  speedPatrol: 125,
  wander: { x: W / 2, y: H / 2, until: 0 },

  // pathfinding
  path: [],
  pathIdx: 0,
  nextPathAt: 0,
  lastTargetKey: null,
  lastSeen: { x: W / 2, y: H / 2, at: 0 },

  // flame breath
  breathCooldownMs: 900,
  breathDurationMs: 700,
  breathActiveUntil: 0,
  lastBreathAt: 0,
  coneAngle: Math.PI / 5.5,
};

// flame particles
const flames = [];

// --- Grid nav (A*) ---
const NAV_CELL = 22; // smaller = smarter but heavier; this is a good sweet spot
const NAV_COLS = Math.floor(W / NAV_CELL);
const NAV_ROWS = Math.floor(H / NAV_CELL);
let navBlocked = null; // Uint8Array(NAV_COLS*NAV_ROWS)

function navIdx(c, r) { return r * NAV_COLS + c; }
function inBounds(c, r) { return c >= 0 && r >= 0 && c < NAV_COLS && r < NAV_ROWS; }

function rebuildNavGrid() {
  navBlocked = new Uint8Array(NAV_COLS * NAV_ROWS);

  // Inflate walls a bit so the dragon doesn't plan paths that scrape walls.
  const inflate = 10;
  const inflatedWalls = walls.map(w => rect(w.x - inflate, w.y - inflate, w.w + inflate * 2, w.h + inflate * 2));

  for (let r = 0; r < NAV_ROWS; r++) {
    for (let c = 0; c < NAV_COLS; c++) {
      const cx = c * NAV_CELL + NAV_CELL / 2;
      const cy = r * NAV_CELL + NAV_CELL / 2;
      const probe = rect(cx - 2, cy - 2, 4, 4);

      let blocked = false;
      for (const w of inflatedWalls) {
        if (intersectsAABB(probe, w)) { blocked = true; break; }
      }
      navBlocked[navIdx(c, r)] = blocked ? 1 : 0;
    }
  }
}
rebuildNavGrid();

function pointToCell(x, y) {
  const c = clamp(Math.floor(x / NAV_CELL), 0, NAV_COLS - 1);
  const r = clamp(Math.floor(y / NAV_CELL), 0, NAV_ROWS - 1);
  return { c, r, key: `${c},${r}` };
}

function cellCenter(c, r) {
  return { x: c * NAV_CELL + NAV_CELL / 2, y: r * NAV_CELL + NAV_CELL / 2 };
}

function isBlocked(c, r) {
  if (!inBounds(c, r)) return true;
  return navBlocked[navIdx(c, r)] === 1;
}

function aStar(start, goal) {
  // Basic A* (4-neighbor) for stability in tight corridors
  const startIdx = navIdx(start.c, start.r);
  const goalIdx = navIdx(goal.c, goal.r);

  const gScore = new Float32Array(NAV_COLS * NAV_ROWS);
  const fScore = new Float32Array(NAV_COLS * NAV_ROWS);
  const cameFrom = new Int32Array(NAV_COLS * NAV_ROWS);
  const inOpen = new Uint8Array(NAV_COLS * NAV_ROWS);
  const inClosed = new Uint8Array(NAV_COLS * NAV_ROWS);

  for (let i = 0; i < gScore.length; i++) {
    gScore[i] = 1e9;
    fScore[i] = 1e9;
    cameFrom[i] = -1;
  }

  function h(c, r) {
    // manhattan
    return Math.abs(c - goal.c) + Math.abs(r - goal.r);
  }

  const openList = [];
  gScore[startIdx] = 0;
  fScore[startIdx] = h(start.c, start.r);
  openList.push(startIdx);
  inOpen[startIdx] = 1;

  const dirs = [
    { dc: 1, dr: 0 },
    { dc: -1, dr: 0 },
    { dc: 0, dr: 1 },
    { dc: 0, dr: -1 },
  ];

  while (openList.length) {
    // find best fScore (small lists, so linear scan is fine)
    let bestI = 0;
    for (let i = 1; i < openList.length; i++) {
      if (fScore[openList[i]] < fScore[openList[bestI]]) bestI = i;
    }
    const currentIdx = openList.splice(bestI, 1)[0];
    inOpen[currentIdx] = 0;
    inClosed[currentIdx] = 1;

    if (currentIdx === goalIdx) {
      // reconstruct
      const path = [];
      let cur = currentIdx;
      while (cur !== -1) {
        const r = Math.floor(cur / NAV_COLS);
        const c = cur - r * NAV_COLS;
        path.push({ c, r });
        cur = cameFrom[cur];
      }
      path.reverse();
      return path;
    }

    const cr = Math.floor(currentIdx / NAV_COLS);
    const cc = currentIdx - cr * NAV_COLS;

    for (const d of dirs) {
      const nc = cc + d.dc;
      const nr = cr + d.dr;
      if (!inBounds(nc, nr)) continue;
      if (isBlocked(nc, nr)) continue;

      const ni = navIdx(nc, nr);
      if (inClosed[ni]) continue;

      const tentative = gScore[currentIdx] + 1;
      if (tentative < gScore[ni]) {
        cameFrom[ni] = currentIdx;
        gScore[ni] = tentative;
        fScore[ni] = tentative + h(nc, nr);
        if (!inOpen[ni]) {
          openList.push(ni);
          inOpen[ni] = 1;
        }
      }
    }
  }

  return null;
}

function buildPathTo(targetX, targetY) {
  const mc = pointToCell(monster.x + monster.w / 2, monster.y + monster.h / 2);
  const tc = pointToCell(targetX, targetY);

  // If target cell blocked (can happen near inflated borders), nudge around.
  if (isBlocked(tc.c, tc.r)) {
    // find nearest unblocked in a small radius
    let found = null;
    for (let rad = 1; rad <= 4 && !found; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          const c = tc.c + dc;
          const r = tc.r + dr;
          if (!inBounds(c, r)) continue;
          if (!isBlocked(c, r)) { found = { c, r }; break; }
        }
        if (found) break;
      }
    }
    if (found) {
      tc.c = found.c;
      tc.r = found.r;
      tc.key = `${found.c},${found.r}`;
    }
  }

  const startBlocked = isBlocked(mc.c, mc.r);
  const goalBlocked = isBlocked(tc.c, tc.r);
  if (startBlocked || goalBlocked) return false;

  const cells = aStar(mc, tc);
  if (!cells || cells.length < 2) return false;

  // Convert to waypoints (skip the starting cell)
  monster.path = cells.slice(1).map(p => cellCenter(p.c, p.r));
  monster.pathIdx = 0;
  monster.lastTargetKey = tc.key;
  return true;
}

function followPath(dt, speed) {
  if (!monster.path.length || monster.pathIdx >= monster.path.length) return false;

  const mcx = monster.x + monster.w / 2;
  const mcy = monster.y + monster.h / 2;
  const wp = monster.path[monster.pathIdx];

  const dx = wp.x - mcx;
  const dy = wp.y - mcy;
  const d = len(dx, dy);
  if (d < 6) {
    monster.pathIdx++;
    return true;
  }

  const v = norm(dx, dy);
  moveEntity(monster, v.x * speed, v.y * speed, dt);
  return true;
}

// --- gameplay ---

function shieldIsUp(now) {
  if (!player.shield.active) return false;
  if (now < player.shield.brokenUntil) return false;
  return player.shield.durability > 0;
}

function updatePlayer(dt, now) {
  player.shield.active = keys.has(' ');

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
    const t = (i / (count - 1)) * 2 - 1;
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

    const fr = rect(f.x - f.r, f.y - f.r, f.r * 2, f.r * 2);
    let hitWall = false;
    for (const w of walls) {
      if (intersectsAABB(fr, w)) { hitWall = true; break; }
    }
    if (hitWall) {
      flames.splice(i, 1);
      continue;
    }

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
    monster.lastSeen = { x: pcx, y: pcy, at: now };
  }

  const toP = norm(pcx - mcx, pcy - mcy);
  const dist = len(pcx - mcx, pcy - mcy);

  // choose a target for pathing: current player if seen, else last seen briefly, else patrol
  let target = null;
  if (sees) target = { x: pcx, y: pcy };
  else if (now - monster.lastSeen.at < 2500) target = { x: monster.lastSeen.x, y: monster.lastSeen.y };

  if (target) {
    // recompute path periodically or if target cell changed
    const tc = pointToCell(target.x, target.y);
    const shouldRepath = now >= monster.nextPathAt || monster.lastTargetKey !== tc.key;
    if (shouldRepath) {
      // Try for a direct move if no wall blocks line segment (cheap win)
      const direct = hasLineOfSight(mcx, mcy, target.x, target.y);
      if (direct) {
        monster.path = [{ x: target.x, y: target.y }];
        monster.pathIdx = 0;
        monster.lastTargetKey = tc.key;
      } else {
        buildPathTo(target.x, target.y);
      }
      monster.nextPathAt = now + 220; // repath ~4-5 times/sec
    }

    // keep a little distance so the cone breath matters
    const desired = sees ? 105 : 0;
    if (sees && dist < 70) {
      // back up slightly if too close
      moveEntity(monster, -toP.x * (monster.speedChase * 0.55), -toP.y * (monster.speedChase * 0.55), dt);
    } else if (!sees || dist > desired) {
      // follow path (or fallback to naive chase if path fails)
      const ok = followPath(dt, sees ? monster.speedChase : monster.speedChase * 0.9);
      if (!ok) {
        moveEntity(monster, toP.x * monster.speedChase, toP.y * monster.speedChase, dt);
      }
    }

    // flame breath only when sees
    if (sees) {
      if (now - monster.lastBreathAt >= monster.breathCooldownMs) {
        monster.lastBreathAt = now;
        monster.breathActiveUntil = now + monster.breathDurationMs;
      }
      if (now < monster.breathActiveUntil) {
        emitConeFlames(mcx, mcy, toP.x, toP.y, now);
      }
    }
  } else {
    // patrol
    if (now > monster.wander.until) pickWanderTarget(now);

    const v = norm(monster.wander.x - mcx, monster.wander.y - mcy);

    // path to wander too, so it doesn't dumb-bump walls
    const tc = pointToCell(monster.wander.x, monster.wander.y);
    const shouldRepath = now >= monster.nextPathAt || monster.lastTargetKey !== tc.key;
    if (shouldRepath) {
      const direct = hasLineOfSight(mcx, mcy, monster.wander.x, monster.wander.y);
      if (direct) {
        monster.path = [{ x: monster.wander.x, y: monster.wander.y }];
        monster.pathIdx = 0;
        monster.lastTargetKey = tc.key;
      } else {
        buildPathTo(monster.wander.x, monster.wander.y);
      }
      monster.nextPathAt = now + 350;
    }

    const ok = followPath(dt, monster.speedPatrol);
    if (!ok) moveEntity(monster, v.x * monster.speedPatrol, v.y * monster.speedPatrol, dt);
  }

  if (intersectsAABB(player, monster)) {
    state = 'lost';
    statusEl.textContent = 'mauled (press R)';
  }
}

// --- rendering ---

function drawStickFigure() {
  const x = player.x;
  const y = player.y;
  const cx = x + player.w / 2;
  const top = y + 2;
  const headR = 5;

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#e9ecff';

  ctx.beginPath();
  ctx.arc(cx, top + headR, headR, 0, Math.PI * 2);
  ctx.stroke();

  const neckY = top + headR * 2 + 1;
  const hipY = y + player.h - 6;
  ctx.beginPath();
  ctx.moveTo(cx, neckY);
  ctx.lineTo(cx, hipY);
  ctx.stroke();

  const armY = neckY + 7;
  ctx.beginPath();
  ctx.moveTo(cx - 7, armY);
  ctx.lineTo(cx + 7, armY);
  ctx.stroke();

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

  ctx.fillStyle = '#ff4d4d';
  ctx.beginPath();
  ctx.ellipse(cx - 2, cy + 2, 14, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(cx + 14, cy - 3, 7, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.moveTo(cx + 19, cy - 9);
  ctx.lineTo(cx + 27, cy - 6);
  ctx.lineTo(cx + 19, cy - 4);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(255,77,77,0.78)';
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy - 2);
  ctx.lineTo(cx - 22, cy - 18);
  ctx.lineTo(cx - 16, cy + 5);
  ctx.closePath();
  ctx.fill();

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

  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x, y, barW, barH);
  ctx.fillStyle = 'rgba(90,200,255,0.9)';
  ctx.fillRect(x, y, barW * staminaPct, barH);
  ctx.fillStyle = 'rgba(233,236,255,0.85)';
  ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
  ctx.fillText('Sprint (Shift)', x, y + 22);

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

  drawFlames(now);

  drawStickFigure();
  drawShield(now);
  drawDragon();
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
  monster.path = [];
  monster.pathIdx = 0;
  monster.nextPathAt = 0;
  monster.lastTargetKey = null;
  monster.lastSeen = { x: W / 2, y: H / 2, at: 0 };

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
