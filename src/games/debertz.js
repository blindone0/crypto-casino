'use strict';
// Debertz (Klaberjass), one hand, player against one bot.
//
// The game's defining quirk is that the trump suit has a different ranking from every
// other suit. In trumps the Jack is the highest card and the nine is second; everywhere
// else the Ace leads and the Jack is nearly worthless. Getting that wrong turns it into
// a different game, so it is the first thing the tests check.
//
//   trump order   J(20)  9(14)  A(11)  10(10)  K(4)  Q(3)  8(0)  7(0)
//   plain order   A(11)  10(10) K(4)   Q(3)    J(2)  9(0)  8(0)  7(0)
//
// Nine cards each from a 32-card pack, one card turned up to propose trump. The player
// always chooses: take the upcard suit, or name another. Then nine tricks, with the
// strict obligations that make the game tactical rather than lucky: follow suit if you
// can, trump if you cannot, and overtrump if the trick is already trumped and you hold
// something higher.
//
// Scoring is card points, plus the best meld (a run of three, four or five in one suit),
// plus bella (king and queen of trumps), plus ten for the last trick. The bete rule is
// the sting: the player who chose trumps must finish ahead, and if they do not they lose
// everything rather than merely losing the difference.
//
// As with Preferans there is no closed-form win probability here, so the payout table is
// measured by bot self-play rather than derived. The edge therefore holds against a
// player of roughly the bot's strength; see tools/calibrate-debertz.js.
const U = require('../util');
const fair = require('../fair');
const auth = require('../auth');

const SUITS = ['S', 'C', 'D', 'H'];
const RANKS = ['7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const DECK = SUITS.flatMap((s) => RANKS.map((r) => r + s));
const HAND_SIZE = 9;
const PLAYERS = 2;
const PLAYER = 0;
const BOT = 1;

const suitOf = (c) => c[1];
const rankOf = (c) => c[0];

// Trick-taking strength, which is NOT the same as point value.
const TRUMP_ORDER = ['7', '8', 'Q', 'K', 'T', 'A', '9', 'J'];
const PLAIN_ORDER = ['7', '8', '9', 'J', 'Q', 'K', 'T', 'A'];
const TRUMP_POINTS = { J: 20, 9: 14, A: 11, T: 10, K: 4, Q: 3, 8: 0, 7: 0 };
const PLAIN_POINTS = { A: 11, T: 10, K: 4, Q: 3, J: 2, 9: 0, 8: 0, 7: 0 };
// Sequence order for melds is the plain card order, ace high, regardless of trumps.
const SEQ_ORDER = ['7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

const isTrump = (card, trump) => suitOf(card) === trump;
const strength = (card, trump) => (isTrump(card, trump)
  ? TRUMP_ORDER.indexOf(rankOf(card))
  : PLAIN_ORDER.indexOf(rankOf(card)));
const points = (card, trump) => (isTrump(card, trump)
  ? TRUMP_POINTS[rankOf(card)]
  : PLAIN_POINTS[rankOf(card)]);

const SUIT_ORDER = { S: 0, C: 1, D: 2, H: 3 };
const sortHand = (hand, trump) => [...hand].sort(
  (a, b) => (SUIT_ORDER[suitOf(a)] - SUIT_ORDER[suitOf(b)])
    || (SEQ_ORDER.indexOf(rankOf(b)) - SEQ_ORDER.indexOf(rankOf(a))),
);

// ------------------------------------------------------------------- deal
function deal(serverSeed, clientSeed, nonce) {
  const cards = [...DECK];
  const floats = fair.floats(serverSeed, clientSeed, nonce, cards.length - 1);
  for (let i = 0; i < cards.length - 1; i += 1) {
    const j = i + Math.floor(floats[i] * (cards.length - i));
    const t = cards[i];
    cards[i] = cards[j];
    cards[j] = t;
  }
  return {
    hands: [cards.slice(0, HAND_SIZE), cards.slice(HAND_SIZE, HAND_SIZE * 2)],
    upcard: cards[HAND_SIZE * 2],
  };
}

// ------------------------------------------------------------- trick rules
/**
 * Legal plays. Klaberjass is strict, and the strictness is the game:
 *   follow the led suit if you can;
 *   if you cannot, you must trump;
 *   if the trick is already trumped, you must play a HIGHER trump if you hold one;
 *   only when none of that is possible may you throw anything.
 */
function legalPlays(hand, trick, trump) {
  if (!trick.length) return [...hand];
  const ledSuit = suitOf(trick[0].card);

  const following = hand.filter((c) => suitOf(c) === ledSuit);
  if (following.length) {
    // Following the led suit when the led suit IS trumps still obliges you to overtrump.
    if (ledSuit === trump) {
      const best = Math.max(...trick.filter((p) => isTrump(p.card, trump))
        .map((p) => strength(p.card, trump)), -1);
      const higher = following.filter((c) => strength(c, trump) > best);
      return higher.length ? higher : following;
    }
    return following;
  }

  const trumps = hand.filter((c) => isTrump(c, trump));
  if (!trumps.length) return [...hand];

  const played = trick.filter((p) => isTrump(p.card, trump));
  if (!played.length) return trumps;

  const best = Math.max(...played.map((p) => strength(p.card, trump)));
  const higher = trumps.filter((c) => strength(c, trump) > best);
  // Holding only lower trumps, you are free to discard instead of wasting one.
  return higher.length ? higher : [...hand];
}

/** Index in `trick` of the winning play. */
function trickWinner(trick, trump) {
  const ledSuit = suitOf(trick[0].card);
  let best = 0;
  for (let i = 1; i < trick.length; i += 1) {
    const card = trick[i].card;
    const bestCard = trick[best].card;
    const ct = isTrump(card, trump);
    const bt = isTrump(bestCard, trump);
    if (ct && !bt) best = i;
    else if (ct === bt && suitOf(card) === suitOf(bestCard)
      && strength(card, trump) > strength(bestCard, trump)) best = i;
    else if (!ct && !bt && suitOf(bestCard) !== ledSuit && suitOf(card) === ledSuit) best = i;
  }
  return best;
}

// ------------------------------------------------------------------ melds
/**
 * The best sequence in a hand: three in a row scores 20, four scores 50, five or more
 * scores 100. Only one meld counts, and only the player holding the better one scores.
 */
function bestMeld(hand) {
  let best = { length: 0, value: 0, cards: [] };
  for (const suit of SUITS) {
    const inSuit = hand.filter((c) => suitOf(c) === suit)
      .sort((a, b) => SEQ_ORDER.indexOf(rankOf(a)) - SEQ_ORDER.indexOf(rankOf(b)));
    let run = [];
    for (let i = 0; i < inSuit.length; i += 1) {
      const prev = run[run.length - 1];
      const consecutive = prev
        && SEQ_ORDER.indexOf(rankOf(inSuit[i])) === SEQ_ORDER.indexOf(rankOf(prev)) + 1;
      run = consecutive ? [...run, inSuit[i]] : [inSuit[i]];
      const value = run.length >= 5 ? 100 : (run.length === 4 ? 50 : (run.length === 3 ? 20 : 0));
      if (value > best.value
        || (value === best.value && value > 0 && run.length > best.length)) {
        best = { length: run.length, value, cards: [...run] };
      }
    }
  }
  return best;
}

/** King and queen of trumps together, worth twenty. */
const hasBella = (hand, trump) => hand.includes(`K${trump}`) && hand.includes(`Q${trump}`);

// -------------------------------------------------------------------- bot
/** How good a hand looks if a given suit were trumps, used for the bot's choice. */
function evaluateTrump(hand, trump) {
  let score = 0;
  for (const card of hand) score += points(card, trump) * (isTrump(card, trump) ? 1.4 : 1);
  score += hand.filter((c) => isTrump(c, trump)).length * 6;
  if (hand.includes(`J${trump}`)) score += 14;
  if (hand.includes(`9${trump}`)) score += 8;
  if (hasBella(hand, trump)) score += 12;
  score += bestMeld(hand).value * 0.5;
  return score;
}

/** The bot's own trump preference, also used as the baseline the payouts are priced on. */
function chooseTrumpFor(hand, upcard) {
  let best = { trump: suitOf(upcard), score: -Infinity, tookUpcard: true };
  for (const suit of SUITS) {
    const score = evaluateTrump(hand, suit) + (suit === suitOf(upcard) ? 8 : 0);
    if (score > best.score) best = { trump: suit, score, tookUpcard: suit === suitOf(upcard) };
  }
  return best;
}

/**
 * Card choice. Competent rather than clever: take the trick cheaply when it is worth
 * taking, throw the least valuable card when it is not, and do not waste trumps early.
 */
function botCard(state) {
  const { hand, trick, trump } = state;
  const legal = legalPlays(hand, trick, trump);
  if (legal.length === 1) return legal[0];

  const cheapest = [...legal].sort((a, b) => points(a, trump) - points(b, trump)
    || strength(a, trump) - strength(b, trump));

  if (!trick.length) {
    // Leading: cash a plain ace if available, otherwise lead a low plain card.
    const aces = legal.filter((c) => !isTrump(c, trump) && rankOf(c) === 'A');
    if (aces.length) return aces[0];
    const plain = cheapest.filter((c) => !isTrump(c, trump));
    return plain.length ? plain[0] : cheapest[0];
  }

  const pot = trick.reduce((sum, p) => sum + points(p.card, trump), 0);
  const winners = legal.filter((card) => {
    const next = [...trick, { seat: -1, card }];
    return trickWinner(next, trump) === next.length - 1;
  });

  if (winners.length) {
    // Worth taking if there are points in it, or if it is nearly free to do so.
    const cheapWin = [...winners].sort((a, b) => points(a, trump) - points(b, trump)
      || strength(a, trump) - strength(b, trump))[0];
    if (pot >= 4 || points(cheapWin, trump) <= 4) return cheapWin;
  }
  return cheapest[0];
}

// ------------------------------------------------------------- play a hand
/**
 * Play out nine tricks. `controller(seat, state)` supplies each card, which lets the
 * same engine run bot-vs-bot for calibration and human-vs-bot in the live game.
 */
function playHand({ hands, trump, leader = PLAYER, controller }) {
  const table = hands.map((h) => [...h]);
  const cardPoints = [0, 0];
  let turn = leader;
  let lastWinner = leader;
  const log = [];

  for (let t = 0; t < HAND_SIZE; t += 1) {
    const trick = [];
    for (let i = 0; i < PLAYERS; i += 1) {
      const seat = (turn + i) % PLAYERS;
      const card = controller(seat, { hand: table[seat], trick, trump, seat, trickNumber: t });
      const legal = legalPlays(table[seat], trick, trump);
      if (!legal.includes(card)) throw new Error(`illegal play ${card} by seat ${seat}`);
      table[seat].splice(table[seat].indexOf(card), 1);
      trick.push({ seat, card });
    }
    const w = trick[trickWinner(trick, trump)].seat;
    cardPoints[w] += trick.reduce((sum, p) => sum + points(p.card, trump), 0);
    log.push({ trick: t + 1, cards: trick.map((p) => ({ seat: p.seat, card: p.card })), winner: w });
    turn = w;
    lastWinner = w;
  }
  cardPoints[lastWinner] += 10;   // last trick
  return { cardPoints, lastWinner, log };
}

/**
 * Full scoring for a finished hand, including melds, bella and the bete rule.
 * `chooser` is the seat that named trumps.
 */
function score({ hands, trump, cardPoints, chooser }) {
  const melds = hands.map(bestMeld);
  const bella = hands.map((h) => (hasBella(h, trump) ? 20 : 0));

  // Only the better meld scores. A tie cancels, which is the usual house rule and keeps
  // the arithmetic honest when both players hold a run of the same length.
  let meldPoints = [0, 0];
  if (melds[0].value > melds[1].value) meldPoints = [melds[0].value, 0];
  else if (melds[1].value > melds[0].value) meldPoints = [0, melds[1].value];

  const totals = [
    cardPoints[0] + meldPoints[0] + bella[0],
    cardPoints[1] + meldPoints[1] + bella[1],
  ];

  const other = chooser === 0 ? 1 : 0;
  const bete = totals[chooser] <= totals[other];
  const final = [...totals];
  if (bete) {
    // Going bete does not cost you the difference, it costs you the hand.
    final[other] = totals[0] + totals[1];
    final[chooser] = 0;
  }
  return {
    cardPoints, meldPoints, bella, totals, final, bete,
    melds: melds.map((m) => ({ length: m.length, value: m.value, cards: m.cards })),
    margin: totals[chooser] - totals[other],
  };
}

/** One complete bot-vs-bot hand, used by the calibration tool. */
function simulateHand(serverSeed, clientSeed, nonce) {
  const d = deal(serverSeed, clientSeed, nonce);
  const pick = chooseTrumpFor(d.hands[PLAYER], d.upcard);
  const played = playHand({
    hands: d.hands,
    trump: pick.trump,
    leader: BOT,
    controller: (seat, st) => botCard(st),
  });
  const s = score({
    hands: d.hands, trump: pick.trump, cardPoints: played.cardPoints, chooser: PLAYER,
  });
  return { trump: pick.trump, ...s };
}

// ------------------------------------------------------------- calibration
/**
 * Outcome distribution from bot self-play, used to price the payouts.
 * Regenerate with `node tools/calibrate-debertz.js` after ANY change to the bot or the
 * hand evaluation. test/debertz.test.js re-simulates and fails if this has drifted.
 */
const OUTCOMES = {
  samples: 40000,
  measured: '2026-09-28',
  // Probability the chooser wins by at least this margin. Index 0 is "won at all".
  bands: [0, 20, 50, 90, 140],
  probs: [0.8015, 0.6710, 0.3775, 0.0901, 0.0144],
};

// The chooser wins about four hands in five, which constrains the pricing hard: at a 1%
// edge the average winning hand can only be worth about 1.23x. Left to a free solve, a
// narrow win would price BELOW the stake, so "you won" would quietly mean "you lost
// money". Instead the narrowest band is pinned to exactly 1.00 (a push, honestly
// labelled) and only the margin bands above it are solved, so every win returns at
// least what was staked and the upside sits where the hand was genuinely good.
const PUSH_BAND = 0;
const PAYOUT_SHAPE = [1, 1.15, 1.6, 3.0];   // relative shape for bands 1..4

const floor2 = (x) => Math.floor(x * 100) / 100;

/**
 * Solve the payout table for a target RTP.
 *
 * Bands are cumulative, so the probability of landing exactly in band i is
 * probs[i] - probs[i+1], and the expected return is the sum of those times the band's
 * payout. One scale factor, solved rather than guessed, then floored so rounding
 * favours the house.
 */
function payoutTable(edge, outcomes = OUTCOMES) {
  const target = 1 - edge;
  const p = outcomes.probs;
  // Probability of landing in exactly band i, since the stored figures are cumulative.
  const exact = p.map((v, i) => v - (p[i + 1] || 0));

  const pushShare = exact[PUSH_BAND];
  let weighted = 0;
  for (let i = 1; i < exact.length; i += 1) weighted += exact[i] * PAYOUT_SHAPE[i - 1];
  if (weighted <= 0) throw new Error('debertz: degenerate outcome distribution');

  const scale = (target - pushShare) / weighted;
  if (scale <= 0) {
    throw new Error('debertz: pushes alone exceed the target RTP; the bot wins too often');
  }

  const pays = [1, ...PAYOUT_SHAPE.map((shape) => floor2(shape * scale))];

  let rtp = 0;
  for (let i = 0; i < exact.length; i += 1) rtp += exact[i] * pays[i];

  // Never ship a table that misses its target, and never one where winning loses money.
  if (rtp > target + 1e-9) throw new Error(`debertz: solved RTP ${rtp} exceeds target ${target}`);
  if (target - rtp > 0.01) {
    throw new Error(`debertz: solved RTP ${(rtp * 100).toFixed(2)}% is more than a point `
      + `below the target ${(target * 100).toFixed(2)}%`);
  }
  for (const [i, pay] of pays.entries()) {
    if (pay < 1) throw new Error(`debertz: band ${i} pays ${pay}x, which turns a win into a loss`);
  }
  return {
    bands: outcomes.bands, pays, rtp, target, scale, pushBand: PUSH_BAND,
    maxMultiplier: pays[pays.length - 1],
  };
}

/** Which payout a finished hand earns. Going bete pays nothing at all. */
function payoutFor(result, table) {
  if (result.bete) return { band: -1, multiplier: 0 };
  let band = -1;
  for (let i = 0; i < table.bands.length; i += 1) {
    if (result.margin >= table.bands[i]) band = i;
  }
  return band < 0 ? { band: -1, multiplier: 0 } : { band, multiplier: table.pays[band] };
}


// ------------------------------------------------------- the casino table
// The player always sits in seat 0 and always names trumps, which is the seat carrying
// the bete risk. State lives in the database so a hand survives a refresh, and the
// opponent cards never leave the server until the hand is over.
const now = () => Math.floor(Date.now() / 1000);

const activeGame = (db, userId) => db.get(
  "SELECT * FROM debertz_games WHERE user_id=? AND state!='done'", userId,
);

const loadState = (g) => ({
  hands: JSON.parse(g.hands),
  trick: JSON.parse(g.trick),
  cardPoints: JSON.parse(g.card_points),
  log: JSON.parse(g.log),
});

/** Client-safe view. The opponent hand is only a count until the hand is finished. */
function view(db, cfg, g, extra = {}) {
  const st = loadState(g);
  const table = payoutTable(cfg.houseEdge.debertz);
  const done = g.state === 'done';
  const trump = g.trump;
  return {
    gameId: g.id,
    state: g.state,
    stake: g.stake,
    upcard: g.upcard,
    trump,
    hand: sortHand(st.hands[PLAYER], trump || suitOf(g.upcard)),
    trick: st.trick,
    turn: g.turn,
    yourTurn: g.state === 'playing' && g.turn === PLAYER,
    cardPoints: st.cardPoints,
    trickNumber: g.trick_no,
    opponentCards: st.hands[BOT].length,
    log: st.log.slice(-6),
    meld: trump ? bestMeld(st.hands[PLAYER]) : null,
    bella: trump ? hasBella(st.hands[PLAYER], trump) : false,
    bands: table.bands,
    pays: table.pays,
    botHand: done ? st.hands[BOT] : null,
    ...extra,
  };
}

function start({ db, cfg, user, bank }, body) {
  const wager = U.parseAmount(body.amount);
  const table = payoutTable(cfg.houseEdge.debertz);

  return db.tx(() => {
    if (activeGame(db, user.id)) throw new U.BadRequest('finish your current hand first');
    bank.checkLimits(user, wager, table.maxMultiplier);

    const seed = auth.activeSeed(db, user.id);
    const nonce = auth.claimNonce(db, seed.id);
    const d = deal(seed.seed, user.client_seed, nonce);

    bank.takeStake(user, wager, `debertz#${nonce}`);
    db.run(
      `INSERT INTO debertz_games(user_id,stake,hands,upcard,state,mode,seed_id,nonce,
                                 client_seed,created_at)
       VALUES(?,?,?,?,'trump',?,?,?,?,?)`,
      user.id, wager, JSON.stringify(d.hands), d.upcard,
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

function chooseTrump({ db, cfg, user, bankFor }, body) {
  const trump = String(body.trump ?? '').toUpperCase();
  if (!SUITS.includes(trump)) throw new U.BadRequest('pick one of the four suits');

  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no hand in progress');
    if (g.state !== 'trump') throw new U.BadRequest('trumps are already chosen');

    // The opponent leads the first trick, which is part of what naming trumps costs.
    db.run("UPDATE debertz_games SET trump=?, state='playing', turn=?, last_winner=? WHERE id=?",
      trump, BOT, BOT, g.id);
    return runBot({ db, cfg, user, bankFor }, db.get('SELECT * FROM debertz_games WHERE id=?', g.id));
  });
}

function playCard({ db, cfg, user, bankFor }, body) {
  const card = String(body.card ?? '');
  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no hand in progress');
    if (g.state !== 'playing') throw new U.BadRequest('the hand is not in play');
    if (g.turn !== PLAYER) throw new U.BadRequest('it is not your turn');

    const st = loadState(g);
    const legal = legalPlays(st.hands[PLAYER], st.trick, g.trump);
    if (!legal.includes(card)) {
      throw new U.BadRequest(st.trick.length
        ? 'you must follow suit, trump if you cannot, and overtrump if the trick is trumped'
        : `${card} is not in your hand`);
    }

    st.hands[PLAYER] = st.hands[PLAYER].filter((c) => c !== card);
    st.trick.push({ seat: PLAYER, card });
    db.run('UPDATE debertz_games SET hands=?, trick=?, turn=? WHERE id=?',
      JSON.stringify(st.hands), JSON.stringify(st.trick), BOT, g.id);

    return runBot({ db, cfg, user, bankFor }, db.get('SELECT * FROM debertz_games WHERE id=?', g.id));
  });
}

/**
 * Advance the opponent until it is the player turn again, resolving tricks on the way.
 * Caller must already hold a transaction.
 */
function runBot(ctx, game) {
  const { db, cfg, user } = ctx;
  let g = game;
  let guard = 0;

  for (;;) {
    guard += 1;
    if (guard > 40) throw new Error('debertz: bot loop did not terminate');
    const st = loadState(g);

    if (st.trick.length === PLAYERS) {
      const w = st.trick[trickWinner(st.trick, g.trump)].seat;
      st.cardPoints[w] += st.trick.reduce((sum, pl) => sum + points(pl.card, g.trump), 0);
      st.log.push({
        trick: g.trick_no + 1,
        cards: st.trick.map((pl) => ({ seat: pl.seat, card: pl.card })),
        winner: w,
      });
      const trickNo = g.trick_no + 1;
      db.run(
        `UPDATE debertz_games SET trick='[]', turn=?, card_points=?, trick_no=?, log=?,
                                  last_winner=? WHERE id=?`,
        w, JSON.stringify(st.cardPoints), trickNo, JSON.stringify(st.log), w, g.id,
      );
      g = db.get('SELECT * FROM debertz_games WHERE id=?', g.id);
      if (trickNo >= HAND_SIZE) return settle(ctx, g);
      continue;
    }

    if (g.turn === PLAYER) return view(db, cfg, g);

    const card = botCard({ hand: st.hands[BOT], trick: st.trick, trump: g.trump, seat: BOT });
    const legal = legalPlays(st.hands[BOT], st.trick, g.trump);
    // The opponent must never be able to cheat; fall back to a legal card if the
    // heuristic ever returns something it is not allowed to play.
    const played = legal.includes(card) ? card : legal[0];

    st.hands[BOT] = st.hands[BOT].filter((c) => c !== played);
    st.trick.push({ seat: BOT, card: played });
    db.run('UPDATE debertz_games SET hands=?, trick=?, turn=? WHERE id=?',
      JSON.stringify(st.hands), JSON.stringify(st.trick), PLAYER, g.id);
    g = db.get('SELECT * FROM debertz_games WHERE id=?', g.id);
  }
}

/** Score and pay a finished hand. */
function settle({ db, cfg, user, bankFor }, g) {
  const bank = bankFor();
  const st = loadState(g);
  const table = payoutTable(cfg.houseEdge.debertz);

  // Melds score from the hands as dealt, so the deal is recomputed from the seed rather
  // than remembered: the same inputs always give the same cards, which is the whole
  // point of the fairness chain.
  const dealt = deal(
    db.get('SELECT seed FROM server_seeds WHERE id=?', g.seed_id).seed,
    g.client_seed, g.nonce,
  );
  const cardPoints = [...st.cardPoints];
  cardPoints[g.last_winner] += 10;   // ten for the last trick

  const result = score({ hands: dealt.hands, trump: g.trump, cardPoints, chooser: PLAYER });
  const { band, multiplier } = payoutFor(result, table);
  const payout = multiplier > 0 ? U.mulUnits(g.stake, multiplier) : 0;

  db.run("UPDATE debertz_games SET state='done', payout=?, ended_at=? WHERE id=?",
    payout, now(), g.id);

  bank.settle({
    user,
    game: 'debertz',
    wager: g.stake,
    multiplier: g.stake ? payout / g.stake : 0,
    payout,
    edgeUnits: Math.floor(g.stake * cfg.houseEdge.debertz),
    seedId: g.seed_id,
    nonce: g.nonce,
    clientSeed: g.client_seed,
    detail: {
      trump: g.trump, totals: result.totals, margin: result.margin,
      bete: result.bete, band, multiplier, melds: result.meldPoints, bella: result.bella,
    },
    stakeTaken: true,
  });

  const fresh = db.get('SELECT * FROM debertz_games WHERE id=?', g.id);
  return {
    ...view(db, cfg, fresh),
    finished: true,
    // Both hands as dealt, so the player can review what the opponent actually held.
    // By this point every card has been played, so the live hands are empty.
    dealtHands: dealt.hands,
    result,
    band,
    multiplier,
    payout,
    profit: payout - g.stake,
    outcome: result.bete ? 'bete' : (payout > g.stake ? 'won' : 'push'),
    balance: bank.balance(user.id),
  };
}

function current({ db, cfg, user }) {
  const g = activeGame(db, user.id);
  if (!g) {
    const table = payoutTable(cfg.houseEdge.debertz);
    return { state: 'none', bands: table.bands, pays: table.pays };
  }
  return view(db, cfg, g);
}

/** Rules panel data. */
function info(cfg) {
  const table = payoutTable(cfg.houseEdge.debertz);
  return {
    bands: table.bands,
    pays: table.pays,
    rtp: table.rtp,
    edge: 1 - table.rtp,
    winRate: OUTCOMES.probs[0],
    beteRate: 1 - OUTCOMES.probs[0],
    calibratedOn: OUTCOMES.measured,
    samples: OUTCOMES.samples,
    trumpOrder: TRUMP_ORDER.slice().reverse(),
    plainOrder: PLAIN_ORDER.slice().reverse(),
    trumpPoints: TRUMP_POINTS,
    plainPoints: PLAIN_POINTS,
    suits: SUITS,
  };
}

module.exports = {
  SUITS, RANKS, DECK, HAND_SIZE, PLAYERS, PLAYER, BOT,
  TRUMP_ORDER, PLAIN_ORDER, TRUMP_POINTS, PLAIN_POINTS,
  suitOf, rankOf, isTrump, strength, points, sortHand,
  deal, legalPlays, trickWinner, bestMeld, hasBella,
  evaluateTrump, chooseTrumpFor, botCard, playHand, score, simulateHand,
  OUTCOMES, PAYOUT_SHAPE, PUSH_BAND, payoutTable, payoutFor,
  start, chooseTrump, playCard, current, info, activeGame,
};
