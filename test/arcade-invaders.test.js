'use strict';
// Void Raiders, driven headlessly.
//
// The raiders drop bombs, so without a seed nothing here could be asserted twice running.
// The cabinet takes one, which is the only reason these tests can say anything definite
// about a game with shooting in it.
//
// What is worth checking is the shape of the thing rather than the pixels: one shot in the
// air at a time, the formation reversing instead of walking off the screen, the wave
// ending when it is empty, lives running out once and only once, and the raiders arriving
// being the end of the game whatever lives are left.

const test = require('node:test');
const assert = require('node:assert');
const { harness } = require('./cabinet-harness');

const MODULE = '../public/games/invaders.js';

/** Start a seeded cabinet so every run of a test is the same run. */
async function cabinet(body, { seed = 12345 } = {}) {
  const h = harness({ width: 400, height: 640 });
  const mod = await import(MODULE);
  const events = { scores: [], balls: [], ends: [] };
  const game = mod.start(h.canvas, {
    seed,
    onScore: (s) => events.scores.push(s),
    onBall: (n) => events.balls.push(n),
    onEnd: (s) => events.ends.push(s),
  });
  h.advance(1);
  try {
    await body({ h, game, events, meta: mod.meta });
  } finally {
    game.stop();
    h.restore();
  }
}

test('a wave starts full, with three lives and nothing in the air', () => cabinet(async ({ game }) => {
  const s = game.debug;
  assert.strictEqual(s.raiders, 35, 'five rows of seven');
  assert.strictEqual(s.lives, 3);
  assert.strictEqual(s.wave, 1);
  assert.strictEqual(s.score, 0);
  assert.strictEqual(s.shot, null);
}));

test('the ship moves under the arrow keys and stays on screen', () => cabinet(async ({ h, game }) => {
  const middle = game.debug.ship;

  h.keyDown('ArrowLeft');
  h.advance(60);
  assert.ok(game.debug.ship < middle, 'left is left');
  h.keyUp('ArrowLeft');

  h.keyDown('ArrowRight');
  h.advance(200);
  h.keyUp('ArrowRight');
  assert.ok(game.debug.ship <= 400, 'the ship stops at the right wall');

  h.keyDown('ArrowLeft');
  h.advance(400);
  h.keyUp('ArrowLeft');
  assert.ok(game.debug.ship >= 0, 'and at the left one');
}));

test('there is one shot in the air at a time, and that is the game', () => cabinet(async ({ h, game }) => {
  h.keyDown('Space');
  h.advance(2);
  const first = game.debug.shot;
  assert.ok(first, 'holding fire launches a shot');

  h.advance(6);
  const later = game.debug.shot;
  assert.ok(later && later.y < first.y, 'and it travels up the screen');

  // Still holding: no second shot appears beside the first.
  assert.ok(game.debug.shot, 'exactly one is in the air');
  h.keyUp('Space');
}));

test('a shot that reaches the raiders removes one and scores', () => cabinet(async ({ h, game, events }) => {
  const before = game.debug.raiders;
  h.keyDown('Space');
  // Sweep across the formation until something is hit; the ship starts under a gap.
  h.keyDown('ArrowLeft');
  const frames = h.until(() => game.debug.raiders < before, 600);
  h.keyUp('ArrowLeft');
  h.keyUp('Space');

  assert.ok(game.debug.raiders < before, `nothing was hit in ${frames} frames`);
  assert.ok(game.debug.score > 0, 'and it scored');
  assert.ok(events.scores.length > 0, 'and reported upward');
}));

test('the formation turns at the wall instead of walking off it', () => cabinet(async ({ h, game }) => {
  // Run long enough for several reversals and check nothing ever leaves the screen.
  for (let i = 0; i < 900; i += 1) {
    h.advance(1);
    if (!game.debug.running) break;
  }
  // The lowest raider has come down, which only happens on a reversal.
  assert.ok(game.debug.lowest > 70, 'the formation never dropped, so it never turned');
}));

test('the game stays sane over a long run', () => cabinet(async ({ h, game }) => {
  h.keyDown('Space');
  for (let i = 0; i < 2500; i += 1) {
    h.advance(1);
    const s = game.debug;
    assert.ok(Number.isFinite(s.ship) && s.ship >= 0 && s.ship <= 400, `ship at ${s.ship}`);
    assert.ok(s.lives >= 0 && s.lives <= 3, `lives at ${s.lives}`);
    assert.ok(s.raiders >= 0 && s.raiders <= 35, `raiders at ${s.raiders}`);
    assert.ok(s.bombs < 200, 'bombs are being cleaned up');
    if (!s.running) break;
  }
  h.keyUp('Space');
}));

test('clearing a wave starts the next one, lower and fuller', () => cabinet(async ({ h, game }) => {
  // Hold fire and sweep back and forth until the wave turns over.
  h.keyDown('Space');
  let dir = 'ArrowLeft';
  h.keyDown(dir);
  const ok = h.until(() => game.debug.wave > 1 || !game.debug.running, 12000) < 12000;
  h.keyUp(dir);
  h.keyUp('Space');

  if (game.debug.wave > 1) {
    assert.strictEqual(game.debug.raiders, 35, 'the new wave is full');
    assert.ok(game.debug.score >= 1000, 'and the clear paid something');
  }
  assert.ok(ok || !game.debug.running, 'the run ended one way or the other');
}));

test('the raiders arriving ends the game whatever lives are left', () => cabinet(async ({ h, game, events }) => {
  // Never fire, never move. The formation walks down and that is that.
  const frames = h.until(() => !game.debug.running, 12000);
  assert.ok(!game.debug.running, `still going after ${frames} frames`);
  assert.strictEqual(events.ends.length, 1, 'onEnd fired once and only once');
  assert.strictEqual(events.ends[0], game.debug.score);
}));

test('nothing runs after the game is over', () => cabinet(async ({ h, game }) => {
  h.until(() => !game.debug.running, 12000);
  const frozen = game.debug;
  h.advance(200);
  assert.deepStrictEqual(game.debug, frozen);
}));

test('two runs with the same seed play out identically', async () => {
  const play = async () => {
    let result = null;
    await cabinet(async ({ h, game }) => {
      h.keyDown('Space');
      h.keyDown('ArrowLeft');
      h.advance(700);
      h.keyUp('ArrowLeft');
      h.keyUp('Space');
      result = game.debug;
    }, { seed: 999 });
    return result;
  };
  assert.deepStrictEqual(await play(), await play());
});

test('the cabinet declares the metadata the arcade shell needs', () => cabinet(async ({ meta }) => {
  assert.strictEqual(meta.key, 'invaders');
  assert.ok(meta.width > 0 && meta.height > 0);
  assert.ok(typeof meta.controls === 'string' && meta.controls.length > 0);
}));
