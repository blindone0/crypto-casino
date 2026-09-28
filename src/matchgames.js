'use strict';
// The games that can be played at a table for tokens.
//
// Each one is a plugin. The framework in match.js owns the lobby, the escrow, the clocks
// and the settlement; a plugin owns nothing but the rules, and the two never mix.
//
// Seats are integers from 0 upward, not "host" and "guest". Chess wants two and poker
// wants up to six, and a framework that knows about exactly two players cannot be talked
// into a third. A two-player game is one whose plugin asks for two seats.
//
// The interface:
//
//   seats            { min, max, default } — how many can sit down
//   clockMs          how long each seat starts with
//   incrementMs      added back after each move
//   create(cfg, n)   the opening state, as a plain object that survives JSON
//   toMove(state)    which seat may act now, or null while nobody may
//   act(state, seat, payload, cfg)
//                    apply one action. Throws BadRequest if it is not allowed.
//                    Returns { state, note, winners?, reason? }; winners ends the match.
//   view(state, seat, n)
//                    what one seat is allowed to see. Морской бой needs this to be less
//                    than the whole state, which is why it exists at all.
//   canAct()         optional: who may act, when that is not simply whose turn it is.
//   clockRuns()      optional: whether the clock is ticking. It is not while people are
//                    still setting up.
//   resultOnTimeout(state, seat, n)        who wins when a clock runs out
//   resultOnSetupTimeout(state, n)         optional: who wins when nobody sets up
//   onQuit(state, seat, n)                 optional: what resigning does at a big table
//
// `winners` is always a list of seats. One of them is a win, all of them is a draw, and
// anything between is what a table game produces: in Дурак everyone except the fool won.

const crypto = require('node:crypto');
const U = require('./util');
const chess = require('./chess');
const seabattle = require('./seabattle');
const balda = require('./balda');
const wordsRu = require('./words-ru');

/** The other seat, at a table of two. */
const other = (seat) => (seat === 0 ? 1 : 0);

/** Everyone but this seat. What "you lose" means when there is no single winner. */
const allBut = (seat, n) => {
  const out = [];
  for (let s = 0; s < n; s += 1) if (s !== seat) out.push(s);
  return out;
};

const TWO = { min: 2, max: 2, default: 2 };

// -------------------------------------------------------------------- chess
const CHESS = {
  key: 'chess',
  name: 'Chess',
  seats: TWO,
  clockMs: 10 * 60 * 1000,
  incrementMs: 5 * 1000,

  create() {
    // Who gets White is decided here and never revisited. Doing it at the first move
    // would let a player learn their colour before committing their stake.
    return {
      fen: chess.START_FEN,
      white: crypto.randomInt(2),
      history: [chess.repetitionKey(chess.parseFen(chess.START_FEN))],
      san: [],
    };
  },

  toMove(state) {
    return chess.parseFen(state.fen).turn === 'w' ? state.white : other(state.white);
  },

  act(state, seat, payload) {
    let played;
    try {
      played = chess.move(state.fen, String(payload.move || ''), state.history);
    } catch (e) {
      // A move the rules forbid is the player's mistake, not the server's. Anything else
      // is rethrown untouched, so a genuine fault still surfaces as a fault.
      if (e.illegalMove) throw new U.BadRequest(e.message);
      throw e;
    }
    const next = {
      ...state,
      fen: played.fen,
      history: [...state.history, played.key],
      san: [...state.san, played.san],
    };
    if (!played.status.over) return { state: next, note: played.san };
    const winners = played.status.result === '1/2-1/2'
      ? [0, 1]
      : [played.status.result === '1-0' ? next.white : other(next.white)];
    return { state: next, note: played.san, winners, reason: played.status.reason };
  },

  view(state) {
    // Chess is a game of perfect information: both players may see everything, and the
    // legal move list is a convenience rather than a secret.
    return {
      fen: state.fen,
      white: state.white,
      san: state.san,
      legal: chess.legalUci(state.fen),
      check: chess.inCheck(chess.parseFen(state.fen)),
    };
  },

  resultOnTimeout(state, seat) {
    // A player who flags loses, unless the other side could not mate with what is left,
    // in which case the game is drawn. That is the actual rule, and it matters here
    // because a stake rides on it.
    const board = chess.parseFen(state.fen).board;
    const winnerWhite = other(seat) === state.white;
    const kept = board.filter(
      (p) => p !== null && (winnerWhite ? p === p.toUpperCase() : p === p.toLowerCase()),
    );
    const onlyKing = kept.length === 1;
    const kingAndMinor = kept.length === 2 && kept.some((p) => 'nbNB'.includes(p));
    return (onlyKing || kingAndMinor) ? [0, 1] : [other(seat)];
  },
};

// -------------------------------------------------------------- Морской бой
const SEABATTLE = {
  key: 'seabattle',
  name: 'Sea Battle',
  seats: TWO,
  clockMs: 8 * 60 * 1000,
  incrementMs: 3 * 1000,

  create() {
    return {
      phase: 'setup',
      boards: [null, null],
      turn: crypto.randomInt(2),
      log: [],
    };
  },

  toMove(state) {
    return state.phase === 'play' ? state.turn : null;
  },

  // During setup both players act, in either order, and neither waits for the other.
  canAct(state, seat) {
    if (state.phase === 'setup') return !state.boards[seat];
    return state.turn === seat;
  },

  // Nobody should lose time they are not being given the chance to use. The clock starts
  // when the shooting does.
  clockRuns(state) {
    return state.phase === 'play';
  },

  act(state, seat, payload) {
    if (state.phase === 'setup') {
      // Shooting is not an option yet, and saying so beats complaining about a fleet the
      // player was not trying to send.
      if (payload.fleet === undefined) {
        throw new U.BadRequest('place your fleet before you shoot');
      }
      const fleet = seabattle.parseFleet(payload.fleet);
      const boards = state.boards.slice();
      boards[seat] = seabattle.emptyBoard(fleet);
      const ready = boards.every(Boolean);
      return {
        state: { ...state, boards, phase: ready ? 'play' : 'setup' },
        note: 'fleet',
      };
    }

    const target = other(seat);
    const shot = seabattle.fire(state.boards[target], Number(payload.cell));
    const boards = state.boards.slice();
    boards[target] = shot.board;
    // A hit shoots again. That is the Russian rule, and it is what gives the game its
    // shape: a good run can take a whole fleet apart without the other side moving.
    const turn = shot.outcome === 'miss' ? target : seat;
    const next = {
      ...state,
      boards,
      turn,
      log: [...state.log, { seat, cell: Number(payload.cell), outcome: shot.outcome }],
    };
    if (seabattle.afloat(shot.board) === 0) {
      return { state: next, note: shot.outcome, winners: [seat], reason: 'fleet-sunk' };
    }
    return { state: next, note: shot.outcome };
  },

  view(state, seat) {
    const mine = seat === null ? null : state.boards[seat];
    const theirs = seat === null ? null : state.boards[other(seat)];
    return {
      phase: state.phase,
      turn: state.turn,
      size: seabattle.SIZE,
      fleet: seabattle.FLEET,
      placed: state.boards.map(Boolean),
      // Own board in full; the opponent's only as far as it has been shot at. Ships
      // nobody has found are not in this response at all, so there is nothing for a
      // modified client to read ahead.
      own: mine ? seabattle.boardView(mine, true) : null,
      theirs: theirs ? seabattle.boardView(theirs, false) : null,
      log: state.log.slice(-12),
    };
  },

  resultOnTimeout(state, seat) {
    return [other(seat)];
  },

  // Whoever did set up wins. If neither did, nobody has won anything and the stakes go
  // back untouched.
  resultOnSetupTimeout(state) {
    const placed = state.boards.map(Boolean);
    if (placed[0] === placed[1]) return null;
    return [placed[0] ? 0 : 1];
  },
};

// -------------------------------------------------------------------- Балда
/** Who won a finished Балда game. Written once and used by both endings. */
function baldaFinish(state) {
  const [a, b] = state.scores;
  if (a === b) return { winners: [0, 1], reason: 'tied' };
  return { winners: [a > b ? 0 : 1], reason: 'higher-score' };
}

const BALDA = {
  key: 'balda',
  name: 'Balda',
  seats: TWO,
  clockMs: 10 * 60 * 1000,
  incrementMs: 10 * 1000,

  create(cfg) {
    // The opening word is drawn from the dictionary, so every game starts differently and
    // neither player can have prepared for this particular board.
    const dictionary = wordsRu.loadWords(cfg && cfg.dataDir);
    const five = wordsRu.wordsOfLength(dictionary, balda.SIZE);
    if (!five.length) throw new Error('the dictionary has no five-letter word to open with');
    const opening = five[crypto.randomInt(five.length)];
    return {
      grid: balda.startGrid(opening),
      opening,
      scores: [0, 0],
      used: [opening],
      turn: crypto.randomInt(2),
      passes: 0,
      log: [],
    };
  },

  toMove(state) {
    return state.turn;
  },

  act(state, seat, payload, cfg) {
    const dictionary = wordsRu.loadWords(cfg && cfg.dataDir);

    // Passing is a move. Two in a row ends the game, which is what stops a player who has
    // run out of ideas from simply sitting on a lead until the clock does it.
    if (payload.pass) {
      const passes = state.passes + 1;
      const next = {
        ...state,
        passes,
        turn: other(seat),
        log: [...state.log, { seat, pass: true }],
      };
      if (passes >= 2) return { state: next, note: 'pass', ...baldaFinish(next) };
      return { state: next, note: 'pass' };
    }

    const move = balda.play(
      { grid: state.grid, used: state.used }, dictionary, payload,
    );
    const scores = state.scores.slice();
    scores[seat] += move.score;
    const next = {
      ...state,
      grid: move.grid,
      scores,
      used: [...state.used, move.word],
      turn: other(seat),
      passes: 0,
      log: [...state.log, { seat, word: move.word, score: move.score, path: move.path }],
    };
    if (balda.gridFull(next.grid)) return { state: next, note: move.word, ...baldaFinish(next) };
    return { state: next, note: move.word };
  },

  view(state) {
    // Nothing here is secret. Both players look at the same board, and the list of words
    // already spent is part of it.
    return {
      size: balda.SIZE,
      grid: state.grid,
      scores: state.scores,
      used: state.used,
      opening: state.opening,
      turn: state.turn,
      playable: balda.playable(state.grid),
      log: state.log.slice(-12),
    };
  },

  resultOnTimeout(state, seat) {
    return [other(seat)];
  },
};

const GAMES = {
  chess: CHESS,
  balda: BALDA,
  seabattle: SEABATTLE,
};

module.exports = { GAMES, other, allBut, TWO };
