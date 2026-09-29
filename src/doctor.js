'use strict';
/**
 * Everything that must be true about a running site, checked in one pass.
 *
 * The pieces existed and nothing put them together. The ledger audit was reachable only
 * through the admin panel, the chain verifier was called by tests, and escrow was never
 * reconciled at all. Knowing the site was healthy meant opening a browser and reading
 * three screens, which in practice meant nobody checked.
 *
 * Each check returns { name, ok, detail }. Nothing here writes: the point is to be safe
 * to run against production at any hour, including from cron, which is why the command
 * around it exits non-zero rather than printing something a person has to read.
 *
 * A failure here is not a style complaint. Every one of these means money or the record
 * of it has gone somewhere it should not be able to go.
 */

const fs = require('node:fs');

const ledger = require('./ledger');
const tokenchain = require('./tokenchain');
const matches = require('./match');
const events = require('./events');
const anticheat = require('./anticheat');
const loans = require('./loans');

const fmt = (units) => (units / 100000000).toFixed(8);

/**
 * Account balances must equal the sum of the ledger.
 *
 * The ledger is append-only and every balance change writes a row inside the same
 * transaction, so the two cannot disagree unless something wrote a balance directly.
 */
function booksBalance(db) {
  const audit = ledger.auditBalances(db);
  return {
    name: 'ledger',
    ok: audit.ok,
    detail: audit.ok
      ? `accounts and ledger agree at ${fmt(audit.accounts)}`
      : `accounts hold ${fmt(audit.accounts)} but the ledger says ${fmt(audit.ledger)}`,
  };
}

/** Every link, every signature, every balance on the token chain. */
function chainVerifies(db, cfg) {
  if (!cfg.token.enabled) return { name: 'token chain', ok: true, detail: 'token is off' };
  // From the latest checkpoint, so this stays quick as the chain grows. It says which:
  // a reader should know the check was a cached one. tools/verify-chain.js is the
  // unconditional replay, and the line below reports when it was last run.
  const out = tokenchain.verifyChain(db, { checkpoint: true });
  const height = db.get('SELECT COUNT(*) AS n FROM token_blocks').n;
  const how = out.from === null || out.from === undefined ? 'from genesis' : `from checkpoint at ${out.from}`;
  return {
    name: 'token chain',
    ok: out.ok,
    detail: out.ok
      ? `${height} blocks verify ${how}, ${out.events || 0} game events among them`
      : `broken: ${out.reason || out.why || out.error}`,
  };
}

/**
 * When the chain was last replayed from genesis.
 *
 * The doctor verifies from a checkpoint, which trusts the blocks below the anchor as
 * long as the anchor still hashes. A rewrite that broke a link below the anchor without
 * touching it is the one thing that mode cannot see, so a full replay is run weekly by
 * cron (npm run verify-chain) and this line says how long ago that was. Reported, never
 * failed: a site that has never run it is behind on a chore, not broken.
 */
function fullVerifyRecent(db, cfg, at) {
  if (!cfg.token.enabled) return { name: 'full verify', ok: true, detail: 'token is off' };
  const last = tokenchain.lastFullVerify(db);
  if (!last) return { name: 'full verify', ok: true, detail: 'never run: schedule npm run verify-chain weekly' };
  const days = (at - last) / 86400;
  return {
    name: 'full verify',
    ok: true,
    detail: days > 7
      ? `${Math.floor(days)} days ago: npm run verify-chain is overdue`
      : `${days < 1 ? 'today' : `${Math.floor(days)} day(s) ago`}`,
  };
}

/**
 * The event queue.
 *
 * A game step waits in token_events until the flusher puts it in a block, a few seconds
 * at most. Rows waiting longer than that mean the flusher is not running, and every step
 * players take meanwhile is a claim the chain has not committed to. Reported rather than
 * failed: the games play on regardless, and a server that is stopped has a queue by
 * definition — this doctor is often run against exactly that.
 */
function eventsFlowing(db, cfg) {
  if (!cfg.token.enabled) return { name: 'events', ok: true, detail: 'token is off' };
  const p = events.pending(db);
  const total = db.get('SELECT COUNT(*) AS n FROM token_events').n;
  if (!p.count) return { name: 'events', ok: true, detail: `${total} logged, none waiting for a block` };
  const late = p.waitedMs > events.settings(cfg).batchMs * 3;
  return {
    name: 'events',
    ok: true,
    detail: late
      ? `${p.count} waiting, the oldest for ${Math.round(p.waitedMs / 1000)}s: is the server running?`
      : `${total - p.count} logged, ${p.count} waiting for the next block`,
  };
}

/**
 * What the record says about the players.
 *
 * The anti-cheat's scan, run here so the findings are seen: a jigsaw solved faster than a
 * hand can move, a solve the log never showed being assembled, clicks with no human gap,
 * a run of mines luck a fair layout would not allow. Reported and never failed: a finding
 * is a reason for a person to look (the admin panel's review queue), not a verdict.
 */
function cheatsReported(db, cfg) {
  if (!cfg.token.enabled) return { name: 'anti-cheat', ok: true, detail: 'token is off' };
  const out = anticheat.scan(db);
  const flagged = anticheat.flagged(db);
  const held = flagged.filter((u) => !u.banned).length;
  const banned = flagged.length - held;
  const state = `${held} under review, ${banned} banned`;
  return {
    name: 'anti-cheat',
    ok: true,
    detail: out.findings.length
      ? `${out.findings.length} finding(s) in ${out.rounds} rounds await review; ${state}`
      : `nothing found in ${out.rounds} rounds; ${state}`,
  };
}

/**
 * The Биржа's books.
 *
 * Untaken offers are in the escrow check above; this is the loans themselves: how many
 * are open, how many are past due and waiting for the sweeper, how many defaulted. A
 * loan past due for long means the sweeper is not running. Reported, not failed.
 */
function loansHealthy(db, cfg) {
  if (!cfg.token.enabled) return { name: 'loans', ok: true, detail: 'token is off' };
  const h = loans.health(db);
  return {
    name: 'loans',
    ok: true,
    detail: `${h.open} open, ${h.pastDue} past due awaiting the sweep, ${h.defaulted} in default, `
      + `${fmt(h.offered)} offered and held in escrow`,
  };
}

/**
 * The supply cap.
 *
 * Read off the chain rather than the config, because the config is what we intended and
 * the chain is what happened. Tugriks are minted once at genesis and never again, so
 * circulating must not exceed the cap and nothing may have been minted after block zero.
 */
function supplyHolds(db, cfg) {
  if (!cfg.token.enabled) return { name: 'supply', ok: true, detail: 'token is off' };
  const s = tokenchain.supply(db);
  const cap = cfg.token.maxSupply;

  // The scan starts after the latest checkpoint: the verify that wrote it refused a
  // mint anywhere but genesis, so the blocks below it are known clean — with the same
  // caveat as the chain check, and the same weekly replay behind it.
  const cp = tokenchain.latestCheckpoint(db);
  let lateMint = null;
  for (const row of db.all('SELECT height, txs FROM token_blocks WHERE height > ?', cp ? cp.height : 0)) {
    if (JSON.parse(row.txs).some((tx) => tx.type === 'mint')) { lateMint = row.height; break; }
  }

  const ok = s.circulating <= cap && lateMint === null;
  let detail = `${fmt(s.circulating)} of ${fmt(cap)} in circulation`;
  if (lateMint !== null) detail = `tokens were minted after genesis, in block ${lateMint}`;
  else if (s.circulating > cap) detail = `${fmt(s.circulating)} in circulation, over the cap`;
  return { name: 'supply', ok, detail };
}

/**
 * The house must hold at least the stakes of every live table.
 *
 * An inequality rather than a balance: the same key is the bankroll for the tugrik games
 * and collects the rake, so holding more is normal and holding less is not survivable.
 */
function escrowCovered(db, cfg) {
  if (!cfg.token.enabled) return { name: 'escrow', ok: true, detail: 'token is off' };
  const health = matches.escrowHealth(db);
  return {
    name: 'escrow',
    ok: health.ok,
    detail: health.ok
      ? `owes ${fmt(health.owed)} to live tables, holds ${fmt(health.held)}`
      : `owes ${fmt(health.owed)} but holds only ${fmt(health.held)}`,
  };
}

/**
 * Tables that should have been swept.
 *
 * The sweeper runs every ten minutes, so anything well past its deadline means the
 * sweeper is not running or is failing on that row. Either way the stakes are sitting in
 * escrow, which is the thing the sweeper exists to prevent.
 */
function nothingStranded(db, cfg, at) {
  const grace = 2;
  const stale = db.get(
    "SELECT COUNT(*) AS n FROM matches WHERE status='open' AND created_at <= ?",
    at - cfg.match.openExpirySeconds * grace,
  ).n;
  const quiet = db.get(
    "SELECT COUNT(*) AS n FROM matches WHERE status='playing' AND moved_at_ms <= ?",
    (at - cfg.match.abandonSeconds * grace) * 1000,
  ).n;
  const ok = stale === 0 && quiet === 0;
  return {
    name: 'stranded tables',
    ok,
    detail: ok ? 'none' : `${stale} expired challenges and ${quiet} abandoned games unswept`,
  };
}

/**
 * Rows pointing at users who are gone.
 *
 * Most of these cascade on delete, so anything left behind means a delete went round the
 * foreign key — which is what happens when a connection opens with foreign_keys off.
 */
function noOrphans(db) {
  const checks = [
    ['sessions', 'SELECT COUNT(*) AS n FROM sessions WHERE user_id NOT IN (SELECT id FROM users)'],
    ['bets', 'SELECT COUNT(*) AS n FROM bets WHERE user_id NOT IN (SELECT id FROM users)'],
    ['match seats', `SELECT COUNT(*) AS n FROM match_seats
                       WHERE match_id NOT IN (SELECT id FROM matches)`],
    ['ledger rows', `SELECT COUNT(*) AS n FROM ledger
                       WHERE account_id NOT IN (SELECT id FROM accounts)`],
  ];
  const bad = [];
  for (const [what, sql] of checks) {
    const n = db.get(sql).n;
    if (n) bad.push(`${n} ${what}`);
  }
  return {
    name: 'orphans',
    ok: bad.length === 0,
    detail: bad.length ? bad.join(', ') : 'none',
  };
}

/** The schema is at the version this code expects. */
function schemaCurrent(db) {
  const migrate = require('./migrate');
  const at = migrate.version(db.raw || db);
  const want = migrate.latest();
  return {
    name: 'schema',
    ok: at === want,
    detail: at === want ? `version ${at}` : `at version ${at}, code expects ${want}`,
  };
}

/**
 * The write-ahead log is not larger than the database it fronts.
 *
 * Unlike every other check here, this one is not about money. It reports rather than
 * fails: a large WAL is a shape worth seeing, never a reason to page anyone at 3am, and
 * a doctor that cries wolf gets ignored when it matters.
 *
 * It grew to 4.16MB against a 1.7MB database once. Nothing was wrong — every frame had
 * been checkpointed — but `journal_size_limit` defaults to -1, meaning SQLite never
 * shrinks the file back after writing it out, so it keeps its high-water mark forever.
 * src/db.js sets both that and a smaller autocheckpoint now. An existing oversized file
 * is reclaimed by `npm run vacuum-wal`, because doing it here would make a read-only
 * tool write, and this one is documented as safe to run against a live server.
 */
function walInCheck(db, cfg) {
  const path = cfg.dbPath;
  const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

  const dbBytes = size(path);
  const walBytes = size(`${path}-wal`);

  if (!walBytes) return { name: 'wal', ok: true, detail: 'none (not in WAL mode, or already written back)' };

  // Bigger than the database AND over a megabyte. Either alone is normal: a small
  // database legitimately has a WAL larger than itself for a moment after a write.
  const oversized = walBytes > dbBytes && walBytes > 1048576;
  return {
    name: 'wal',
    ok: true,
    detail: oversized
      ? `${mb(walBytes)} against a ${mb(dbBytes)} database — run npm run vacuum-wal`
      : `${mb(walBytes)} against a ${mb(dbBytes)} database`,
  };
}

/** Run the lot. Returns { ok, checks }. */
function checkAll(db, cfg, at = Math.floor(Date.now() / 1000)) {
  const checks = [
    schemaCurrent(db),
    booksBalance(db),
    chainVerifies(db, cfg),
    fullVerifyRecent(db, cfg, at),
    eventsFlowing(db, cfg),
    cheatsReported(db, cfg),
    supplyHolds(db, cfg),
    escrowCovered(db, cfg),
    loansHealthy(db, cfg),
    nothingStranded(db, cfg, at),
    noOrphans(db),
    walInCheck(db, cfg),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = {
  checkAll,
  walInCheck,
  schemaCurrent,
  booksBalance,
  chainVerifies,
  fullVerifyRecent,
  eventsFlowing,
  cheatsReported,
  supplyHolds,
  escrowCovered,
  loansHealthy,
  nothingStranded,
  noOrphans,
};
