'use strict';
// Crash: one shared round for everybody. A multiplier climbs from 1.00x and busts at a
// predetermined point. Cash out before the bust to keep stake x multiplier.
//
// Fairness uses a pre-committed reverse hash chain, which is stronger than revealing a
// fresh seed per round:
//   c[0] = f (secret), c[i] = sha256(c[i-1]), and c[n] is published as the commitment.
//   Round 1 reveals c[n-1], round 2 reveals c[n-2], and so on.
//   Anyone can check sha256(revealed) == previously revealed, all the way back to the
//   commitment. Every future outcome is already fixed when the commitment is published,
//   so the operator cannot react to how much money is on the table.
const crypto = require('node:crypto');
const U = require('../util');
const fair = require('../fair');
const ledger = require('../ledger');

const BETTING_MS = 7000;
const ENDED_MS = 4000;
const TICK_MS = 100;
const GROWTH = 0.07;      // e^(0.07 t): 2x at ~9.9s, 10x at ~33s
const CHAIN_LEN = 10000;  // about 33 hours of rounds before a new commitment is needed

const now = () => Math.floor(Date.now() / 1000);

/** Multiplier shown at elapsed time t (seconds), floored to 2dp. */
const multiplierAt = (t) => Math.max(1, Math.floor(Math.exp(GROWTH * t) * 100) / 100);
/** Seconds until the multiplier reaches m. */
const timeFor = (m) => Math.log(m) / GROWTH;

// ------------------------------------------------------------------ chain
function buildChain(f, n) {
  const c = new Array(n + 1);
  c[0] = f;
  for (let i = 1; i <= n; i += 1) c[i] = fair.sha256hex(c[i - 1]);
  return c;
}

function ensureChain(db) {
  let meta = db.kvGet('crash.chain');
  if (!meta || meta.cursor >= meta.n) {
    const f = crypto.randomBytes(32).toString('hex');
    const chain = buildChain(f, CHAIN_LEN);
    meta = { f, n: CHAIN_LEN, cursor: 0, commitment: chain[CHAIN_LEN], createdAt: now() };
    db.kvSet('crash.chain', meta);
    db.audit('system', 'crash.chain.new', { commitment: meta.commitment, rounds: CHAIN_LEN });
    return { meta, chain };
  }
  return { meta, chain: buildChain(meta.f, meta.n) };
}

/**
 * The crash engine. One instance per process; server.js starts it.
 * All database work happens synchronously inside db.tx() so it cannot interleave.
 */
function createCrash({ db, cfg, logger = console }) {
  const salt = cfg.crashPublicSalt || 'nullstake-crash-v1';
  let chain = null;
  let meta = null;
  let round = null;      // { id, seed, seedHash, crashPoint, state, startedAt, runStartMs }
  let timer = null;
  let stopped = false;
  const clients = new Set();

  function loadChain() {
    const c = ensureChain(db);
    meta = c.meta;
    chain = c.chain;
  }

  function nextSeed() {
    if (meta.cursor >= meta.n) loadChain();      // exhausted: fresh commitment
    const seed = chain[meta.n - 1 - meta.cursor];
    meta = { ...meta, cursor: meta.cursor + 1 };
    db.kvSet('crash.chain', meta);
    return seed;
  }

  // ------------------------------------------------------------ broadcast
  function send(res, event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
  function broadcast(event, data) {
    for (const res of clients) send(res, event, data);
  }

  function subscribe(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    send(res, 'state', publicState());
    const ping = setInterval(() => send(res, 'ping', { t: Date.now() }), 25000);
    const drop = () => { clearInterval(ping); clients.delete(res); };
    req.on('close', drop);
    req.on('error', drop);
  }

  // ---------------------------------------------------------------- state
  function publicState() {
    if (!round) return { state: 'starting', players: [], commitment: meta?.commitment };
    const elapsed = round.state === 'running' ? (Date.now() - round.runStartMs) / 1000 : 0;
    const live = round.state === 'running'
      ? Math.min(multiplierAt(elapsed), round.crashPoint)
      : (round.state === 'ended' ? round.crashPoint : 1);
    return {
      state: round.state,
      roundId: round.id,
      seedHash: round.seedHash,
      commitment: meta.commitment,
      multiplier: live,
      crashPoint: round.state === 'ended' ? round.crashPoint : null,
      seed: round.state === 'ended' ? round.seed : null,
      msLeft: round.state === 'betting' ? Math.max(0, round.bettingEndsMs - Date.now()) : 0,
      players: playerList(),
      history: recentHistory(),
    };
  }

  function playerList() {
    if (!round) return [];
    return db.all(
      `SELECT cb.wager, cb.auto_cashout, cb.cashed_at, cb.payout, cb.state, u.username
         FROM crash_bets cb JOIN users u ON u.id = cb.user_id
        WHERE cb.round_id = ? ORDER BY cb.wager DESC LIMIT 50`,
      round.id,
    );
  }

  const recentHistory = () => db.all(
    "SELECT id, crash_point FROM crash_rounds WHERE state='ended' ORDER BY id DESC LIMIT 25",
  ).map((r) => ({ id: r.id, crashPoint: r.crash_point }));

  // ------------------------------------------------------------- lifecycle
  function openRound() {
    if (stopped) return;
    const seed = nextSeed();
    const crashPoint = fair.crashPoint(seed, 0, cfg.houseEdge.crash, salt);
    const seedHash = fair.sha256hex(seed);

    db.tx(() => {
      db.run(
        'INSERT INTO crash_rounds(seed,seed_hash,nonce,crash_point,state,started_at) VALUES(?,?,?,?,?,?)',
        seed, seedHash, meta.cursor, crashPoint, 'betting', now(),
      );
    });
    const id = db.get('SELECT last_insert_rowid() AS id').id;

    round = {
      id,
      seed,
      seedHash,
      crashPoint,
      state: 'betting',
      startedAt: now(),
      bettingEndsMs: Date.now() + BETTING_MS,
      runStartMs: 0,
    };
    // The seed itself stays private until the round ends; only its hash goes out now.
    broadcast('betting', {
      roundId: id, seedHash, commitment: meta.commitment, msLeft: BETTING_MS, history: recentHistory(),
    });
    timer = setTimeout(startRun, BETTING_MS);
  }

  function startRun() {
    if (stopped || !round) return;
    round.state = 'running';
    round.runStartMs = Date.now();
    db.run("UPDATE crash_rounds SET state='running' WHERE id=?", round.id);
    broadcast('running', { roundId: round.id, startedAt: round.runStartMs, players: playerList() });
    timer = setInterval(tick, TICK_MS);
  }

  function tick() {
    if (stopped || !round || round.state !== 'running') return;
    const elapsed = (Date.now() - round.runStartMs) / 1000;
    const live = multiplierAt(elapsed);

    if (live >= round.crashPoint) {
      clearInterval(timer);
      timer = null;
      endRound();
      return;
    }
    processAutoCashouts(live);
    broadcast('tick', { m: live });
  }

  /** Cash out anyone whose target has been reached. Safe: live is always below crashPoint. */
  function processAutoCashouts(live) {
    const due = db.all(
      `SELECT * FROM crash_bets
        WHERE round_id=? AND state='placed' AND auto_cashout > 1 AND auto_cashout <= ?`,
      round.id, live,
    );
    for (const bet of due) {
      try {
        db.tx(() => payWin(bet, bet.auto_cashout));
        broadcast('cashout', { userId: bet.user_id, at: bet.auto_cashout, auto: true });
      } catch (e) {
        logger.error('crash auto-cashout failed', e.message);
      }
    }
  }

  /** Credit a winning crash bet. Caller must be inside a transaction. */
  function payWin(bet, atMultiplier) {
    const user = db.get('SELECT * FROM users WHERE id=?', bet.user_id);
    const raw = U.mulUnits(bet.wager, atMultiplier);
    const payout = Math.min(raw, bet.max_payout || raw);

    db.run("UPDATE crash_bets SET state='won', cashed_at=?, payout=? WHERE id=?",
      atMultiplier, payout, bet.id);
    ledger.settleBet(db, cfg, {
      user,
      game: 'crash',
      wager: bet.wager,
      multiplier: bet.wager ? payout / bet.wager : 0,
      payout,
      edgeUnits: Math.floor(bet.wager * cfg.houseEdge.crash),
      seedId: null,
      nonce: round.id,
      clientSeed: salt,
      detail: {
        roundId: round.id,
        cashedAt: atMultiplier,
        crashPoint: round.crashPoint,
        capped: payout < raw,
      },
      stakeTaken: true,
    });
    return payout;
  }

  function endRound() {
    if (!round) return;
    const r = round;
    r.state = 'ended';

    db.tx(() => {
      db.run("UPDATE crash_rounds SET state='ended', ended_at=? WHERE id=?", now(), r.id);
      const losers = db.all("SELECT * FROM crash_bets WHERE round_id=? AND state='placed'", r.id);
      for (const bet of losers) {
        const user = db.get('SELECT * FROM users WHERE id=?', bet.user_id);
        db.run("UPDATE crash_bets SET state='lost' WHERE id=?", bet.id);
        ledger.settleBet(db, cfg, {
          user,
          game: 'crash',
          wager: bet.wager,
          multiplier: 0,
          payout: 0,
          edgeUnits: Math.floor(bet.wager * cfg.houseEdge.crash),
          seedId: null,
          nonce: r.id,
          clientSeed: salt,
          detail: { roundId: r.id, crashPoint: r.crashPoint, busted: true },
          stakeTaken: true,
        });
      }
    });

    // Seed revealed here: every client can now verify this round independently.
    broadcast('crash', {
      roundId: r.id,
      crashPoint: r.crashPoint,
      seed: r.seed,
      seedHash: r.seedHash,
      commitment: meta.commitment,
      history: recentHistory(),
    });
    timer = setTimeout(openRound, ENDED_MS);
  }

  // ------------------------------------------------------------ player API
  function placeBet(user, body) {
    if (!round || round.state !== 'betting') throw new U.BadRequest('betting is closed for this round');
    const wager = U.parseAmount(body.amount);
    const autoRaw = body.autoCashout == null || body.autoCashout === '' ? 0 : Number(body.autoCashout);
    if (!Number.isFinite(autoRaw) || autoRaw < 0) throw new U.BadRequest('bad auto cashout');
    const auto = autoRaw ? Math.floor(autoRaw * 100) / 100 : 0;
    if (auto && auto < 1.01) throw new U.BadRequest('auto cashout must be at least 1.01');
    if (auto > cfg.risk.maxMultiplier) throw new U.BadRequest('auto cashout too high');

    return db.tx(() => {
      if (db.get('SELECT 1 FROM crash_bets WHERE round_id=? AND user_id=?', round.id, user.id)) {
        throw new U.BadRequest('you already have a bet on this round');
      }
      ledger.checkBetLimits(db, cfg, user, wager, 1);
      const maxPayout = ledger.capPayout(db, cfg, wager, Infinity).ceiling;

      ledger.transfer(
        db,
        ledger.userAccount(db, user.id).id,
        ledger.houseAccount(db).id,
        wager, 'bet', `crash#${round.id}`,
      );
      db.run(
        `INSERT INTO crash_bets(round_id,user_id,wager,auto_cashout,max_payout,state,created_at)
         VALUES(?,?,?,?,?,'placed',?)`,
        round.id, user.id, wager, auto, maxPayout, now(),
      );
      const out = {
        roundId: round.id,
        wager,
        autoCashout: auto,
        maxPayout,
        balance: ledger.userAccount(db, user.id).balance,
      };
      broadcast('bet', { username: user.username, wager, autoCashout: auto });
      return out;
    });
  }

  function cashout(user) {
    if (!round || round.state !== 'running') throw new U.BadRequest('no round is running');
    const elapsed = (Date.now() - round.runStartMs) / 1000;
    const live = multiplierAt(elapsed);
    if (live >= round.crashPoint) throw new U.BadRequest('too late, the round has busted');

    const out = db.tx(() => {
      const bet = db.get(
        "SELECT * FROM crash_bets WHERE round_id=? AND user_id=? AND state='placed'",
        round.id, user.id,
      );
      if (!bet) throw new U.BadRequest('no active bet to cash out');
      const payout = payWin(bet, live);
      return {
        cashedAt: live,
        payout,
        profit: payout - bet.wager,
        balance: ledger.userAccount(db, user.id).balance,
      };
    });
    broadcast('cashout', { username: user.username, at: live, auto: false });
    return out;
  }

  function myBet(user) {
    if (!round) return null;
    return db.get('SELECT * FROM crash_bets WHERE round_id=? AND user_id=?', round.id, user.id) || null;
  }

  function start() {
    loadChain();
    // Any round left mid-flight by a restart is abandoned; stakes are refunded.
    db.tx(() => {
      const stale = db.all("SELECT * FROM crash_rounds WHERE state IN ('betting','running')");
      for (const r of stale) {
        const bets = db.all("SELECT * FROM crash_bets WHERE round_id=? AND state='placed'", r.id);
        for (const b of bets) {
          ledger.transfer(
            db,
            ledger.houseAccount(db).id,
            ledger.userAccount(db, b.user_id).id,
            b.wager, 'refund', `crash#${r.id} restart`,
          );
          db.run("UPDATE crash_bets SET state='lost', payout=0 WHERE id=?", b.id);
        }
        db.run("UPDATE crash_rounds SET state='ended', ended_at=? WHERE id=?", now(), r.id);
      }
      if (stale.length) db.audit('system', 'crash.recover', { rounds: stale.length });
    });
    logger.log(`[crash] commitment ${meta.commitment} (round ${meta.cursor}/${meta.n})`);
    openRound();
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; }
    for (const res of clients) { try { res.end(); } catch { /* gone */ } }
    clients.clear();
  }

  return {
    start, stop, subscribe, placeBet, cashout, myBet,
    state: publicState,
    get commitment() { return meta?.commitment; },
    multiplierAt, timeFor,
  };
}

module.exports = { createCrash, multiplierAt, timeFor, buildChain, GROWTH, CHAIN_LEN };
