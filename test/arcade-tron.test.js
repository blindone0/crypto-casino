'use strict';
// Tron, played headless.
//
// The same harness as the other cabinets: a fake window and canvas, and a clock that only
// moves when a test says so. The race is a pure function of the seed and the input, so a
// run with no input is one run, and a crash into the wall happens on the same frame every
// time. The rules themselves are tested in tron.test.js; this is the cabinet — the
// countdown, the keys and swipes, the score, the end.

const test = require('node:test');
const assert = require('node:assert');
const { harness } = require('./cabinet-harness');

const MODULE = '../public/games/tron.js';

/** Start a race with a fixed seed, run `body`, and always put the globals back. */
async function cabinet(body, { seed = 4242 } = {}) {
  const h = harness({ width: 768, height: 512 });
  const mod = await import(MODULE);
  const events = { scores: [], balls: [], ends: [] };
  const game = mod.start(h.canvas, {
    onScore: (s) => events.scores.push(s),
    onBall: (n) => events.balls.push(n),
    onEnd: (s) => events.ends.push(s),
    seed,
  });
  try {
    await body({ h, game, events, mod });
  } finally {
    game.stop();
    h.restore();
  }
}

/** Frames until the countdown is over and the race is moving. */
const READY_FRAMES = 80;

test('round one seats you and one machine, after a beat', () => cabinet(async ({ h, game, events }) => {
  const s = game.debug;
  assert.strictEqual(s.round, 1);
  assert.strictEqual(s.riders.length, 2);
  assert.strictEqual(s.alive, 2);
  assert.strictEqual(s.phase, 'ready', 'the countdown is running');
  assert.strictEqual(s.tick, 0, 'nobody moves during the countdown');
  assert.deepStrictEqual(events.balls, [2], 'the HUD is told how many riders are on the field');
  h.advance(READY_FRAMES);
  assert.strictEqual(game.debug.phase, 'riding');
  assert.ok(game.debug.tick > 0, 'and then they ride');
}));

test('riding into the wall ends the game, once, with the ticks survived on the score', () => cabinet(async ({ h, game, events }) => {
  h.keyDown('ArrowLeft');
  h.until(() => !game.debug.running, 900);
  const s = game.debug;
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.riders[0].alive, false, 'the player is out');
  assert.strictEqual(events.ends.length, 1, 'onEnd fires exactly once');
  assert.ok(s.score >= 10 * 30, `thirty-odd ticks west at ten a tick, not ${s.score}`);
  assert.strictEqual(events.ends[0], s.score);
  h.advance(30);
  assert.strictEqual(events.ends.length, 1, 'and nothing runs afterwards');
}));

test('with no input at all the race still ends', () => cabinet(async ({ h, game, events }) => {
  h.until(() => !game.debug.running, 3000);
  assert.strictEqual(game.debug.running, false, 'a rider that never turns meets the wall');
  assert.strictEqual(events.ends.length, 1);
}));

test('the arrow keys turn the rider at the next tick, and a reverse is refused', () => cabinet(async ({ h, game }) => {
  h.advance(READY_FRAMES);
  assert.strictEqual(game.debug.riders[0].h, 's');
  h.keyDown('ArrowUp');
  h.advance(6);
  assert.strictEqual(game.debug.riders[0].h, 's', 'straight back into your own trail is not a turn');
  h.keyDown('ArrowRight');
  h.advance(6);
  assert.strictEqual(game.debug.riders[0].h, 'e');
  h.keyDown('KeyW');
  h.advance(6);
  assert.strictEqual(game.debug.riders[0].h, 'n', 'W A S D work too');
}));

test('a swipe on the arena turns the rider the way it went', () => cabinet(async ({ h, game }) => {
  h.advance(READY_FRAMES);
  h.pointer('pointerdown', 300, 300);
  h.pointer('pointermove', 240, 300);
  h.pointer('pointerup', 240, 300);
  h.advance(6);
  assert.strictEqual(game.debug.riders[0].h, 'w');
  // A tap is not a swipe.
  const before = game.debug.riders[0].h;
  h.pointer('pointerdown', 300, 300);
  h.pointer('pointerup', 302, 301);
  h.advance(6);
  assert.strictEqual(game.debug.riders[0].h, before);
}));

test('the machine goes down before the player does when the player steers clear', () => cabinet(async ({ h, game, events }) => {
  // Ride a box around the player's own corner: south, then west, then north, then east,
  // each leg a few ticks, and let the machine find a wall on its own.
  h.advance(READY_FRAMES);
  const legs = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
  let i = 0;
  h.until(() => {
    if (game.debug.tick % 6 === 0) { h.keyDown(legs[i % 4]); i += 1; }
    return game.debug.alive < 2 || !game.debug.running;
  }, 2400);
  if (game.debug.riders[0].alive) {
    assert.ok(events.balls.includes(1), 'the HUD saw the field shrink');
    assert.ok(game.debug.score >= 500, 'outliving a rider pays');
  }
}));

test('two runs with the same seed play out identically', async () => {
  const runs = [];
  for (let i = 0; i < 2; i += 1) {
    await cabinet(async ({ h, game }) => {
      h.advance(400);
      runs.push(JSON.stringify(game.debug));
    }, { seed: 99 });
  }
  assert.strictEqual(runs[0], runs[1]);
});

test('the cabinet declares the metadata the arcade shell needs', async () => {
  const { meta } = await import(MODULE);
  assert.strictEqual(meta.key, 'tron');
  assert.strictEqual(meta.width, 768);
  assert.strictEqual(meta.height, 512);
  assert.strictEqual(meta.hud, 'arc.g.tron.hud');
  assert.ok(meta.controls.length > 10);
});
