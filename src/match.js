'use strict';
// Games played at a table for tokens.
//
// This is the part the arcade deliberately does not have. An arcade score arrives from the
// player's own machine and can never be worth money; a game between people is different,
// because the server holds the board and each move is checked against the rules before it
// is allowed to change anything. Nobody can move for anybody else, nobody can move out of
// turn, and nobody can play a move the rules forbid.
//
// Seats are an ordered list from 0 upward, not a host and a guest. Chess wants two and
// poker wants up to six, and a framework that knows about exactly two players cannot be
// talked into a third. A two-player game is simply one whose plugin asks for two seats.
//
// Stakes are escrowed on the token chain rather than in a column somewhere. Joining means
// signing a transfer of your stake to the house key, a signature only the player can
// produce; settling means the house signing the pot back out. Both are ordinary blocks, so
// the escrow is as auditable as every other token movement, and an operator who quietly
// pays the wrong person leaves the evidence on the chain.
//
// The rules themselves live in matchgames.js. Nothing in this file knows what a chess
// board is.

const crypto = require('node:crypto');
const U = require('./util');
const tokenchain = require('./tokenchain');
const { GAMES } = require('./matchgames');

const now = () => Math.floor(Date.now() / 1000);
const nowMs = () => Date.now();

const gameFor = (key) => GAMES[String(key || '')] || null;

// ----------------------------------------------------------------- the house
/**
 * The escrow identity: an ordinary chain key whose private half the server holds.
 *
 * Kept separate from the block-signing key on purpose. One is the operator's identity as
 * the keeper of the ledger and the other is a party that holds funds, and letting a single
 * key be both makes the chain harder to reason about for anyone auditing it.
 */
function houseKey(db) {
  let stored = db.kvGet('token.houseKey');
  if (!stored) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    stored = {
      publicRaw: tokenchain.rawPublicKey(publicKey),
      privatePkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'),
      createdAt: now(),
    };
    db.kvSet('token.houseKey', stored);
    db.audit('system', 'token.houseKey.created', { publicKey: stored.publicRaw });
  }
  return {
    publicRaw: stored.publicRaw,
    private: crypto.createPrivateKey({
      key: Buffer.from(stored.privatePkcs8, 'hex'), format: 'der', type: 'pkcs8',
    }),
  };
}

/** Build a transfer out of the house key, signed the same way a player's would be. */
function houseTransfer(db, to, amount) {
  const key = houseKey(db);
  const nonce = tokenchain.nextNonce(db, key.publicRaw);
  const tx = {
    type: 'transfer', from: key.publicRaw, to, amount, nonce,
  };
  tx.sig = crypto.sign(
    null, Buffer.from(tokenchain.canonical(tokenchain.transferPayload(tx))), key.private,
  ).toString('hex');
  db.run('INSERT INTO token_nonces(pubkey, nonce, created_at) VALUES(?,?,?)',
    key.publicRaw, nonce, now());
  return tx;
}

/**
 * Take a player's stake into escrow.
 *
 * The signature is the whole point: without it the operator could empty an account by
 * inventing matches it never agreed to join.
 */
function escrow(db, spend, amount) {
  const key = houseKey(db);
  const tx = {
    type: 'transfer',
    from: String(spend.from || '').toLowerCase(),
    to: key.publicRaw,
    amount,
    nonce: Number(spend.nonce),
    sig: String(spend.sig || '').toLowerCase(),
  };
  if (!/^[0-9a-f]{64}$/.test(tx.from)) throw new U.BadRequest('bad key');
  if (!/^[0-9a-f]{128}$/.test(tx.sig)) throw new U.BadRequest('bad signature');
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0) throw new U.BadRequest('bad nonce');
  if (!tokenchain.verifyTransferSignature(tx)) {
    throw new U.BadRequest('signature does not match this stake');
  }
  if (db.get('SELECT 1 FROM token_nonces WHERE pubkey=? AND nonce=?', tx.from, tx.nonce)) {
    throw new U.BadRequest('that nonce has already been used');
  }
  if (tokenchain.balanceOf(db, tx.from) < amount) {
    throw new U.BadRequest('not enough tokens for that stake');
  }
  db.run('INSERT INTO token_nonces(pubkey, nonce, created_at) VALUES(?,?,?)',
    tx.from, tx.nonce, now());
  return tokenchain.appendBlock(db, [tx]);
}

// ------------------------------------------------------------------- seats
/** Everyone at the table, in seat order. */
const seatsOf = (db, matchId) => db.all(
  'SELECT * FROM match_seats WHERE match_id=? ORDER BY seat', matchId,
);

/** Which seat a user occupies, or null. */
function seatOf(db, matchId, user) {
  if (!user) return null;
  const row = db.get('SELECT seat FROM match_seats WHERE match_id=? AND user_id=?',
    matchId, user.id);
  return row ? row.seat : null;
}

// ------------------------------------------------------------------ clocks
/**
 * Charge a seat for the time it took, and say whether it has run out.
 * The clock is read from the database rather than from anything the client sends, because
 * a clock a player can edit is not a clock.
 */
function chargeClock(db, match, seat) {
  const row = db.get('SELECT ms FROM match_seats WHERE match_id=? AND seat=?', match.id, seat);
  const elapsed = match.moved_at_ms ? nowMs() - match.moved_at_ms : 0;
  const left = (row ? row.ms : 0) - elapsed;
  return { left, flagged: left <= 0 };
}

function clockNow(db, match, seat, state) {
  const row = db.get('SELECT ms FROM match_seats WHERE match_id=? AND seat=?', match.id, seat);
  const raw = row ? row.ms : 0;
  if (match.status !== 'playing' || !state) return raw;
  const plugin = gameFor(match.game);
  const ticking = plugin.clockRuns ? plugin.clockRuns(state) : true;
  if (!ticking || plugin.toMove(state) !== seat) return raw;
  return Math.max(0, raw - (nowMs() - match.moved_at_ms));
}

// -------------------------------------------------------------- settlement
/**
 * Pay out and close the match.
 *
 * `winners` is a list of seats. One of them is a win, all of them is a draw, and anything
 * between is what a table game produces: in Дурак everyone except the fool has won.
 *
 * The rake comes off the pot once. What is left is split between the winners, and any
 * indivisible remainder stays with the house rather than being invented out of nothing to
 * make the shares even.
 */
function settle(db, cfg, match, winners, reason) {
  const seats = seatsOf(db, match.id);
  const pot = match.stake * seats.length;
  const rake = Math.floor(pot * cfg.match.rake);
  const prize = pot - rake;

  const list = [...new Set(winners || [])].filter((s) => seats.some((x) => x.seat === s));
  const each = list.length ? Math.floor(prize / list.length) : 0;

  const txs = [];
  if (each > 0) {
    for (const seat of list) {
      txs.push(houseTransfer(db, seats.find((x) => x.seat === seat).pubkey, each));
    }
  }
  if (txs.length) tokenchain.appendBlock(db, txs);

  // Whatever the winners did not take is what the house kept, which is the rake plus any
  // indivisible remainder. Recording the real figure beats recording the intended one.
  const kept = pot - each * list.length;
  db.run(
    "UPDATE matches SET status='done', result=?, reason=?, rake=?, ended_at=? WHERE id=?",
    JSON.stringify(list), reason, kept, now(), match.id,
  );
  db.audit('system', 'match.settled', {
    match: match.id, game: match.game, winners: list, reason, pot, rake: kept,
  });
  return { winners: list, reason, pot, rake: kept, each };
}

/** Give every stake back untouched. Used when a match is abandoned before it matters. */
function refund(db, match, reason) {
  const seats = seatsOf(db, match.id);
  const txs = seats.map((s) => houseTransfer(db, s.pubkey, match.stake));
  if (txs.length) tokenchain.appendBlock(db, txs);
  db.run("UPDATE matches SET status='cancelled', reason=?, ended_at=? WHERE id=?",
    reason, now(), match.id);
  return { cancelled: true, reason };
}

// ------------------------------------------------------------------- lobby
function requireToken(db, cfg, user) {
  if (!cfg.token.enabled) throw new U.BadRequest('the site token is disabled');
  if (!cfg.match.enabled) throw new U.BadRequest('matches are closed');
  const key = tokenchain.keyFor(db, user.id);
  if (!key) throw new U.BadRequest('create a token wallet first');
  return key;
}

function checkStake(cfg, stake) {
  const value = Number(stake);
  if (!Number.isSafeInteger(value)) throw new U.BadRequest('bad stake');
  if (value < cfg.match.minStake || value > cfg.match.maxStake) {
    throw new U.BadRequest(
      `stake must be between ${U.formatAmount(cfg.match.minStake)}`
      + ` and ${U.formatAmount(cfg.match.maxStake)}`,
    );
  }
  return value;
}

/** How many seats this table wants, within what the game allows. */
function checkSeats(plugin, wanted) {
  const n = Number(wanted ?? plugin.seats.default);
  if (!Number.isSafeInteger(n) || n < plugin.seats.min || n > plugin.seats.max) {
    throw new U.BadRequest(
      `${plugin.name} is for ${plugin.seats.min} to ${plugin.seats.max} players`,
    );
  }
  return n;
}

function sit(db, matchId, seat, user, pubkey, ms) {
  db.run(
    `INSERT INTO match_seats(match_id, seat, user_id, pubkey, ms, joined_at)
     VALUES(?,?,?,?,?,?)`,
    matchId, seat, user.id, pubkey, ms, now(),
  );
}

/** Open a table. The host's stake goes into escrow immediately. */
function create(db, cfg, user, { game, stake, spend, seats }) {
  const plugin = gameFor(game);
  if (!plugin) throw new U.BadRequest('no such game');
  const key = requireToken(db, cfg, user);
  const amount = checkStake(cfg, stake);
  const wanted = checkSeats(plugin, seats);
  if (String(spend.from || '').toLowerCase() !== key.pubkey) {
    throw new U.Forbidden('that key is not registered to this account');
  }

  return db.tx(() => {
    const open = db.get(
      "SELECT COUNT(*) AS n FROM matches WHERE host_id=? AND status='open'", user.id,
    ).n;
    if (open >= cfg.match.maxOpenPerUser) {
      throw new U.BadRequest('you already have too many open challenges');
    }
    escrow(db, spend, amount);
    const info = db.run(
      `INSERT INTO matches(game, status, stake, rake, seats, host_id, state, created_at)
       VALUES(?,'open',?,0,?,?,?,?)`,
      plugin.key, amount, wanted, user.id, JSON.stringify(null), now(),
    );
    const id = Number(info.lastInsertRowid);
    sit(db, id, 0, user, key.pubkey, plugin.clockMs);
    return { id, game: plugin.key, stake: amount, seats: wanted };
  });
}

/** Take a seat. The table starts when the last one is filled. */
function join(db, cfg, user, { id, spend }) {
  const key = requireToken(db, cfg, user);
  return db.tx(() => {
    const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
    if (!match) throw new U.NotFound('no such match');
    if (match.status !== 'open') throw new U.BadRequest('that match is no longer open');
    if (match.host_id === user.id) throw new U.BadRequest('you cannot join your own challenge');
    if (seatOf(db, match.id, user) !== null) {
      throw new U.BadRequest('you are already at that table');
    }
    if (String(spend.from || '').toLowerCase() !== key.pubkey) {
      throw new U.Forbidden('that key is not registered to this account');
    }

    const plugin = gameFor(match.game);
    const taken = seatsOf(db, match.id);
    if (taken.length >= match.seats) throw new U.BadRequest('that table is full');

    escrow(db, spend, match.stake);
    sit(db, match.id, taken.length, user, key.pubkey, plugin.clockMs);

    const filled = taken.length + 1;
    if (filled < match.seats) {
      return { id: match.id, game: match.game, seated: filled, of: match.seats };
    }

    const state = plugin.create(cfg, match.seats);
    db.run(
      "UPDATE matches SET status='playing', state=?, started_at=?, moved_at_ms=? WHERE id=?",
      JSON.stringify(state), now(), nowMs(), match.id,
    );
    return { id: match.id, game: match.game, seated: filled, of: match.seats, started: true };
  });
}

/** Withdraw a table that has not started. Everyone seated gets their stake back. */
function cancel(db, user, id) {
  return db.tx(() => {
    const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
    if (!match) throw new U.NotFound('no such match');
    if (match.host_id !== user.id) throw new U.Forbidden('not your challenge');
    if (match.status !== 'open') throw new U.BadRequest('that match has already started');
    return refund(db, match, 'cancelled');
  });
}

/** Play one move. */
function act(db, cfg, user, { id, ...payload }) {
  return db.tx(() => {
    const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
    if (!match) throw new U.NotFound('no such match');
    if (match.status !== 'playing') throw new U.BadRequest('that match is not in play');
    const seat = seatOf(db, match.id, user);
    if (seat === null) throw new U.Forbidden('you are not in that match');

    const plugin = gameFor(match.game);
    const state = JSON.parse(match.state);
    const allowed = plugin.canAct ? plugin.canAct(state, seat) : plugin.toMove(state) === seat;
    if (!allowed) throw new U.BadRequest('not your turn');

    // The clock is charged before the move is applied, so a move sent after the flag has
    // fallen cannot save the player who sent it. It does not run during setup.
    const ticking = plugin.clockRuns ? plugin.clockRuns(state) : true;
    const clock = ticking ? chargeClock(db, match, seat) : null;
    if (clock && clock.flagged) {
      const winners = plugin.resultOnTimeout(state, seat, match.seats);
      return { ...settle(db, cfg, match, winners, 'timeout'), flagged: seat };
    }

    const outcome = plugin.act(state, seat, payload, cfg);
    const ply = db.get('SELECT COUNT(*) AS n FROM match_moves WHERE match_id=?', match.id).n;
    db.run(
      `INSERT INTO match_moves(match_id, seat, ply, move, note, created_at)
       VALUES(?,?,?,?,?,?)`,
      match.id, seat, ply, JSON.stringify(payload), outcome.note || null, now(),
    );
    if (clock) {
      db.run('UPDATE match_seats SET ms=? WHERE match_id=? AND seat=?',
        clock.left + plugin.incrementMs, match.id, seat);
    }
    // The clock always restarts here. During setup nobody is charged, but play must not
    // begin with one seat already owing however long the setting-up took.
    db.run('UPDATE matches SET state=?, moved_at_ms=? WHERE id=?',
      JSON.stringify(outcome.state), nowMs(), match.id);

    if (outcome.winners) {
      const fresh = db.get('SELECT * FROM matches WHERE id=?', match.id);
      return settle(db, cfg, fresh, outcome.winners, outcome.reason || 'result');
    }
    return { ok: true, note: outcome.note };
  });
}

/**
 * Give up.
 *
 * At a table of more than two this folds you rather than handing the pot to one opponent,
 * when the game knows how to carry on without you. Otherwise everyone else has won.
 */
function resign(db, cfg, user, id) {
  return db.tx(() => {
    const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
    if (!match) throw new U.NotFound('no such match');
    if (match.status !== 'playing') throw new U.BadRequest('that match is not in play');
    const seat = seatOf(db, match.id, user);
    if (seat === null) throw new U.Forbidden('you are not in that match');

    const plugin = gameFor(match.game);
    if (plugin.onQuit) {
      const state = JSON.parse(match.state);
      const outcome = plugin.onQuit(state, seat, match.seats);
      if (!outcome.winners) {
        db.run('UPDATE matches SET state=?, moved_at_ms=? WHERE id=?',
          JSON.stringify(outcome.state), nowMs(), match.id);
        return { ok: true, folded: seat };
      }
      return settle(db, cfg, match, outcome.winners, outcome.reason || 'resignation');
    }

    const everyoneElse = [];
    for (let s = 0; s < match.seats; s += 1) if (s !== seat) everyoneElse.push(s);
    return settle(db, cfg, match, everyoneElse, 'resignation');
  });
}

/**
 * Claim the win when somebody's clock has run out.
 *
 * Anyone at the table may call it, and it is checked against the stored clock rather than
 * taken on trust, so calling it early simply fails.
 */
function claimTimeout(db, cfg, user, id) {
  return db.tx(() => {
    const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
    if (!match) throw new U.NotFound('no such match');
    if (match.status !== 'playing') throw new U.BadRequest('that match is not in play');
    if (seatOf(db, match.id, user) === null) throw new U.Forbidden('you are not in that match');
    const plugin = gameFor(match.game);
    const state = JSON.parse(match.state);

    // Still setting up, so the game clock is not running and a separate deadline applies.
    if (plugin.clockRuns && !plugin.clockRuns(state)) {
      if (now() - match.started_at < cfg.match.setupSeconds) {
        throw new U.BadRequest('they still have time to set up');
      }
      const winners = plugin.resultOnSetupTimeout
        ? plugin.resultOnSetupTimeout(state, match.seats) : null;
      // Nobody turned up. Nobody won anything, so nobody is charged for it.
      if (!winners || !winners.length) return refund(db, match, 'abandoned');
      return settle(db, cfg, match, winners, 'no-setup');
    }

    const waiting = plugin.toMove(state);
    if (waiting === null) throw new U.BadRequest('nobody is on the clock');
    const clock = chargeClock(db, match, waiting);
    if (!clock.flagged) throw new U.BadRequest('their clock has not run out');
    return settle(db, cfg, match, plugin.resultOnTimeout(state, waiting, match.seats), 'timeout');
  });
}

// -------------------------------------------------------------------- views
function summary(db, match) {
  const seats = seatsOf(db, match.id);
  const players = seats.map((s) => {
    const u = db.get('SELECT username FROM users WHERE id=?', s.user_id);
    return { seat: s.seat, name: u ? u.username : '?' };
  });
  return {
    id: match.id,
    game: match.game,
    status: match.status,
    stake: match.stake,
    seats: match.seats,
    players,
    host: players.length ? players[0].name : '?',
    winners: match.result ? JSON.parse(match.result) : null,
    reason: match.reason,
    createdAt: match.created_at,
  };
}

/** One match, as a given user is allowed to see it. */
function detail(db, cfg, user, id) {
  const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
  if (!match) throw new U.NotFound('no such match');
  const plugin = gameFor(match.game);
  const seat = seatOf(db, match.id, user);
  const state = match.state && match.state !== 'null' ? JSON.parse(match.state) : null;
  const seats = seatsOf(db, match.id);
  return {
    ...summary(db, match),
    seat,
    toMove: state ? plugin.toMove(state) : null,
    view: state ? plugin.view(state, seat, match.seats) : null,
    clock: seats.map((s) => clockNow(db, match, s.seat, state)),
    moves: db.all(
      'SELECT seat, ply, note, created_at FROM match_moves WHERE match_id=? ORDER BY ply',
      match.id,
    ),
  };
}

/** The lobby: open tables, plus whatever the caller is already playing. */
function lobby(db, cfg, user) {
  const open = db.all(
    "SELECT * FROM matches WHERE status='open' ORDER BY created_at DESC LIMIT 50",
  );
  const mine = user
    ? db.all(
      `SELECT m.* FROM matches m JOIN match_seats s ON s.match_id = m.id
        WHERE s.user_id = ? AND m.status IN ('open','playing')
        ORDER BY m.created_at DESC LIMIT 50`, user.id,
    )
    : [];
  const key = user ? tokenchain.keyFor(db, user.id) : null;
  return {
    enabled: cfg.match.enabled && cfg.token.enabled,
    symbol: cfg.token.symbol,
    rake: cfg.match.rake,
    minStake: cfg.match.minStake,
    maxStake: cfg.match.maxStake,
    houseKey: houseKey(db).publicRaw,
    pubkey: key ? key.pubkey : null,
    balance: key ? tokenchain.balanceOf(db, key.pubkey) : 0,
    nextNonce: key ? tokenchain.nextNonce(db, key.pubkey) : 0,
    games: Object.values(GAMES).map((g) => ({
      key: g.key, name: g.name, clockMs: g.clockMs, seats: g.seats,
    })),
    open: open.map((m) => summary(db, m)),
    mine: mine.map((m) => summary(db, m)),
  };
}

/** Operator view: what the tables are actually earning. */
function stats(db) {
  const rows = db.all(
    `SELECT game, COUNT(*) AS played, COALESCE(SUM(rake),0) AS rake,
            COALESCE(SUM(stake * seats),0) AS wagered
       FROM matches WHERE status='done' GROUP BY game ORDER BY played DESC`,
  );
  return {
    perGame: rows,
    played: rows.reduce((s, r) => s + r.played, 0),
    rake: rows.reduce((s, r) => s + r.rake, 0),
    wagered: rows.reduce((s, r) => s + r.wagered, 0),
  };
}

module.exports = {
  GAMES, gameFor, houseKey, houseTransfer, escrow,
  create, join, cancel, act, resign, claimTimeout,
  lobby, detail, summary, settle, refund, stats, seatOf, seatsOf,
};
