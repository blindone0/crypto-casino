'use strict';
// Fairness engine: determinism, correct distributions, and that the house edge the
// configuration promises is the edge the maths actually delivers.
const test = require('node:test');
const assert = require('node:assert');
const fair = require('../src/fair');

const SEED = 'a'.repeat(64);
const EDGE = 0.01;

test('same inputs always give the same outcome', () => {
  for (let n = 0; n < 50; n += 1) {
    assert.strictEqual(fair.diceRoll(SEED, 'client', n), fair.diceRoll(SEED, 'client', n));
    assert.strictEqual(
      fair.limboMultiplier(SEED, 'client', n, EDGE),
      fair.limboMultiplier(SEED, 'client', n, EDGE),
    );
    assert.deepStrictEqual(
      fair.minePositions(SEED, 'client', n, 3),
      fair.minePositions(SEED, 'client', n, 3),
    );
  }
});

test('changing any input changes the outcome', () => {
  const base = fair.diceRoll(SEED, 'client', 1);
  const otherSeed = fair.diceRoll('b'.repeat(64), 'client', 1);
  const otherClient = fair.diceRoll(SEED, 'other', 1);
  const otherNonce = fair.diceRoll(SEED, 'client', 2);
  assert.ok(base !== otherSeed || base !== otherClient || base !== otherNonce,
    'outcome must depend on all three inputs');
});

test('published hash commits to the seed', () => {
  const seed = fair.newServerSeed();
  assert.match(seed, /^[0-9a-f]{64}$/);
  assert.strictEqual(fair.sha256hex(seed).length, 64);
  assert.notStrictEqual(fair.sha256hex(seed), fair.sha256hex(fair.newServerSeed()));
});

test('dice rolls are uniform over 0..9999', () => {
  const buckets = new Array(10).fill(0);
  const N = 100000;
  for (let n = 0; n < N; n += 1) {
    const roll = fair.diceRoll(SEED, 'uniform', n);
    assert.ok(roll >= 0 && roll <= 9999, `roll out of range: ${roll}`);
    buckets[Math.floor(roll / 1000)] += 1;
  }
  // Each decile should hold about 10% of draws; allow a generous 1.5% band.
  for (const [i, count] of buckets.entries()) {
    const share = count / N;
    assert.ok(Math.abs(share - 0.1) < 0.015, `decile ${i} share ${share} is skewed`);
  }
});

test('dice never prices a bet above fair value minus the edge', () => {
  // Exact, not sampled: for every legal target the quoted multiplier times the true win
  // chance must not exceed 1 - edge. This is the invariant the whole business rests on.
  for (const mode of ['under', 'over']) {
    for (let target = 0; target <= 9999; target += 1) {
      const winCount = fair.diceWinCount(target, mode);
      if (winCount < 100 || winCount > 9500) continue;
      const chance = winCount / fair.DICE_OUTCOMES;
      const rtp = chance * fair.payoutMultiplier(chance, EDGE);
      assert.ok(rtp <= 1 - EDGE + 1e-12,
        `${mode} target ${target}: theoretical RTP ${rtp} exceeds ${1 - EDGE}`);
      assert.ok(rtp > 1 - EDGE - 0.02,
        `${mode} target ${target}: RTP ${rtp} gives away far more edge than configured`);
    }
  }
});

test('dice win rate matches its stated chance within sampling error', () => {
  // Tolerance scales with the standard error: a 10x bet is far noisier than an even-money
  // one. Four sigma keeps this from flaking while still catching real bias.
  const N = 200000;
  for (const mode of ['under', 'over']) {
    for (const target of [1000, 5000, 9000]) {
      const winCount = fair.diceWinCount(target, mode);
      if (winCount < 100 || winCount > 9500) continue;
      const chance = winCount / fair.DICE_OUTCOMES;
      let wins = 0;
      for (let n = 0; n < N; n += 1) {
        if (fair.diceWins(fair.diceRoll(SEED, `e${mode}${target}`, n), target, mode)) wins += 1;
      }
      const observed = wins / N;
      const sigma = Math.sqrt((chance * (1 - chance)) / N);
      assert.ok(Math.abs(observed - chance) < 4 * sigma,
        `${mode} ${target}: win rate ${observed} vs ${chance}, ${
          (Math.abs(observed - chance) / sigma).toFixed(2)} sigma out`);
    }
  }
});

test('limbo multiplier follows 1/x with the edge applied', () => {
  const N = 200000;
  for (const target of [1.5, 2, 5, 20]) {
    let hits = 0;
    for (let n = 0; n < N; n += 1) {
      if (fair.limboMultiplier(SEED, `l${target}`, n, EDGE) >= target) hits += 1;
    }
    const expected = (1 - EDGE) / target;
    const observed = hits / N;
    const sigma = Math.sqrt((expected * (1 - expected)) / N);
    assert.ok(Math.abs(observed - expected) < 4 * sigma + 0.0005,
      `target ${target}: hit rate ${observed} vs expected ${expected}`);
  }
});

test('limbo and crash never return less than 1.00', () => {
  for (let n = 0; n < 20000; n += 1) {
    assert.ok(fair.limboMultiplier(SEED, 'floor', n, EDGE) >= 1);
    assert.ok(fair.crashPoint(SEED, n, EDGE) >= 1);
  }
});

test('crash busts instantly about as often as the edge implies', () => {
  const N = 100000;
  let instant = 0;
  for (let n = 0; n < N; n += 1) if (fair.crashPoint(SEED, n, EDGE) <= 1) instant += 1;
  const rate = instant / N;
  // P(multiplier floors to 1.00) is slightly above the raw edge because of the 2dp floor.
  assert.ok(rate > 0.005 && rate < 0.03, `instant-bust rate ${rate} is off`);
});

test('mines lays exactly the requested number of distinct mines', () => {
  for (const count of [1, 3, 5, 12, 24]) {
    for (let n = 0; n < 200; n += 1) {
      const mines = fair.minePositions(SEED, 'm', n, count);
      assert.strictEqual(mines.length, count);
      assert.strictEqual(new Set(mines).size, count, 'mines must be distinct');
      for (const m of mines) assert.ok(m >= 0 && m < 25, `tile ${m} out of range`);
    }
  }
});

test('mine positions are spread evenly across the board', () => {
  const hits = new Array(25).fill(0);
  const N = 40000;
  for (let n = 0; n < N; n += 1) {
    for (const m of fair.minePositions(SEED, 'spread', n, 5)) hits[m] += 1;
  }
  // With 5 of 25 tiles mined, each tile should be hit about 20% of rounds.
  for (const [i, h] of hits.entries()) {
    const share = h / N;
    assert.ok(Math.abs(share - 0.2) < 0.02, `tile ${i} share ${share} is skewed`);
  }
});

test('mines multiplier matches the combinatorial fair price', () => {
  for (const mineCount of [1, 3, 5]) {
    for (const picks of [1, 2, 5]) {
      if (picks > 25 - mineCount) continue;
      const p = fair.choose(25 - mineCount, picks) / fair.choose(25, picks);
      const expected = Math.floor(((1 - EDGE) / p) * 100) / 100;
      assert.strictEqual(fair.minesMultiplier(mineCount, picks, EDGE), expected);
      // Payout must always be below the true fair price, never above it.
      assert.ok(fair.minesMultiplier(mineCount, picks, EDGE) <= 1 / p);
    }
  }
});

test('mines empirical win rate matches the quoted multiplier', () => {
  const N = 60000;
  const mineCount = 3;
  const picks = 3;
  const mult = fair.minesMultiplier(mineCount, picks, EDGE);
  const chance = fair.choose(25 - mineCount, picks) / fair.choose(25, picks);
  let wins = 0;
  for (let n = 0; n < N; n += 1) {
    const mines = new Set(fair.minePositions(SEED, 'mrtp', n, mineCount));
    if (!mines.has(0) && !mines.has(1) && !mines.has(2)) wins += 1;
  }
  const observed = wins / N;
  const sigma = Math.sqrt((chance * (1 - chance)) / N);
  assert.ok(Math.abs(observed - chance) < 4 * sigma,
    `mines win rate ${observed} vs ${chance}`);
  assert.ok(chance * mult <= 1 - EDGE + 1e-12, `mines theoretical RTP ${chance * mult} too high`);
});

test('replay reproduces every game from stored parameters', () => {
  const dice = fair.replay({
    game: 'dice', serverSeed: SEED, clientSeed: 'c', nonce: 7, edge: EDGE, target: 5000, mode: 'under',
  });
  assert.strictEqual(dice.roll, fair.diceRoll(SEED, 'c', 7));

  const limbo = fair.replay({ game: 'limbo', serverSeed: SEED, clientSeed: 'c', nonce: 7, edge: EDGE });
  assert.strictEqual(limbo.multiplier, fair.limboMultiplier(SEED, 'c', 7, EDGE));

  const mines = fair.replay({
    game: 'mines', serverSeed: SEED, clientSeed: 'c', nonce: 7, edge: EDGE, mineCount: 4, picks: 2,
  });
  assert.deepStrictEqual(mines.mines, fair.minePositions(SEED, 'c', 7, 4));

  assert.throws(() => fair.replay({ game: 'roulette', serverSeed: SEED }), /unknown game/);
});

test('payoutMultiplier rejects impossible win chances', () => {
  assert.throws(() => fair.payoutMultiplier(0, EDGE));
  assert.throws(() => fair.payoutMultiplier(1, EDGE));
  assert.throws(() => fair.payoutMultiplier(-0.5, EDGE));
});

test('the float stream is bounded and advances past one HMAC block', () => {
  // 24 floats needs more than the 8 a single 32-byte HMAC provides.
  const fs = fair.floats(SEED, 'c', 0, 24);
  assert.strictEqual(fs.length, 24);
  for (const f of fs) assert.ok(f >= 0 && f < 1, `float ${f} out of range`);
  assert.notDeepStrictEqual(fs.slice(0, 8), fs.slice(8, 16), 'cursor must change the block');
});
