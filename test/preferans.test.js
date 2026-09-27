'use strict';
// Preferans: the rules must be enforced exactly, and the payout table must still match
// the bot it was calibrated against.
const test = require('node:test');
const assert = require('node:assert');
const pref = require('../src/games/preferans');
const fair = require('../src/fair');

const SEED = fair.newServerSeed();

test('every deal is a complete, disjoint 32-card pack', () => {
  for (let n = 0; n < 300; n += 1) {
    const d = pref.deal(SEED, 'client', n);
    assert.strictEqual(d.hands.length, 3);
    for (const h of d.hands) assert.strictEqual(h.length, pref.HAND_SIZE);
    assert.strictEqual(d.talon.length, pref.TALON);

    const all = [...d.hands.flat(), ...d.talon];
    assert.strictEqual(all.length, 32);
    assert.strictEqual(new Set(all).size, 32, 'no card may appear twice');
    for (const c of all) assert.ok(pref.DECK.includes(c), `unknown card ${c}`);
  }
});

test('the same seed always deals the same cards', () => {
  const a = pref.deal(SEED, 'client', 5);
  const b = pref.deal(SEED, 'client', 5);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, pref.deal(SEED, 'client', 6));
});

test('the shuffle does not favour any position', () => {
  // Each specific card should land in the talon about 2/32 of the time.
  const N = 20000;
  const counts = Object.fromEntries(pref.DECK.map((c) => [c, 0]));
  for (let n = 0; n < N; n += 1) {
    for (const c of pref.deal(SEED, 'uniform', n).talon) counts[c] += 1;
  }
  const expected = (N * pref.TALON) / 32;
  const sigma = Math.sqrt(expected * (1 - 2 / 32));
  for (const [card, seen] of Object.entries(counts)) {
    assert.ok(Math.abs(seen - expected) < 5 * sigma,
      `${card} landed in the talon ${seen} times, expected about ${expected}`);
  }
});

test('you must follow suit when you can', () => {
  const hand = ['AS', 'KS', '7H', 'AD'];
  const legal = pref.legalPlays(hand, 'S', 'H');
  assert.deepStrictEqual(legal.sort(), ['AS', 'KS'].sort());
});

test('when void you are obliged to trump', () => {
  const hand = ['7H', '8H', 'AD', 'KC'];
  // Led spades, holds no spades, trump is hearts: only hearts are legal.
  const legal = pref.legalPlays(hand, 'S', 'H');
  assert.deepStrictEqual(legal.sort(), ['7H', '8H'].sort());
});

test('void in both the suit and the trump frees the hand', () => {
  const hand = ['AD', 'KC', '9C'];
  assert.deepStrictEqual(pref.legalPlays(hand, 'S', 'H').sort(), hand.sort());
  // In no-trump there is nothing to be obliged to play.
  assert.deepStrictEqual(pref.legalPlays(hand, 'S', pref.NO_TRUMP).sort(), hand.sort());
});

test('trick resolution ranks trumps above the led suit', () => {
  // Led hearts, spades are trump.
  assert.strictEqual(pref.trickWinner(['AH', 'KH', '7S'], 'H', 'S'), 2,
    'the lowest trump beats the highest non-trump');
  assert.strictEqual(pref.trickWinner(['AH', 'KH', 'QH'], 'H', 'S'), 0,
    'highest of the led suit wins when no one trumps');
  assert.strictEqual(pref.trickWinner(['7S', 'AS', 'KS'], 'S', 'S'), 1,
    'highest trump wins a trumped trick');
  assert.strictEqual(pref.trickWinner(['AH', 'AD', 'AC'], 'H', 'S'), 0,
    'off-suit discards cannot win');
  assert.strictEqual(pref.trickWinner(['AH', 'KH', '7S'], 'H', pref.NO_TRUMP), 0,
    'in no-trump a spade is just a discard');
});

test('a full hand always distributes exactly ten tricks', () => {
  for (let n = 0; n < 400; n += 1) {
    const d = pref.deal(SEED, 'full', n);
    const won = pref.playHand({
      hands: d.hands,
      trump: pref.SUITS[n % 4],
      declarer: 0,
      controller: (seat, st) => pref.chooseCard(st, seat),
    });
    assert.strictEqual(won.reduce((a, b) => a + b, 0), pref.HAND_SIZE);
    for (const w of won) assert.ok(w >= 0 && w <= pref.HAND_SIZE);
  }
});

test('the bot never plays an illegal card', () => {
  // playHand throws on an illegal play, so completing many hands is the assertion.
  for (let n = 0; n < 300; n += 1) {
    const d = pref.deal(SEED, 'legal', n);
    assert.doesNotThrow(() => pref.playHand({
      hands: d.hands,
      trump: [...pref.SUITS, pref.NO_TRUMP][n % 5],
      declarer: n % 3,
      controller: (seat, st) => pref.chooseCard(st, seat),
    }));
  }
});

test('discarding keeps ten cards and never throws a trump ace', () => {
  for (let n = 0; n < 200; n += 1) {
    const d = pref.deal(SEED, 'disc', n);
    const withTalon = pref.sortHand([...d.hands[0], ...d.talon]);
    const trump = pref.SUITS[n % 4];
    const discards = pref.chooseDiscards(withTalon, trump);
    assert.strictEqual(discards.length, 2);
    assert.strictEqual(new Set(discards).size, 2);
    for (const c of discards) assert.ok(withTalon.includes(c));
    assert.ok(!discards.includes(`A${trump}`), 'the trump ace is never the right discard');
    assert.strictEqual(withTalon.filter((c) => !discards.includes(c)).length, pref.HAND_SIZE);
  }
});

test('the payout table delivers the configured RTP', () => {
  for (const edge of [0.03, 0.05, 0.08]) {
    const t = pref.payoutTable(edge);
    const target = 1 - edge;
    assert.ok(t.rtp <= target + 1e-9, `RTP ${t.rtp} exceeds target ${target}`);
    assert.ok(target - t.rtp < 0.01, `RTP ${t.rtp} falls too far below ${target}`);
    // Six tricks returns the stake, and the curve rises from there.
    assert.strictEqual(t.pays[pref.PUSH_AT], 1);
    for (let k = pref.PUSH_AT + 1; k <= 10; k += 1) {
      assert.ok(t.pays[k] > t.pays[k - 1], `payout for ${k} tricks must beat ${k - 1}`);
    }
  }
});

test('the payout solver refuses an impossible target', () => {
  // A distribution that pushes on almost every hand cannot also return only 50%.
  const degenerate = { dist: new Array(11).fill(0) };
  degenerate.dist[6] = 0.99;
  degenerate.dist[7] = 0.01;
  assert.throws(() => pref.payoutTable(0.5, degenerate), /exceed|below|PUSH_AT/);
});

test('the stored calibration still matches how the bot actually plays', () => {
  // The payouts are priced against this exact bot. If someone changes the heuristics
  // without re-running tools/calibrate-preferans.js, the table silently becomes wrong,
  // so this test is the tripwire.
  const N = 8000;
  const seed = fair.newServerSeed();
  const dist = new Array(11).fill(0);
  let total = 0;

  for (let i = 0; i < N; i += 1) {
    const d = pref.deal(seed, 'drift', i);
    const withTalon = pref.sortHand([...d.hands[0], ...d.talon]);
    let trump = null;
    let best = -1;
    for (const t of [...pref.SUITS, pref.NO_TRUMP]) {
      const est = pref.estimateTricks(withTalon, t);
      if (est > best) { best = est; trump = t; }
    }
    const discards = pref.chooseDiscards(withTalon, trump);
    const hands = [...d.hands];
    hands[0] = withTalon.filter((c) => !discards.includes(c));
    const won = pref.playHand({
      hands, trump, declarer: 0, controller: (seat, st) => pref.chooseCard(st, seat),
    });
    dist[won[0]] += 1;
    total += won[0];
  }

  const average = total / N;
  const stored = pref.TRICK_DISTRIBUTION;
  assert.ok(Math.abs(average - stored.average) < 0.12,
    `declarer now averages ${average.toFixed(3)} tricks but the stored table says `
    + `${stored.average}. Re-run: node tools/calibrate-preferans.js`);

  // And the shape, not just the mean, must still hold.
  for (let k = 4; k <= 9; k += 1) {
    const observed = dist[k] / N;
    const expected = stored.dist[k];
    assert.ok(Math.abs(observed - expected) < 0.03,
      `P(${k} tricks) drifted from ${expected} to ${observed.toFixed(4)}; recalibrate`);
  }
});
