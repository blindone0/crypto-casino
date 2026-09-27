'use strict';
// Orbit Pinball, driven headlessly.
//
// The table is browser code, so this stands up just enough of a DOM to run it: a canvas
// whose 2D context swallows every drawing call, a virtual clock, and a requestAnimationFrame
// that only advances when this file says so. The physics are a pure function of the timestep,
// so a fixed-step run here is deterministic and these assertions cannot flake.
//
// Both launch bugs this catches were real and both made the cabinet unplayable:
//   - the plunger's full power was below escape velocity for the launch lane, so the ball
//     could never reach the playfield at all;
//   - the plunger only charged on animation frames, so pressing and releasing the key
//     inside one frame did nothing, which is exactly what a quick tap is.

const test = require('node:test');
const assert = require('node:assert');

/** A 2D context that accepts everything and draws nothing. */
function stubContext() {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
        return () => gradient;
      }
      if (prop === 'measureText') return () => ({ width: 0 });
      if (!(prop in target)) target[prop] = () => {};
      return typeof target[prop] === 'function' ? target[prop] : target[prop];
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

/**
 * Install the globals the table expects and hand back a driver.
 * `advance(ms)` runs whole frames; nothing moves unless it is called.
 */
function harness() {
  const listeners = { window: {}, canvas: {} };
  const addTo = (bag) => (type, fn) => { (bag[type] ||= []).push(fn); };
  const removeFrom = (bag) => (type, fn) => {
    bag[type] = (bag[type] || []).filter((f) => f !== fn);
  };

  let clock = 0;
  let pending = null;

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => stubContext(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 640 }),
    addEventListener: addTo(listeners.canvas),
    removeEventListener: removeFrom(listeners.canvas),
    focus() {},
  };

  const saved = {
    window: global.window,
    performance: global.performance,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
  };

  global.window = {
    addEventListener: addTo(listeners.window),
    removeEventListener: removeFrom(listeners.window),
  };
  global.performance = { now: () => clock };
  global.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  global.cancelAnimationFrame = () => { pending = null; };

  const fire = (type, code) => {
    const event = { code, repeat: false, preventDefault() {} };
    for (const fn of listeners.window[type] || []) fn(event);
  };

  return {
    canvas,
    /** Run `frames` frames of `stepMs` each. Returns how many actually ran. */
    advance(frames, stepMs = 16) {
      let ran = 0;
      for (let i = 0; i < frames; i += 1) {
        const fn = pending;
        if (!fn) break;
        pending = null;
        clock += stepMs;
        fn(clock);
        ran += 1;
      }
      return ran;
    },
    keyDown: (code) => fire('keydown', code),
    keyUp: (code) => fire('keyup', code),
    restore() {
      global.window = saved.window;
      global.performance = saved.performance;
      global.requestAnimationFrame = saved.requestAnimationFrame;
      global.cancelAnimationFrame = saved.cancelAnimationFrame;
    },
  };
}

/** Start a table, run `body`, and always put the globals back. */
async function table(body) {
  const h = harness();
  const mod = await import('../public/games/pinball.js');
  const events = { ends: [], balls: [], scores: [] };
  const game = mod.start(h.canvas, {
    onScore: (s) => events.scores.push(s),
    onBall: (n) => events.balls.push(n),
    onEnd: (s) => events.ends.push(s),
  });
  // The loop asks for its first frame during start(); prime the clock past it.
  h.advance(1);
  try {
    await body({ h, game, events, meta: mod.meta });
  } finally {
    game.stop();
    h.restore();
  }
}

// The top of the launch lane. Clearing it is the whole point of the plunger.
const LANE_TOP = 168;

test('the table starts with the ball parked in the launch lane', () => table(async ({ game }) => {
  const s = game.debug;
  assert.strictEqual(s.inLane, true);
  assert.strictEqual(s.ballsLeft, 3);
  assert.strictEqual(s.score, 0);
  assert.strictEqual(s.x, 336);
  assert.ok(s.y > 500, `ball should sit low in the lane, got y=${s.y}`);
}));

test('the ball does not move until the player launches it', () => table(async ({ h, game }) => {
  const before = game.debug;
  h.advance(120);
  const after = game.debug;
  assert.strictEqual(after.inLane, true);
  assert.strictEqual(after.x, before.x);
  assert.strictEqual(after.y, before.y);
  assert.strictEqual(after.vy, 0);
}));

test('holding the plunger charges it', () => table(async ({ h, game }) => {
  h.keyDown('Space');
  h.advance(30);
  assert.ok(game.debug.plunger > 0, 'plunger should charge while SPACE is held');
  assert.strictEqual(game.debug.inLane, true, 'holding alone must not fire the ball');
}));

test('a full-power launch clears the lane and reaches the playfield', () => table(async ({ h, game }) => {
  h.keyDown('Space');
  h.advance(60); // ~1s of charge, well past the 60-unit cap
  assert.ok(game.debug.plunger >= 59, `expected a full plunger, got ${game.debug.plunger}`);
  h.keyUp('Space');
  h.advance(1);

  assert.strictEqual(game.debug.inLane, false, 'releasing the plunger must launch the ball');
  assert.ok(game.debug.vy < 0, 'the ball should be travelling up the lane');

  let highest = game.debug.y;
  for (let i = 0; i < 90; i += 1) {
    h.advance(1);
    highest = Math.min(highest, game.debug.y);
  }
  assert.ok(highest < LANE_TOP, `ball only reached y=${highest}; the lane top is ${LANE_TOP}`);
}));

test('a tap of the plunger also puts the ball in play', () => table(async ({ h, game }) => {
  // Press and release inside a single frame. This is what tapping the key looks like, and
  // it used to leave the ball sat in the lane with the plunger still at zero.
  h.keyDown('Space');
  h.keyUp('Space');
  h.advance(1);

  assert.strictEqual(game.debug.inLane, false, 'a tap must launch the ball');

  let highest = game.debug.y;
  for (let i = 0; i < 90; i += 1) {
    h.advance(1);
    highest = Math.min(highest, game.debug.y);
  }
  assert.ok(highest < LANE_TOP, `a tapped launch only reached y=${highest}`);
}));

test('the ball scores off the bumpers once it is on the playfield', () => table(async ({ h, game, events }) => {
  h.keyDown('Space');
  h.advance(60);
  h.keyUp('Space');
  h.advance(400);
  assert.ok(game.debug.score > 0, 'a launched ball should hit something worth points');
  assert.ok(events.scores.length > 0, 'onScore should have reported upward');
}));

test('the game stays numerically sane over a long run', () => table(async ({ h, game }) => {
  h.keyDown('Space');
  h.advance(60);
  h.keyUp('Space');
  for (let i = 0; i < 2000; i += 1) {
    h.advance(1);
    const s = game.debug;
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), `ball left the number line at frame ${i}`);
    assert.ok(Math.abs(s.x) < 5000 && s.y > -5000, `ball escaped the table at frame ${i}: ${s.x},${s.y}`);
    if (s.ballsLeft <= 0) break;
  }
}));

test('draining three balls ends the game exactly once', () => table(async ({ h, game, events }) => {
  // Launch each ball and let it drain. The flippers are never touched, so every ball dies.
  for (let ball = 0; ball < 4 && events.ends.length === 0; ball += 1) {
    h.keyDown('Space');
    h.advance(20);
    h.keyUp('Space');
    h.advance(1200);
  }
  assert.strictEqual(events.ends.length, 1, 'onEnd should fire once and only once');
  assert.strictEqual(events.balls.at(-1), 0, 'the last ball report should be zero');
  assert.ok(events.ends[0] >= 0, 'the final score should be reported');

  // Nothing should run after the game is over.
  const frozen = game.debug;
  h.advance(60);
  assert.deepStrictEqual(game.debug, frozen, 'the table should be still once the game ends');
}));

test('the flipper keys raise and drop the flippers', () => table(async ({ h, game }) => {
  h.keyDown('Space');
  h.keyUp('Space');
  h.advance(2);
  // Z and M are the alternates to the arrow keys; if they are wired, so are the arrows.
  for (const code of ['KeyZ', 'ArrowLeft', 'KeyM', 'ArrowRight']) {
    h.keyDown(code);
    h.advance(1);
    h.keyUp(code);
    h.advance(1);
  }
  // No assertion on geometry here; the point is that none of these throw and the table
  // keeps running, which is what a missing key binding would break.
  assert.strictEqual(game.debug.ballsLeft > 0, true);
}));

test('the cabinet declares the metadata the arcade shell needs', () => table(async ({ meta }) => {
  assert.strictEqual(meta.key, 'pinball');
  assert.ok(meta.width > 0 && meta.height > 0);
  assert.ok(typeof meta.controls === 'string' && meta.controls.length > 0);
}));
