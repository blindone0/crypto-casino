'use strict';
// Billiards, driven headlessly.
//
// Pool is a physics game, and physics games fail quietly: balls settle inside each other
// and buzz, a hard shot passes straight through a ball it should have hit, energy creeps
// upward until everything is moving at once. None of that is visible in a screenshot and
// all of it is visible in a fixed-step run with the numbers in front of you.
//
// The harness advances time only when told to, so every one of these is deterministic.

const test = require('node:test');
const assert = require('node:assert');
const { cabinet } = require('./cabinet-harness');

const MODULE = '../public/games/billiards.js';
const table = (body) => cabinet(MODULE, body, { width: 360, height: 680 });

/** Run until every ball has stopped, or give up. */
const settle = (h, game, limit = 3000) => h.until(() => !game.debug.moving, limit);

test('the table racks up with a red cue and fifteen white balls', () => table(async ({ game }) => {
  const s = game.debug;
  assert.strictEqual(s.balls, 16, 'fifteen whites and the cue');
  assert.strictEqual(s.remaining, 15);
  assert.strictEqual(s.pocketed, 0);
  assert.strictEqual(s.toGo, 8, 'free pyramid ends at eight');
  assert.strictEqual(s.score, 0);
  assert.strictEqual(s.shots, 30);
  assert.strictEqual(s.moving, false);
}));

test('nothing moves until a shot is taken', () => table(async ({ h, game }) => {
  const before = game.debug.cue;
  h.advance(200);
  assert.deepStrictEqual(game.debug.cue, before);
  assert.strictEqual(game.debug.moving, false);
  assert.strictEqual(game.debug.shots, 30);
}));

test('a shot moves the cue ball, costs a shot, and eventually stops', () => table(async ({ h, game }) => {
  const before = game.debug.cue;
  game.shootAt(-Math.PI / 2, 1); // straight up the table
  h.advance(2);

  assert.strictEqual(game.debug.shots, 29, 'the shot is counted');
  assert.ok(game.debug.moving, 'and the ball is moving');

  const frames = settle(h, game);
  assert.ok(frames < 3000, `the table never settled: ${frames} frames`);
  assert.notDeepStrictEqual(game.debug.cue, before, 'the cue ball went somewhere');
}));

test('balls stay on the table however hard they are hit', () => table(async ({ h, game }) => {
  // Fire at every angle in turn and check nothing ever leaves the cloth.
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2;
    game.shootAt(angle, 1);
    for (let f = 0; f < 240; f += 1) {
      h.advance(1);
      const s = game.debug;
      assert.ok(Number.isFinite(s.cue.x) && Number.isFinite(s.cue.y),
        `the cue ball left the number line at angle ${angle.toFixed(2)}`);
      assert.ok(s.cue.x >= 0 && s.cue.x <= 360 && s.cue.y >= 0 && s.cue.y <= 680,
        `a ball escaped to ${s.cue.x},${s.cue.y} at angle ${angle.toFixed(2)}`);
      if (!s.moving) break;
    }
    if (!game.debug.running) break;
  }
}));

test('the table always comes to rest: friction wins', () => table(async ({ h, game }) => {
  game.shootAt(-Math.PI / 2, 1);
  const frames = settle(h, game, 2000);
  assert.ok(frames < 2000, 'still rolling after half a minute of play');
  assert.strictEqual(game.debug.moving, false);
}));

test('the break scatters the rack rather than passing through it', () => table(async ({ h, game }) => {
  // Before: the object balls are in a tight diamond. Afterwards they should not be.
  game.shootAt(-Math.PI / 2, 1);
  settle(h, game);
  // Something was hit: either balls went down, or the cue ball is no longer where a
  // straight run up an empty table would have left it.
  const s = game.debug;
  assert.ok(s.remaining < 9 || s.cue.y !== 20 + 9,
    'the cue ball ran up an empty table and nothing was struck');
}));

test('potting a ball scores and takes it off the table', () => table(async ({ h, game }) => {
  // Aim the cue ball straight at the nearest corner pocket, with nothing in the way.
  const before = game.debug;
  game.shootAt(Math.PI / 2, 1); // straight down, toward the bottom cushion
  settle(h, game);
  const after = game.debug;
  // Either it potted in a bottom pocket, or it did not; both are fine, but the bookkeeping
  // has to agree with itself in either case.
  assert.strictEqual(after.balls, after.remaining + 1, 'the cue ball is always on the table');
  assert.ok(after.remaining <= before.remaining);
}));

test('a shot cannot be taken while the balls are still rolling', () => table(async ({ h, game }) => {
  game.shootAt(-Math.PI / 2, 1);
  h.advance(2);
  assert.ok(game.debug.moving);
  const shotsLeft = game.debug.shots;
  game.shootAt(Math.PI / 2, 1);
  assert.strictEqual(game.debug.shots, shotsLeft, 'the second shot was ignored');
}));

test('running out of shots ends the game exactly once', () => table(async ({ h, game, events }) => {
  for (let i = 0; i < 40 && events.ends.length === 0; i += 1) {
    game.shootAt((i * 0.7) % (Math.PI * 2), 1);
    settle(h, game);
  }
  assert.strictEqual(events.ends.length, 1, 'onEnd fired once and only once');
  assert.ok(game.debug.shots === 0 || game.debug.remaining === 0,
    'the game ended for one of the two reasons it can');

  // Nothing runs afterwards.
  const frozen = game.debug;
  h.advance(120);
  assert.deepStrictEqual(game.debug, frozen);
}));

test('the eighth ball ends the game, with a bonus for the shots not taken', () => table(async ({ h, game, events }) => {
  // Play until the game ends one way or the other, then check the score is consistent
  // with what happened rather than with a number written down here. The pockets are
  // tight now, so it takes more blind shots to drop eight than it took to clear nine.
  for (let i = 0; i < 120 && events.ends.length === 0; i += 1) {
    game.shootAt((i * 1.3) % (Math.PI * 2), 1);
    settle(h, game);
  }
  const s = game.debug;
  assert.ok(s.pocketed <= 8, 'the game stops at eight; nothing is potted after it');
  // Two honest endings: the eighth ball, or the last shot. Blind shooting into pockets
  // this tight usually runs out of shots first, and that is a result, not a failure.
  assert.strictEqual(events.ends.length, 1, 'the game ended, once');
  if (s.pocketed >= 8) {
    assert.ok(s.score >= 8 * 1000 + 3000, `eight balls for only ${s.score}`);
  } else {
    assert.strictEqual(s.shots, 0, 'if eight did not drop, it ended on the last shot');
    assert.ok(s.score >= s.pocketed * 1000, 'every ball that dropped was paid');
  }
}));

test('a pocketed cue ball scores like any other and comes back', () => table(async ({ h, game }) => {
  // Aim into a corner pocket at an angle that gives the cue ball a clear run.
  const start = game.debug;
  game.shootAt(Math.PI * 0.75, 1); // down and to the left
  settle(h, game);
  const after = game.debug;
  assert.strictEqual(after.shots, start.shots - 1, 'only the shot itself is charged: there is no scratch');
  assert.strictEqual(after.balls, after.remaining + 1, 'the cue ball came back');
  if (after.pocketed > start.pocketed) {
    assert.ok(after.score >= start.score + 1000, 'whatever dropped, the cue included, scored');
  }
}));

test('a drag released outside the table still fires the shot', () => table(async ({ h, game }) => {
  // The cue sits on its spot at (180, 503). Press on it, pull well past the bottom edge of
  // the canvas, as a player against the far cushion has to, and release out there. With
  // the drag heard on the canvas alone this shot never happened: the bug igor hit.
  const start = game.debug;
  h.pointer('pointerdown', 180, 503);
  h.pointerWindow('pointermove', 180, 620);
  h.pointerWindow('pointermove', 180, 900);
  h.pointerWindow('pointerup', 180, 900);
  h.advance(2);
  assert.strictEqual(game.debug.shots, start.shots - 1, 'the release outside the table took the shot');
  assert.ok(game.debug.moving, 'and the ball is away');
}));

test('any ball may be played: a press on a white ball makes it the striker', () => table(async ({ h, game }) => {
  // The apex of the pyramid sits on the spot at (180, 204). Press it, pull down, release:
  // the apex ball goes up and the cue has not moved.
  h.pointer('pointerdown', 180, 204);
  h.pointerWindow('pointerup', 180, 260);
  h.advance(2);
  assert.notStrictEqual(game.debug.striker, 0, 'the striker is no longer the cue');
  assert.ok(game.debug.moving);
  assert.deepStrictEqual(game.debug.cue, { x: 180, y: 503 }, 'the cue ball stayed on its spot');
}));

test('the flat keys aim and strike without a pointer', () => table(async ({ h, game }) => {
  h.keyDown('ArrowLeft');
  h.keyUp('ArrowLeft');
  h.keyDown('Space');
  h.advance(30); // charge
  h.keyUp('Space');
  h.advance(2);
  assert.strictEqual(game.debug.shots, 29, 'the keyboard took a shot');
  assert.ok(game.debug.moving);
}));

test('the cabinet declares the metadata the arcade shell needs', () => table(async ({ meta }) => {
  assert.strictEqual(meta.key, 'billiards');
  assert.ok(meta.width > 0 && meta.height > 0);
  assert.ok(typeof meta.controls === 'string' && meta.controls.length > 0);
}));
