'use strict';
// Head-to-head matches played for tokens.
//
// This is the part the arcade deliberately does not have. An arcade score arrives from the
// player's own machine and can never be worth money; a match between two people is
// different, because the server holds the board and each side's move is checked against
// the rules here before it is allowed to change anything. Neither player can move for the
// other, neither can move out of turn, and neither can play a move the rules forbid.
//
// Stakes are escrowed on the token chain rather than in a column somewhere. Joining a
// match means signing a transfer of your stake to the house key, which is a signature only
// the player can produce; settling means the house signing the pot to the winner. Both
// appear as ordinary blocks, so the escrow is as auditable as every other token movement
// and an operator who quietly pays the wrong person leaves the evidence on the chain.
//
// Games plug in through a small interface (see GAMES below) so that chess, Морской бой and
// Балда share the lobby, the escrow, the clock and the settlement, and differ only in the
// rules of the game itself.

const crypto = require('node:crypto');
const U = require('./util');
const tokenchain = require('./tokenchain');
const chess = require('./chess');

const now = () => Math.floor(Date.now() / 1000);
const nowMs = () => Date.now();

const SEATS = ['host', 'guest'];
const otherSeat = (seat) => (seat === 'host' ? 'guest' : 'host');

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

// -------------------------------------------------------------- the games
/**
 * A game plugin.
 *
 * create()      the opening state, as a plain object that survives JSON.
 * toMove()      which seat may act now, or null while nobody may.
 * act()         apply one action for one seat. Throws BadRequest if it is not allowed.
 *               Returns { state, note, result?, reason? }; a result ends the match.
 * view()        what one seat is allowed to see. Battleship needs this to be less than
 *               the whole state, which is why it exists at all.
 * resultOnTimeout() who wins when a clock runs out.
 */
const GAMES = {
  chess: {
    key: 'chess',
    name: 'Chess',
    clockMs: 10 * 60 * 1000,
    incrementMs: 5 * 1000,

    create() {
      // Who gets White is decided here and never revisited. Doing it at the first move
      // would let a player learn their colour before committing their stake.
      const hostIsWhite = crypto.randomInt(2) === 0;
      const fen = chess.START_FEN;
      return {
        fen,
        white: hostIsWhite ? 'host' : 'guest',
        history: [chess.repetitionKey(chess.parseFen(fen))],
        san: [],
      };
    },

    toMove(state) {
      const pos = chess.parseFen(state.fen);
      return pos.turn === 'w' ? state.white : otherSeat(state.white);
    },

    act(state, seat, payload) {
      const played = chess.move(state.fen, String(payload.move || ''), state.history);
      const next = {
        ...state,
        fen: played.fen,
        history: [...state.history, played.key],
        san: [...state.san, played.san],
      };
      if (!played.status.over) return { state: next, note: played.san };
      const result = played.status.result === '1/2-1/2'
        ? 'draw'
        : (played.status.result === '1-0' ? next.white : otherSeat(next.white));
      return { state: next, note: played.san, result, reason: played.status.reason };
    },

    view(state) {
      // Chess is a game of perfect information: both players may see everything, and the
      // legal move list is a convenience, not a secret.
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
      const winnerWhite = otherSeat(seat) === state.white;
      const kept = board.filter((p) => p !== null && (winnerWhite ? p === p.toUpperCase() : p === p.toLowerCase()));
      const onlyKing = kept.length === 1;
      const kingAndMinor = kept.length === 2 && kept.some((p) => 'nbNB'.includes(p));
      return (onlyKing || kingAndMinor) ? 'draw' : otherSeat(seat);
    },
  },
};

const gameFor = (key) => GAMES[String(key || '')] || null;

// ------------------------------------------------------------------ clocks
/**
 * Charge the mover for the time they took, and say whether they have run out.
 * The clock is read from the database rather than from anything the client sends, because
 * a clock a player can edit is not a clock.
 */
function chargeClock(match, seat) {
  const elapsed = match.moved_at_ms ? nowMs() - match.moved_at_ms : 0;
  const column = seat === 'host' ? 'host_ms' : 'guest_ms';
  const left = match[column] - elapsed;
  return { column, left, flagged: left <= 0 };
}

// -------------------------------------------------------------- settlement
/**
 * Pay out and close the match.
 *
 * The rake comes off the pot once. On a decisive result the winner takes what is left; on
 * a draw it is split, and a single indivisible unit stays with the house rather than being
 * invented out of nothing to make the halves even.
 */
function settle(db, cfg, match, result, reason) {
  const pot = match.stake * 2;
  const rake = Math.floor(pot * cfg.match.rake);
  const prize = pot - rake;

  const txs = [];
  if (result === 'draw') {
    const each = Math.floor(prize / 2);
    if (each > 0) {
      txs.push(houseTransfer(db, match.host_key, each));
      txs.push(houseTransfer(db, match.guest_key, each));
    }
  } else {
    const winner = result === 'host' ? match.host_key : match.guest_key;
    if (prize > 0) txs.push(houseTransfer(db, winner, prize));
  }
  if (txs.length) tokenchain.appendBlock(db, txs);

  db.run(
    `UPDATE matches SET status='done', result=?, reason=?, rake=?, ended_at=? WHERE id=?`,
    result, reason, rake, now(), match.id,
  );
  db.audit('system', 'match.settled', {
    match: match.id, game: match.game, result, reason, pot, rake,
  });
  return { result, reason, pot, rake, prize };
}

/** Give both stakes back untouched. Used when a match is abandoned before it starts. */
function refund(db, match, reason) {
  const txs = [houseTransfer(db, match.host_key, match.stake)];
  if (match.guest_key) txs.push(houseTransfer(db, match.guest_key, match.stake));
  tokenchain.appendBlock(db, txs);
  db.run(`UPDATE matches SET status='cancelled', reason=?, ended_at=? WHERE id=?`,
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
    throw new U.BadRequest(`stake must be between ${cfg.match.minStake} and ${cfg.match.maxStake}`);
  }
  return value;
}

/** Open a challenge. The host's stake goes into escrow immediately. */
function create(db, cfg, user, { game, stake, spend }) {
  const plugin = gameFor(game);
  if (!plugin) throw new U.BadRequest('no such game');
  const key = requireToken(db, cfg, user);
  const amount = checkStake(cfg, stake);
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
      `INSERT INTO matches(game, status, stake, rake, host_id, host_key, state, created_at)
       VALUES(?,'open',?,0,?,?,?,?)`,
      plugin.key, amount, user.id, key.pubkey, JSON.stringify(null), now(),
    );
    return { id: Number(info.lastInsertRowid), game: plugin.key, stake: amount };
  });
}

/** Take up a challenge. Both stakes are now held, and the clocks start. */
function join(db, cfg, user, { id, spend }) {
  const key = requireToken(db, cfg, user);
  return db.tx(() => {
    const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
    if (!match) throw new U.NotFound('no such match');
    if (match.status !== 'open') throw new U.BadRequest('that match is no longer open');
    if (match.host_id === user.id) throw new U.BadRequest('you cannot join your own challenge');
    if (String(spend.from || '').toLowerCase() !== key.pubkey) {
      throw new U.Forbidden('that key is not registered to this account');
    }
    escrow(db, spend, match.stake);

    const plugin = gameFor(match.game);
    const state = plugin.create();
    db.run(
      `UPDATE matches SET status='playing', guest_id=?, guest_key=?, state=?,
              started_at=?, moved_at_ms=?, host_ms=?, guest_ms=? WHERE id=?`,
      user.id, key.pubkey, JSON.stringify(state), now(), nowMs(),
      plugin.clockMs, plugin.clockMs, match.id,
    );
    return { id: match.id, game: match.game };
  });
}

/** Withdraw an unanswered challenge and take the stake back. */
function cancel(db, user, id) {
  return db.tx(() => {
    const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
    if (!match) throw new U.NotFound('no such match');
    if (match.host_id !== user.id) throw new U.Forbidden('not your challenge');
    if (match.status !== 'open') throw new U.BadRequest('that match has already started');
    return refund(db, match, 'cancelled');
  });
}

const seatOf = (match, user) => {
  if (match.host_id === user.id) return 'host';
  if (match.guest_id === user.id) return 'guest';
  return null;
};

/** Play one move. */
function act(db, cfg, user, { id, ...payload }) {
  return db.tx(() => {
    const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
    if (!match) throw new U.NotFound('no such match');
    if (match.status !== 'playing') throw new U.BadRequest('that match is not in play');
    const seat = seatOf(match, user);
    if (!seat) throw new U.Forbidden('you are not in that match');

    const plugin = gameFor(match.game);
    const state = JSON.parse(match.state);
    if (plugin.toMove(state) !== seat) throw new U.BadRequest('not your turn');

    // The clock is charged before the move is applied, so a move made after the flag has
    // fallen cannot save the player who made it.
    const clock = chargeClock(match, seat);
    if (clock.flagged) {
      const result = plugin.resultOnTimeout(state, seat);
      return { ...settle(db, cfg, match, result, 'timeout'), flagged: seat };
    }

    const outcome = plugin.act(state, seat, payload);
    const ply = db.get('SELECT COUNT(*) AS n FROM match_moves WHERE match_id=?', match.id).n;
    db.run(
      `INSERT INTO match_moves(match_id, seat, ply, move, note, created_at)
       VALUES(?,?,?,?,?,?)`,
      match.id, seat, ply, JSON.stringify(payload), outcome.note || null, now(),
    );
    db.run(
      `UPDATE matches SET state=?, ${clock.column}=?, moved_at_ms=? WHERE id=?`,
      JSON.stringify(outcome.state), clock.left + plugin.incrementMs, nowMs(), match.id,
    );

    if (outcome.result) {
      const fresh = db.get('SELECT * FROM matches WHERE id=?', match.id);
      return settle(db, cfg, fresh, outcome.result, outcome.reason || 'result');
    }
    return { ok: true, note: outcome.note };
  });
}

/** Give up. */
function resign(db, cfg, user, id) {
  return db.tx(() => {
    const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
    if (!match) throw new U.NotFound('no such match');
    if (match.status !== 'playing') throw new U.BadRequest('that match is not in play');
    const seat = seatOf(match, user);
    if (!seat) throw new U.Forbidden('you are not in that match');
    return settle(db, cfg, match, otherSeat(seat), 'resignation');
  });
}

/**
 * Claim the win when the other side's clock has run out.
 *
 * Anyone in the match may call it, and it is checked against the stored clock rather than
 * taken on trust, so calling it early simply fails.
 */
function claimTimeout(db, cfg, user, id) {
  return db.tx(() => {
    const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
    if (!match) throw new U.NotFound('no such match');
    if (match.status !== 'playing') throw new U.BadRequest('that match is not in play');
    if (!seatOf(match, user)) throw new U.Forbidden('you are not in that match');
    const plugin = gameFor(match.game);
    const state = JSON.parse(match.state);
    const waiting = plugin.toMove(state);
    const clock = chargeClock(match, waiting);
    if (!clock.flagged) throw new U.BadRequest('their clock has not run out');
    return settle(db, cfg, match, plugin.resultOnTimeout(state, waiting), 'timeout');
  });
}

// -------------------------------------------------------------------- views
const clockNow = (match, seat) => {
  if (match.status !== 'playing') return match[seat === 'host' ? 'host_ms' : 'guest_ms'];
  const plugin = gameFor(match.game);
  const state = JSON.parse(match.state);
  const running = plugin.toMove(state) === seat;
  const raw = match[seat === 'host' ? 'host_ms' : 'guest_ms'];
  return running ? Math.max(0, raw - (nowMs() - match.moved_at_ms)) : raw;
};

function summary(db, match) {
  const host = db.get('SELECT username FROM users WHERE id=?', match.host_id);
  const guest = match.guest_id
    ? db.get('SELECT username FROM users WHERE id=?', match.guest_id) : null;
  return {
    id: match.id,
    game: match.game,
    status: match.status,
    stake: match.stake,
    host: host ? host.username : '?',
    guest: guest ? guest.username : null,
    result: match.result,
    reason: match.reason,
    createdAt: match.created_at,
  };
}

/** One match, as a given user is allowed to see it. */
function detail(db, cfg, user, id) {
  const match = db.get('SELECT * FROM matches WHERE id=?', Number(id));
  if (!match) throw new U.NotFound('no such match');
  const plugin = gameFor(match.game);
  const seat = user ? seatOf(match, user) : null;
  const state = match.state ? JSON.parse(match.state) : null;
  return {
    ...summary(db, match),
    seat,
    toMove: state ? plugin.toMove(state) : null,
    view: state ? plugin.view(state, seat) : null,
    clock: { host: clockNow(match, 'host'), guest: clockNow(match, 'guest') },
    moves: db.all(
      'SELECT seat, ply, note, created_at FROM match_moves WHERE match_id=? ORDER BY ply', match.id,
    ),
  };
}

/** The lobby: open challenges, plus whatever the caller is already playing. */
function lobby(db, cfg, user) {
  const open = db.all(
    `SELECT * FROM matches WHERE status='open' ORDER BY created_at DESC LIMIT 50`,
  );
  const mine = user
    ? db.all(
      `SELECT * FROM matches WHERE (host_id=? OR guest_id=?) AND status IN ('open','playing')
       ORDER BY created_at DESC LIMIT 50`, user.id, user.id,
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
    games: Object.values(GAMES).map((g) => ({ key: g.key, name: g.name, clockMs: g.clockMs })),
    open: open.map((m) => summary(db, m)),
    mine: mine.map((m) => summary(db, m)),
  };
}

/** Operator view: what the matches are actually earning. */
function stats(db) {
  const rows = db.all(
    `SELECT game, COUNT(*) AS played, COALESCE(SUM(rake),0) AS rake,
            COALESCE(SUM(stake*2),0) AS wagered
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
  lobby, detail, summary, settle, refund, stats, seatOf, otherSeat,
};
