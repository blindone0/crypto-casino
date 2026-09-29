'use strict';
// A real jigsaw: drag the pieces into place, against a clock.
//
// WHY A SKILL GAME IS AWKWARD HERE
//
// Anyone who keeps dragging finishes eventually, so the only thing that can decide a
// payout is *how fast*. That makes a script the natural opponent rather than variance, and
// everything below is shaped by it.
//
// WHAT STOPS IT BEING FARMED
//
// 1. The clock is the server's. `started_at` is written here, and the finish time is
//    `now() - started_at` computed here. A client that lies about its own timer is lying
//    to itself; nothing it sends is used.
//
// 2. The solution is never sent to the browser. The scramble is derived from the round
//    seed, and `solve` checks the arrangement the player submits against the one this file
//    recomputes. A modified client cannot read the answer off the wire because it was
//    never on the wire.
//
// 3. There is a floor under the time. A human cannot place thirty-six pieces in two
//    seconds, so a finish that fast is a script and pays nothing. The floor is per piece
//    rather than per round, which is what makes it scale with difficulty instead of
//    punishing the big grids.
//
// 4. The payout is capped by what the house holds, like every other game here.
//
// None of that makes it unfarmable by a determined person with a browser automation
// harness. It makes it not worth the trouble, which for a project friends play is the
// honest goal — and it is why the entry fee exists at all: a farm that pays its entry
// every round is paying for the privilege.

const U = require('../util');
const fair = require('../fair');
const auth = require('../auth');
const events = require('../events');
const tokenchain = require('../tokenchain');
const pictures = require('../pictures');

const now = () => Math.floor(Date.now() / 1000);

/** How many moves a round may log, per piece. Past this a client is filling blocks. */
const MOVE_CAP = 40;

/**
 * The board. There is one, and it is 10x10.
 *
 * This started as four rungs — 36, 100, 196 and 400 pieces — and was cut twice: first to
 * two, then to this. 400 was too much to sit through and 36 is not a jigsaw, so the ladder
 * was mostly rungs nobody would choose. One board also means one honest pay table rather
 * than four that have to be kept in step with each other.
 *
 * The structure stays a table rather than four constants because the size is a product
 * decision that has now changed three times, and `boardOf` already refuses an unknown
 * name. Adding a rung back is one line.
 *
 * `par` is seconds *per piece*, not per board, so the target scales with the work.
 */
const BOARDS = {
  medium: { cols: 10, rows: 10, par: 2.6, label: 'Medium' },
};

/** The par a round gets when it was played on a board that no longer exists. */
const DEFAULT_PAR = BOARDS.medium.par;

/** The fastest believable seconds per piece. Below this, nobody is dragging anything. */
const HUMAN_FLOOR_PER_PIECE = 0.45;

/** The best a round can pay, before the house's own ceiling is applied. */
const MAX_MULTIPLIER = 3;

function boardOf(name) {
  const b = BOARDS[name];
  if (!b) {
    throw new U.BadRequest(`unknown board; pick one of ${Object.keys(BOARDS).join(', ')}`);
  }
  return { ...b, pieces: b.cols * b.rows };
}

/**
 * The board a round in progress was played on, which is not necessarily a board still on
 * offer.
 *
 * This is the difference between choosing and remembering, and conflating the two stranded
 * a real player. The board table has been retuned three times; each time, every round open
 * at that moment named a board that had just stopped existing. `boardOf` threw, `current`
 * threw with it, the client saw no round and drew the start panel — and starting was then
 * refused with "finish your current jigsaw first", a round the interface would not show.
 * A dead end of exactly the kind this project is supposed not to have.
 *
 * So a round carries its own geometry. `cols`, `rows` and `par` are all it needs, and a
 * round played on a since-retired board finishes on the terms it was sold under, which is
 * also the honest answer.
 */
function boardOfRound(g) {
  const b = BOARDS[g.board];
  if (b) return { ...b, pieces: b.cols * b.rows };

  // A retired board. The row does not store `cols` and `rows`, but it stores the scramble,
  // and the scramble is the board that was actually played — one entry per piece. Every
  // board here has been square, so the side is its square root; a non-square one would
  // need the columns stored, and this returns a square that at least has the right piece
  // count rather than guessing a size.
  const pieces = Array.isArray(g.scramble)
    ? g.scramble.length
    : (JSON.parse(g.scramble || '[]').length || 100);
  const side = Math.round(Math.sqrt(pieces)) || 10;
  return {
    cols: side,
    rows: Math.ceil(pieces / side),
    pieces,
    // The par the round was sold under is not recoverable, so it takes the current one.
    // It is the only guess here, and it moves a finished time by seconds, not tiers.
    par: DEFAULT_PAR,
    label: g.board,
    retired: true,
  };
}

/**
 * Where every piece starts, derived from the seed.
 *
 * A Fisher-Yates shuffle driven by the round's own floats, so the scramble is part of the
 * provably-fair record: replaying the seed reproduces exactly the board that was played.
 * `scramble[i]` is the piece that begins in slot `i`.
 */
function scrambleFor(serverSeed, clientSeed, nonce, board) {
  const n = board.pieces;
  const order = Array.from({ length: n }, (_, i) => i);
  const fs = fair.floats(serverSeed, `${clientSeed}:jigsaw`, nonce, n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    const j = i + Math.floor(fs[i] * (n - i));
    [order[i], order[j]] = [order[j], order[i]];
  }
  // A scramble that happens to be solved would pay for nothing, so nudge it.
  if (order.every((piece, slot) => piece === slot)) {
    [order[0], order[1]] = [order[1], order[0]];
  }
  return order;
}

/**
 * What a finish is worth.
 *
 * Full multiplier at or under par, sliding to nothing at three times par. Linear, because
 * a curve here would be a second house edge nobody was told about: the edge is applied
 * once, at the end.
 */
function payoutMultiplier(seconds, board, edge) {
  const par = board.par * board.pieces;
  if (seconds <= par) return fair.floor2(MAX_MULTIPLIER * (1 - edge));
  const slack = par * 2;
  const over = seconds - par;
  if (over >= slack) return 0;
  const share = 1 - over / slack;
  return fair.floor2(MAX_MULTIPLIER * share * (1 - edge));
}

/** The ladder a player is shown before they pay, so the offer is legible up front. */
function payTable(name, edge) {
  return payTableFor(boardOf(name), edge);
}

/** The same ladder, for a board already in hand — including a retired one. */
function payTableFor(board, edge) {
  const par = board.par * board.pieces;
  return [
    { within: Math.round(par), multiplier: payoutMultiplier(par, board, edge) },
    { within: Math.round(par * 1.5), multiplier: payoutMultiplier(par * 1.5, board, edge) },
    { within: Math.round(par * 2), multiplier: payoutMultiplier(par * 2, board, edge) },
    { within: Math.round(par * 2.5), multiplier: payoutMultiplier(par * 2.5, board, edge) },
  ];
}

const activeGame = (db, userId) => db.get(
  "SELECT * FROM jigsaw_games WHERE user_id=? AND state='active'", userId,
);

/** What the player may see. Never the solution: they are meant to work that out. */
function view(db, cfg, g) {
  const board = boardOfRound(g);
  const elapsed = now() - g.started_at;
  return {
    id: g.id,
    board: g.board,
    cols: board.cols,
    rows: board.rows,
    pieces: board.pieces,
    picture: g.picture,
    scramble: JSON.parse(g.scramble),
    // The cut shape is cosmetic and the client draws it, but it has to be the same shape
    // on every re-render, so the seed for it travels with the round.
    cutSeed: g.nonce,
    state: g.state,
    wager: g.wager,
    elapsed,
    par: Math.round(board.par * board.pieces),
    cols: board.cols,
    rows: board.rows,
    payTable: payTableFor(board, cfg.houseEdge.jigsaw),
    multiplier: g.multiplier ?? null,
    payout: g.payout ?? null,
    seconds: g.seconds ?? null,
  };
}

function start({ db, cfg, user, bank }, body) {
  const wager = U.parseAmount(body.amount);
  const name = String(body.board || 'medium');
  const board = boardOf(name);

  return db.tx(() => {
    if (activeGame(db, user.id)) throw new U.BadRequest('finish your current jigsaw first');
    bank.checkLimits(user, wager, MAX_MULTIPLIER);

    const seed = auth.activeSeed(db, user.id);
    const nonce = auth.claimNonce(db, seed.id);
    const scramble = scrambleFor(seed.seed, user.client_seed, nonce, board);
    const picture = pictures.pictureFor(seed.seed, user.client_seed, nonce, cfg);

    bank.takeStake(user, wager, `jigsaw#${nonce}`);
    db.run(
      `INSERT INTO jigsaw_games(user_id,wager,board,picture,scramble,seed_id,nonce,
                                client_seed,state,started_at,created_at)
       VALUES(?,?,?,?,?,?,?,?,'active',?,?)`,
      user.id, wager, name, picture, JSON.stringify(scramble),
      seed.id, nonce, user.client_seed, now(), now(),
    );
    const g = activeGame(db, user.id);
    const opened = events.emit(db, cfg, {
      g: 'jigsaw',
      r: g.id,
      k: 'o',
      a: [wager, name, board.cols, board.rows, picture, tokenchain.sha256(tokenchain.canonical(scramble))],
      userId: user.id,
      pubkey: tokenchain.keyFor(db, user.id)?.pubkey || null,
    });
    return {
      ...view(db, cfg, g),
      event: opened && events.shown(opened),
      serverSeedHash: seed.seed_hash,
      balance: bank.balance(user.id),
    };
  });
}

/**
 * One drag, on the record.
 *
 * The board reports every drop, the wrong ones included — a log of only correct moves is
 * a log of a solver, not of a player — and each is written as an event without being
 * judged: the rules are the board's and the answer is solve()'s. What is checked is the
 * shape, and a ceiling on how many moves a round may have, so a client cannot fill blocks
 * with noise. A piece taken off the board is recorded as -1.
 */
function place({ db, cfg, user }, body) {
  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.BadRequest('no jigsaw in progress');
    const board = boardOfRound(g);
    const slot = U.toInt(body.slot, { min: 0, max: board.pieces - 1, name: 'slot' });
    const off = body.piece === null || body.piece === undefined || Number(body.piece) === -1;
    const piece = off ? -1 : U.toInt(body.piece, { min: 0, max: board.pieces - 1, name: 'piece' });
    const round = events.round(db, 'jigsaw', g.id);
    if (round && round.next_seq >= board.pieces * MOVE_CAP) {
      throw new U.BadRequest('too many moves for one round');
    }
    const step = events.emit(db, cfg, { g: 'jigsaw', r: g.id, k: 'p', a: [slot, piece] });
    return { ok: true, event: step && events.shown(step) };
  });
}

/**
 * The board as the record has it: slot -> piece, rebuilt from the round's moves. This is
 * what a player who closed the tab comes back to.
 */
function placedFrom(db, g) {
  const board = boardOfRound(g);
  const placed = new Array(board.pieces).fill(null);
  for (const e of events.history(db, 'jigsaw', g.id)) {
    if (e.k !== 'p') continue;
    const [slot, piece] = e.a;
    // A piece is in one slot at most and a slot holds one piece: the later move wins.
    for (let s = 0; s < placed.length; s += 1) if (placed[s] === piece) placed[s] = null;
    placed[slot] = piece === -1 ? null : piece;
  }
  return placed;
}

/**
 * Hand in a finished board.
 *
 * `arrangement[slot] = piece`. It is checked against the only arrangement that counts —
 * every piece in its own slot — rather than against anything the client claims about
 * itself.
 */
function solve({ db, cfg, user, bankFor }, body) {
  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.BadRequest('no jigsaw in progress');

    const board = boardOfRound(g);
    const arrangement = Array.isArray(body.arrangement) ? body.arrangement : null;
    if (!arrangement || arrangement.length !== board.pieces) {
      throw new U.BadRequest('that is not a finished board');
    }
    // Every entry must be a piece. The client's board now starts empty and an unplaced
    // slot holds `null`, and `Number(null)` is 0 — which matches slot 0. On its own that
    // is harmless, because a board where every other slot is also null fails immediately;
    // but it is a coincidence rather than a rule, and a check that happens to be safe is
    // one refactor away from not being. So nulls are refused outright.
    const complete = arrangement.every((piece) => Number.isInteger(Number(piece))
      && piece !== null && piece !== '' && Number(piece) >= 0 && Number(piece) < board.pieces);
    const solved = complete && arrangement.every((piece, slot) => Number(piece) === slot);
    if (!solved) throw new U.BadRequest('the picture is not complete');

    const seconds = now() - g.started_at;
    const bank = bankFor();
    const edge = cfg.houseEdge.jigsaw;

    // Faster than a person can physically drag: no payout, and the round still closes so
    // the entry is not refunded. Saying so plainly beats a silent zero.
    const floor = HUMAN_FLOOR_PER_PIECE * board.pieces;
    const tooFast = seconds < floor;
    const multiplier = tooFast ? 0 : payoutMultiplier(seconds, board, edge);
    const raw = U.mulUnits(g.wager, multiplier);
    const { payout, capped } = bank.capPayout(g.wager, raw);

    db.run(
      `UPDATE jigsaw_games SET state='done', seconds=?, multiplier=?, payout=? WHERE id=?`,
      seconds, multiplier, payout, g.id,
    );

    bank.settle({
      user,
      game: 'jigsaw',
      wager: g.wager,
      multiplier,
      payout,
      edgeUnits: Math.floor(g.wager * edge),
      seedId: g.seed_id,
      nonce: g.nonce,
      clientSeed: g.client_seed,
      detail: { board: g.board, seconds, tooFast, capped },
      stakeTaken: true,
      logged: true,
    });
    // The player's signature over the round so far, if the request carried one, goes on
    // the finishing event: the record of this round is then theirs as much as the house's.
    const att = events.attest(db, cfg, {
      g: 'jigsaw', r: g.id, sig: body.roundSig, pubkey: tokenchain.keyFor(db, user.id)?.pubkey || null,
    });
    const sig = att.attested ? String(body.roundSig) : null;
    events.emit(db, cfg, { g: 'jigsaw', r: g.id, k: 'f', a: [seconds, multiplier, payout, tooFast], sig });
    events.close(db, { g: 'jigsaw', r: g.id, sig });

    const done = db.get('SELECT * FROM jigsaw_games WHERE id=?', g.id);
    return {
      ...view(db, cfg, done),
      attested: att.attested,
      tooFast,
      capped,
      balance: bank.balance(user.id),
    };
  });
}

/** Walk away. The entry is spent, which is what an entry is. */
function give({ db, cfg, user }) {
  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) return { ok: true };
    db.run("UPDATE jigsaw_games SET state='done', seconds=?, multiplier=0, payout=0 WHERE id=?",
      now() - g.started_at, g.id);
    events.emit(db, cfg, { g: 'jigsaw', r: g.id, k: 'q', a: [now() - g.started_at] });
    events.close(db, { g: 'jigsaw', r: g.id });
    return { ok: true, ...view(db, cfg, db.get('SELECT * FROM jigsaw_games WHERE id=?', g.id)) };
  });
}

function current({ db, cfg, user }) {
  const g = activeGame(db, user.id);
  if (!g) return null;
  return {
    ...view(db, cfg, g),
    placed: placedFrom(db, g),
    // The round's record so far, for a browser that reopened it to fold again.
    events: events.history(db, 'jigsaw', g.id).map(events.shown),
  };
}

module.exports = {
  BOARDS, MAX_MULTIPLIER, HUMAN_FLOOR_PER_PIECE,
  boardOf, boardOfRound, scrambleFor, payoutMultiplier, payTable, payTableFor,
  start, solve, give, current, place, placedFrom, MOVE_CAP,
};
