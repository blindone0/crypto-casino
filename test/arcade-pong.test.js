'use strict';
// Pong, played headless.
//
// The same harness as the other cabinets: a fake window and canvas, and a clock that only
// moves when a test says so. The court is a pure function of the timestep, so one seed is
// one game, and a ball that leaves the court or a game that never ends is found here
// rather than on somebody's phone.

const test = require('node:test');
const assert = require('node:assert');
const { harness } = require('./cabinet-harness');

const MODULE = '../public/games/pong.js';

/** Start a court with a fixed seed, run `body`, and always put the globals back. */
async function cabinet(body, { seed = 4242 } = {}) {
  const h = harness({ width: 640, height: 400 });
  const mod = await import(MODULE);
  const events = { scores: [], balls: [], ends: [] };
  const game = mod.start(h.canvas, {
    onScore: (s) => events.scores.push(s),
    onBall: (n) => events.balls.push(n),
    onEnd: (s) => events.ends.push(s),
    seed,
  });
  // The loop asks for its first frame during start(); prime the clock past it.
  h.advance(1);
  try { await body({ h, game, events, meta: mod.meta }); }
  finally { game.stop(); h.restore(); }
}

test('the court starts level: no points, eleven to win, a serve pending', () => cabinet(async ({ game, events }) => {
  const d = game.debug;
  assert.strictEqual(d.player, 0);
  assert.strictEqual(d.bot, 0);
  assert.strictEqual(d.serving, true, 'the ball waits on the spot before the first serve');
  assert.deepStrictEqual(events.balls, [11], 'the HUD counts points to eleven, not balls');
}));

test('the ball never leaves the court', () => cabinet(async ({ h, game }) => {
  for (let i = 0; i < 2400; i += 1) {
    h.advance(1);
    const { x, y } = game.debug.ball;
    assert.ok(y >= 0 && y <= 400, `ball y=${y} left the court at frame ${i}`);
    // A point is scored a little past the wall; that is the only time x may be outside.
    assert.ok(x >= -40 && x <= 680, `ball x=${x} is nowhere near the court at frame ${i}`);
    if (!game.debug.running) break;
  }
}));

test('a paddle hit speeds the ball up, and the hit is counted', () => cabinet(async ({ h, game }) => {
  const serve = 260;
  h.until(() => game.debug.hits >= 1, 3000);
  assert.ok(game.debug.hits >= 1, 'somebody hit the ball within three thousand frames');
  assert.ok(game.debug.ball.speed > serve,
    `speed ${game.debug.ball.speed} after a hit, ${serve} at the serve`);
}));

test('holding the key moves the paddle, and the wall stops it', () => cabinet(async ({ h, game }) => {
  const start = game.debug.playerY;
  h.keyDown('ArrowUp');
  h.advance(30);
  assert.ok(game.debug.playerY < start, 'ArrowUp moves the paddle up');
  h.advance(600);
  assert.strictEqual(game.debug.playerY, 32, 'and it stops at the top, half a paddle in');
  h.keyUp('ArrowUp');
}));

test('with nobody at the left paddle the machine wins, and the game ends exactly once', () => cabinet(async ({ h, game, events }) => {
  h.until(() => !game.debug.running, 60000);
  assert.strictEqual(game.debug.running, false, 'the game reached a result');
  assert.strictEqual(events.ends.length, 1, 'onEnd fires once');
  assert.strictEqual(game.debug.bot, 11);
  assert.ok(game.debug.player < 11);
  // The last HUD report is the points still needed, never below zero.
  assert.ok(events.balls[events.balls.length - 1] >= 0);
}));

test('two runs with the same seed play out identically', async () => {
  const snap = async () => {
    let out;
    await cabinet(async ({ h, game }) => { h.advance(900); out = JSON.stringify(game.debug); }, { seed: 777 });
    return out;
  };
  assert.strictEqual(await snap(), await snap());
});

test('the cabinet declares the metadata the arcade shell needs', () => cabinet(async ({ meta }) => {
  assert.strictEqual(meta.key, 'pong');
  assert.ok(meta.width > 0 && meta.height > 0);
  assert.ok(meta.controls.length > 10);
  assert.strictEqual(meta.hud, 'arc.g.pong.hud', 'Pong names its own HUD label: it has no balls left');
}));
