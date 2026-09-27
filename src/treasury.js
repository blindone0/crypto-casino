'use strict';
// Treasury: moving operator profit off the site and into cold storage.
//
// Two wallets, two jobs:
//   hot wallet  - online, holds only enough to pay players, keys on the server
//   treasury    - offline, holds profit, keys never touch the server
//
// A payout may only ever draw on FREE CAPITAL, defined as bankroll minus the sum of all
// player balances. That single rule is what stops an operator paying themselves out of
// customer funds, which is the usual way one of these sites dies.
//
// Money path, mirroring player withdrawals so the ledger stays balanced:
//   reserve : house -> pending/treasury     (still on the books, no longer spendable)
//   sent    : fee-free burn from pending    (left the system, txid recorded)
//   failed  : pending -> house              (fully returned)
const U = require('./util');
const ledger = require('./ledger');
const addrcheck = require('./addrcheck');
const configMod = require('./config');

const now = () => Math.floor(Date.now() / 1000);
const pendingAccount = (db) => ledger.ensureAccount(db, 'pending', null, 'treasury');

/** Free capital: what is genuinely the operator's, after covering everything owed. */
function freeCapital(db) {
  const owed = ledger.playerLiabilities(db)
    + db.get("SELECT COALESCE(SUM(balance),0) AS n FROM accounts WHERE owner_type='affiliate'").n
    + db.get("SELECT COALESCE(SUM(balance),0) AS n FROM accounts WHERE owner_type='pending'").n;
  return ledger.bankroll(db) - owed;
}

/** Configured treasury addresses, each re-validated so a bad paste shows up immediately. */
function list(cfg) {
  return (cfg.treasury.addresses || []).map((a) => {
    const check = addrcheck.validate(a.driver || cfg.wallet.driver, a.address);
    return {
      label: a.label || '(unnamed)',
      driver: a.driver || cfg.wallet.driver,
      address: a.address,
      valid: check.ok,
      kind: check.kind || null,
      problem: check.ok ? null : check.reason,
    };
  });
}

/** Add an address to the whitelist and persist it to config.json. */
function addAddress(cfg, { label, driver, address }) {
  const drv = String(driver || cfg.wallet.driver);
  const addr = String(address ?? '').trim();
  const lab = String(label ?? '').trim() || `${drv} cold`;

  const check = addrcheck.validate(drv, addr);
  if (!check.ok) throw new U.BadRequest(`address rejected: ${check.reason}`);

  const current = cfg.treasury.addresses || [];
  if (current.some((a) => a.address === addr)) throw new U.BadRequest('address is already whitelisted');

  const next = [...current, { label: lab, driver: drv, address: addr }];
  cfg.treasury.addresses = next;
  configMod.save({ treasury: { addresses: next } });
  return { added: { label: lab, driver: drv, address: addr, kind: check.kind }, count: next.length };
}

function removeAddress(cfg, address) {
  const addr = String(address ?? '').trim();
  const current = cfg.treasury.addresses || [];
  const next = current.filter((a) => a.address !== addr);
  if (next.length === current.length) throw new U.NotFound('address is not whitelisted');
  cfg.treasury.addresses = next;
  configMod.save({ treasury: { addresses: next } });
  return { removed: addr, count: next.length };
}

function resolveTarget(cfg, { address, label }) {
  const listed = cfg.treasury.addresses || [];
  if (label) {
    const hit = listed.find((a) => a.label === label);
    if (!hit) throw new U.NotFound(`no treasury address labelled "${label}"`);
    return hit;
  }
  const addr = String(address ?? '').trim();
  const hit = listed.find((a) => a.address === addr);
  if (hit) return hit;
  if (cfg.treasury.requireWhitelist) {
    throw new U.Forbidden('address is not whitelisted; add it first, or turn off treasury.requireWhitelist');
  }
  const drv = cfg.wallet.driver;
  const check = addrcheck.validate(drv, addr);
  if (!check.ok) throw new U.BadRequest(`address rejected: ${check.reason}`);
  return { label: '(ad hoc)', driver: drv, address: addr };
}

/**
 * Take profit out. Reserves synchronously, sends on-chain, then settles.
 * With the manual driver the row stays `reserved` for the operator to pay by hand
 * and confirm with markPayoutSent.
 */
async function payout(db, cfg, driver, { address, label, amount, note }, actor) {
  const target = resolveTarget(cfg, { address, label });
  if (target.driver !== driver.name) {
    throw new U.BadRequest(
      `that address is for the ${target.driver} wallet but the active driver is ${driver.name}`,
    );
  }
  const units = U.parseAmount(amount);
  if (units < cfg.treasury.minPayoutUnits) {
    throw new U.BadRequest(`minimum payout is ${U.formatAmount(cfg.treasury.minPayoutUnits)}`);
  }

  const id = db.tx(() => {
    const free = freeCapital(db);
    if (units > free) {
      throw new U.BadRequest(
        `only ${U.formatAmount(Math.max(0, free))} is free capital; the rest backs player balances`,
      );
    }
    ledger.transfer(db, ledger.houseAccount(db).id, pendingAccount(db).id,
      units, 'treasury.reserve', target.label);
    db.run(
      `INSERT INTO treasury_payouts(label,driver,address,amount_units,state,note,actor,created_at)
       VALUES(?,?,?,?,'reserved',?,?,?)`,
      target.label, target.driver, target.address, units, note ?? null, actor, now(),
    );
    const rowId = db.get('SELECT last_insert_rowid() AS id').id;
    db.audit(actor, 'treasury.reserve', { id: rowId, units, address: target.address });
    return rowId;
  });

  if (driver.isManual) {
    return {
      id,
      state: 'reserved',
      amount: units,
      address: target.address,
      manual: true,
      note: 'send it from your own wallet, then confirm with the transaction id',
    };
  }

  try {
    const { txid } = await driver.send(target.address, units);
    return db.tx(() => {
      ledger.burn(db, pendingAccount(db).id, units, 'treasury.sent', `${driver.name}:${txid}`);
      db.run("UPDATE treasury_payouts SET state='sent', txid=?, sent_at=? WHERE id=?", txid, now(), id);
      db.audit(actor, 'treasury.sent', { id, txid, units });
      return { id, state: 'sent', txid, amount: units, address: target.address };
    });
  } catch (e) {
    db.tx(() => {
      ledger.transfer(db, pendingAccount(db).id, ledger.houseAccount(db).id,
        units, 'treasury.refund', `payout ${id} failed`);
      db.run("UPDATE treasury_payouts SET state='refunded', note=? WHERE id=?",
        `send failed: ${e.message}`.slice(0, 500), id);
      db.audit(actor, 'treasury.failed', { id, error: e.message });
    });
    throw new U.BadRequest(`send failed, funds returned to the bankroll: ${e.message}`);
  }
}

/** Confirm a hand-sent payout. */
function markPayoutSent(db, id, txid, actor) {
  const tx = String(txid ?? '').trim();
  if (tx.length < 4) throw new U.BadRequest('enter the transaction id');
  return db.tx(() => {
    const row = db.get('SELECT * FROM treasury_payouts WHERE id=?', id);
    if (!row) throw new U.NotFound('no such payout');
    if (row.state !== 'reserved') throw new U.BadRequest(`payout is ${row.state}`);
    ledger.burn(db, pendingAccount(db).id, row.amount_units, 'treasury.sent', `${row.driver}:${tx}`);
    db.run("UPDATE treasury_payouts SET state='sent', txid=?, sent_at=? WHERE id=?", tx, now(), id);
    db.audit(actor, 'treasury.markSent', { id, txid: tx });
    return db.get('SELECT * FROM treasury_payouts WHERE id=?', id);
  });
}

/** Cancel a reserved payout and return the funds to the bankroll. */
function cancelPayout(db, id, actor) {
  return db.tx(() => {
    const row = db.get('SELECT * FROM treasury_payouts WHERE id=?', id);
    if (!row) throw new U.NotFound('no such payout');
    if (row.state !== 'reserved') throw new U.BadRequest(`payout is ${row.state}`);
    ledger.transfer(db, pendingAccount(db).id, ledger.houseAccount(db).id,
      row.amount_units, 'treasury.refund', `payout ${id} cancelled`);
    db.run("UPDATE treasury_payouts SET state='refunded' WHERE id=?", id);
    db.audit(actor, 'treasury.cancel', { id });
    return db.get('SELECT * FROM treasury_payouts WHERE id=?', id);
  });
}

/**
 * Hot-wallet exposure advice. Anything sitting hot beyond what is needed to cover
 * player balances and a buffer is money at risk from a server compromise.
 */
function exposure(db, cfg) {
  const bankroll = ledger.bankroll(db);
  const owed = ledger.playerLiabilities(db);
  const free = freeCapital(db);
  const buffer = Math.floor(free * cfg.treasury.hotWalletMaxFraction);
  return {
    bankroll,
    playerLiabilities: owed,
    freeCapital: free,
    recommendedHotMax: owed + buffer,
    sweepSuggestion: Math.max(0, free - buffer),
    hotWalletMaxFraction: cfg.treasury.hotWalletMaxFraction,
  };
}

const history = (db, limit = 100) => db.all(
  'SELECT * FROM treasury_payouts ORDER BY id DESC LIMIT ?', U.clamp(Number(limit) || 100, 1, 500),
);

const totalPaidOut = (db) => db.get(
  "SELECT COALESCE(SUM(amount_units),0) AS n FROM treasury_payouts WHERE state='sent'",
).n;

module.exports = {
  list, addAddress, removeAddress, payout, markPayoutSent, cancelPayout,
  exposure, history, freeCapital, totalPaidOut, pendingAccount, resolveTarget,
};
