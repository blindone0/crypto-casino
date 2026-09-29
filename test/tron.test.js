'use strict';
// Tron: the rules, tested where they live.
//
// public/games/tron-rules.js is an ES module with no imports, which is what lets this
// CommonJS test require() it and lets the server do the same. The last test here is the
// one that justifies sharing the file at all: the module loaded through require and the
// module loaded through import run the same race to the same cell.

const test = require('node:test');
const assert = require('node:assert');
const R = require('../public/games/tron-rules.js');

const snapshot = (sim) => ({
  tick: sim.tick,
  over: sim.over,
  winners: sim.winners,
  riders: sim.riders.map((r) => [r.x, r.y, r.h, r.alive]),
});

test('two riders start apart, facing each other across the arena', () => {
  const sim = R.create(2);
  assert.strictEqual(sim.n, 2);
  assert.strictEqual(sim.alive, 2);
  const [a, b] = sim.riders;
  assert.ok(a.x < R.COLS / 2 && b.x > R.COLS / 2, 'one on each side');
  assert.notStrictEqual(a.h, b.h);
  assert.strictEqual(sim.grid[a.y * R.COLS + a.x], 1, 'a rider stands on its own wall');
  assert.strictEqual(R.create(9).n, R.MAX_RIDERS, 'the seat count is clamped');
  assert.strictEqual(R.create(0).n, R.MIN_RIDERS);
});

test('a rider that reaches the edge crashes, and the other wins', () => {
  const sim = R.create(2);
  assert.strictEqual(R.setHeading(sim, 0, 'w'), true);
  let crashed = [];
  while (!sim.over && sim.tick < 500) crashed = R.step(sim);
  assert.deepStrictEqual(crashed, [0], 'rider 0 rode west into the wall');
  assert.strictEqual(sim.riders[0].alive, false);
  assert.ok(sim.over);
  assert.deepStrictEqual(sim.winners, [1]);
  assert.strictEqual(sim.riders[0].crashedAt, sim.tick);
});

test('a rider that runs into a trail crashes', () => {
  // Rider 1 rides north and crosses y = 21 at x = 64 on tick 22. Rider 0 rides east along
  // y = 21 and reaches x = 64 on tick 32, which by then is rider 1's trail.
  const sim = R.create(2);
  R.setHeading(sim, 0, 'e');
  let crashed = [];
  while (!sim.over) crashed = R.step(sim);
  assert.deepStrictEqual(crashed, [0]);
  assert.strictEqual(sim.tick, 32);
  assert.deepStrictEqual(sim.winners, [1]);
});

test('two riders entering one cell go down together: a draw', () => {
  const sim = R.create(2);
  R.setHeading(sim, 0, 'e');
  while (sim.tick < 22) R.step(sim);
  assert.deepStrictEqual([sim.riders[1].x, sim.riders[1].y], [64, 21]);
  R.setHeading(sim, 1, 'w');
  let crashed = [];
  while (!sim.over) crashed = R.step(sim);
  assert.strictEqual(sim.tick, 27, 'they meet in the middle of the same cell');
  assert.deepStrictEqual(crashed.slice().sort(), [0, 1]);
  assert.deepStrictEqual(sim.winners.slice().sort(), [0, 1], 'a head-on is a draw');
  assert.strictEqual(sim.alive, 0);
});

test('a heading that would reverse into your own trail is refused', () => {
  const sim = R.create(2);
  assert.strictEqual(sim.riders[0].h, 's');
  assert.strictEqual(R.setHeading(sim, 0, 'n'), false);
  assert.strictEqual(sim.riders[0].next, 's', 'the refused heading is not kept either');
  assert.strictEqual(R.setHeading(sim, 0, 'x'), false, 'not a heading');
  assert.strictEqual(R.setHeading(sim, 5, 'e'), false, 'not a rider');
  assert.strictEqual(R.setHeading(sim, 0, 'e'), true);
  assert.strictEqual(sim.riders[0].h, 's', 'a turn waits for the tick');
  R.step(sim);
  assert.strictEqual(sim.riders[0].h, 'e');
});

test('a trail is a list of corners, not a list of every cell', () => {
  const sim = R.create(2);
  R.setHeading(sim, 0, 'e');
  for (let i = 0; i < 10; i += 1) R.step(sim);
  R.setHeading(sim, 0, 's');
  for (let i = 0; i < 5; i += 1) R.step(sim);
  const path = sim.riders[0].path;
  assert.strictEqual(path.length, 3, 'start, the corner, the head');
  assert.deepStrictEqual(path[1], [42, 21]);
  assert.deepStrictEqual(path[2], [42, 26]);
});

test('room tells a pocket from the open field', () => {
  const sim = R.create(2);
  assert.strictEqual(R.room(sim, 10, 10), 400, 'the open field hits the cap');
  // Wall off a two-cell pocket in a corner.
  sim.grid[0 * R.COLS + 2] = 9;
  sim.grid[1 * R.COLS + 0] = 9;
  sim.grid[1 * R.COLS + 1] = 9;
  sim.grid[1 * R.COLS + 2] = 9;
  assert.strictEqual(R.room(sim, 0, 0), 2);
  assert.strictEqual(R.room(sim, 2, 0), 0, 'a wall has no room');
});

test('the bots ride to a decision and do not stalemate', () => {
  for (const seed of [1, 2, 3]) {
    for (const n of [2, 4]) {
      const sim = R.create(n);
      const random = R.rng(seed);
      while (!sim.over && sim.tick < 5000) {
        for (let s = 0; s < n; s += 1) {
          const h = R.botHeading(sim, s, random);
          if (h) R.setHeading(sim, s, h);
        }
        R.step(sim);
      }
      assert.ok(sim.over, `seed ${seed}, ${n} riders: still riding after ${sim.tick} ticks`);
      assert.ok(sim.tick > 30, 'a race is not over before it has started');
      assert.ok(sim.winners.length >= 1);
    }
  }
});

test('a bot turns away from a wall it can see, and never straight into one', () => {
  const sim = R.create(2);
  const random = R.rng(7);
  // Rider 0 heads south from y = 21 towards the bottom edge at y = 63.
  let turned = null;
  while (!turned && sim.tick < 200) {
    const h = R.botHeading(sim, 0, random);
    if (h !== 's') turned = { h, y: sim.riders[0].y };
    R.setHeading(sim, 0, h);
    R.step(sim);
  }
  assert.ok(turned, 'it turned before the wall');
  assert.ok(['e', 'w'].includes(turned.h));
  assert.ok(turned.y < R.ROWS - 1, 'and did so with room to spare');
  assert.strictEqual(sim.riders[0].alive, true);
});

test('a race replays from its inputs to the same cell, whatever order they arrived in', () => {
  const turns = [
    { t: 5, seat: 0, h: 'e' }, { t: 12, seat: 1, h: 'w' },
    { t: 30, seat: 0, h: 's' }, { t: 31, seat: 1, h: 's' },
  ];
  const a = R.replay(2, turns, 400);
  const b = R.replay(2, turns.slice().reverse(), 400);
  assert.deepStrictEqual(snapshot(a), snapshot(b));
  assert.ok(a.over, 'four turns on a small grid end in a crash');
  const c = R.replay(2, turns, 20);
  assert.strictEqual(c.tick, 20, 'stopping early is the same race, earlier');
  assert.strictEqual(c.riders[0].h, 'e');
  assert.strictEqual(c.over, false);
});

test('the same rules load through require and through import', async () => {
  const viaImport = await import('../public/games/tron-rules.js');
  const turns = [{ t: 3, seat: 0, h: 'e' }, { t: 9, seat: 1, h: 'w' }, { t: 20, seat: 0, h: 'n' }];
  assert.deepStrictEqual(
    snapshot(viaImport.replay(2, turns, 100)),
    snapshot(R.replay(2, turns, 100)),
  );
  assert.strictEqual(viaImport.COLS, R.COLS);
});
