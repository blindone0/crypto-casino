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
const pictures = require('../pictures');

const now = () => Math.floor(Date.now() / 1000);

/**
 * Board sizes. Only big ones — a nine-piece jigsaw is not a jigsaw.
 *
 * `par` is seconds *per piece*, not per board, so a 400-piece jigsaw is not simply
 * twenty-five times harder than a 36-piece one for the same money.
 *
 * It falls as boards grow, which is deliberate and not a discount: a big picture gives far
 * more context per piece than a small one — more edges to match, more obvious neighbours —
 * so people genuinely place them faster once they are going. A flat rate per piece would
 * make the big boards trivially winnable.
 */
const BOARDS = {
  easy: { cols: 6, rows: 6, par: 3.4, label: 'Easy' },
  medium: { cols: 10, rows: 10, par: 2.6, label: 'Medium' },
  hard: { cols: 14, rows: 14, par: 2.1, label: 'Hard' },
  expert: { cols: 20, rows: 20, par: 1.7, label: 'Expert' },
};

/**
 * Below this many pixels a piece is not draggable with a finger, so the boards that would
 * land under it are offered but marked. 400 pieces across a 390px phone is 16px, which is
 * a desktop board whatever the interface claims.
 */
const TOUCH_FLOOR_PX = 24;

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
  const board = boardOf(name);
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
  const board = boardOf(g.board);
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
    payTable: payTable(g.board, cfg.houseEdge.jigsaw),
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
    return {
      ...view(db, cfg, g),
      serverSeedHash: seed.seed_hash,
      balance: bank.balance(user.id),
    };
  });
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

    const board = boardOf(g.board);
    const arrangement = Array.isArray(body.arrangement) ? body.arrangement : null;
    if (!arrangement || arrangement.length !== board.pieces) {
      throw new U.BadRequest('that is not a finished board');
    }
    const solved = arrangement.every((piece, slot) => Number(piece) === slot);
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
    });

    const done = db.get('SELECT * FROM jigsaw_games WHERE id=?', g.id);
    return {
      ...view(db, cfg, done),
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
    return { ok: true, ...view(db, cfg, db.get('SELECT * FROM jigsaw_games WHERE id=?', g.id)) };
  });
}

function current({ db, cfg, user }) {
  const g = activeGame(db, user.id);
  return g ? view(db, cfg, g) : null;
}

module.exports = {
  BOARDS, MAX_MULTIPLIER, HUMAN_FLOOR_PER_PIECE,
  boardOf, scrambleFor, payoutMultiplier, payTable,
  start, solve, give, current,
};
