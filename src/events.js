'use strict';
// Every step of every game, on the chain.
//
// WHAT AN EVENT IS
//
// A game writes one event per thing a player did — a round opened, a tile picked, a
// piece placed, a cashout — and the events go into the token chain as `ev` transactions,
// in the same blocks as the money. Not a second chain: one order. "Stake at block N,
// reveal at block N+4" is only provable when both sit on the same clock, and reading that
// interleaving is what the anti-cheat is for.
//
// An event is `{ type: 'ev', g, r, s, k, a, u }`: the game code, the round (the game's
// own row id), a sequence number within the round, a one-letter kind, its arguments, and
// the first eight hex characters of the actor's key as a hint. The round row here holds
// the full key; a full key on every event would triple the size for nothing. The
// server's millisecond receipt time is the last argument of every event: block times are
// whole seconds, and a scripted jigsaw has gaps of tens of milliseconds between clicks.
//
// THE QUEUE IS A TABLE, AND THE TWO TRANSACTIONS ARE SEPARATE
//
// emit() runs inside the game's own transaction, so the game's write and its event commit
// together or not at all — the same guarantee the ledger already has. The rows it leaves
// with height NULL ARE the queue: durable in SQLite before the process could lose them,
// so a crash between a click and its block loses nothing; the next boot flushes.
//
// flush() runs in a transaction of its own, on a timer, never from inside a game: it
// appends one block when enough events are waiting or the oldest has waited long enough,
// and caps a block so a backlog after downtime drains as several blocks rather than one
// forty-kilobyte monster. An event recorded but not yet in a block is a claim the operator
// has not yet committed to. The window is a few seconds, and the doctor reports anything
// older.
//
// WHY BATCHES
//
// Verification cost is per block, not per event: verifyChain runs about half a millisecond
// a block, and an event is under eighty bytes against a block's quarter-kilobyte overhead.
// At a hundred jigsaw rounds a day, one block per click is a thirty-minute verify after a
// year; twenty-five a block is a minute. The sequence number is what makes batching
// harmless: order within a round is the sequence, not the block.
//
// NEVER token_nonces: that is the money nonce space, on the hot path of every stake
// check, and millions of clicks in it would turn nextNonce()'s MAX() into a scan.

const tokenchain = require('./tokenchain');

const nowMs = () => Date.now();
const nowS = () => Math.floor(Date.now() / 1000);

/** The dials, under cfg.token.events. A broken flusher can be switched off without a deploy. */
const DEFAULTS = { enabled: true, batchCount: 25, batchMs: 5000, maxPerBlock: 500, checkpointEvery: 500 };
const settings = (cfg) => ({ ...DEFAULTS, ...((cfg && cfg.token && cfg.token.events) || {}) });

/** The event as it goes into a block. */
function toTx(row) {
  const tx = { type: 'ev', g: row.g, r: row.r, s: row.s, k: row.k, a: JSON.parse(row.a) };
  if (row.u) tx.u = row.u;
  if (row.sig) tx.sig = row.sig;
  return tx;
}

/**
 * Record one event. Must be called inside the game's transaction.
 *
 * The round row is created on the first event of a round and hands out the sequence
 * numbers from then on — one UPDATE on one row, no scan, no race. Returns the event as
 * it will appear on the chain, or null when events are switched off.
 */
function emit(db, cfg, { g, r, k, a = [], userId = null, pubkey = null, sig = null }) {
  if (!settings(cfg).enabled) return null;
  const ms = nowMs();
  db.run(
    `INSERT OR IGNORE INTO token_rounds(g, r, user_id, pubkey, next_seq, opened_at)
     VALUES(?,?,?,?,0,?)`,
    g, r, userId, pubkey, nowS(),
  );
  const round = db.get(
    'UPDATE token_rounds SET next_seq = next_seq + 1 WHERE g=? AND r=? RETURNING next_seq - 1 AS s, pubkey',
    g, r,
  );
  const u = round.pubkey ? String(round.pubkey).slice(0, 8) : null;
  const args = JSON.stringify([...a, ms]);
  db.run(
    'INSERT INTO token_events(g, r, s, k, a, u, sig, ms) VALUES(?,?,?,?,?,?,?,?)',
    g, r, round.s, k, args, u, sig || null, ms,
  );
  const tx = { type: 'ev', g, r, s: round.s, k, a: JSON.parse(args) };
  if (u) tx.u = u;
  if (sig) tx.sig = sig;
  const why = tokenchain.checkEvent(tx);
  // A game emitting something the chain would refuse is a bug worth failing the request
  // for: the whole point is that every step reaches the chain.
  if (why) throw new Error(`${g} emitted a bad event: ${why}`);
  return tx;
}

/** Close a round: the moment after its last event, and the player's signature if any. */
function close(db, { g, r, sig = null }) {
  db.run(
    'UPDATE token_rounds SET closed_at=?, sig=COALESCE(?, sig) WHERE g=? AND r=? AND closed_at IS NULL',
    nowS(), sig, g, r,
  );
}

/** An event as the browser is shown it: no receipt time, so both sides fold the same bytes. */
const shown = (ev) => ({ g: ev.g, r: ev.r, s: ev.s, k: ev.k, a: ev.a.slice(0, -1) });

/** The running hash over a round's record so far, and how many events are in it. */
function digest(db, g, r) {
  let h = tokenchain.sha256(tokenchain.ROUND_SEED);
  let n = 0;
  for (const ev of history(db, g, r)) {
    h = tokenchain.foldEvent(h, shown(ev));
    n += 1;
  }
  return { n, h };
}

/**
 * Check the player's signature over the round as recorded so far.
 *
 * Returns { attested, n, h }. Never throws and never refuses the round: a signature that
 * does not verify — a step the network lost on the way to the log, a key that changed —
 * leaves a round the record calls unattested, which is what it is.
 */
function attest(db, cfg, { g, r, sig, pubkey }) {
  const { n, h } = digest(db, g, r);
  if (!sig || !pubkey) return { attested: false, n, h };
  const ok = /^[0-9a-f]{128}$/.test(String(sig))
    && tokenchain.verifyRoundSignature(pubkey, tokenchain.roundPayload({ g, r, n, h }), sig);
  return { attested: ok, n, h };
}

/** What is waiting for a block: how many, and how long the oldest has waited. */
function pending(db) {
  const row = db.get('SELECT COUNT(*) AS n, MIN(ms) AS oldest FROM token_events WHERE height IS NULL');
  return { count: row.n, oldestMs: row.oldest === null ? null : row.oldest, waitedMs: row.oldest === null ? 0 : nowMs() - row.oldest };
}

/**
 * Append the waiting events to the chain, one block per batch.
 *
 * Runs on a timer beside the heartbeat, and once more at shutdown with `force`, which
 * appends whatever is waiting regardless of the batch rules. Never call this from inside
 * a game's transaction: it would nest a block under the game's rollback scope, and a
 * jigsaw validation error could roll back a block holding someone else's stake.
 */
function flush(db, cfg, { force = false } = {}) {
  const s = settings(cfg);
  const out = { blocks: 0, events: 0 };
  if (!s.enabled && !force) return out;
  for (;;) {
    const rows = db.all(
      `SELECT g, r, s, k, a, u, sig, ms FROM token_events WHERE height IS NULL
       ORDER BY ms, g, r, s LIMIT ?`, s.maxPerBlock,
    );
    if (!rows.length) break;
    const ripe = rows.length >= s.batchCount || nowMs() - rows[0].ms >= s.batchMs;
    if (!ripe && !force) break;
    const block = db.tx(() => {
      const appended = tokenchain.appendBlock(db, rows.map(toTx));
      for (const row of rows) {
        db.run('UPDATE token_events SET height=? WHERE g=? AND r=? AND s=?', appended.height, row.g, row.r, row.s);
      }
      return appended;
    });
    out.blocks += 1;
    out.events += rows.length;
    // Every so many blocks, a checkpoint, so the doctor's verify stays quick. Its own
    // transaction, after the block's: a checkpoint is a cache and must never roll a
    // block back with it.
    if (s.checkpointEvery > 0 && block.height % s.checkpointEvery === 0) {
      try { db.tx(() => tokenchain.writeCheckpoint(db)); } catch { /* the next one will do */ }
    }
    if (rows.length < s.maxPerBlock) break;
  }
  return out;
}

/** A round's events from the index, in order. The fast path for resume and review. */
function history(db, g, r) {
  return db.all(
    'SELECT g, r, s, k, a, u, sig, ms, height FROM token_events WHERE g=? AND r=? ORDER BY s', g, r,
  ).map((row) => ({ ...toTx(row), ms: row.ms, height: row.height }));
}

/**
 * A round's events from the chain alone, ignoring the index.
 *
 * Slow on purpose — it reads every block — and exists so a test, or an auditor, can show
 * that what the index says happened is what the chain says happened.
 */
function fromChain(db, g, r) {
  const out = [];
  for (const row of db.all('SELECT height, txs FROM token_blocks ORDER BY height')) {
    for (const tx of JSON.parse(row.txs)) {
      if (tx.type === 'ev' && tx.g === g && tx.r === r) out.push({ ...tx, height: row.height });
    }
  }
  return out.sort((x, y) => x.s - y.s);
}

/** The round row: who played it and whether it is over. */
function round(db, g, r) {
  return db.get('SELECT * FROM token_rounds WHERE g=? AND r=?', g, r) || null;
}

module.exports = {
  DEFAULTS, settings, emit, close, pending, flush, history, fromChain, round, toTx,
  shown, digest, attest,
};
