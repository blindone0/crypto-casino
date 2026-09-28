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

const ledger = require('./ledger');
const tokenchain = require('./tokenchain');
const matches = require('./match');

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
  const out = tokenchain.verifyChain(db);
  const height = db.get('SELECT COUNT(*) AS n FROM token_blocks').n;
  return {
    name: 'token chain',
    ok: out.ok,
    detail: out.ok ? `${height} blocks verify` : `broken: ${out.why || out.error}`,
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

  let lateMint = null;
  for (const row of db.all('SELECT height, txs FROM token_blocks WHERE height > 0')) {
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

/** Run the lot. Returns { ok, checks }. */
function checkAll(db, cfg, at = Math.floor(Date.now() / 1000)) {
  const checks = [
    schemaCurrent(db),
    booksBalance(db),
    chainVerifies(db, cfg),
    supplyHolds(db, cfg),
    escrowCovered(db, cfg),
    nothingStranded(db, cfg, at),
    noOrphans(db),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = {
  checkAll,
  schemaCurrent,
  booksBalance,
  chainVerifies,
  supplyHolds,
  escrowCovered,
  nothingStranded,
  noOrphans,
};
