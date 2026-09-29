// Tron: Legacy. Light cycles in the arcade: you against the machines.
//
// The rules are not here. They live in tron-rules.js, because the staked match on the
// server runs the same race and a rule with two copies is two rules. What this file owns
// is the cabinet: the clock that turns rules into motion, the keys and the swipes, the
// bots that fill the other seats, the score, and the look — black, a faint grid, and
// every trail a bright core inside a wide glow.
//
// A round is you and one machine. Outlive it and the next round seats two, then three,
// and the tick keeps shortening. Crash, and the game is over: the score is the ticks you
// survived and the riders you outlived, and no round is ever replayed.
//
// Same contract as every cabinet: start(canvas, callbacks) returns { stop, score, debug },
// the module exports meta, sound is a callback so the headless tests need no audio engine,
// and every random number — the bots' — comes from a seeded generator, so a run with no
// input is the same run every time.

import * as R from './tron-rules.js';

const CELL = 8;
const W = R.COLS * CELL;
const H = R.ROWS * CELL;

const TICK_S = 0.08;             // the first round's tick
const TICK_MIN_S = 0.042;
const READY_S = 1.2;             // a beat before each round, so you know where you are
const AFTER_S = 1.4;             // and one after it, so a crash is seen
const MAX_BOTS = 3;

const KEYS = {
  ArrowUp: 'n', KeyW: 'n', ArrowRight: 'e', KeyD: 'e',
  ArrowDown: 's', KeyS: 's', ArrowLeft: 'w', KeyA: 'w',
};

export function start(canvas, { onScore, onEnd, onBall, seed, sound } = {}) {
  const say = (name) => { if (sound) sound(name); };
  const ctx = canvas.getContext('2d');
  canvas.width = W;
  canvas.height = H;

  const random = R.rng(seed ?? (Date.now() & 0xffffffff));
  const stillness = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let round = 0;
  let sim = null;
  let score = 0;
  let running = true;
  let ended = false;
  let phase = 'ready';           // 'ready' (the countdown), 'riding', 'after' (the pause)
  let wait = 0;                  // seconds left in the countdown or the pause
  let acc = 0;                   // time owed to the next tick
  let message = '';
  let messageFor = 0;
  let flash = 0;
  const bursts = [];             // { x, y, colour, t }

  const award = (points) => {
    score = Math.max(0, score + points);
    if (onScore) onScore(score);
  };

  /** How long a tick is right now: shorter each round, and shorter as the round runs. */
  const tickS = () => Math.max(TICK_MIN_S, TICK_S - (round - 1) * 0.008 - sim.tick * 0.00003);

  function nextRound() {
    round += 1;
    sim = R.create(1 + Math.min(MAX_BOTS, round));
    phase = 'ready';
    wait = READY_S;
    acc = 0;
    message = `Round ${round}`;
    messageFor = READY_S;
    if (onBall) onBall(sim.alive);
    say('wave');
  }

  function finish() {
    if (ended) return;
    ended = true;
    running = false;
    if (onEnd) onEnd(score);
  }

  function burst(r) {
    bursts.push({ x: (r.x + 0.5) * CELL, y: (r.y + 0.5) * CELL, colour: R.COLOURS[r.seat], t: 0 });
    if (!stillness) flash = 0.12;
    say('boom');
  }

  /** One tick of the race: the machines choose, everyone moves, the fallen are counted. */
  function tick() {
    for (let s = 1; s < sim.n; s += 1) {
      const h = R.botHeading(sim, s, random, 4 + round);
      if (h) R.setHeading(sim, s, h);
    }
    const crashed = R.step(sim);
    const me = sim.riders[0];
    if (me.alive) award(10);
    for (const seat of crashed) {
      burst(sim.riders[seat]);
      if (seat !== 0 && me.alive) award(500 * round);
    }
    if (onBall && crashed.length) onBall(sim.alive);

    if (!me.alive) {
      message = 'Derezzed';
      messageFor = 2;
      // The round holds for a moment so the crash is seen, then the game is over.
      phase = 'after';
      wait = AFTER_S;
      return;
    }
    if (sim.over) {
      award(2000 * round);
      message = 'Round clear';
      messageFor = AFTER_S;
      phase = 'after';
      wait = AFTER_S;
    }
  }

  function step(dt) {
    if (messageFor > 0) messageFor -= dt;
    if (flash > 0) flash -= dt;
    for (let i = bursts.length - 1; i >= 0; i -= 1) {
      bursts[i].t += dt;
      if (bursts[i].t > 0.5) bursts.splice(i, 1);
    }
    if (phase === 'ready') {
      wait -= dt;
      if (wait <= 0) { phase = 'riding'; acc = 0; }
      return;
    }
    if (phase === 'after') {
      wait -= dt;
      if (wait <= 0) {
        if (!sim.riders[0].alive) finish();
        else nextRound();
      }
      return;
    }
    acc += dt;
    while (acc >= tickS() && running && phase === 'riding') {
      acc -= tickS();
      tick();
    }
  }

  // ------------------------------------------------------------------- draw
  function strokeTrail(r, width, alpha) {
    ctx.strokeStyle = R.COLOURS[r.seat];
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.beginPath();
    r.path.forEach(([x, y], i) => {
      const px = (x + 0.5) * CELL;
      const py = (y + 0.5) * CELL;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  function draw() {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = flash > 0 ? '#16161c' : '#050508';
    ctx.fillRect(0, 0, W, H);

    // The grid, faint, every eight cells: the floor of the arena.
    ctx.strokeStyle = 'rgba(80,200,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += CELL * 8) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = 0; y <= H; y += CELL * 8) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();

    if (!sim) return;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    // The glow is additive, so where two trails cross it brightens rather than covers.
    ctx.globalCompositeOperation = 'lighter';
    for (const r of sim.riders) strokeTrail(r, CELL * 1.6, 0.22);
    ctx.globalCompositeOperation = 'source-over';
    for (const r of sim.riders) strokeTrail(r, CELL * 0.5, 1);
    ctx.globalAlpha = 1;

    // The heads: a bright square with a white heart, so the front of a trail is findable.
    for (const r of sim.riders) {
      if (!r.alive) continue;
      ctx.fillStyle = R.COLOURS[r.seat];
      ctx.fillRect(r.x * CELL, r.y * CELL, CELL, CELL);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(r.x * CELL + 2, r.y * CELL + 2, CELL - 4, CELL - 4);
    }

    // A crash: a ring of the rider's colour that opens and fades.
    for (const b of bursts) {
      const k = b.t / 0.5;
      ctx.strokeStyle = b.colour;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 6 + k * 40, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = b.colour;
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        ctx.fillRect(b.x + Math.cos(a) * k * 52 - 2, b.y + Math.sin(a) * k * 52 - 2, 4, 4);
      }
      ctx.globalAlpha = 1;
    }

    if (messageFor > 0) {
      ctx.fillStyle = '#e8f6ff';
      ctx.font = 'bold 28px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(message, W / 2, H / 2 - 40);
    }
    ctx.fillStyle = 'rgba(232,246,255,0.7)';
    ctx.font = '14px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(String(score).padStart(6, '0'), 10, 20);
    ctx.textAlign = 'right';
    ctx.fillText(`R${round}`, W - 10, 20);
  }

  // ------------------------------------------------------------------ input
  const keyDown = (e) => {
    const h = KEYS[e.code];
    if (!h) return;
    e.preventDefault();
    if (e.repeat || !sim) return;
    R.setHeading(sim, 0, h);
  };
  window.addEventListener('keydown', keyDown);

  // A swipe on the arena, in the direction you want to go. A tap does nothing: on a
  // phone the thumb is on the arena the whole time, and a tap that turned would be a
  // turn you did not mean.
  let swipe = null;
  const pointerDown = (e) => {
    e.preventDefault();
    swipe = { x: e.clientX, y: e.clientY };
  };
  const pointerMove = (e) => {
    if (!swipe || !sim) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
    const h = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
    R.setHeading(sim, 0, h);
    swipe = null;
  };
  const pointerOff = () => { swipe = null; };
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerOff);
  canvas.addEventListener('pointercancel', pointerOff);

  nextRound();

  // ------------------------------------------------------------------- loop
  let last = performance.now();
  let raf = 0;
  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    step(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', keyDown);
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerOff);
      canvas.removeEventListener('pointercancel', pointerOff);
    },
    get score() { return score; },
    /** Exposed so a test can watch the race without reading pixels. */
    get debug() {
      return {
        score, round, running, phase, wait: Math.round(wait * 100) / 100,
        tick: sim ? sim.tick : 0,
        alive: sim ? sim.alive : 0,
        over: sim ? sim.over : false,
        riders: sim ? sim.riders.map((r) => ({ x: r.x, y: r.y, h: r.h, alive: r.alive })) : [],
      };
    },
  };
}

export const meta = {
  key: 'tron',
  width: W,
  height: H,
  hud: 'arc.g.tron.hud',
  controls: 'Arrow keys or W A S D to turn. On a phone, swipe the way you want to go.',
};
