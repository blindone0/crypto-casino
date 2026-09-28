'use strict';
// Дурак переводной.
//
// A thirty-six card deck, six cards each, and the bottom card of the stock turned to set
// trumps and left under it. The player with the lowest trump attacks first.
//
// An attack is one card. The defender either beats it with a higher card of the same suit
// or any trump, or picks the whole thing up. Once a card has been beaten, anyone may throw
// in another of a rank already on the table, up to six cards or the number the defender
// still holds, whichever is smaller.
//
// The переводной part is the variant: instead of defending, the defender may pass the
// attack on to the next player by adding a card of the same rank as the attack. The new
// defender faces everything already on the table. That is only possible while nothing has
// been beaten yet, and only if that next player holds at least as many cards as the attack
// would become.
//
// Everyone refills to six from the stock between hands, attacker first. When the stock is
// empty and a player runs out of cards, they are out. The last player still holding cards
// is the дурак, and everybody else has won.
//
// Nothing here knows about tokens, clocks or seats in the database sense. It is the rules,
// and it is deliberately pure: every function takes a state and returns a new one.

const U = require('./util');

const SUITS = ['s', 'h', 'd', 'c'];          // spades, hearts, diamonds, clubs
const RANKS = ['6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const HAND = 6;
const MAX_SEATS = 5;

const cardOf = (rank, suit) => `${rank}${suit}`;
const rankOf = (card) => card[0];
const suitOf = (card) => card[1];
const rankValue = (card) => RANKS.indexOf(rankOf(card));

/** The full deck, in a fixed order. Shuffling is the caller's business. */
function freshDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(cardOf(rank, suit));
  return deck;
}

/**
 * Deal a new game.
 *
 * `random` is injected so a test can pin the deal. The trump card sits at the bottom of
 * the stock and is the last card anyone draws, which is why it is stored as part of the
 * stock rather than beside it.
 */
function deal(seats, random = Math.random) {
  // Five is the ceiling for a thirty-six card deck. Six hands of six is the whole pack,
  // which leaves no stock to draw from and no bottom card to turn for trumps: not a
  // harder game, just a broken one.
  if (!Number.isInteger(seats) || seats < 2 || seats > MAX_SEATS) {
    throw new Error('дурак is for two to five players');
  }
  const deck = freshDeck();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  const hands = [];
  for (let s = 0; s < seats; s += 1) hands.push(deck.splice(0, HAND).sort(bySuitThenRank));
  // The bottom card of what is left decides trumps and stays there to be drawn last.
  const trump = suitOf(deck[deck.length - 1]);

  return {
    trump,
    stock: deck,
    hands,
    out: new Array(seats).fill(false),
    // The table: attacks in order, with the card that beat each one, or null.
    attacks: [],
    attacker: lowestTrump(hands, trump),
    defender: -1,
    // Who has said they are done adding cards this bout.
    passed: [],
    discarded: 0,
    // Bouts since the discard pile last grew. See STALE_BOUTS in endBout.
    stale: 0,
    log: [],
  };
}

const bySuitThenRank = (a, b) => (
  suitOf(a) === suitOf(b) ? rankValue(a) - rankValue(b) : SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b))
);

/**
 * Who leads. The lowest trump in anybody's hand, which is the usual rule and stops the
 * first attack being an accident of seating.
 */
function lowestTrump(hands, trump) {
  let best = { seat: 0, value: Infinity };
  hands.forEach((hand, seat) => {
    for (const card of hand) {
      if (suitOf(card) !== trump) continue;
      if (rankValue(card) < best.value) best = { seat, value: rankValue(card) };
    }
  });
  return best.seat;
}

/** The next seat still in the game, walking forward from `from`. */
function nextLive(state, from) {
  const n = state.hands.length;
  for (let step = 1; step <= n; step += 1) {
    const seat = (from + step) % n;
    if (!state.out[seat]) return seat;
  }
  return from;
}

const liveSeats = (state) => state.out.reduce((n, o) => n + (o ? 0 : 1), 0);

/** Does `beat` take `attack`, given the trump suit? */
function beats(beat, attack, trump) {
  if (suitOf(beat) === suitOf(attack)) return rankValue(beat) > rankValue(attack);
  return suitOf(beat) === trump && suitOf(attack) !== trump;
}

/** Every card on the table, beaten or not. */
function tableCards(state) {
  const out = [];
  for (const a of state.attacks) {
    out.push(a.card);
    if (a.beat) out.push(a.beat);
  }
  return out;
}

const unbeaten = (state) => state.attacks.filter((a) => !a.beat);

/**
 * How many attacks this bout may hold.
 *
 * Six is one ceiling and the defender's hand is the other: the number still unbeaten can
 * never exceed what they are holding. Beating a card does not free a slot, which surprises
 * people: it removes one from the table and one from the hand, so the balance is the same.
 */
function attackLimit(state) {
  return Math.min(HAND, state.hands[state.defender].length + state.attacks.length
    - unbeaten(state).length);
}

function requireHolding(state, seat, card) {
  if (!state.hands[seat].includes(card)) throw new U.BadRequest('you do not hold that card');
}

function removeCard(hands, seat, card) {
  const next = hands.map((h) => h.slice());
  next[seat] = next[seat].filter((c) => c !== card);
  return next;
}

// --------------------------------------------------------------------- moves
/**
 * Open or add to an attack.
 *
 * The first card of a bout may be anything. After that, only a rank already on the table,
 * which is the rule that makes дурак a game about collecting sets rather than dumping
 * whatever is highest.
 */
function attack(state, seat, card) {
  if (state.defender < 0) throw new U.BadRequest('the bout has not started');
  if (seat === state.defender) throw new U.BadRequest('the defender does not attack');
  if (state.out[seat]) throw new U.BadRequest('you are out of the game');
  requireHolding(state, seat, card);

  if (state.attacks.length === 0) {
    if (seat !== state.attacker) throw new U.BadRequest('it is not your attack');
  } else {
    const ranks = new Set(tableCards(state).map(rankOf));
    if (!ranks.has(rankOf(card))) {
      throw new U.BadRequest('you may only add a rank already on the table');
    }
    if (state.attacks.length >= attackLimit(state)) {
      throw new U.BadRequest('the table is full');
    }
  }

  return {
    ...state,
    hands: removeCard(state.hands, seat, card),
    attacks: [...state.attacks, { card, beat: null, by: seat }],
    // Somebody adding a card reopens the question for everyone else.
    passed: [],
    log: [...state.log, { seat, act: 'attack', card }],
  };
}

/**
 * Beat an attacking card.
 *
 * `on` names which one. Left out, it takes the first card this one can actually beat,
 * which is what a player means when there is only one option and saves the client having
 * to say so. The defender choosing is the real rule: forcing the oldest first would make
 * cards unplayable that are not.
 */
function defend(state, seat, card, on) {
  if (seat !== state.defender) throw new U.BadRequest('you are not defending');
  requireHolding(state, seat, card);
  const open = unbeaten(state);
  if (!open.length) throw new U.BadRequest('there is nothing to beat');

  const target = on
    ? open.find((a) => a.card === on)
    : open.find((a) => beats(card, a.card, state.trump));
  if (!target) {
    throw new U.BadRequest(on
      ? 'that card is not under attack'
      : `${card} does not beat anything on the table`);
  }
  if (!beats(card, target.card, state.trump)) {
    throw new U.BadRequest(`${card} does not beat ${target.card}`);
  }

  const attacks = state.attacks.map(
    (a) => (a === target ? { ...a, beat: card } : a),
  );
  return {
    ...state,
    hands: removeCard(state.hands, seat, card),
    attacks,
    passed: [],
    log: [...state.log, { seat, act: 'defend', card, on: target.card }],
  };
}

/**
 * Pass the attack to the next player. The переводной move, and the whole point of it.
 *
 * Only while nothing has been beaten, only with a card of the same rank as the attack,
 * and only if the next player can actually face what it would become. Without that last
 * check a pass could hand somebody more cards than they hold, which no rule allows.
 */
function passOn(state, seat, card) {
  if (seat !== state.defender) throw new U.BadRequest('only the defender may pass it on');
  if (!state.attacks.length) throw new U.BadRequest('there is nothing to pass on');
  if (state.attacks.some((a) => a.beat)) {
    throw new U.BadRequest('you cannot pass on once you have started beating');
  }
  requireHolding(state, seat, card);
  const rank = rankOf(state.attacks[0].card);
  if (rankOf(card) !== rank) {
    throw new U.BadRequest(`you can only pass on with another ${rank}`);
  }

  // Passing needs somewhere for it to go. At a table of two the next seat is the player
  // who just attacked, and handing it back to them is not a move this game has.
  if (liveSeats(state) < 3) throw new U.BadRequest('there is nobody to pass it to');
  const target = nextLive(state, seat);
  if (target === seat) throw new U.BadRequest('there is nobody to pass it to');
  const would = state.attacks.length + 1;
  if (state.hands[target].length < would) {
    throw new U.BadRequest('they do not hold enough cards to take that on');
  }

  return {
    ...state,
    hands: removeCard(state.hands, seat, card),
    attacks: [...state.attacks, { card, beat: null, by: seat }],
    attacker: seat,
    defender: target,
    passed: [],
    log: [...state.log, { seat, act: 'pass-on', card, to: target }],
  };
}

/**
 * Give up on the bout and take everything on the table.
 * The defender keeps the cards and misses their turn to attack, which is the cost.
 */
function take(state, seat) {
  if (seat !== state.defender) throw new U.BadRequest('only the defender takes');
  if (!state.attacks.length) throw new U.BadRequest('there is nothing to take');
  const hands = state.hands.map((h) => h.slice());
  hands[seat] = [...hands[seat], ...tableCards(state)].sort(bySuitThenRank);
  return endBout({ ...state, hands }, { tookIt: seat });
}

/**
 * Say you are adding nothing more.
 * When every attacker has said so and nothing is unbeaten, the bout is over and the cards
 * are discarded.
 */
function done(state, seat) {
  if (seat === state.defender) throw new U.BadRequest('the defender beats or takes');
  if (state.out[seat]) throw new U.BadRequest('you are out of the game');
  if (!state.attacks.length) throw new U.BadRequest('the bout has not started');
  const passed = [...new Set([...state.passed, seat])];
  const waiting = [];
  for (let s = 0; s < state.hands.length; s += 1) {
    if (s !== state.defender && !state.out[s] && !passed.includes(s)) waiting.push(s);
  }
  const next = { ...state, passed, log: [...state.log, { seat, act: 'done' }] };
  if (waiting.length || unbeaten(next).length) return next;
  return endBout(next, { tookIt: null });
}

// ------------------------------------------------------------- end of a bout
/** Bouts in which nothing at all moved before a game is called drawn. */
const STALE_BOUTS = 30;

/**
 * Close the bout: draw back up to six, drop anyone who is out, and hand the attack on.
 *
 * Drawing order is the attacker first, then round the table, then the defender last. That
 * ordering decides who gets the trump card at the bottom, so it is not cosmetic.
 */
function endBout(state, { tookIt }) {
  const discarded = tookIt === null ? state.discarded + tableCards(state).length : state.discarded;
  // A дурак game can cycle. Cards leave play only when a defence succeeds; a bout the
  // defender takes puts them straight back into a hand, and once nobody is drawing, the
  // same cards go round for ever. A dumb player left to it loops through 3/8/18, 3/9/17,
  // 4/8/17 and back with the pile frozen for as long as you care to watch, which would
  // hold every stake in escrow indefinitely.
  //
  // So count the bouts in which nothing moved at all: nothing discarded, nobody out, and
  // not a card drawn. Any of those three is real progress towards an end; none of them,
  // thirty bouts running, means there is no end to reach. It is called a draw, in the
  // spirit of the fifty-move rule.
  //
  // Thirty is far beyond any real game, where a bout that discards nothing hands the
  // whole table to one player and the attackers soon have nothing left to attack with.

  const hands = state.hands.map((h) => h.slice());
  const stock = state.stock.slice();
  const order = [];
  for (let step = 0; step < hands.length; step += 1) {
    const seat = (state.attacker + step) % hands.length;
    if (seat !== state.defender && !state.out[seat]) order.push(seat);
  }
  if (!state.out[state.defender]) order.push(state.defender);
  for (const seat of order) {
    while (hands[seat].length < HAND && stock.length) hands[seat].push(stock.shift());
    hands[seat].sort(bySuitThenRank);
  }

  // Anybody with nothing left, once the stock is gone, has finished.
  const out = state.out.slice();
  for (let s = 0; s < hands.length; s += 1) {
    if (!out[s] && hands[s].length === 0 && stock.length === 0) out[s] = true;
  }

  const moved = discarded > state.discarded
    || out.some((o, i) => o && !state.out[i])
    || stock.length < state.stock.length;
  const stale = moved ? 0 : (state.stale || 0) + 1;

  const mid = {
    ...state, hands, stock, out, discarded, stale, attacks: [], passed: [],
  };

  const remaining = liveSeats(mid);
  if (remaining <= 1) {
    const fool = mid.out.findIndex((o) => !o);
    return { ...mid, attacker: -1, defender: -1, finished: true, fool: fool < 0 ? null : fool };
  }

  if (stale >= STALE_BOUTS) {
    // Nobody is the fool, because nobody lost: the cards would not come out.
    return {
      ...mid, attacker: -1, defender: -1, finished: true, fool: null, stalemate: true,
    };
  }

  // Beat everything and you attack next; take the cards and the attack goes past you.
  // That skip is the real cost of picking up, more than the cards themselves.
  const from = tookIt === null ? state.defender : nextLive(mid, state.defender);
  const attacker = mid.out[from] ? nextLive(mid, from) : from;
  return { ...mid, attacker, defender: nextLive(mid, attacker) };
}

/** Open the first bout of the game. */
function start(state) {
  return { ...state, defender: nextLive(state, state.attacker) };
}

/**
 * What a seat is allowed to do right now.
 * Used by the client to grey out buttons, and by the tests to be sure the answer matches
 * what the move functions actually accept.
 */
function options(state, seat) {
  if (state.finished || state.out[seat] || state.defender < 0) return {};
  const open = unbeaten(state);
  if (seat === state.defender) {
    return {
      // Only if something in hand actually beats something on the table. Offering a move
      // that will be refused is worse than not offering it.
      defend: open.length > 0
        && state.hands[seat].some((c) => open.some((a) => beats(c, a.card, state.trump))),
      take: state.attacks.length > 0,
      passOn: state.attacks.length > 0 && !state.attacks.some((a) => a.beat)
        && liveSeats(state) >= 3
        && state.hands[seat].some((c) => rankOf(c) === rankOf(state.attacks[0].card))
        && state.hands[nextLive(state, seat)].length >= state.attacks.length + 1,
    };
  }
  const first = state.attacks.length === 0;
  if (first) return { attack: seat === state.attacker };
  const ranks = new Set(tableCards(state).map(rankOf));
  return {
    attack: state.attacks.length < attackLimit(state)
      && state.hands[seat].some((c) => ranks.has(rankOf(c))),
    done: !state.passed.includes(seat),
  };
}

module.exports = {
  SUITS, RANKS, HAND, MAX_SEATS,
  cardOf, rankOf, suitOf, rankValue, freshDeck, bySuitThenRank,
  deal, start, beats, tableCards, unbeaten, attackLimit, nextLive, liveSeats,
  attack, defend, passOn, take, done, endBout, options, lowestTrump, STALE_BOUTS,
};
