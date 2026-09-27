'use strict';
// Preferans, simplified to one hand against two bots.
//
// Rules implemented (the "simplest" form: no competitive bidding, no misere, no pulka):
//   32-card deck, 7 to A in four suits. Ten cards each, two face down as the talon.
//   The player declares a contract of 6-10 tricks and a trump suit (or no-trump), takes
//   the talon, discards two, and must take at least that many tricks. The two bots defend.
//   Follow suit if you can; if void you MUST trump if able; highest trump wins, else the
//   highest card of the led suit.
//
// Why the payouts are calibrated rather than derived:
// Every other game here has a closed-form win probability, so the payout follows from
// arithmetic. A trick-taking game does not: the chance of making a contract depends on
// how well it is played. So the payout table is measured, by simulating the bot playing
// BOTH sides many thousands of times, and then set to (1 - edge) / P(make it).
//
// That calibration is honest about one thing: the edge holds against a player who plays
// about as well as the bot. A stronger player erodes it, a weaker one loses more. The
// baseline is therefore calibrated against the strongest declarer heuristic available
// here, not a weak one, so the edge is conservative rather than optimistic.
const fair = require('../fair');

const SUITS = ['S', 'C', 'D', 'H'];
const RANKS = ['7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i]));
const NO_TRUMP = 'NT';
const HAND_SIZE = 10;
const TALON = 2;
const PLAYERS = 3;

const DECK = SUITS.flatMap((s) => RANKS.map((r) => r + s));
const suitOf = (card) => card[1];
const rankOf = (card) => card[0];
const valueOf = (card) => RANK_VALUE[rankOf(card)];

// ------------------------------------------------------------------- deal
/**
 * Deterministic shuffle from the fair stream, so a player can replay the deal from the
 * revealed seed and confirm the cards were not chosen to suit the house.
 */
function shuffle(serverSeed, clientSeed, nonce) {
  const cards = [...DECK];
  const floats = fair.floats(serverSeed, clientSeed, nonce, cards.length - 1);
  for (let i = 0; i < cards.length - 1; i += 1) {
    const j = i + Math.floor(floats[i] * (cards.length - i));
    const t = cards[i];
    cards[i] = cards[j];
    cards[j] = t;
  }
  return cards;
}

function deal(serverSeed, clientSeed, nonce) {
  const cards = shuffle(serverSeed, clientSeed, nonce);
  return {
    hands: [
      cards.slice(0, HAND_SIZE),
      cards.slice(HAND_SIZE, HAND_SIZE * 2),
      cards.slice(HAND_SIZE * 2, HAND_SIZE * 3),
    ].map(sortHand),
    talon: cards.slice(HAND_SIZE * 3, HAND_SIZE * 3 + TALON),
  };
}

const SUIT_ORDER = { S: 0, C: 1, D: 2, H: 3 };
const sortHand = (hand) => [...hand].sort(
  (a, b) => (SUIT_ORDER[suitOf(a)] - SUIT_ORDER[suitOf(b)]) || (valueOf(b) - valueOf(a)),
);

// ------------------------------------------------------------- trick rules
/**
 * Legal plays. Preferans is strict: follow the led suit, and if you cannot, you are
 * obliged to trump if you hold one. Only when void in both may you throw anything.
 */
function legalPlays(hand, ledSuit, trump) {
  if (!ledSuit) return [...hand];
  const following = hand.filter((c) => suitOf(c) === ledSuit);
  if (following.length) return following;
  if (trump !== NO_TRUMP) {
    const trumps = hand.filter((c) => suitOf(c) === trump);
    if (trumps.length) return trumps;
  }
  return [...hand];
}

/** Index within `plays` of the card that wins the trick. */
function trickWinner(plays, ledSuit, trump) {
  let best = 0;
  for (let i = 1; i < plays.length; i += 1) {
    const card = plays[i];
    const bestCard = plays[best];
    const cardTrump = trump !== NO_TRUMP && suitOf(card) === trump;
    const bestTrump = trump !== NO_TRUMP && suitOf(bestCard) === trump;
    if (cardTrump && !bestTrump) best = i;
    else if (cardTrump === bestTrump && suitOf(card) === suitOf(bestCard)
      && valueOf(card) > valueOf(bestCard)) best = i;
    else if (!cardTrump && !bestTrump && suitOf(bestCard) !== ledSuit
      && suitOf(card) === ledSuit) best = i;
  }
  return best;
}

// --------------------------------------------------------------- hand value
/**
 * Rough trick-taking strength of a hand, used by the bot to choose a contract and to
 * decide which two cards to throw away. Counts near-certain winners and long-suit
 * potential rather than pretending to solve the hand.
 */
function estimateTricks(hand, trump) {
  let tricks = 0;
  const bySuit = Object.fromEntries(SUITS.map((s) => [s, hand.filter((c) => suitOf(c) === s)]));

  for (const suit of SUITS) {
    const cards = bySuit[suit].sort((a, b) => valueOf(b) - valueOf(a));
    if (!cards.length) continue;
    const isTrump = suit === trump;

    for (const [i, card] of cards.entries()) {
      const r = rankOf(card);
      if (r === 'A') tricks += isTrump ? 1 : 0.95;
      else if (r === 'K') tricks += i === 0 ? 0.7 : 0.75;
      else if (r === 'Q') tricks += cards.length >= 3 ? 0.5 : 0.3;
      else if (r === 'J' && cards.length >= 4) tricks += 0.25;
    }
    // Length in trumps wins tricks by force; length in a side suit wins late ones.
    if (isTrump && cards.length > 3) tricks += (cards.length - 3) * 0.8;
    else if (!isTrump && cards.length >= 5) tricks += (cards.length - 4) * 0.4;
    // Being void or short in a side suit is worth tricks when you hold trumps.
    if (!isTrump && trump !== NO_TRUMP && cards.length === 0) tricks += 0.5;
  }
  return tricks;
}

/** Best contract this hand can reasonably attempt: { contract, trump, estimate }. */
function bestContract(hand) {
  let best = { contract: 6, trump: SUITS[0], estimate: 0 };
  for (const trump of [...SUITS, NO_TRUMP]) {
    const est = estimateTricks(hand, trump);
    if (est > best.estimate) best = { contract: Math.max(6, Math.min(10, Math.round(est))), trump, estimate: est };
  }
  return best;
}

/** Which two of twelve cards to throw. Keeps trumps and top cards, sheds short side suits. */
function chooseDiscards(hand, trump) {
  const scored = hand.map((card) => {
    const suit = suitOf(card);
    const inSuit = hand.filter((c) => suitOf(c) === suit).length;
    let keep = valueOf(card);
    if (trump !== NO_TRUMP && suit === trump) keep += 20;
    if (rankOf(card) === 'A') keep += 12;
    else if (rankOf(card) === 'K') keep += 8;
    // A lone low card in a short side suit is the cheapest thing to lose.
    if (inSuit <= 2 && valueOf(card) < RANK_VALUE.J && suit !== trump) keep -= 6;
    return { card, keep };
  });
  scored.sort((a, b) => a.keep - b.keep);
  return [scored[0].card, scored[1].card];
}

// ------------------------------------------------------------------- bot
/**
 * Card choice. `role` is 'declarer' or 'defender'. The heuristic is deliberately decent
 * rather than clever: win cheaply when winning matters, duck when it does not, and keep
 * winners for later. The payout table is calibrated against exactly this play, so the
 * strength here is what defines the house edge.
 */
function chooseCard(state, seat) {
  const { hand, trick, ledSuit, trump, declarer } = state;
  const legal = legalPlays(hand, ledSuit, trump);
  if (legal.length === 1) return legal[0];

  const isDeclarer = seat === declarer;
  const sorted = [...legal].sort((a, b) => valueOf(a) - valueOf(b));

  // Leading: declarer pulls trumps, defenders lead their longest side suit.
  if (!trick.length) {
    if (isDeclarer && trump !== NO_TRUMP) {
      const trumps = legal.filter((c) => suitOf(c) === trump);
      if (trumps.length >= 2) return trumps.sort((a, b) => valueOf(b) - valueOf(a))[0];
    }
    const aces = legal.filter((c) => rankOf(c) === 'A');
    if (aces.length) return aces[0];
    return sorted[sorted.length - 1];
  }

  // Following: would each legal card take the trick as it stands?
  const winners = legal.filter((card) => {
    const plays = [...trick.map((t) => t.card), card];
    return trickWinner(plays, ledSuit, trump) === plays.length - 1;
  });

  const partnerLeading = !isDeclarer
    && trick.length
    && (() => {
      const plays = trick.map((t) => t.card);
      const leaderIdx = trickWinner(plays, ledSuit, trump);
      return trick[leaderIdx].seat !== declarer;
    })();

  // A defender whose partner already holds the trick should not spend a winner on it.
  if (partnerLeading && trick.length === PLAYERS - 1) return sorted[0];

  if (winners.length) {
    // Win as cheaply as possible; a winner kept is a trick kept.
    return winners.sort((a, b) => valueOf(a) - valueOf(b))[0];
  }
  return sorted[0];
}

// -------------------------------------------------------------- play a hand
/**
 * Play out ten tricks. `controller(seat, state)` returns the card for that seat, which
 * lets the same engine run bot-vs-bot for calibration and human-vs-bot in the live game.
 * Returns tricks won per seat.
 */
function playHand({ hands, trump, declarer, controller }) {
  const table = hands.map((h) => [...h]);
  const won = [0, 0, 0];
  let leader = (declarer + 1) % PLAYERS; // the defender to the declarer's left leads

  for (let t = 0; t < HAND_SIZE; t += 1) {
    const trick = [];
    let ledSuit = null;
    for (let i = 0; i < PLAYERS; i += 1) {
      const seat = (leader + i) % PLAYERS;
      const card = controller(seat, {
        hand: table[seat], trick, ledSuit, trump, declarer, seat, trickNumber: t,
      });
      const legal = legalPlays(table[seat], ledSuit, trump);
      if (!legal.includes(card)) throw new Error(`illegal play ${card} by seat ${seat}`);
      table[seat].splice(table[seat].indexOf(card), 1);
      if (!ledSuit) ledSuit = suitOf(card);
      trick.push({ seat, card });
    }
    const winnerIdx = trickWinner(trick.map((x) => x.card), ledSuit, trump);
    leader = trick[winnerIdx].seat;
    won[leader] += 1;
  }
  return won;
}

/** Full bot-vs-bot hand, used by the calibration tool. */
function simulateHand(serverSeed, clientSeed, nonce) {
  const { hands, talon } = deal(serverSeed, clientSeed, nonce);
  const declarer = 0;

  const picked = bestContract(hands[declarer]);
  const withTalon = sortHand([...hands[declarer], ...talon]);
  const discards = chooseDiscards(withTalon, picked.trump);
  const finalHand = withTalon.filter((c) => !discards.includes(c));

  const table = [...hands];
  table[declarer] = finalHand;

  const won = playHand({
    hands: table,
    trump: picked.trump,
    declarer,
    controller: (seat, state) => chooseCard(state, seat),
  });
  return { contract: picked.contract, trump: picked.trump, tricks: won[declarer], made: won[declarer] >= picked.contract };
}

// ------------------------------------------------------------- calibration
/**
 * How many tricks the declarer takes, measured by bot self-play.
 * Regenerate with `node tools/calibrate-preferans.js` after ANY change to the hand
 * evaluation or card-play heuristics, or the payouts will be priced against a bot that
 * no longer exists. test/preferans.test.js re-simulates and fails if this has drifted.
 */
const TRICK_DISTRIBUTION = {
  samples: 40000,
  measured: '2026-09-27',
  average: 5.8751,
  dist: [0.000100, 0.002275, 0.015925, 0.057525, 0.126650, 0.204450,
    0.234575, 0.194275, 0.113575, 0.042925, 0.007725],
};

// Six tricks returns the stake: a push, not a win. Profit starts at seven, and the curve
// steepens sharply so the rare 9 and 10 trick hands are what people play for.
const PUSH_AT = 6;
const PAYOUT_SHAPE = { 7: 1.5, 8: 2.5, 9: 5, 10: 15 };

const floor2 = (x) => Math.floor(x * 100) / 100;

/**
 * Solve the payout table for a target RTP.
 *
 * P(6 tricks) is paid at exactly 1.0, so the remaining budget is spread over 7-10 in the
 * fixed shape above. One scale factor, solved rather than guessed, then floored to 2dp
 * so rounding always favours the house.
 */
function payoutTable(edge, distribution = TRICK_DISTRIBUTION) {
  const target = 1 - edge;
  const d = distribution.dist;
  const pushShare = d[PUSH_AT] || 0;

  let weighted = 0;
  for (const [k, shape] of Object.entries(PAYOUT_SHAPE)) weighted += (d[k] || 0) * shape;
  if (weighted <= 0) throw new Error('preferans: degenerate trick distribution');

  const scale = (target - pushShare) / weighted;
  if (scale <= 0) {
    throw new Error('preferans: pushes alone already exceed the target RTP; lower PUSH_AT');
  }

  const pays = { [PUSH_AT]: 1 };
  for (const [k, shape] of Object.entries(PAYOUT_SHAPE)) pays[k] = floor2(shape * scale);

  let rtp = 0;
  for (const [k, pay] of Object.entries(pays)) rtp += (d[k] || 0) * pay;

  // Same discipline as the slot solver: never ship a table that misses its target.
  if (rtp > target + 1e-9) throw new Error(`preferans: solved RTP ${rtp} exceeds target ${target}`);
  if (target - rtp > 0.01) {
    throw new Error(`preferans: solved RTP ${(rtp * 100).toFixed(2)}% is more than 1 point `
      + `below the target ${(target * 100).toFixed(2)}%`);
  }
  return {
    pays, rtp, target, scale, pushAt: PUSH_AT, distribution: d, maxMultiplier: pays[10],
  };
}

// ------------------------------------------------------- the casino table
// The player always sits in seat 0 and always declares; the two bots defend. State lives
// in the database so a hand survives a refresh, and the bots' cards never leave the
// server until the hand is over.
const U = require('../util');
const ledger = require('../ledger');
const auth = require('../auth');

const PLAYER = 0;
const now = () => Math.floor(Date.now() / 1000);

const activeGame = (db, userId) => db.get(
  "SELECT * FROM pref_games WHERE user_id=? AND state!='done'", userId,
);

const loadState = (g) => ({
  hands: JSON.parse(g.hands),
  talon: JSON.parse(g.talon),
  trick: JSON.parse(g.trick),
  tricksWon: JSON.parse(g.tricks_won),
  log: JSON.parse(g.log),
});

/** Whose turn it is, derived from the leader and how many cards are already down. */
const turnOf = (g, trick) => (g.leader + trick.length) % PLAYERS;

/** Client-safe view. Bot hands are summarised as counts, never listed, while in play. */
function view(db, cfg, g, extra = {}) {
  const s = loadState(g);
  const table = payoutTable(cfg.houseEdge.preferans);
  const done = g.state === 'done';
  return {
    gameId: g.id,
    state: g.state,
    stake: g.stake,
    trump: g.trump,
    hand: sortHand(s.hands[PLAYER]),
    talon: (g.state === 'discard' || done) ? s.talon : null,
    trick: s.trick,
    leader: g.leader,
    turn: g.state === 'playing' ? turnOf(g, s.trick) : null,
    yourTurn: g.state === 'playing' && turnOf(g, s.trick) === PLAYER,
    tricksWon: s.tricksWon,
    trickNumber: g.trick_no,
    opponentCards: [s.hands[1].length, s.hands[2].length],
    log: s.log.slice(-12),
    payouts: table.pays,
    pushAt: table.pushAt,
    nonce: g.nonce,
    botHands: done ? [s.hands[1], s.hands[2]] : null,
    ...extra,
  };
}

function start({ db, cfg, user, bank }, body) {
  const wager = U.parseAmount(body.amount);
  const table = payoutTable(cfg.houseEdge.preferans);

  return db.tx(() => {
    if (activeGame(db, user.id)) throw new U.BadRequest('finish your current hand first');
    // The top payout is known in advance here, so the bet can be limit-checked properly
    // rather than capped after the fact.
    bank.checkLimits(user, wager, table.maxMultiplier);

    const seed = auth.activeSeed(db, user.id);
    const nonce = auth.claimNonce(db, seed.id);
    const d = deal(seed.seed, user.client_seed, nonce);

    bank.takeStake(user, wager, `preferans#${nonce}`);

    db.run(
      `INSERT INTO pref_games(user_id,stake,hands,talon,state,mode,seed_id,nonce,client_seed,created_at)
       VALUES(?,?,?,?,'trump',?,?,?,?,?)`,
      user.id, wager, JSON.stringify(d.hands), JSON.stringify(d.talon),
      bank.mode, seed.id, nonce, user.client_seed, now(),
    );
    const g = activeGame(db, user.id);
    return {
      ...view(db, cfg, g),
      serverSeedHash: seed.seed_hash,
      balance: bank.balance(user.id),
    };
  });
}

function chooseTrump({ db, cfg, user }, body) {
  const trump = String(body.trump ?? '').toUpperCase();
  if (![...SUITS, NO_TRUMP].includes(trump)) throw new U.BadRequest('pick a suit or no-trump');

  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no hand in progress');
    if (g.state !== 'trump') throw new U.BadRequest('trump is already chosen');

    const s = loadState(g);
    s.hands[PLAYER] = sortHand([...s.hands[PLAYER], ...s.talon]);
    db.run("UPDATE pref_games SET trump=?, hands=?, state='discard' WHERE id=?",
      trump, JSON.stringify(s.hands), g.id);
    return view(db, cfg, db.get('SELECT * FROM pref_games WHERE id=?', g.id));
  });
}

function discard({ db, cfg, user, bankFor }, body) {
  const cards = Array.isArray(body.cards) ? body.cards.map(String) : [];
  if (cards.length !== TALON) throw new U.BadRequest(`discard exactly ${TALON} cards`);
  if (cards[0] === cards[1]) throw new U.BadRequest('pick two different cards');

  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no hand in progress');
    if (g.state !== 'discard') throw new U.BadRequest('not at the discard step');

    const s = loadState(g);
    for (const c of cards) {
      if (!s.hands[PLAYER].includes(c)) throw new U.BadRequest(`${c} is not in your hand`);
    }
    s.hands[PLAYER] = s.hands[PLAYER].filter((c) => !cards.includes(c));

    db.run(
      "UPDATE pref_games SET hands=?, state='playing', leader=1, trick='[]', trick_no=0 WHERE id=?",
      JSON.stringify(s.hands), g.id,
    );
    // The defender on the declarer's left leads, so the bots move before the player does.
    return runBots({ db, cfg, user, bankFor }, db.get('SELECT * FROM pref_games WHERE id=?', g.id));
  });
}

function playCard({ db, cfg, user, bankFor }, body) {
  const card = String(body.card ?? '');
  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no hand in progress');
    if (g.state !== 'playing') throw new U.BadRequest('the hand is not in play');

    const s = loadState(g);
    if (turnOf(g, s.trick) !== PLAYER) throw new U.BadRequest('it is not your turn');

    const ledSuit = s.trick.length ? suitOf(s.trick[0].card) : null;
    const legal = legalPlays(s.hands[PLAYER], ledSuit, g.trump);
    if (!legal.includes(card)) {
      throw new U.BadRequest(
        legal.length && ledSuit
          ? `you must follow ${ledSuit}${g.trump !== NO_TRUMP ? ' or trump' : ''}`
          : `${card} is not a legal play`,
      );
    }

    s.hands[PLAYER] = s.hands[PLAYER].filter((c) => c !== card);
    s.trick.push({ seat: PLAYER, card });
    db.run('UPDATE pref_games SET hands=?, trick=? WHERE id=?',
      JSON.stringify(s.hands), JSON.stringify(s.trick), g.id);

    return runBots({ db, cfg, user, bankFor }, db.get('SELECT * FROM pref_games WHERE id=?', g.id));
  });
}

/**
 * Play bot turns until it is the player's move again, resolving tricks along the way.
 * Caller must already hold a transaction.
 */
function runBots(ctx, game) {
  const { db, cfg, user } = ctx;  // ctx also carries bankFor, used by settle
  let g = game;
  let guard = 0;

  for (;;) {
    guard += 1;
    if (guard > 64) throw new Error('preferans: bot loop did not terminate');
    const s = loadState(g);

    // Complete trick: work out who took it and move on.
    if (s.trick.length === PLAYERS) {
      const ledSuit = suitOf(s.trick[0].card);
      const winnerIdx = trickWinner(s.trick.map((t) => t.card), ledSuit, g.trump);
      const winner = s.trick[winnerIdx].seat;
      s.tricksWon[winner] += 1;
      s.log.push({
        trick: g.trick_no + 1,
        cards: s.trick.map((t) => ({ seat: t.seat, card: t.card })),
        winner,
      });

      const trickNo = g.trick_no + 1;
      db.run(
        "UPDATE pref_games SET trick='[]', leader=?, tricks_won=?, trick_no=?, log=? WHERE id=?",
        winner, JSON.stringify(s.tricksWon), trickNo, JSON.stringify(s.log), g.id,
      );
      g = db.get('SELECT * FROM pref_games WHERE id=?', g.id);

      if (trickNo >= HAND_SIZE) return settle(ctx, g);
      continue;
    }

    const seat = turnOf(g, s.trick);
    if (seat === PLAYER) return view(db, cfg, g);

    const ledSuit = s.trick.length ? suitOf(s.trick[0].card) : null;
    const card = chooseCard({
      hand: s.hands[seat],
      trick: s.trick,
      ledSuit,
      trump: g.trump,
      declarer: PLAYER,
      seat,
    }, seat);
    const legal = legalPlays(s.hands[seat], ledSuit, g.trump);
    // A bot must never be able to cheat; if the heuristic returns something illegal,
    // fall back to a legal card rather than corrupting the hand.
    const played = legal.includes(card) ? card : legal[0];

    s.hands[seat] = s.hands[seat].filter((c) => c !== played);
    s.trick.push({ seat, card: played });
    db.run('UPDATE pref_games SET hands=?, trick=? WHERE id=?',
      JSON.stringify(s.hands), JSON.stringify(s.trick), g.id);
    g = db.get('SELECT * FROM pref_games WHERE id=?', g.id);
  }
}

/** Pay the hand out according to how many tricks the player took. */
function settle({ db, cfg, user, bankFor }, g) {
  // Settle against the bank the hand was dealt with, never the one the request asks for:
  // a hand opened with play money must never pay out real money.
  const bank = bankFor(g.mode);
  const s = loadState(g);
  const table = payoutTable(cfg.houseEdge.preferans);
  const tricks = s.tricksWon[PLAYER];
  const multiplier = table.pays[tricks] || 0;
  const payout = multiplier > 0 ? U.mulUnits(g.stake, multiplier) : 0;

  db.run("UPDATE pref_games SET state='done', payout=?, ended_at=? WHERE id=?",
    payout, now(), g.id);

  bank.settle({
    user,
    game: 'preferans',
    wager: g.stake,
    multiplier: g.stake ? payout / g.stake : 0,
    payout,
    edgeUnits: Math.floor(g.stake * cfg.houseEdge.preferans),
    seedId: g.seed_id,
    nonce: g.nonce,
    clientSeed: g.client_seed,
    detail: { tricks, trump: g.trump, multiplier, tricksWon: s.tricksWon },
    stakeTaken: true,
  });

  const fresh = db.get('SELECT * FROM pref_games WHERE id=?', g.id);
  return {
    ...view(db, cfg, fresh),
    finished: true,
    tricks,
    multiplier,
    payout,
    profit: payout - g.stake,
    outcome: payout === 0 ? 'lost' : (payout === g.stake ? 'push' : 'won'),
    balance: bank.balance(user.id),
  };
}

function current({ db, cfg, user }) {
  const g = activeGame(db, user.id);
  if (!g) return { state: 'none', payouts: payoutTable(cfg.houseEdge.preferans).pays };
  return view(db, cfg, g);
}

/** Table info for the rules panel. */
function info(cfg) {
  const table = payoutTable(cfg.houseEdge.preferans);
  return {
    pays: table.pays,
    pushAt: table.pushAt,
    rtp: table.rtp,
    edge: 1 - table.rtp,
    averageTricks: TRICK_DISTRIBUTION.average,
    distribution: table.distribution,
    calibratedOn: TRICK_DISTRIBUTION.measured,
    samples: TRICK_DISTRIBUTION.samples,
    suits: SUITS,
    noTrump: NO_TRUMP,
  };
}

module.exports = {
  SUITS, RANKS, DECK, NO_TRUMP, HAND_SIZE, TALON, PLAYERS, PLAYER,
  suitOf, rankOf, valueOf, sortHand,
  shuffle, deal, legalPlays, trickWinner,
  estimateTricks, bestContract, chooseDiscards, chooseCard,
  playHand, simulateHand,
  TRICK_DISTRIBUTION, PAYOUT_SHAPE, PUSH_AT, payoutTable,
  start, chooseTrump, discard, playCard, current, info, activeGame,
};
