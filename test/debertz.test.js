'use strict';
// Debertz (Klaberjass). The rules that matter most here are the ones that are easy to get
// subtly wrong and impossible to notice afterwards: the trump ranking, the obligation to
// overtrump, and the bete rule.
const test = require('node:test');
const assert = require('node:assert');
const deb = require('../src/games/debertz');
const fair = require('../src/fair');

const SEED = fair.newServerSeed();
const T = 'S';

test('trumps rank differently from every other suit', () => {
  // This is the whole character of the game. In trumps the jack is highest and the nine
  // is second; elsewhere the ace leads and the jack is almost worthless.
  assert.ok(deb.strength('JS', T) > deb.strength('9S', T));
  assert.ok(deb.strength('9S', T) > deb.strength('AS', T));
  assert.ok(deb.strength('AS', T) > deb.strength('TS', T));
  assert.ok(deb.strength('TS', T) > deb.strength('KS', T));

  assert.ok(deb.strength('AH', T) > deb.strength('TH', T));
  assert.ok(deb.strength('TH', T) > deb.strength('KH', T));
  assert.ok(deb.strength('KH', T) > deb.strength('JH', T));
  assert.ok(deb.strength('JH', T) > deb.strength('9H', T));
});

test('card values follow the trump ranking too', () => {
  assert.strictEqual(deb.points('JS', T), 20);
  assert.strictEqual(deb.points('9S', T), 14);
  assert.strictEqual(deb.points('AS', T), 11);
  // The same cards are worth almost nothing off-trump.
  assert.strictEqual(deb.points('JH', T), 2);
  assert.strictEqual(deb.points('9H', T), 0);
  assert.strictEqual(deb.points('AH', T), 11);

  // A full pack is worth 152 in card points regardless of which suit is trumps.
  for (const trump of deb.SUITS) {
    const total = deb.DECK.reduce((sum, c) => sum + deb.points(c, trump), 0);
    assert.strictEqual(total, 152, `total with ${trump} trumps`);
  }
});

test('every deal is nine, nine and an upcard, all distinct', () => {
  for (let n = 0; n < 300; n += 1) {
    const d = deb.deal(SEED, 'c', n);
    assert.strictEqual(d.hands[0].length, 9);
    assert.strictEqual(d.hands[1].length, 9);
    const all = [...d.hands[0], ...d.hands[1], d.upcard];
    assert.strictEqual(new Set(all).size, 19, 'no card may appear twice');
    for (const c of all) assert.ok(deb.DECK.includes(c), `unknown card ${c}`);
  }
});

test('the same seed always deals the same cards', () => {
  assert.deepStrictEqual(deb.deal(SEED, 'c', 5), deb.deal(SEED, 'c', 5));
  assert.notDeepStrictEqual(deb.deal(SEED, 'c', 5), deb.deal(SEED, 'c', 6));
});

test('following the led suit comes before everything else', () => {
  const hand = ['9S', 'JS', '7H', 'KH'];
  assert.deepStrictEqual(
    deb.legalPlays(hand, [{ seat: 1, card: 'AH' }], T).sort(),
    ['7H', 'KH'].sort(),
    'holding hearts, only hearts are legal even though trumps are available',
  );
});

test('void in the led suit obliges you to trump', () => {
  const hand = ['9S', 'JS', '7D', 'KD'];
  assert.deepStrictEqual(
    deb.legalPlays(hand, [{ seat: 1, card: 'AH' }], T).sort(),
    ['9S', 'JS'].sort(),
  );
});

test('a trumped trick obliges you to overtrump when you can', () => {
  const hand = ['8S', '9S', 'JS', '7D'];
  // Queen of trumps is already down; only higher trumps are legal, so the 8 is out.
  assert.deepStrictEqual(
    deb.legalPlays(hand, [{ seat: 1, card: 'AH' }, { seat: 1, card: 'QS' }], T).sort(),
    ['9S', 'JS'].sort(),
  );
});

test('holding nothing higher, you may discard instead of wasting a trump', () => {
  const hand = ['9S', '8S', '7D', 'KD'];
  // The jack is the top trump, so nothing can beat it and the hand is freed.
  assert.deepStrictEqual(
    deb.legalPlays(hand, [{ seat: 1, card: 'AH' }, { seat: 1, card: 'JS' }], T).sort(),
    hand.slice().sort(),
  );
});

test('overtrumping applies when trumps themselves are led', () => {
  const hand = ['7S', '9S', 'JS'];
  assert.deepStrictEqual(
    deb.legalPlays(hand, [{ seat: 1, card: 'TS' }], T).sort(),
    ['9S', 'JS'].sort(),
    'the seven cannot beat the ten, so it is not a legal follow',
  );
});

test('trick resolution respects the trump order', () => {
  const trick = (a, b) => deb.trickWinner([{ seat: 0, card: a }, { seat: 1, card: b }], T);
  assert.strictEqual(trick('AS', 'JS'), 1, 'the jack of trumps beats the ace of trumps');
  assert.strictEqual(trick('AS', '9S'), 1, 'the nine of trumps beats the ace of trumps');
  assert.strictEqual(trick('AH', '7S'), 1, 'the lowest trump beats the highest plain card');
  assert.strictEqual(trick('AH', 'KH'), 0, 'highest of the led suit wins when untrumped');
  assert.strictEqual(trick('AH', 'AD'), 0, 'an off-suit discard cannot win');
});

test('melds score by length and only the best one counts', () => {
  assert.strictEqual(deb.bestMeld(['7S', '8S', '9S', 'AH']).value, 20);
  assert.strictEqual(deb.bestMeld(['7S', '8S', '9S', 'TS']).value, 50);
  assert.strictEqual(deb.bestMeld(['TS', 'JS', 'QS', 'KS', 'AS']).value, 100);
  assert.strictEqual(deb.bestMeld(['7S', '9S', 'JS', 'KS']).value, 0, 'gaps are not a run');
  // A run must be in one suit.
  assert.strictEqual(deb.bestMeld(['7S', '8H', '9D']).value, 0);
});

test('bella is the king and queen of trumps, and nothing else', () => {
  assert.ok(deb.hasBella(['KS', 'QS', '7H'], 'S'));
  assert.ok(!deb.hasBella(['KH', 'QH', '7S'], 'S'));
  assert.ok(!deb.hasBella(['KS', '7H'], 'S'));
});

test('going bete costs the whole hand, not the difference', () => {
  const hands = [['7H'], ['8H']];
  // Chooser trails 40 to 60: everything goes to the opponent and the chooser gets zero.
  const lost = deb.score({ hands, trump: 'S', cardPoints: [40, 60], chooser: 0 });
  assert.strictEqual(lost.bete, true);
  assert.strictEqual(lost.final[0], 0);
  assert.strictEqual(lost.final[1], 100);

  // A tie also counts as bete: the chooser must finish strictly ahead.
  const tied = deb.score({ hands, trump: 'S', cardPoints: [50, 50], chooser: 0 });
  assert.strictEqual(tied.bete, true);

  const won = deb.score({ hands, trump: 'S', cardPoints: [60, 40], chooser: 0 });
  assert.strictEqual(won.bete, false);
  assert.deepStrictEqual(won.final, [60, 40]);
});

test('a hand always plays to completion and the bot never cheats', () => {
  // playHand throws on an illegal play, so finishing many hands is the assertion.
  let errors = 0;
  for (let n = 0; n < 400; n += 1) {
    try {
      const d = deb.deal(SEED, 'legal', n);
      const played = deb.playHand({
        hands: d.hands,
        trump: deb.SUITS[n % 4],
        leader: n % 2,
        controller: (seat, st) => deb.botCard(st),
      });
      // Card points plus the ten for the last trick must be conserved.
      const dealtTotal = [...d.hands[0], ...d.hands[1]]
        .reduce((sum, c) => sum + deb.points(c, deb.SUITS[n % 4]), 0);
      assert.strictEqual(played.cardPoints[0] + played.cardPoints[1], dealtTotal + 10);
      assert.strictEqual(played.log.length, deb.HAND_SIZE);
    } catch (e) {
      errors += 1;
      if (errors === 1) throw e;
    }
  }
  assert.strictEqual(errors, 0);
});

test('the payout table never turns a win into a loss', () => {
  for (const edge of [0.01, 0.03, 0.05, 0.08]) {
    const table = deb.payoutTable(edge);
    const target = 1 - edge;
    assert.ok(table.rtp <= target + 1e-9, `RTP ${table.rtp} exceeds ${target}`);
    assert.ok(target - table.rtp < 0.01, `RTP ${table.rtp} falls too far below ${target}`);
    // The chooser wins four hands in five, which squeezes the pricing hard. Every band
    // must still return at least the stake, or "you won" would quietly mean "you lost".
    for (const pay of table.pays) assert.ok(pay >= 1, `a band pays ${pay}x`);
    for (let i = 1; i < table.pays.length; i += 1) {
      assert.ok(table.pays[i] >= table.pays[i - 1], 'a wider margin must never pay less');
    }
  }
});

test('the payout solver refuses an impossible distribution', () => {
  // A bot that wins every hand cannot be priced at a 50% return.
  // Every hand landing in the top band leaves nothing to pay the lower ones with, so the
  // solver must refuse rather than quietly price a "win" below the stake.
  const impossible = { bands: [0, 20, 50, 90, 140], probs: [1, 1, 1, 1, 1] };
  assert.throws(() => deb.payoutTable(0.5, impossible), /turns a win into a loss/);

  // A bot that never loses cannot be priced at any edge at all.
  const unbeatable = { bands: [0, 20, 50, 90, 140], probs: [1, 0, 0, 0, 0] };
  assert.throws(() => deb.payoutTable(0.5, unbeatable), /degenerate|too often|below/);
});

test('bete pays nothing and margins map to the right band', () => {
  const table = deb.payoutTable(0.05);
  assert.strictEqual(deb.payoutFor({ bete: true, margin: 200 }, table).multiplier, 0);
  assert.strictEqual(deb.payoutFor({ bete: false, margin: 0 }, table).band, 0);
  assert.strictEqual(deb.payoutFor({ bete: false, margin: 19 }, table).band, 0);
  assert.strictEqual(deb.payoutFor({ bete: false, margin: 20 }, table).band, 1);
  assert.strictEqual(deb.payoutFor({ bete: false, margin: 500 }, table).band, 4);
});

test('the stored calibration still matches how the bot actually plays', () => {
  // The payouts are priced against this exact bot. If someone changes the heuristics
  // without re-running tools/calibrate-debertz.js the table silently becomes wrong, so
  // this test is the tripwire.
  const N = 8000;
  const seed = fair.newServerSeed();
  let wins = 0;
  for (let i = 0; i < N; i += 1) {
    if (!deb.simulateHand(seed, 'drift', i).bete) wins += 1;
  }
  const rate = wins / N;
  const stored = deb.OUTCOMES.probs[0];
  assert.ok(Math.abs(rate - stored) < 0.03,
    `the chooser now wins ${(rate * 100).toFixed(2)}% of hands but the stored table says `
    + `${(stored * 100).toFixed(2)}%. Re-run: node tools/calibrate-debertz.js`);
});
