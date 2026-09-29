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
//
// PICTURES, BONUSES, EVENTS. The raiders, the bursts and the backdrop can come from a
// seeded pack the RTX drew at build time (tools/generate-invaders.js). The pack is optional
// by construction: the headless harness has no Image, a fresh checkout may have no pack,
// and in both cases the rectangles below are what draws. Bonuses drop from kills and one
// event fires per wave; both are rolled from the same seeded generator as the bombs, so a
// play's whole schedule is reproducible from its seed. That is not a nicety: it is what
// keeps the same-seed test green, and what a chain record can pin.

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

/**
 * Where the pack lives and how its atlas is laid out. tools/generate-invaders.js writes
 * exactly this layout; the game hard-codes it rather than fetching the manifest, so a
 * cabinet never has a network request in it.
 */
const PACK_URL = '/textures/invaders/';
const ATLAS = { alien: 64, species: 3, walk: 2, burst: 96, burstFrames: 8, burstY: 64 };
const BURST_FRAME_S = 0.06;
const WALK_S = 0.45;

/** Bonuses: how long each lasts, in seconds. A shield and a life are one-shot. */
const BONUS_S = { rapid: 8, wide: 6, slow: 5 };
const DROP_CHANCE = 0.08;
const DROP_SPEED = 110;
const EVENT_KINDS = ['saucer', 'meteors', 'blackout', 'shuffle'];

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

export function start(canvas, { onScore, onEnd, onBall, seed, sound, pack: usePack = true } = {}) {
  // A callback rather than an import: the cabinet stays free of the audio engine, and the
  // headless tests do not have to stub one.
  const say = (name) => { if (sound) sound(name); };
  const ctx = canvas.getContext('2d');
  canvas.width = W;
  canvas.height = H;

  const random = rng(seed ?? (Date.now() & 0xffffffff));

  // The pictures, if this browser has them. Guarded twice: the headless harness has no
  // Image, and a checkout may have no pack. Either way the rectangles stay as the
  // fallback and the tests run exactly as they always did.
  const pack = { atlas: null, back: null, ready: false };
  if (usePack && typeof Image !== 'undefined') {
    let arrived = 0;
    const one = () => { arrived += 1; if (arrived === 2) pack.ready = true; };
    pack.atlas = new Image();
    pack.back = new Image();
    pack.atlas.onload = one;
    pack.back.onload = one;
    pack.atlas.src = `${PACK_URL}atlas.png`;
    pack.back.src = `${PACK_URL}backdrop.jpg`;
  }

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

  // One at a time, on purpose, until a rapid-fire bonus says three. A list, so the bonus
  // is a number and not a second code path.
  const shots = [];
  const maxShots = () => (bonus.rapid > 0 ? 3 : 1);
  const bombs = [];
  let raiders = [];
  let dir = 1;
  let dropPending = false;
  let bombTimer = 0;

  const bonus = { rapid: 0, wide: 0, slow: 0, shield: false };
  const drops = [];
  const bursts = [];
  const meteors = [];
  let saucer = null;
  let event = null;
  let dropsSeen = 0;
  let walkT = 0;
  let walkFrame = 0;
  let bgScroll = 0;
  let meteorTimer = 0;

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
    // One event a wave, at a moment the seed decides, of a kind the seed decides.
    event = {
      kind: EVENT_KINDS[Math.floor(random() * EVENT_KINDS.length)],
      at: 2 + random() * 6, t: 0, fired: false, active: 0,
    };
    meteors.length = 0;
    saucer = null;
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
    return 26 * thinned * (1 + (wave - 1) * 0.22) * (bonus.slow > 0 ? 0.5 : 1);
  }

  function award(points) {
    score += points;
    if (onScore) onScore(score);
  }

  function loseLife() {
    lives -= 1;
    say('lose');
    if (onBall) onBall(lives);
    shots.length = 0;
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

  /**
   * A bonus lands. Also the test harness's door: a falling drop cannot be steered under
   * in a headless test, so the effect is granted directly and the effect is what is tested.
   */
  function grant(kind) {
    if (kind === 'life') {
      lives += 1;
      if (onBall) onBall(lives);
      message = 'Extra life';
    } else if (kind === 'shield') {
      bonus.shield = true;
      message = 'Shield';
    } else {
      bonus[kind] = BONUS_S[kind];
      message = { rapid: 'Rapid fire', wide: 'Wide shot', slow: 'Slow time' }[kind];
    }
    messageFor = 1.2;
    say('wave');
  }

  /** A hit that a shield takes instead of a life. */
  function absorbed() {
    if (!bonus.shield) return false;
    bonus.shield = false;
    say('boom');
    message = 'Shield gone';
    messageFor = 1;
    return true;
  }

  function fireEvent() {
    event.fired = true;
    message = { saucer: 'Saucer!', meteors: 'Meteors!', blackout: 'Blackout!', shuffle: 'Shuffle!' }[event.kind];
    messageFor = 1.4;
    if (event.kind === 'saucer') saucer = { x: -30 };
    if (event.kind === 'meteors') event.active = 4;
    if (event.kind === 'blackout') event.active = 3;
    if (event.kind === 'shuffle') {
      // Each row's raiders swap columns among themselves: the formation keeps its shape
      // and loses its predictability.
      for (let row = 0; row < ROWS; row += 1) {
        const rowRaiders = alive().filter((r) => r.row === row);
        const xs = rowRaiders.map((r) => r.x);
        for (let i = xs.length - 1; i > 0; i -= 1) {
          const j = Math.floor(random() * (i + 1));
          [xs[i], xs[j]] = [xs[j], xs[i]];
        }
        rowRaiders.forEach((r, i) => { r.x = xs[i]; });
      }
    }
  }

  function stepEvent(dt) {
    if (!event) return;
    event.t += dt;
    if (!event.fired && event.t >= event.at) fireEvent();
    if (event.active > 0) event.active = Math.max(0, event.active - dt);
    if (saucer) {
      saucer.x += 120 * dt;
      if (saucer.x > W + 30) saucer = null;
    }
    if (event.kind === 'meteors' && event.active > 0) {
      meteorTimer -= dt;
      if (meteorTimer <= 0) {
        meteorTimer = 0.5;
        meteors.push({ x: 20 + random() * (W - 40), y: -10 });
      }
    }
    for (let i = meteors.length - 1; i >= 0; i -= 1) {
      const m = meteors[i];
      m.y += 260 * dt;
      if (m.y > H + 10) { meteors.splice(i, 1); continue; }
      if (hit(m.x - 6, m.y - 6, 12, 12, shipX - SHIP_W / 2, SHIP_Y, SHIP_W, SHIP_H)) {
        meteors.splice(i, 1);
        if (!absorbed()) { loseLife(); return; }
      }
    }
  }

  // ------------------------------------------------------------------ step
  function step(dt) {
    if (!running) return;
    if (messageFor > 0) messageFor -= dt;

    // --- the ship
    if (left) shipX -= SHIP_SPEED * dt;
    if (right) shipX += SHIP_SPEED * dt;
    shipX = Math.max(SHIP_W / 2, Math.min(W - SHIP_W / 2, shipX));
    if (firing && shots.length < maxShots()) {
      // Wide shot: three at once, the outer two splayed.
      if (bonus.wide > 0) for (const vx of [-160, 0, 160]) shots.push({ x: shipX, y: SHIP_Y, vx });
      else shots.push({ x: shipX, y: SHIP_Y, vx: 0 });
      say('laser');
    }

    // --- our shots
    for (let i = shots.length - 1; i >= 0; i -= 1) {
      const sh = shots[i];
      sh.y -= SHOT_SPEED * dt;
      sh.x += sh.vx * dt;
      if (sh.y < -10 || sh.x < -10 || sh.x > W + 10) shots.splice(i, 1);
    }

    // --- the bonus clocks, the drops, the bursts, the walk, and the wave's event
    for (const k of Object.keys(BONUS_S)) if (bonus[k] > 0) bonus[k] = Math.max(0, bonus[k] - dt);
    for (let i = drops.length - 1; i >= 0; i -= 1) {
      const d = drops[i];
      d.y += DROP_SPEED * dt;
      if (hit(d.x - 7, d.y - 7, 14, 14, shipX - SHIP_W / 2, SHIP_Y, SHIP_W, SHIP_H)) {
        grant(d.kind);
        drops.splice(i, 1);
      } else if (d.y > H + 10) {
        drops.splice(i, 1);
      }
    }
    for (let i = bursts.length - 1; i >= 0; i -= 1) {
      bursts[i].t += dt;
      if (bursts[i].t > BURST_FRAME_S * ATLAS.burstFrames) bursts.splice(i, 1);
    }
    walkT += dt;
    if (walkT >= WALK_S) { walkT -= WALK_S; walkFrame = 1 - walkFrame; }
    bgScroll = (bgScroll + 6 * dt) % W;
    stepEvent(dt);
    if (!running) return;

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
      bombTimer = Math.max(0.28, 1.5 - wave * 0.12) * (0.5 + random()) * (bonus.slow > 0 ? 2 : 1);
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
    for (let i = shots.length - 1; i >= 0; i -= 1) {
      const sh = shots[i];
      let used = false;
      for (const r of alive()) {
        if (!hit(sh.x - 1.5, sh.y - 8, 3, 10, r.x, r.y, RAIDER_W, RAIDER_H)) continue;
        r.alive = false;
        used = true;
        say('boom');
        award(ROW_POINTS[r.row] * wave);
        bursts.push({ x: r.x + RAIDER_W / 2, y: r.y + RAIDER_H / 2, t: 0 });
        // A kill can drop a bonus. Rolled from the seeded generator, like the bombs, so
        // the same seed drops the same bonuses from the same kills.
        if (random() < DROP_CHANCE) {
          const roll = random();
          const kind = roll < 0.30 ? 'rapid' : roll < 0.55 ? 'shield' : roll < 0.75 ? 'wide' : roll < 0.95 ? 'slow' : 'life';
          drops.push({ x: r.x + RAIDER_W / 2, y: r.y + RAIDER_H, kind });
          dropsSeen += 1;
        }
        break;
      }
      if (!used && saucer && hit(sh.x - 1.5, sh.y - 8, 3, 10, saucer.x, 40, 26, 10)) {
        used = true;
        say('boom');
        award(300 * wave);
        bursts.push({ x: saucer.x + 13, y: 45, t: 0 });
        saucer = null;
      }
      if (used) shots.splice(i, 1);
    }
    for (let i = bombs.length - 1; i >= 0; i -= 1) {
      const b = bombs[i];
      if (!hit(b.x - 2, b.y, 4, 9, shipX - SHIP_W / 2, SHIP_Y, SHIP_W, SHIP_H)) continue;
      bombs.splice(i, 1);
      if (absorbed()) continue;
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
      shots.length = 0;
      bombs.length = 0;
      buildWave();
    }
  }

  // ----------------------------------------------------------------- render
  function draw() {
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, W, H);

    const dark = event && event.kind === 'blackout' && event.active > 0;
    if (pack.ready) {
      // The nebula, scrolling slowly and tiled down the screen at the canvas width. It is
      // kept dim so the sprites stay the brightest things on it.
      ctx.globalAlpha = dark ? 0.25 : 0.9;
      for (let y = -bgScroll; y < H; y += W) ctx.drawImage(pack.back, 0, y, W, W);
      ctx.globalAlpha = 1;
    } else {
      // A few fixed stars. Deliberately not animated: a moving starfield behind a game
      // about tiny sprites makes the sprites harder to see.
      ctx.fillStyle = 'rgba(180,200,235,.25)';
      for (let i = 0; i < 40; i += 1) {
        const x = (i * 97) % W;
        const y = (i * 163) % H;
        ctx.fillRect(x, y, 1.5, 1.5);
      }
    }

    // In a blackout the raiders are barely there; the player fires at memory.
    if (dark) ctx.globalAlpha = 0.15;
    if (pack.ready) {
      const a = ATLAS.alien;
      for (const r of alive()) {
        const sx = ((r.row % ATLAS.species) * ATLAS.walk + walkFrame) * a;
        ctx.drawImage(pack.atlas, sx, 0, a, a, r.x + RAIDER_W / 2 - 16, r.y + RAIDER_H / 2 - 16, 32, 32);
      }
    } else {
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
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#e8a83c';
    ctx.fillRect(shipX - SHIP_W / 2, SHIP_Y + 6, SHIP_W, SHIP_H - 6);
    ctx.fillRect(shipX - 4, SHIP_Y, 8, 8);

    ctx.fillStyle = '#ffffff';
    for (const sh of shots) ctx.fillRect(sh.x - 1.5, sh.y - 8, 3, 10);
    ctx.fillStyle = '#ff6b6b';
    for (const b of bombs) ctx.fillRect(b.x - 2, b.y, 4, 9);

    if (pack.ready) {
      const b = ATLAS.burst;
      for (const x of bursts) {
        const f = Math.min(ATLAS.burstFrames - 1, Math.floor(x.t / BURST_FRAME_S));
        ctx.drawImage(pack.atlas, f * b, ATLAS.burstY, b, b, x.x - 24, x.y - 24, 48, 48);
      }
    }
    for (const d of drops) {
      ctx.fillStyle = { rapid: '#ffd166', shield: '#5fd6ff', wide: '#c77dff', slow: '#8de08d', life: '#ff6b6b' }[d.kind];
      ctx.fillRect(d.x - 7, d.y - 7, 14, 14);
      ctx.fillStyle = '#05070c';
      ctx.font = '700 10px ui-monospace, monospace';
      ctx.fillText(d.kind[0].toUpperCase(), d.x - 3, d.y + 4);
    }
    if (saucer) {
      ctx.fillStyle = '#ff7bd5';
      ctx.fillRect(saucer.x, 40, 26, 10);
    }
    ctx.fillStyle = '#9aa3ad';
    for (const m of meteors) ctx.fillRect(m.x - 6, m.y - 6, 12, 12);

    ctx.fillStyle = '#e8edf6';
    ctx.font = '600 14px ui-monospace, monospace';
    ctx.fillText(String(score).padStart(6, '0'), 14, 22);
    ctx.fillText('^'.repeat(Math.max(0, lives)), W - 60, 22);
    const inPlay = ['rapid', 'wide', 'slow'].filter((k) => bonus[k] > 0).map((k) => k[0].toUpperCase());
    if (bonus.shield) inPlay.push('S');
    if (inPlay.length) ctx.fillText(inPlay.join(' '), W - 60, 40);

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
        shot: shots[0] ? { x: Math.round(shots[0].x), y: Math.round(shots[0].y) } : null,
        shots: shots.length,
        bombs: bombs.length,
        bonus: { ...bonus },
        drops: drops.length,
        dropsSeen,
        bursts: bursts.length,
        event: event ? { kind: event.kind, fired: event.fired, active: Math.round(event.active * 10) / 10 } : null,
        saucer: !!saucer,
        meteors: meteors.length,
        pack: pack.ready,
      };
    },
    /** For the test harness: a bonus lands without a drop to catch. */
    grant(kind) { grant(kind); },
  };
}

export const meta = {
  key: 'invaders',
  width: W,
  height: H,
  hud: 'arc.g.invaders.hud',
  /** Where the pictures come from, so a test can hold the layout against the pack. */
  pack: { url: PACK_URL, atlas: ATLAS },
  controls: 'Arrow keys or A / D to move, SPACE to fire. On a phone, tap the sides to move and the middle to shoot.',
};
