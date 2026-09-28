'use strict';
// Texas Hold'em: the cards, the hand ranking, and the betting.
//
// This file knows nothing about tokens, seats in a database, or clocks. It is the rules of
// a hand of poker, and it is pure: every function takes a state and returns a new one.
//
// The part worth being careful about is the evaluator. Ranking seven cards means choosing
// the best five, and the obvious shortcuts are all wrong in ways that only show up on the
// hand that matters: a straight that wraps the ace at the bottom, a flush that is also a
// straight, three pair where only two of them count, a board that plays and splits the pot
// between everyone still in. Every one of those has a test.
//
// Hands are scored as a single comparable number rather than a category plus kickers.
// One number means comparing two hands is `>`, and a tie is `===`, which removes a whole
// family of bugs around split pots.

const U = require('./util');

const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

const rankOf = (card) => card[0];
const suitOf = (card) => card[1];
const rankValue = (card) => RANKS.indexOf(rankOf(card)) + 2;   // 2..14

const CATEGORY = {
  HIGH: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

const CATEGORY_NAME = [
  'high card', 'a pair', 'two pair', 'three of a kind', 'a straight',
  'a flush', 'a full house', 'four of a kind', 'a straight flush',
];

function freshDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(`${rank}${suit}`);
  return deck;
}

function shuffled(random = Math.random) {
  const deck = freshDeck();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * The highest card of a straight in this set of rank values, or 0.
 *
 * The ace counts low as well as high, so A-2-3-4-5 is a straight with the five at the top.
 * Leaving that out is the single most common evaluator bug, and it loses somebody a pot
 * roughly once every few hundred hands.
 */
function straightHigh(values) {
  const set = new Set(values);
  if (set.has(14)) set.add(1);
  const sorted = [...set].sort((a, b) => b - a);
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1] - 1) {
      run += 1;
      if (run >= 5) return sorted[i] + 4;
    } else {
      run = 1;
    }
  }
  return 0;
}

/**
 * Score a hand of five to seven cards as one comparable number.
 *
 * The layout is category, then five tiebreak values, each in its own base-16 digit. Two
 * hands compare with `>` and tie with `===`, so a split pot needs no special case.
 */
function score(cards) {
  if (cards.length < 5) throw new Error('a hand is at least five cards');

  const byRank = new Map();
  const bySuit = new Map();
  for (const card of cards) {
    const v = rankValue(card);
    byRank.set(v, (byRank.get(v) || 0) + 1);
    if (!bySuit.has(suitOf(card))) bySuit.set(suitOf(card), []);
    bySuit.get(suitOf(card)).push(v);
  }

  const pack = (category, ...tiebreaks) => {
    let n = category;
    for (let i = 0; i < 5; i += 1) n = n * 16 + (tiebreaks[i] || 0);
    return n;
  };

  // A flush, and possibly a straight flush. Only one suit can have five of seven cards,
  // so there is never a choice to make here.
  const flushSuit = [...bySuit.entries()].find(([, vs]) => vs.length >= 5);
  if (flushSuit) {
    const vs = flushSuit[1].slice().sort((a, b) => b - a);
    const sfHigh = straightHigh(vs);
    if (sfHigh) return pack(CATEGORY.STRAIGHT_FLUSH, sfHigh);
    return pack(CATEGORY.FLUSH, ...vs.slice(0, 5));
  }

  const straight = straightHigh([...byRank.keys()]);

  // Rank groups, biggest group first and then highest rank, which is the order every
  // remaining category wants.
  const groups = [...byRank.entries()]
    .sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
  const [topRank, topCount] = groups[0];
  const second = groups[1];

  if (topCount === 4) {
    const kicker = groups.slice(1).map(([v]) => v).sort((a, b) => b - a)[0];
    return pack(CATEGORY.QUADS, topRank, kicker);
  }
  if (topCount === 3 && second && second[1] >= 2) {
    return pack(CATEGORY.FULL_HOUSE, topRank, second[0]);
  }
  if (straight) return pack(CATEGORY.STRAIGHT, straight);
  if (topCount === 3) {
    const kickers = groups.slice(1).map(([v]) => v).sort((a, b) => b - a).slice(0, 2);
    return pack(CATEGORY.TRIPS, topRank, ...kickers);
  }
  if (topCount === 2 && second && second[1] === 2) {
    // Three pair is possible with seven cards; only the top two count, and the kicker is
    // the best card left, which may be the third pair.
    const pairs = groups.filter(([, n]) => n === 2).map(([v]) => v).sort((a, b) => b - a);
    const rest = groups.filter(([v]) => v !== pairs[0] && v !== pairs[1])
      .map(([v]) => v).sort((a, b) => b - a);
    return pack(CATEGORY.TWO_PAIR, pairs[0], pairs[1], rest[0]);
  }
  if (topCount === 2) {
    const kickers = groups.slice(1).map(([v]) => v).sort((a, b) => b - a).slice(0, 3);
    return pack(CATEGORY.PAIR, topRank, ...kickers);
  }
  const high = groups.map(([v]) => v).sort((a, b) => b - a).slice(0, 5);
  return pack(CATEGORY.HIGH, ...high);
}

/** What to call the hand a score represents. */
const describe = (value) => CATEGORY_NAME[Math.floor(value / (16 ** 5))] || 'nothing';

module.exports = {
  SUITS, RANKS, CATEGORY, CATEGORY_NAME,
  rankOf, suitOf, rankValue, freshDeck, shuffled, straightHigh, score, describe,
};
