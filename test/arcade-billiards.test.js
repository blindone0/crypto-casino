'use strict';
// Русская пирамида, the cabinet, driven headlessly.
//
// The rules and the pocket geometry have their own file (billiards-rules.test.js); this is
// the cabinet around them: the pointer and the keys, the flat cloth that stands in for
// WebGL here, the machine taking its turn, the arcade score, and the game ending once.
// Node has no document, so createView() returns null and the cabinet draws the cloth
// flat, which is exactly the path a browser without WebGL takes.
//
// The cloth is drawn mirrored — +y to the left, as the 3D camera has it — with the house
// at the bottom of a 420 by 750 canvas. The cue ball on its spot is at (210, 547.5) and
// the apex of the pyramid at (210, 202.5); the numbers below come from that.

const test = require('node:test');
const assert = require('node:assert');
const { cabinet } = require('./cabinet-harness');

const MODULE = '../public/games/billiards.js';
const table = (body) => cabinet(MODULE, body, { width: 420, height: 750 });

/** Run until every ball has stopped, or give up. */
const settle = (h, game, limit = 4000) => h.until(() => !game.debug.moving, limit);
/** Run until it is the player's shot again, or the game is over. */
const myTurn = (h, game, limit = 8000) => h.until(
  () => !game.debug.running || (game.debug.turn === 0 && !game.debug.moving && !game.debug.thinking), limit,
);

test('the table racks up in millimetres: the cue ball in the house, fifteen to play, eight to win', () => table(async ({ game, events }) => {
  const s = game.debug;
  assert.strictEqual(s.balls, 16, 'fifteen whites and the cue');
  assert.strictEqual(s.remaining, 15);
  assert.strictEqual(s.toGo, 8);
  assert.deepStrictEqual(s.scores, [0, 0]);
  assert.strictEqual(s.turn, 0, 'the player breaks');
  assert.strictEqual(s.shots, 0);
  assert.strictEqual(s.score, 0);
  assert.strictEqual(s.moving, false);
  assert.deepStrictEqual(s.cue, { x: 888, y: 888, potted: false }, 'a quarter of the way up a 3550 mm table');
  assert.strictEqual(s.view, '2d', 'no WebGL here: the cloth is drawn flat');
  assert.deepStrictEqual(events.balls, [8], 'the HUD starts at eight to go');
}));

test('nothing moves until a shot is taken', () => table(async ({ h, game }) => {
  const before = game.debug.cue;
  h.advance(200);
  assert.deepStrictEqual(game.debug.cue, before);
  assert.strictEqual(game.debug.moving, false);
  assert.strictEqual(game.debug.shots, 0);
}));

test('a shot moves the cue ball, is counted, and the table comes to rest', () => table(async ({ h, game }) => {
  const before = game.debug.cue;
  game.shootAt(0, 1); // straight up the table, into the rack
  h.advance(2);
  assert.strictEqual(game.debug.shots, 1);
  assert.ok(game.debug.moving);
  const frames = settle(h, game);
  assert.ok(frames < 4000, `the table never settled: ${frames} frames`);
  assert.notDeepStrictEqual(game.debug.cue, before, 'the cue ball went somewhere');
  assert.ok(!/Foul/.test(game.debug.message), 'a straight break touches the rack');
}));

test('balls stay on the table however hard they are hit', () => table(async ({ h, game }) => {
  for (let i = 0; i < 12 && game.debug.running; i += 1) {
    myTurn(h, game);
    if (!game.debug.running) break;
    const angle = (i / 12) * Math.PI * 2;
    game.shootAt(angle, 1);
    for (let f = 0; f < 600; f += 1) {
      h.advance(1);
      const s = game.debug;
      assert.ok(Number.isFinite(s.cue.x) && Number.isFinite(s.cue.y),
        `the cue ball left the number line at angle ${angle.toFixed(2)}`);
      if (!s.cue.potted) {
        assert.ok(s.cue.x >= 0 && s.cue.x <= 3550 && s.cue.y >= 0 && s.cue.y <= 1775,
          `a ball escaped to ${s.cue.x},${s.cue.y} at angle ${angle.toFixed(2)}`);
      }
      if (!s.moving) break;
    }
  }
}));

test('the table always comes to rest: friction wins', () => table(async ({ h, game }) => {
  game.shootAt(0, 1);
  const frames = settle(h, game, 3000);
  assert.ok(frames < 3000, 'still rolling after fifty seconds of play');
  assert.strictEqual(game.debug.moving, false);
}));

test('a shot cannot be taken while the balls are still rolling', () => table(async ({ h, game }) => {
  game.shootAt(0, 1);
  h.advance(2);
  assert.ok(game.debug.moving);
  game.shootAt(Math.PI, 1);
  assert.strictEqual(game.debug.shots, 1, 'the second shot was ignored');
}));

test('a miss is a foul: the machine takes a ball, and then takes its shot', () => table(async ({ h, game, events }) => {
  // Softly away from the rack: the cue ball touches nothing and the rule applies.
  game.shootAt(Math.PI, 0.3);
  settle(h, game);
  let s = game.debug;
  assert.deepStrictEqual(s.scores, [0, 1], 'one to the machine');
  assert.strictEqual(s.remaining, 14, 'a ball came off the table for it');
  assert.strictEqual(s.turn, 1, 'and the cue passed');
  assert.ok(/Foul/.test(s.message), s.message);
  assert.strictEqual(s.score, 0, "the machine's ball is worth nothing to you");
  assert.strictEqual(events.balls[events.balls.length - 1], 8, 'you still need eight');
  // The machine lines up and shoots on its own: nothing from the player.
  game.shootAt(0, 1);
  assert.strictEqual(game.debug.shots, 1, "the player cannot shoot on the machine's turn");
  const waited = h.until(() => game.debug.shots >= 2, 200);
  assert.ok(waited < 200, 'the machine took its shot');
  assert.ok(game.debug.moving);
  settle(h, game);
  s = game.debug;
  assert.strictEqual(s.shots, 2);
  assert.strictEqual(s.remaining + s.scores[0] + s.scores[1], 15, 'every ball accounted for');
}));

test('only the cue ball can be struck: a pull from the pyramid still moves the cue ball', () => table(async ({ h, game }) => {
  h.pointer('pointerdown', 210, 202.5);      // the apex ball
  h.pointerWindow('pointerup', 210, 260);    // pulled down the table
  h.advance(3);
  const s = game.debug;
  assert.strictEqual(s.shots, 1);
  assert.ok(s.moving);
  assert.ok(s.cue.x < 888, 'the cue ball is away, toward the head cushion');
  assert.strictEqual(s.remaining, 15);
}));

test('a drag released outside the table still fires the shot, at full draw', () => table(async ({ h, game }) => {
  // Press on the cue ball, pull well past the bottom edge of the canvas, as a player
  // against the head cushion has to, and release out there.
  h.pointer('pointerdown', 210, 547.5);
  h.pointerWindow('pointermove', 210, 700);
  h.pointerWindow('pointermove', 210, 900);
  h.pointerWindow('pointerup', 210, 900);
  h.advance(3);
  const s = game.debug;
  assert.strictEqual(s.shots, 1, 'the release outside the table took the shot');
  assert.ok(s.moving, 'and the ball is away');
  assert.ok(s.cue.x > 888, 'up the table, away from the pull');
}));

test('the flat keys aim and strike without a pointer', () => table(async ({ h, game }) => {
  h.keyDown('ArrowLeft');
  h.keyUp('ArrowLeft');
  h.keyDown('Space');
  h.advance(30); // charge
  h.keyUp('Space');
  h.advance(2);
  assert.strictEqual(game.debug.shots, 1, 'the keyboard took a shot');
  assert.ok(game.debug.moving);
}));

test('the game ends exactly once, at eight, and the score is what the balls were worth', () => table(async ({ h, game, events }) => {
  for (let i = 0; i < 320 && events.ends.length === 0; i += 1) {
    myTurn(h, game);
    if (!game.debug.running) break;
    game.shootAt((i * 1.3) % (Math.PI * 2), 1);
    settle(h, game);
  }
  assert.strictEqual(events.ends.length, 1, 'onEnd fired once and only once');
  const s = game.debug;
  assert.strictEqual(s.running, false);
  assert.ok(s.over || s.shots >= 300, 'ended on a result, or on the shot cap');
  if (s.over) {
    assert.strictEqual(Math.max(...s.scores), 8, 'somebody reached eight');
    assert.ok(s.winner === 0 || s.winner === 1);
  }
  assert.ok(s.score >= s.scores[0] * 1000, 'every ball of yours paid a thousand');
  assert.ok(s.score <= 20000, 'and the registry cap holds');
  assert.strictEqual(events.ends[0], s.score);

  // Nothing runs afterwards.
  const frozen = game.debug;
  h.advance(120);
  assert.deepStrictEqual(game.debug, frozen);
}));

test('the cabinet declares the metadata the arcade shell needs', () => table(async ({ meta }) => {
  assert.strictEqual(meta.key, 'billiards');
  assert.strictEqual(meta.width, 420);
  assert.strictEqual(meta.height, 750);
  assert.strictEqual(meta.hud, 'arc.g.billiards.hud');
  assert.ok(typeof meta.controls === 'string' && meta.controls.length > 0);
}));
