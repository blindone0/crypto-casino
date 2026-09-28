'use strict';
// The Hold'em hand evaluator.
//
// This is the piece that decides who gets the money, so it is tested harder than anything
// else in the game. The failures it is built to catch are all quiet ones: they do not
// throw, they do not look wrong on screen, they just hand a pot to the wrong player on the
// hand where it mattered.
//
// The classics, each with a test below:
//   - the wheel, A-2-3-4-5, which is a straight with the five on top
//   - a straight that runs through the ace and does not wrap: Q-K-A-2-3 is not a straight
//   - three pair in seven cards, where only the top two count
//   - a flush that is also a straight, which is neither of those things but a straight flush
//   - kickers, which decide most hands that are not obviously decided

const test = require('node:test');
const assert = require('node:assert');
const holdem = require('../src/holdem');

const better = (a, b) => holdem.score(a) > holdem.score(b);
const same = (a, b) => holdem.score(a) === holdem.score(b);

test('the deck is fifty-two distinct cards', () => {
  const deck = holdem.freshDeck();
  assert.strictEqual(deck.length, 52);
  assert.strictEqual(new Set(deck).size, 52);
  assert.ok(deck.includes('2s') && deck.includes('Ac'));
});

test('a shuffle keeps every card exactly once', () => {
  for (let i = 0; i < 50; i += 1) {
    const deck = holdem.shuffled();
    assert.strictEqual(new Set(deck).size, 52);
  }
});

// ------------------------------------------------------------- the categories
test('the categories rank in the right order', () => {
  const hands = [
    ['2s', '7h', '9d', 'Jc', 'Kh'],                 // high card
    ['2s', '2h', '9d', 'Jc', 'Kh'],                 // pair
    ['2s', '2h', '9d', '9c', 'Kh'],                 // two pair
    ['2s', '2h', '2d', '9c', 'Kh'],                 // trips
    ['5s', '6h', '7d', '8c', '9h'],                 // straight
    ['2s', '7s', '9s', 'Js', 'Ks'],                 // flush
    ['2s', '2h', '2d', '9c', '9h'],                 // full house
    ['2s', '2h', '2d', '2c', '9h'],                 // quads
    ['5s', '6s', '7s', '8s', '9s'],                 // straight flush
  ];
  for (let i = 1; i < hands.length; i += 1) {
    assert.ok(better(hands[i], hands[i - 1]),
      `${holdem.describe(holdem.score(hands[i]))} should beat ${holdem.describe(holdem.score(hands[i - 1]))}`);
  }
});

test('each hand is named correctly', () => {
  const named = [
    [['2s', '7h', '9d', 'Jc', 'Kh'], 'high card'],
    [['2s', '2h', '9d', 'Jc', 'Kh'], 'a pair'],
    [['2s', '2h', '9d', '9c', 'Kh'], 'two pair'],
    [['2s', '2h', '2d', '9c', 'Kh'], 'three of a kind'],
    [['5s', '6h', '7d', '8c', '9h'], 'a straight'],
    [['2s', '7s', '9s', 'Js', 'Ks'], 'a flush'],
    [['2s', '2h', '2d', '9c', '9h'], 'a full house'],
    [['2s', '2h', '2d', '2c', '9h'], 'four of a kind'],
    [['5s', '6s', '7s', '8s', '9s'], 'a straight flush'],
  ];
  for (const [hand, name] of named) {
    assert.strictEqual(holdem.describe(holdem.score(hand)), name);
  }
});

// -------------------------------------------------------------- the straights
test('the wheel is a straight, with the five on top', () => {
  const wheel = ['As', '2h', '3d', '4c', '5h'];
  assert.strictEqual(holdem.describe(holdem.score(wheel)), 'a straight');
  // And it is the lowest straight: six high beats it.
  assert.ok(better(['2s', '3h', '4d', '5c', '6h'], wheel));
  assert.strictEqual(holdem.straightHigh([14, 2, 3, 4, 5]), 5);
});

test('a straight does not wrap around the ace', () => {
  assert.strictEqual(holdem.straightHigh([12, 13, 14, 2, 3]), 0, 'Q-K-A-2-3 is nothing');
  assert.strictEqual(holdem.describe(holdem.score(['Qs', 'Kh', 'Ad', '2c', '3h'])), 'high card');
});

test('broadway is the best straight', () => {
  const broadway = ['Ts', 'Jh', 'Qd', 'Kc', 'Ah'];
  assert.strictEqual(holdem.straightHigh([10, 11, 12, 13, 14]), 14);
  assert.ok(better(broadway, ['9s', 'Th', 'Jd', 'Qc', 'Kh']));
});

test('a straight is found inside seven cards', () => {
  const seven = ['2s', '5h', '6d', '7c', '8h', '9s', 'Kd'];
  assert.strictEqual(holdem.describe(holdem.score(seven)), 'a straight');
  // Nine high, not the five that also completes one lower down.
  assert.ok(same(['5h', '6d', '7c', '8h', '9s'], seven));
});

// ---------------------------------------------------------------- the flushes
test('a flush beats a straight, and the highest flush wins', () => {
  assert.ok(better(['2s', '7s', '9s', 'Js', 'Ks'], ['5s', '6h', '7d', '8c', '9h']));
  assert.ok(better(['As', '7s', '9s', 'Js', '3s'], ['Ks', '7s', '9s', 'Js', '3h'].map((c, i) => (i === 4 ? '3s' : c))));
});

test('a flush and a straight in the same seven cards is a straight flush', () => {
  // Five spades that also run: this is not "a flush" and not "a straight".
  const seven = ['5s', '6s', '7s', '8s', '9s', 'Kh', '2d'];
  assert.strictEqual(holdem.describe(holdem.score(seven)), 'a straight flush');
});

test('a flush and a straight in different suits is only a flush', () => {
  // Spades make a flush; the ranks also make a straight, but not in one suit.
  const seven = ['2s', '4s', '6s', '8s', 'Ts', '3h', '5d'];
  assert.strictEqual(holdem.describe(holdem.score(seven)), 'a flush');
});

test('the steel wheel is a straight flush, five high', () => {
  const steel = ['As', '2s', '3s', '4s', '5s'];
  assert.strictEqual(holdem.describe(holdem.score(steel)), 'a straight flush');
  // And the lowest one: six-high beats it.
  assert.ok(better(['2s', '3s', '4s', '5s', '6s'], steel));
});

// ------------------------------------------------------------------ the pairs
test('three pair in seven cards counts only the top two', () => {
  // Kings, nines and fours, with an ace. The fours do not play; the ace is the kicker.
  const seven = ['Ks', 'Kh', '9d', '9c', '4h', '4s', 'Ad'];
  assert.strictEqual(holdem.describe(holdem.score(seven)), 'two pair');
  assert.ok(same(seven, ['Ks', 'Kh', '9d', '9c', 'Ad']), 'the fours are not in the hand');
});

test('the third pair can still be the kicker when it is high enough', () => {
  // Kings, queens and jacks: the jack is the best remaining card.
  const seven = ['Ks', 'Kh', 'Qd', 'Qc', 'Jh', 'Js', '3d'];
  assert.ok(same(seven, ['Ks', 'Kh', 'Qd', 'Qc', 'Jh']));
});

test('a full house prefers the higher trips, then the higher pair', () => {
  assert.ok(better(['9s', '9h', '9d', '2c', '2h'], ['8s', '8h', '8d', 'Ac', 'Ah']),
    'nines full beats eights full, whatever the pair');
  assert.ok(better(['9s', '9h', '9d', 'Ac', 'Ah'], ['9s', '9h', '9d', '2c', '2h']));
});

test('two sets of trips in seven cards is a full house', () => {
  const seven = ['9s', '9h', '9d', '5c', '5h', '5d', 'Kd'];
  assert.strictEqual(holdem.describe(holdem.score(seven)), 'a full house');
  // Nines full of fives, not fives full of nines.
  assert.ok(same(seven, ['9s', '9h', '9d', '5c', '5h']));
});

test('quads take the best kicker from what is left', () => {
  const seven = ['7s', '7h', '7d', '7c', '2h', '9s', 'Kd'];
  assert.ok(same(seven, ['7s', '7h', '7d', '7c', 'Kd']));
  assert.ok(better(seven, ['7s', '7h', '7d', '7c', '9s']));
});

// ---------------------------------------------------------------- the kickers
test('kickers decide a shared pair', () => {
  assert.ok(better(['As', 'Ah', 'Kd', '7c', '3h'], ['As', 'Ah', 'Qd', 'Jc', 'Th']));
  assert.ok(better(['As', 'Ah', 'Kd', 'Qc', '3h'], ['As', 'Ah', 'Kd', 'Jc', 'Th']));
  assert.ok(same(['As', 'Ah', 'Kd', 'Qc', '3h'], ['Ac', 'Ad', 'Kh', 'Qs', '3d']),
    'identical ranks in different suits tie');
});

test('only five cards count, so the sixth and seventh never break a tie', () => {
  // Both players play the board: an ace-high straight on the table.
  const board = ['Ts', 'Jh', 'Qd', 'Kc', 'Ah'];
  const one = [...board, '2s', '3h'];
  const two = [...board, '7d', '8c'];
  assert.ok(same(one, two), 'the board plays and the pot is split');
});

test('a higher pair beats a lower one however good the kickers', () => {
  assert.ok(better(['3s', '3h', '4d', '5c', '7h'], ['2s', '2h', 'Ad', 'Kc', 'Qh']));
});

// ---------------------------------------------------------------- consistency
test('scoring is stable and order does not matter', () => {
  const hand = ['9s', '2h', 'Kd', '9c', '4h'];
  const shuffledHand = ['4h', '9c', '9s', 'Kd', '2h'];
  assert.strictEqual(holdem.score(hand), holdem.score(shuffledHand));
});

test('seven cards never score worse than the best five inside them', () => {
  // Brute force: for a sample of random sevens, check the evaluator agrees with taking
  // the best of all twenty-one five-card subsets.
  const best5 = (cards) => {
    let top = 0;
    for (let a = 0; a < 7; a += 1) {
      for (let b = a + 1; b < 7; b += 1) {
        const five = cards.filter((_, i) => i !== a && i !== b);
        top = Math.max(top, holdem.score(five));
      }
    }
    return top;
  };
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 400; trial += 1) {
    const seven = holdem.shuffled(rnd).slice(0, 7);
    assert.strictEqual(holdem.score(seven), best5(seven),
      `seven-card score disagreed with the best five in ${seven.join(' ')}`);
  }
});

test('a hand shorter than five cards is refused rather than guessed at', () => {
  assert.throws(() => holdem.score(['As', 'Kh']), /at least five/);
  assert.throws(() => holdem.score([]), /at least five/);
});
