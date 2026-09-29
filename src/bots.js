'use strict';
// Opponents for the match games, so they can be played when nobody else is about.
//
// THE RULE THAT SHAPES EVERYTHING HERE
//
// A bot is handed `plugin.view(state, seat, seats)` and nothing else — the same object the
// browser receives for that seat. That is not a promise made in a comment, it is the
// function signature: a bot has no reference to the state, so hole cards, opponents' hands
// and unsunk ships are not merely ignored, they are absent. Морской бой's view exists for
// exactly this reason and predates the bots by months.
//
// The cost is real and worth paying. A durak bot cannot count the cards in your hand and a
// poker bot cannot see your hole, so both play worse than one that cheated would. Good:
// the alternative is a practice opponent whose strength is indistinguishable from a rigged
// one, which teaches nothing.
//
// WHAT THESE ARE NOT
//
// They are not strong. Chess is the honest example: a real engine wants an evaluation
// function, a transposition table and an unmake-move, and `src/chess.js` has none of those
// — `legalMoves` calls `makeMove` per pseudo-move and `status()` re-runs `legalMoves`, so a
// search deep enough to matter would allocate its way to a halt. What is here is a one-ply
// search with a material and piece-square evaluation, which will take a hanging piece,
// prefer the centre, and lose to anyone who plans. Saying so plainly is better than
// shipping a weak bot behind a label that says "strong".
//
// Everything below returns a payload for `plugin.act`. Returning something illegal is not
// a crash: `src/solo.js` re-derives the legal set and falls back, because a bot that
// corrupts a game is worse than a bot that plays badly.

const crypto = require('node:crypto');
const chess = require('./chess');
const seabattle = require('./seabattle');
const balda = require('./balda');
const wordsRu = require('./words-ru');
const tron = require('../public/games/tron-rules.js');

/** A fair pick, using the same generator the games deal from. */
const pick = (list) => list[crypto.randomInt(list.length)];

// ----------------------------------------------------------------- chess ---

// Centipawns. Ordinary values; nothing here is tuned, because a one-ply search is not
// sensitive enough for tuning to mean anything.
const PIECE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// A pawn is worth more the further it has walked, and a knight is worth more in the middle
// than in a corner. Two small tables are enough to stop the bot shuffling on the back rank.
const PAWN_RANK = [0, 5, 10, 20, 35, 60, 100, 0];
const CENTRE = [0, 10, 20, 30, 30, 20, 10, 0];

/**
 * How good this position is for `white`, in centipawns.
 *
 * Material first, because material decides almost everything at one ply, then a nudge
 * towards the centre and up the board so the opening is not random.
 */
function evaluate(fen, white) {
  const pos = chess.parseFen(fen);
  let score = 0;
  for (let i = 0; i < 64; i += 1) {
    const piece = pos.board[i];
    if (!piece) continue;
    const isWhite = piece === piece.toUpperCase();
    const kind = piece.toLowerCase();
    let v = PIECE[kind] || 0;
    const file = i % 8;
    const rank = Math.floor(i / 8);
    if (kind === 'p') v += PAWN_RANK[isWhite ? 7 - rank : rank];
    else if (kind === 'n' || kind === 'b') v += (CENTRE[file] + CENTRE[isWhite ? 7 - rank : rank]) / 2;
    score += isWhite === white ? v : -v;
  }
  return score;
}

/**
 * Pick a move by looking one ply ahead.
 *
 * Every legal move is tried, the resulting position is evaluated, and the best is played.
 * Ties are broken at random so the bot does not repeat the same game every time.
 *
 * What this misses is everything an opponent does next: it will happily win a pawn with a
 * queen that is then taken. That is the honest limit of one ply, and going deeper needs
 * the engine work described at the top of this file.
 */
function chessBot(view, seat) {
  const legal = view.legal || [];
  if (!legal.length) return null;
  const white = seat === view.white;

  let best = -Infinity;
  let bestMoves = [];
  for (const uci of legal) {
    let next;
    try {
      next = chess.move(view.fen, uci, []);
    } catch {
      continue;  // the engine is the authority on legality, not this list
    }
    const score = evaluate(next.fen, white);
    if (score > best) { best = score; bestMoves = [uci]; }
    else if (score === best) bestMoves.push(uci);
  }
  return { move: bestMoves.length ? pick(bestMoves) : pick(legal) };
}

// ------------------------------------------------------------ морской бой ---

/**
 * Place a fleet, then hunt.
 *
 * The placement is the engine's own `randomFleet`, so a bot's ships are laid out by
 * exactly the rules a player's must satisfy.
 *
 * The hunt has two modes, which is what separates a bot that finishes a game from one that
 * wanders. With a wounded ship on the board it works outwards from the hits; with nothing
 * wounded it sweeps a parity pattern, because the smallest ship covers two squares and so
 * half the board is enough to find everything. That halves the shots wasted looking.
 */
function seabattleBot(view) {
  if (view.phase === 'setup') return { fleet: seabattle.randomFleet() };

  const shots = view.theirs && view.theirs.shots;
  if (!shots) return null;
  const size = view.size;
  const free = [];
  const hits = [];
  for (let i = 0; i < shots.length; i += 1) {
    if (shots[i] === null || shots[i] === undefined) free.push(i);
    else if (shots[i] === 'hit') hits.push(i);
  }
  if (!free.length) return null;

  // Target: anything orthogonally next to a hit is the rest of that ship.
  const targets = [];
  for (const h of hits) {
    const x = h % size;
    const y = Math.floor(h / size);
    const around = [
      x > 0 ? h - 1 : -1,
      x < size - 1 ? h + 1 : -1,
      y > 0 ? h - size : -1,
      y < size - 1 ? h + size : -1,
    ];
    for (const c of around) if (c >= 0 && free.includes(c)) targets.push(c);
  }
  if (targets.length) return { cell: pick(targets) };

  // Hunt: only squares where a two-long ship could still sit.
  const parity = free.filter((i) => ((i % size) + Math.floor(i / size)) % 2 === 0);
  return { cell: pick(parity.length ? parity : free) };
}

// ----------------------------------------------------------------- balda ---

/**
 * The longest word it can find.
 *
 * `balda.suggestions` was written with a comment saying it was for a hint "or a bot", so
 * this is that bot. It asks for several and takes the longest, because the score is the
 * length; passing is what is left when the dictionary has nothing.
 */
function baldaBot(view, seat, cfg) {
  const dictionary = wordsRu.loadWords(cfg && cfg.dataDir);
  const found = balda.suggestions(view.grid, dictionary, 12) || [];
  const fresh = found.filter((s) => !view.used.includes(s.word));
  if (!fresh.length) return { pass: true };
  const best = fresh.reduce((a, b) => (b.word.length > a.word.length ? b : a));
  return { cell: best.cell, letter: best.letter, word: best.word, path: best.path };
}

// ----------------------------------------------------------------- durak ---

const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rankOf = (card) => String(card).slice(0, -1);
const suitOf = (card) => String(card).slice(-1);
const power = (card, trump) => RANKS.indexOf(rankOf(card)) + (suitOf(card) === trump ? 100 : 0);

/**
 * Cheapest card that does the job, and hold the trumps.
 *
 * All of this reads `view.options`, which the plugin already computes for the browser, so
 * the bot is choosing between moves the server has agreed are legal rather than working
 * them out again.
 *
 * The one idea beyond "play the lowest card" is that a trump is worth keeping: defending
 * with a trump when a plain card would do is how a hand of trumps turns into a loss later.
 */
function durakBot(view) {
  const opts = view.options || {};
  const trump = view.trump;
  const playable = view.playable || [];
  const cheapest = (cards) => cards.slice().sort((a, b) => power(a, trump) - power(b, trump))[0];
  // Prefer a plain card over a trump at the same job: a hand that spends its trumps early
  // loses the bouts that matter later. Falls back when trumps are all that is left.
  const thrifty = (cards) => {
    const plain = cards.filter((c) => suitOf(c) !== trump);
    return cheapest(plain.length ? plain : cards);
  };

  // `options` reports *whether* a move is available, as booleans; the cards that make it
  // available arrive separately as `playable` and `canBeat`. Reading the booleans as card
  // lists is the obvious mistake to make here, so the two are kept visibly apart.
  if (opts.defend) {
    const answers = view.canBeat && view.canBeat.length ? view.canBeat : playable;
    if (answers.length) {
      const on = view.attacks.find((a) => !a.beat);
      return { play: 'defend', card: thrifty(answers), on: on ? on.card : undefined };
    }
  }
  if (opts.take) return { play: 'take' };
  if (opts.attack && playable.length) return { play: 'attack', card: thrifty(playable) };
  if (opts.passOn && playable.length) return { play: 'pass', card: thrifty(playable) };
  if (opts.done) return { play: 'done' };
  // Nothing legal left to do. Taking is the only move that always exists for a defender;
  // otherwise `solo.js` will fall back for us.
  return opts.take ? { play: 'take' } : null;
}

// ----------------------------------------------------------------- poker ---

const HIGH = ['A', 'K', 'Q', 'J', '10'];

/**
 * A tight, simple player.
 *
 * It sees its own two cards and the board, which is all any player sees, and it does not
 * attempt to read anyone: with no opponent model, bluffing would be noise rather than
 * strategy. So it plays a straightforward game — raise with a strong hand, call cheaply
 * with a hopeful one, fold what is going nowhere — and folds far more often than a person
 * would.
 *
 * Deliberately not built: Monte-Carlo equity. It would make the bot better at the cost of
 * a rollout per decision inside the player's own HTTP request, and a practice opponent is
 * not worth a second of latency per action.
 */
function pokerBot(view) {
  // A finished hand is not a decision. The table sits at 'showdown' until somebody asks
  // for the next deal, and `options` is empty there, so a bot that only ever reasoned
  // about betting would stop the tournament the first time a hand was won.
  if (view.street === 'showdown') return { play: 'next' };

  const o = view.options || {};
  if (!o.fold) return null;  // not this bot's turn after all

  const hole = view.hole || [];
  if (hole.length < 2) return o.check ? { play: 'check' } : { play: 'fold' };

  const [a, b] = hole;
  const ra = rankOf(a);
  const rb = rankOf(b);
  const pair = ra === rb;
  const suited = suitOf(a) === suitOf(b);
  const highs = [ra, rb].filter((r) => HIGH.includes(r)).length;

  // A rough strength, 0..1. Crude on purpose — see the note above.
  let strength = 0.1;
  if (pair) strength = RANKS.indexOf(ra) >= RANKS.indexOf('10') ? 0.9 : 0.6;
  else if (highs === 2) strength = suited ? 0.75 : 0.62;
  else if (highs === 1) strength = suited ? 0.45 : 0.32;
  else if (suited) strength = 0.28;

  // After the flop, having improved matters more than what was dealt.
  if (view.board && view.board.length >= 3) {
    const ranks = view.board.map(rankOf);
    if (ranks.includes(ra) || ranks.includes(rb)) strength = Math.max(strength, 0.78);
  }

  const potOdds = o.call > 0 ? o.call / Math.max(1, view.pot + o.call) : 0;

  if (strength > 0.8 && o.raise) {
    // Raise about two thirds of the pot, held inside what the table allows.
    const want = Math.round(view.pot * 0.66) + o.call;
    const to = Math.min(Math.max(want, o.minRaiseTo), o.maxRaiseTo);
    return { play: 'raise', amount: to };
  }
  if (o.check) return { play: 'check' };
  if (o.call > 0 && strength > potOdds + 0.12) return { play: 'call' };
  return { play: 'fold' };
}

// ---------------------------------------------------------------------------

// ------------------------------------------------------------------ tron ---
/**
 * The classic light-cycle bot, which lives in the rules file so the arcade rides the same
 * one. In solo the view carries the live simulation; a caller with only the inputs gets
 * the race rebuilt from them, which is the same race.
 */
function tronBot(view, seat) {
  const sim = view.sim || tron.replay(view.n, view.turns, view.tick);
  const h = tron.botHeading(sim, seat, () => crypto.randomInt(1000000) / 1000000, 6);
  if (!h || h === sim.riders[seat].h) return { turn: 'straight' };
  return { turn: h };
}

/**
 * One bot per game, keyed the way `matchgames.GAMES` is.
 *
 * Each is `(view, seat, cfg) -> payload`. `view` is the only window onto the position, and
 * that is the whole anti-cheat story.
 */
const BOTS = {
  chess: chessBot,
  seabattle: seabattleBot,
  balda: baldaBot,
  durak: durakBot,
  poker: pokerBot,
  tron: tronBot,
};

/**
 * Ask the bot for this game to move.
 *
 * Returns null when it has nothing to say, which `solo.js` treats as "fall back to a legal
 * move" rather than as an error. The registry is a seam: a stronger engine for one game —
 * a real chess search, say — replaces one entry here and nothing else in the codebase
 * changes. Nothing in it needs a GPU, and nothing ever will be allowed to require one.
 */
function choose(game, view, seat, cfg) {
  const bot = BOTS[game];
  if (!bot) return null;
  try {
    return bot(view, seat, cfg);
  } catch {
    // A bot that throws must not take the player's game down with it.
    return null;
  }
}

module.exports = { choose, BOTS, evaluate };
