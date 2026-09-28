'use strict';
// A sit-and-go of Texas Hold'em.
//
// Everyone buys in for the same stake, gets the same chips, and plays until one person has
// all of them. That shape is chosen deliberately: it maps onto a staked match exactly. The
// buy-in is the stake, the chips are counters that never leave the table, and the pot at
// the end is what the escrow pays out. Nobody can bring money to the table mid-game, so
// there is nothing for the house to have to track beyond the one buy-in.
//
// The rules here are the ordinary ones, and the two that are usually got wrong are:
//
//   Side pots. A player who is all in for less than the bet can only win what they could
//   match. Paying the whole pot to a short all-in is the classic way to leak money, and a
//   test builds a three-way pot where the shortest stack wins and checks that the rest
//   goes to the best hand among the others.
//
//   Heads up. With two players the button posts the small blind and acts first before the
//   flop and last after it, which is the reverse of every other seat count. It is not a
//   detail; it changes who is under pressure on every hand.
//
// Hole cards live in the state and are filtered out per seat by the view, never sent.

const U = require('./util');
const holdem = require('./holdem');

const START_CHIPS = 1500;
const SMALL_BLIND = 10;
// Blinds rise so a sit-and-go finishes rather than grinding on for hours.
const HANDS_PER_LEVEL = 6;
const LEVELS = [1, 2, 3, 5, 8, 12, 20, 30, 50, 80];

const nextLevel = (hand) => LEVELS[Math.min(Math.floor(hand / HANDS_PER_LEVEL), LEVELS.length - 1)];
const blindsAt = (hand) => {
  const mult = nextLevel(hand);
  return { small: SMALL_BLIND * mult, big: SMALL_BLIND * 2 * mult };
};

/** Seats still holding chips. Anyone at zero is out of the tournament. */
const alive = (state) => state.chips.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);

/** Seats still in the current hand. */
const inHand = (state) => state.chips
  .map((_, i) => i)
  .filter((i) => !state.folded[i] && state.dealt[i]);

/** Seats that can still be asked to act: in the hand and not already all in. */
const canAct = (state) => inHand(state).filter((i) => !state.allIn[i]);

const nextSeat = (state, from, filter) => {
  const n = state.chips.length;
  for (let step = 1; step <= n; step += 1) {
    const seat = (from + step) % n;
    if (filter(seat)) return seat;
  }
  return -1;
};

/**
 * Start a tournament.
 * `random` is injected so a test can pin the deal.
 */
function create(seats, random = Math.random) {
  if (!Number.isInteger(seats) || seats < 2 || seats > 6) {
    throw new Error('poker is for two to six players');
  }
  const state = {
    chips: new Array(seats).fill(START_CHIPS),
    hole: new Array(seats).fill(null),
    dealt: new Array(seats).fill(false),
    folded: new Array(seats).fill(false),
    allIn: new Array(seats).fill(false),
    acted: new Array(seats).fill(false),
    bets: new Array(seats).fill(0),
    committed: new Array(seats).fill(0),
    board: [],
    deck: [],
    pot: 0,
    currentBet: 0,
    minRaise: 0,
    button: 0,
    toAct: -1,
    street: 'idle',
    hand: 0,
    finished: false,
    winner: null,
    showdown: null,
    log: [],
  };
  return deal(state, random);
}

/** Deal a new hand: blinds posted, two cards each, action opened. */
function deal(state, random = Math.random) {
  const live = alive(state);
  if (live.length <= 1) {
    return { ...state, finished: true, winner: live[0] ?? null, street: 'over', toAct: -1 };
  }

  const seats = state.chips.length;
  const deck = holdem.shuffled(random);
  const hole = new Array(seats).fill(null);
  const dealt = new Array(seats).fill(false);
  for (const seat of live) {
    hole[seat] = [deck.pop(), deck.pop()];
    dealt[seat] = true;
  }

  // The button moves to the next player who still has chips.
  const button = state.hand === 0
    ? live[0]
    : nextSeat({ ...state, chips: state.chips }, state.button, (s) => state.chips[s] > 0);

  const blinds = blindsAt(state.hand);
  const heads = live.length === 2;
  // Heads up the button is the small blind. Everywhere else it is the seat to its left.
  const smallSeat = heads ? button : nextSeat(state, button, (s) => state.chips[s] > 0);
  const bigSeat = nextSeat(state, smallSeat, (s) => state.chips[s] > 0);

  const next = {
    ...state,
    deck,
    hole,
    dealt,
    folded: new Array(seats).fill(false),
    allIn: new Array(seats).fill(false),
    acted: new Array(seats).fill(false),
    bets: new Array(seats).fill(0),
    committed: new Array(seats).fill(0),
    board: [],
    pot: 0,
    button,
    street: 'preflop',
    showdown: null,
    blinds,
    log: [{ hand: state.hand + 1, act: 'deal', blinds }],
  };

  post(next, smallSeat, blinds.small);
  post(next, bigSeat, blinds.big);
  next.currentBet = blinds.big;
  next.minRaise = blinds.big;
  // A blind is money in, not a decision: the big blind still gets to act.
  next.acted[smallSeat] = false;
  next.acted[bigSeat] = false;

  // Preflop, action is left of the big blind. Heads up that is the button itself.
  next.toAct = heads ? smallSeat : nextSeat(next, bigSeat, (s) => canAct(next).includes(s));
  if (next.toAct < 0) next.toAct = bigSeat;
  return next;
}

/** Put chips in, going all in if that is everything. */
function post(state, seat, amount) {
  const put = Math.min(amount, state.chips[seat]);
  state.chips[seat] -= put;
  state.bets[seat] += put;
  state.committed[seat] += put;
  if (state.chips[seat] === 0) state.allIn[seat] = true;
  return put;
}

/** What a seat may do right now, and what it would cost. */
function options(state, seat) {
  if (state.finished || state.toAct !== seat) return {};
  const owed = state.currentBet - state.bets[seat];
  const stack = state.chips[seat];
  const canRaiseTo = state.currentBet + state.minRaise;
  return {
    fold: true,
    check: owed === 0,
    call: owed > 0 ? Math.min(owed, stack) : 0,
    // Raising needs more than the call; if the stack cannot cover a full raise the only
    // way up is all in, which the rules allow and this reports honestly.
    raise: stack > owed ? Math.min(canRaiseTo, state.bets[seat] + stack) : 0,
    minRaiseTo: canRaiseTo,
    maxRaiseTo: state.bets[seat] + stack,
    allIn: stack,
    owed,
  };
}

/** Is the betting round finished? */
function roundClosed(state) {
  const live = canAct(state);
  if (live.length === 0) return true;
  // Everyone who can still act has acted, and nobody owes anything.
  return live.every((s) => state.acted[s] && state.bets[s] === state.currentBet);
}

const STREETS = ['preflop', 'flop', 'turn', 'river'];

/** Move the chips in front of people into the pot and open the next street. */
function advance(state) {
  const next = { ...state };
  next.pot = state.pot + state.bets.reduce((a, b) => a + b, 0);
  next.bets = new Array(state.chips.length).fill(0);
  next.acted = new Array(state.chips.length).fill(false);
  next.currentBet = 0;
  next.minRaise = state.blinds.big;

  if (inHand(next).length <= 1) return settleHand(next);

  const at = STREETS.indexOf(state.street);
  if (at === STREETS.length - 1) return settleHand(next);

  const deck = state.deck.slice();
  const board = state.board.slice();
  // A card is burned before each community card, as at a real table. It changes nothing
  // about the odds and everything about whether the deck order is reproducible.
  deck.pop();
  if (at === 0) board.push(deck.pop(), deck.pop(), deck.pop());
  else board.push(deck.pop());

  next.deck = deck;
  next.board = board;
  next.street = STREETS[at + 1];
  next.log = [...state.log, { act: 'street', street: next.street, board: board.slice() }];

  // If nobody can act any more the hand runs out on its own.
  if (canAct(next).length <= 1 && inHand(next).length > 1) {
    const stillOwed = canAct(next).some((s) => next.bets[s] < next.currentBet);
    if (!stillOwed) return advance(next);
  }

  next.toAct = nextSeat(next, next.button, (s) => canAct(next).includes(s));
  if (next.toAct < 0) return advance(next);
  return next;
}

/**
 * Split the pot into a main pot and any side pots.
 *
 * A player who is all in for less than the bets around them can only win what everyone
 * else also put in up to that amount. Getting this wrong pays a short stack the whole pot,
 * which is money out of somebody else's stack.
 */
function buildPots(committed, eligible) {
  const left = committed.slice();
  const pots = [];
  for (;;) {
    const contributors = left.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
    if (!contributors.length) break;
    const step = Math.min(...contributors.map((i) => left[i]));
    let amount = 0;
    for (const i of contributors) { left[i] -= step; amount += step; }
    const claimants = contributors.filter((i) => eligible[i]);
    const last = pots[pots.length - 1];
    // Consecutive layers with the same claimants are one pot, not two.
    if (last && last.eligible.join() === claimants.join()) last.amount += amount;
    else pots.push({ amount, eligible: claimants });
  }
  return pots;
}

/** Work out who won, pay the pots, and start the next hand. */
function settleHand(state) {
  const next = { ...state };
  next.pot = state.pot + state.bets.reduce((a, b) => a + b, 0);
  next.bets = new Array(state.chips.length).fill(0);

  const contenders = inHand(next);
  const chips = state.chips.slice();

  // Give back anything nobody matched.
  //
  // If you bet 300 and the most anyone else put in was 140, then 160 of yours was never
  // called and it comes straight back. Skipping this is not a rounding error: those chips
  // belong to a pot no remaining player is eligible for, so they simply disappear, which
  // is how a table quietly loses money over a long session.
  const committed = next.committed.slice();
  for (let i = 0; i < committed.length; i += 1) {
    const maxOther = committed.reduce((m, c, j) => (j === i ? m : Math.max(m, c)), 0);
    if (committed[i] > maxOther) {
      chips[i] += committed[i] - maxOther;
      committed[i] = maxOther;
    }
  }

  const eligible = state.chips.map((_, i) => contenders.includes(i));
  const pots = buildPots(committed, eligible);

  const scores = new Map();
  if (contenders.length > 1) {
    for (const seat of contenders) {
      scores.set(seat, holdem.score([...next.board, ...next.hole[seat]]));
    }
  }

  const awards = [];
  for (const pot of pots) {
    if (!pot.eligible.length) continue;
    let winners;
    if (pot.eligible.length === 1 || contenders.length === 1) {
      winners = [pot.eligible[0]];
    } else {
      const best = Math.max(...pot.eligible.map((s) => scores.get(s)));
      winners = pot.eligible.filter((s) => scores.get(s) === best);
    }
    const each = Math.floor(pot.amount / winners.length);
    for (const seat of winners) chips[seat] += each;
    // An odd chip goes to the first winner left of the button, which is the usual rule
    // and beats letting it vanish.
    let odd = pot.amount - each * winners.length;
    let seat = next.button;
    while (odd > 0) {
      seat = nextSeat(next, seat, (s) => winners.includes(s));
      chips[seat] += 1;
      odd -= 1;
    }
    awards.push({ amount: pot.amount, winners });
  }

  const shown = contenders.length > 1
    ? contenders.map((seat) => ({
      seat, hole: next.hole[seat].slice(), hand: holdem.describe(scores.get(seat)),
    }))
    : [];

  const after = {
    ...next,
    chips,
    // The pot has been paid out, so it is empty. Leaving the figure standing counts the
    // same chips twice: once in the stacks that just received them and once here.
    pot: 0,
    committed: new Array(next.chips.length).fill(0),
    street: 'showdown',
    toAct: -1,
    showdown: { awards, shown, board: next.board.slice() },
    hand: state.hand + 1,
    log: [...state.log, { act: 'showdown', awards }],
  };

  const left = alive(after);
  if (left.length <= 1) {
    return { ...after, finished: true, winner: left[0] ?? null, street: 'over' };
  }
  return after;
}

/** Deal the next hand after a showdown. */
const nextHand = (state, random = Math.random) => (
  state.finished ? state : deal({ ...state, showdown: null }, random)
);

// --------------------------------------------------------------------- acting
function act(state, seat, move, amount) {
  if (state.finished) throw new U.BadRequest('the tournament is over');
  if (state.street === 'showdown') throw new U.BadRequest('the hand is over');
  if (state.toAct !== seat) throw new U.BadRequest('not your turn');

  const o = options(state, seat);
  const next = {
    ...state,
    chips: state.chips.slice(),
    bets: state.bets.slice(),
    committed: state.committed.slice(),
    folded: state.folded.slice(),
    allIn: state.allIn.slice(),
    acted: state.acted.slice(),
  };

  if (move === 'fold') {
    next.folded[seat] = true;
  } else if (move === 'check') {
    if (!o.check) throw new U.BadRequest(`you owe ${o.owed}; check is not an option`);
  } else if (move === 'call') {
    if (o.owed <= 0) throw new U.BadRequest('there is nothing to call');
    post(next, seat, o.owed);
  } else if (move === 'raise') {
    const to = Number(amount);
    if (!Number.isSafeInteger(to)) throw new U.BadRequest('bad raise');
    if (to > o.maxRaiseTo) throw new U.BadRequest('you do not have that many chips');
    // A raise below the minimum is only allowed when it is everything you have, which is
    // the rule that lets a short stack shove without re-opening the betting.
    if (to < o.minRaiseTo && to !== o.maxRaiseTo) {
      throw new U.BadRequest(`a raise must be to at least ${o.minRaiseTo}`);
    }
    if (to <= state.currentBet) throw new U.BadRequest('a raise must be more than the bet');
    post(next, seat, to - state.bets[seat]);
    const raiseBy = to - state.currentBet;
    next.currentBet = to;
    // Only a full raise reopens the betting for players who have already acted.
    if (raiseBy >= state.minRaise) {
      next.minRaise = raiseBy;
      for (let s = 0; s < next.acted.length; s += 1) if (s !== seat) next.acted[s] = false;
    }
  } else if (move === 'allin') {
    const to = state.bets[seat] + state.chips[seat];
    post(next, seat, state.chips[seat]);
    if (to > state.currentBet) {
      const raiseBy = to - state.currentBet;
      next.currentBet = to;
      if (raiseBy >= state.minRaise) {
        next.minRaise = raiseBy;
        for (let s = 0; s < next.acted.length; s += 1) if (s !== seat) next.acted[s] = false;
      }
    }
  } else {
    throw new U.BadRequest('no such move');
  }

  next.acted[seat] = true;
  next.log = [...state.log, { seat, act: move, amount: next.bets[seat] }];

  if (inHand(next).length === 1) return settleHand(next);
  if (roundClosed(next)) return advance(next);

  next.toAct = nextSeat(next, seat, (s) => canAct(next).includes(s) && !next.folded[s]);
  if (next.toAct < 0) return advance(next);
  return next;
}

/** Fold a seat out of the tournament entirely, surrendering their chips. */
function quit(state, seat) {
  const next = {
    ...state,
    chips: state.chips.slice(),
    folded: state.folded.slice(),
  };
  next.folded[seat] = true;
  next.chips[seat] = 0;
  if (state.toAct === seat) {
    const after = nextSeat(next, seat, (s) => canAct(next).includes(s));
    next.toAct = after;
  }
  const left = alive(next);
  if (left.length <= 1) return { ...next, finished: true, winner: left[0] ?? null, street: 'over' };
  if (inHand(next).length <= 1) return settleHand(next);
  return next;
}

/** What one seat may see: its own cards, and everything public. */
function view(state, seat) {
  const mine = seat === null || seat === undefined ? null : state.hole[seat];
  return {
    board: state.board.slice(),
    pot: state.pot + state.bets.reduce((a, b) => a + b, 0),
    chips: state.chips.slice(),
    bets: state.bets.slice(),
    folded: state.folded.slice(),
    allIn: state.allIn.slice(),
    dealt: state.dealt.slice(),
    button: state.button,
    blinds: state.blinds,
    street: state.street,
    toAct: state.toAct,
    hand: state.hand,
    currentBet: state.currentBet,
    finished: !!state.finished,
    winner: state.winner,
    // Everyone's cards at a showdown, nobody's before one. This is the only place hole
    // cards leave the server, and only after they are public anyway.
    showdown: state.showdown,
    hole: mine ? mine.slice() : null,
    options: seat === null || seat === undefined ? {} : options(state, seat),
    log: state.log.slice(-16),
  };
}

module.exports = {
  START_CHIPS, SMALL_BLIND, HANDS_PER_LEVEL, LEVELS,
  blindsAt, alive, inHand, canAct, create, deal, nextHand,
  options, act, quit, view, buildPots, roundClosed, settleHand,
};
