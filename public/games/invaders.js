// Void Raiders.
//
// Rows of raiders step sideways, drop when they touch an edge, and come down until they
// reach you. You have a ship, three lives, and one shot in the air at a time. Clear a wave
// and the next one starts lower and faster.
//
// The one-shot-at-a-time rule is not a limitation left over from 1978, it is the game.
// Being allowed to hold the fire button turns the whole thing into a hosepipe and there is
// nothing left to decide. Everything else here is in service of that: the raiders speed up
// as they thin out, so the last one is the hardest, which is the shape the original had
// and the reason it still works.
//
// The raiders' fire uses a seeded generator rather than Math.random, so a run is
// reproducible. That is what lets the tests assert anything at all about a game with
// shooting in it.

const W = 400;
const H = 640;

const COLS = 7;
const ROWS = 5;
const RAIDER_W = 26;
const RAIDER_H = 18;
const GAP_X = 14;
const GAP_Y = 12;

const SHIP_W = 30;
const SHIP_H = 14;
const SHIP_Y = H - 46;
const SHIP_SPEED = 260;

const SHOT_SPEED = 620;
const BOMB_SPEED = 210;
const LIVES = 3;

const ROW_POINTS = [150, 120, 90, 60, 50];

/** A small deterministic generator. Good enough to drop bombs with, and repeatable. */
function rng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

export function start(canvas, { onScore, onEnd, onBall, seed, sound } = {}) {
  // A callback rather than an import: the cabinet stays free of the audio engine, and the
  // headless tests do not have to stub one.
  const say = (name) => { if (sound) sound(name); };
  const ctx = canvas.getContext('2d');
  canvas.width = W;
  canvas.height = H;

  const random = rng(seed ?? (Date.now() & 0xffffffff));

  let score = 0;
  let lives = LIVES;
  let wave = 1;
  let running = true;
  let message = 'Wave 1';
  let messageFor = 1.6;

  let shipX = W / 2;
  let left = false;
  let right = false;
  let firing = false;

  let shot = null;                 // one at a time, on purpose
  const bombs = [];
  let raiders = [];
  let dir = 1;
  let dropPending = false;
  let bombTimer = 0;

  function buildWave() {
    raiders = [];
    const startY = 70 + Math.min(wave - 1, 4) * 16;
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        raiders.push({
          x: 40 + col * (RAIDER_W + GAP_X),
          y: startY + row * (RAIDER_H + GAP_Y),
          row,
          alive: true,
        });
      }
    }
    dir = 1;
    dropPending = false;
  }
  buildWave();

  const alive = () => raiders.filter((r) => r.alive);

  /**
   * How fast the formation moves.
   * It rises as the raiders thin out, so the last one is the fastest thing on screen.
   */
  function formationSpeed() {
    const left = alive().length;
    const total = ROWS * COLS;
    const thinned = 1 + (1 - left / total) * 3.2;
    return 26 * thinned * (1 + (wave - 1) * 0.22);
  }

  function award(points) {
    score += points;
    if (onScore) onScore(score);
  }

  function loseLife() {
    lives -= 1;
    say('lose');
    if (onBall) onBall(lives);
    shot = null;
    bombs.length = 0;
    shipX = W / 2;
    if (lives <= 0) {
      running = false;
      if (onEnd) onEnd(score);
      return;
    }
    message = `${lives} left`;
    messageFor = 1.2;
  }

  const hit = (ax, ay, aw, ah, bx, by, bw, bh) => ax < bx + bw && ax + aw > bx
    && ay < by + bh && ay + ah > by;

  // ------------------------------------------------------------------ step
  function step(dt) {
    if (!running) return;
    if (messageFor > 0) messageFor -= dt;

    // --- the ship
    if (left) shipX -= SHIP_SPEED * dt;
    if (right) shipX += SHIP_SPEED * dt;
    shipX = Math.max(SHIP_W / 2, Math.min(W - SHIP_W / 2, shipX));
    if (firing && !shot) { shot = { x: shipX, y: SHIP_Y }; say('laser'); }

    // --- our shot
    if (shot) {
      shot.y -= SHOT_SPEED * dt;
      if (shot.y < -10) shot = null;
    }

    // --- the formation
    const speed = formationSpeed();
    let edge = false;
    for (const r of alive()) {
      r.x += dir * speed * dt;
      if (r.x < 8 || r.x + RAIDER_W > W - 8) edge = true;
    }
    if (edge && !dropPending) {
      dropPending = true;
      dir *= -1;
      for (const r of alive()) {
        r.y += 16;
        // Nudge back inside so a reversal cannot leave anyone stuck against the wall.
        r.x = Math.max(8, Math.min(W - 8 - RAIDER_W, r.x));
      }
    } else if (!edge) {
      dropPending = false;
    }

    // --- their bombs
    bombTimer -= dt;
    if (bombTimer <= 0 && alive().length) {
      bombTimer = Math.max(0.28, 1.5 - wave * 0.12) * (0.5 + random());
      // Only the lowest raider in a column can drop one; the rest are behind it.
      const columns = new Map();
      for (const r of alive()) {
        const col = Math.round(r.x / (RAIDER_W + GAP_X));
        const low = columns.get(col);
        if (!low || r.y > low.y) columns.set(col, r);
      }
      const shooters = [...columns.values()];
      if (shooters.length) {
        const from = shooters[Math.floor(random() * shooters.length)];
        bombs.push({ x: from.x + RAIDER_W / 2, y: from.y + RAIDER_H });
      }
    }
    for (const b of bombs) b.y += BOMB_SPEED * dt;
    for (let i = bombs.length - 1; i >= 0; i -= 1) if (bombs[i].y > H + 10) bombs.splice(i, 1);

    // --- collisions
    if (shot) {
      for (const r of alive()) {
        if (!hit(shot.x - 1.5, shot.y - 8, 3, 10, r.x, r.y, RAIDER_W, RAIDER_H)) continue;
        r.alive = false;
        shot = null;
        say('boom');
        award(ROW_POINTS[r.row] * wave);
        break;
      }
    }
    for (let i = bombs.length - 1; i >= 0; i -= 1) {
      const b = bombs[i];
      if (!hit(b.x - 2, b.y, 4, 9, shipX - SHIP_W / 2, SHIP_Y, SHIP_W, SHIP_H)) continue;
      bombs.splice(i, 1);
      loseLife();
      return;
    }

    // --- the raiders arriving is the end of it, whatever lives are left
    for (const r of alive()) {
      if (r.y + RAIDER_H < SHIP_Y) continue;
      lives = 0;
      running = false;
      if (onBall) onBall(0);
      if (onEnd) onEnd(score);
      return;
    }

    // --- the wave
    if (alive().length === 0) {
      wave += 1;
      say('wave');
      award(500 * wave);
      message = `Wave ${wave}`;
      messageFor = 1.6;
      shot = null;
      bombs.length = 0;
      buildWave();
    }
  }

  // ----------------------------------------------------------------- render
  function draw() {
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, W, H);

    // A few fixed stars. Deliberately not animated: a moving starfield behind a game
    // about tiny sprites makes the sprites harder to see.
    ctx.fillStyle = 'rgba(180,200,235,.25)';
    for (let i = 0; i < 40; i += 1) {
      const x = (i * 97) % W;
      const y = (i * 163) % H;
      ctx.fillRect(x, y, 1.5, 1.5);
    }

    ctx.fillStyle = '#5fd6ff';
    for (const r of alive()) {
      const x = r.x;
      const y = r.y;
      ctx.fillRect(x + 6, y, RAIDER_W - 12, 4);
      ctx.fillRect(x + 2, y + 4, RAIDER_W - 4, 6);
      ctx.fillRect(x, y + 10, RAIDER_W, 4);
      ctx.fillRect(x + 3, y + 14, 5, 4);
      ctx.fillRect(x + RAIDER_W - 8, y + 14, 5, 4);
    }

    ctx.fillStyle = '#e8a83c';
    ctx.fillRect(shipX - SHIP_W / 2, SHIP_Y + 6, SHIP_W, SHIP_H - 6);
    ctx.fillRect(shipX - 4, SHIP_Y, 8, 8);

    if (shot) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(shot.x - 1.5, shot.y - 8, 3, 10);
    }
    ctx.fillStyle = '#ff6b6b';
    for (const b of bombs) ctx.fillRect(b.x - 2, b.y, 4, 9);

    ctx.fillStyle = '#e8edf6';
    ctx.font = '600 14px ui-monospace, monospace';
    ctx.fillText(String(score).padStart(6, '0'), 14, 22);
    ctx.fillText('^'.repeat(Math.max(0, lives)), W - 60, 22);

    if (messageFor > 0 && message) {
      ctx.fillStyle = '#ffd166';
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(message, W / 2, H / 2);
      ctx.textAlign = 'left';
    }
  }

  // ------------------------------------------------------------------ input
  const onKey = (e, down) => {
    if (e.repeat) return;
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') { left = down; e.preventDefault(); }
    if (e.code === 'ArrowRight' || e.code === 'KeyD') { right = down; e.preventDefault(); }
    if (e.code === 'Space' || e.code === 'ArrowUp') { firing = down; e.preventDefault(); }
  };
  const keyDown = (e) => onKey(e, true);
  const keyUp = (e) => onKey(e, false);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);

  // Touch: the left and right thirds steer, the middle fires.
  const pointer = (e, down) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (!down) { left = false; right = false; firing = false; return; }
    left = x < 0.33;
    right = x > 0.67;
    firing = !left && !right;
  };
  const pDown = (e) => pointer(e, true);
  const pUp = (e) => pointer(e, false);
  canvas.addEventListener('pointerdown', pDown);
  canvas.addEventListener('pointerup', pUp);
  canvas.addEventListener('pointercancel', pUp);

  // ------------------------------------------------------------------- loop
  const SUBSTEPS = 2;
  let last = performance.now();
  let raf = 0;
  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    for (let i = 0; i < SUBSTEPS && running; i += 1) step(dt / SUBSTEPS);
    draw();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      canvas.removeEventListener('pointerdown', pDown);
      canvas.removeEventListener('pointerup', pUp);
      canvas.removeEventListener('pointercancel', pUp);
    },
    get score() { return score; },
    get debug() {
      const low = alive().reduce((m, r) => Math.max(m, r.y), 0);
      return {
        score, lives, wave, running,
        raiders: alive().length,
        lowest: Math.round(low),
        ship: Math.round(shipX),
        shot: shot ? { x: Math.round(shot.x), y: Math.round(shot.y) } : null,
        bombs: bombs.length,
      };
    },
  };
}

export const meta = {
  key: 'invaders',
  width: W,
  height: H,
  controls: 'Arrow keys or A / D to move, SPACE to fire. On a phone, tap the sides to move and the middle to shoot.',
};
