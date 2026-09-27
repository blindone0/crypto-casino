'use strict';
// Slot machine: the payout table must actually deliver the configured RTP, and the
// closed-form maths must agree with what spinning the reels really pays.
const test = require('node:test');
const assert = require('node:assert');
const slots = require('../src/games/slots');
const fair = require('../src/fair');

const EDGE = 0.03;

test('the solved paytable hits the configured RTP', () => {
  for (const edge of [0.01, 0.02, 0.03, 0.05, 0.08]) {
    const m = slots.machineFor(edge);
    const target = 1 - edge;
    assert.ok(m.rtp <= target + 1e-9, `RTP ${m.rtp} exceeds target ${target}`);
    assert.ok(target - m.rtp < 0.002, `RTP ${m.rtp} is too far below target ${target}`);
  }
});

test('the solver refuses to ship a machine that misses its target', () => {
  // Flooring each payout to 2dp makes RTP a staircase in the scale factor, so landing
  // exactly on a target is essentially impossible. Demanding zero tolerance must
  // therefore trip the guard: the point is that it fails loudly instead of quietly
  // shipping a machine that underpays, which is what a clamped search once did here.
  assert.throws(() => slots.solveScale(0.97, 0), /misses the target/);

  // And the normal path still succeeds, so the guard is not simply always on.
  assert.doesNotThrow(() => slots.solveScale(0.97));
});

test('simulated return matches the closed-form return', () => {
  const m = slots.machineFor(EDGE);
  const seed = fair.newServerSeed();
  const N = 200000;
  let ret = 0;

  for (let n = 0; n < N; n += 1) {
    const base = slots.spinOnce(seed, 'rtp', n, m, 0);
    let mult = base.lineTotal / slots.LINES;
    const sc = Math.min(base.scatters, 5);
    if (sc >= 3) {
      mult += m.scatter[sc] || 0;
      const fs = m.freeSpins[sc] || 0;
      for (let i = 0; i < fs; i += 1) {
        mult += (slots.spinOnce(seed, 'rtp', n, m, i + 1).lineTotal / slots.LINES)
          * m.freeSpinMultiplier;
      }
    }
    ret += mult;
  }
  const simulated = ret / N;
  // Slot variance is large, so the band is wide on purpose; this catches a broken
  // paytable or a mis-scaled solver, not a one-percent drift.
  assert.ok(Math.abs(simulated - m.rtp) < 0.03,
    `simulated ${simulated.toFixed(4)} vs exact ${m.rtp.toFixed(4)}`);
});

test('the same seed and nonce always give the same screen', () => {
  const m = slots.machineFor(EDGE);
  const seed = fair.newServerSeed();
  for (let n = 0; n < 40; n += 1) {
    const a = slots.spinOnce(seed, 'client', n, m, 0);
    const b = slots.spinOnce(seed, 'client', n, m, 0);
    assert.deepStrictEqual(a.stops, b.stops);
    assert.deepStrictEqual(a.screen, b.screen);
  }
});

test('free spins draw different reels from the base spin', () => {
  const m = slots.machineFor(EDGE);
  const seed = fair.newServerSeed();
  const base = slots.spinOnce(seed, 'client', 1, m, 0);
  const free = slots.spinOnce(seed, 'client', 1, m, 1);
  assert.notDeepStrictEqual(base.stops, free.stops);
});

test('every screen is 5x3 and holds only real symbols', () => {
  const m = slots.machineFor(EDGE);
  const seed = fair.newServerSeed();
  const valid = new Set(slots.SYMBOLS);
  for (let n = 0; n < 200; n += 1) {
    const { screen } = slots.spinOnce(seed, 'shape', n, m, 0);
    assert.strictEqual(screen.length, slots.REELS);
    for (const reel of screen) {
      assert.strictEqual(reel.length, slots.ROWS);
      for (const cell of reel) assert.ok(valid.has(cell), `unknown symbol ${cell}`);
    }
  }
});

test('line evaluation pays runs from the left and honours wilds', () => {
  const m = slots.machineFor(EDGE);
  // A screen whose middle row is GEM GEM GEM K Q: a three-of-a-kind on the centre line.
  const screen = [
    ['T', 'GEM', 'J'], ['T', 'GEM', 'J'], ['T', 'GEM', 'J'],
    ['T', 'K', 'J'], ['T', 'Q', 'J'],
  ];
  const { wins } = slots.evaluate(screen, m);
  const centre = wins.find((w) => w.line === 0);
  assert.ok(centre, 'the centre line should win');
  assert.strictEqual(centre.symbol, 'GEM');
  assert.strictEqual(centre.count, 3);

  // A wild in the middle extends the run.
  const withWild = [
    ['T', 'GEM', 'J'], ['T', 'WILD', 'J'], ['T', 'GEM', 'J'],
    ['T', 'GEM', 'J'], ['T', 'Q', 'J'],
  ];
  const w2 = slots.evaluate(withWild, m).wins.find((w) => w.line === 0);
  assert.strictEqual(w2.count, 4, 'a wild should substitute and lengthen the run');

  // A run that does not start on reel one pays nothing on that line.
  const rightAligned = [
    ['T', 'Q', 'J'], ['T', 'GEM', 'J'], ['T', 'GEM', 'J'],
    ['T', 'GEM', 'J'], ['T', 'GEM', 'J'],
  ];
  assert.ok(!slots.evaluate(rightAligned, m).wins.some((w) => w.line === 0),
    'wins must start from the leftmost reel');
});

test('the scatter distribution is a real probability distribution', () => {
  const dist = slots.scatterDistribution();
  const sum = dist.reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `scatter probabilities sum to ${sum}`);
  for (const p of dist) assert.ok(p >= 0);
  const trigger = dist.slice(3).reduce((s, x) => s + x, 0);
  assert.ok(trigger > 0.001 && trigger < 0.05, `free-spin rate ${trigger} looks wrong`);
});

test('observed scatter frequency matches the computed distribution', () => {
  const m = slots.machineFor(EDGE);
  const seed = fair.newServerSeed();
  const dist = slots.scatterDistribution();
  const N = 120000;
  let triggers = 0;
  for (let n = 0; n < N; n += 1) {
    if (slots.spinOnce(seed, 'scat', n, m, 0).scatters >= 3) triggers += 1;
  }
  const expected = dist.slice(3).reduce((s, x) => s + x, 0);
  const observed = triggers / N;
  const sigma = Math.sqrt((expected * (1 - expected)) / N);
  assert.ok(Math.abs(observed - expected) < 5 * sigma,
    `scatter rate ${observed} vs expected ${expected}`);
});

test('payouts are never quoted above the fair price', () => {
  const m = slots.machineFor(EDGE);
  // Total RTP is the sum of its parts, and each part must be non-negative and bounded.
  const { lineRtp, scatterPay, freeSpinValue } = m.breakdown;
  assert.ok(lineRtp > 0 && scatterPay >= 0 && freeSpinValue >= 0);
  assert.ok(Math.abs((lineRtp + scatterPay + freeSpinValue) - m.rtp) < 1e-9);
  assert.ok(m.rtp < 1, 'a slot must not return more than it takes');
});
