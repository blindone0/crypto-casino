'use strict';
// Crypto deposit and withdrawal layer.
//
// Accounting of a withdrawal, so funds can never be double-spent:
//   request  : player -> pending          (reserved, player can no longer bet it)
//   approve  : pending -> fees (the fee), then burn the rest as it goes on-chain
//   reject   : pending -> player          (fully refunded)
//
// A deposit mints into the player balance once it has enough confirmations. It does NOT
// add to the house bankroll: the bankroll is the operator capital that backs the games,
// funded separately, and player deposits are a liability, not revenue.
const U = require('../util');
const ledger = require('../ledger');

const now = () => Math.floor(Date.now() / 1000);

const DRIVERS = {
  mock: () => require('./mock'),
  manual: () => require('./manual'),
  bitcoind: () => require('./bitcoind'),
  monero: () => require('./monero'),
};

function loadDriver(cfg, logger = console) {
  const name = cfg.wallet.driver;
  const make = DRIVERS[name];
  if (!make) {
    throw new Error(`unknown wallet driver "${name}"; available: ${Object.keys(DRIVERS).join(', ')}`);
  }
  return make().create({ cfg, logger });
}

const pendingAccount = (db) => ledger.ensureAccount(db, 'pending', null, 'withdrawals');

// --------------------------------------------------------------- addresses
async function addressFor(db, driver, userId) {
  // The manual driver shares one operator address across all players, so it is never
  // stored per user (the addresses table is unique per address) and attribution happens
  // via the memo plus an operator check instead.
  if (driver.isManual) {
    const made = await driver.newAddress(userId);
    return {
      user_id: userId,
      driver: driver.name,
      address: made.address,
      memo: made.memo,
      deriv_index: made.index ?? 0,
    };
  }

  const existing = db.get(
    'SELECT * FROM addresses WHERE user_id=? AND driver=? ORDER BY id DESC LIMIT 1',
    userId, driver.name,
  );
  if (existing) return existing;

  const nextIndex = (db.get('SELECT COALESCE(MAX(deriv_index),-1) AS m FROM addresses WHERE driver=?',
    driver.name).m) + 1;
  const made = await driver.newAddress(userId, nextIndex);
  db.run(
    'INSERT INTO addresses(user_id,driver,address,deriv_index,created_at) VALUES(?,?,?,?,?)',
    userId, driver.name, made.address, made.index ?? nextIndex, now(),
  );
  return db.get('SELECT * FROM addresses WHERE driver=? AND address=?', driver.name, made.address);
}

// ---------------------------------------------------------------- deposits
/**
 * Ask the driver what has arrived, record it, and credit anything that has reached the
 * confirmation threshold. Safe to run repeatedly: (driver, txid, vout) is unique, and
 * credited_at gates the mint so a deposit can never be credited twice.
 */
async function syncDeposits(db, cfg, driver, logger = console) {
  const rows = db.all('SELECT address, user_id FROM addresses WHERE driver=?', driver.name);
  if (!rows.length) return { seen: 0, credited: 0 };
  const owner = new Map(rows.map((r) => [r.address, r.user_id]));

  let found = [];
  try {
    found = await driver.listDeposits(rows.map((r) => r.address));
  } catch (e) {
    logger.error(`[wallet:${driver.name}] listDeposits failed: ${e.message}`);
    return { seen: 0, credited: 0, error: e.message };
  }

  let credited = 0;
  for (const d of found) {
    const userId = owner.get(d.address);
    if (!userId) continue;
    if (!Number.isSafeInteger(d.amountUnits) || d.amountUnits <= 0) continue;

    db.tx(() => {
      const existing = db.get(
        'SELECT * FROM deposits WHERE driver=? AND txid=? AND vout=?',
        driver.name, d.txid, d.vout ?? 0,
      );
      if (!existing) {
        db.run(
          `INSERT INTO deposits(user_id,driver,address,txid,vout,amount_units,confirmations,created_at)
           VALUES(?,?,?,?,?,?,?,?)`,
          userId, driver.name, d.address, d.txid, d.vout ?? 0,
          d.amountUnits, d.confirmations ?? 0, now(),
        );
      } else {
        db.run('UPDATE deposits SET confirmations=? WHERE id=?', d.confirmations ?? 0, existing.id);
      }
      const row = db.get('SELECT * FROM deposits WHERE driver=? AND txid=? AND vout=?',
        driver.name, d.txid, d.vout ?? 0);

      if (!row.credited_at && row.confirmations >= cfg.wallet.minConfirmations) {
        const acct = ledger.userAccount(db, userId);
        ledger.mint(db, acct.id, row.amount_units, 'deposit', `${driver.name}:${row.txid}`);
        db.run('UPDATE deposits SET credited_at=? WHERE id=?', now(), row.id);
        db.audit(`user:${userId}`, 'deposit.credited',
          { txid: row.txid, units: row.amount_units, driver: driver.name });
        credited += 1;
      }
    });
  }
  return { seen: found.length, credited };
}

// ------------------------------------------------------------- withdrawals
function requestWithdrawal(db, cfg, driver, user, { address, amount }, ip) {
  const addr = String(address ?? '').trim();
  if (!driver.validateAddress(addr)) throw new U.BadRequest('that does not look like a valid address');

  const units = U.parseAmount(amount);
  const fee = cfg.wallet.withdrawalFeeUnits;
  if (units < cfg.wallet.minWithdrawalUnits) {
    throw new U.BadRequest(`minimum withdrawal is ${U.formatAmount(cfg.wallet.minWithdrawalUnits)}`);
  }
  if (units <= fee) throw new U.BadRequest('amount must be greater than the network fee');
  if (user.frozen) throw new U.Forbidden('account frozen');

  return db.tx(() => {
    const uAcc = ledger.userAccount(db, user.id);
    const pAcc = pendingAccount(db);
    // Throws "insufficient funds" and rolls back if the balance is not there.
    ledger.transfer(db, uAcc.id, pAcc.id, units, 'withdraw.reserve', addr);

    const auto = units <= cfg.wallet.autoApproveBelowUnits;
    db.run(
      `INSERT INTO withdrawals(user_id,driver,address,amount_units,fee_units,send_units,state,requested_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      user.id, driver.name, addr, units, fee, units - fee,
      auto ? 'approved' : 'pending', now(),
    );
    const id = db.get('SELECT last_insert_rowid() AS id').id;
    db.audit(`user:${user.id}`, 'withdraw.request',
      { id, units, address: addr, auto }, ip);
    return {
      id,
      state: auto ? 'approved' : 'pending',
      amount: units,
      fee,
      willSend: units - fee,
      balance: ledger.userAccount(db, user.id).balance,
    };
  });
}

function decideWithdrawal(db, id, approve, note, actor) {
  return db.tx(() => {
    const w = db.get('SELECT * FROM withdrawals WHERE id=?', id);
    if (!w) throw new U.NotFound('no such withdrawal');
    if (w.state !== 'pending') throw new U.BadRequest(`withdrawal is already ${w.state}`);

    if (approve) {
      db.run("UPDATE withdrawals SET state='approved', admin_note=?, decided_at=? WHERE id=?",
        note ?? null, now(), id);
    } else {
      const pAcc = pendingAccount(db);
      const uAcc = ledger.userAccount(db, w.user_id);
      ledger.transfer(db, pAcc.id, uAcc.id, w.amount_units, 'withdraw.refund', `wd:${id}`);
      db.run("UPDATE withdrawals SET state='rejected', admin_note=?, decided_at=? WHERE id=?",
        note ?? null, now(), id);
    }
    db.audit(actor, approve ? 'withdraw.approve' : 'withdraw.reject', { id, note });
    return db.get('SELECT * FROM withdrawals WHERE id=?', id);
  });
}

/**
 * Broadcast every approved withdrawal. The on-chain send happens BETWEEN two
 * transactions on purpose: we mark the row 'sent' with its txid only after the driver
 * confirms, and a driver failure leaves the money in `pending` for a retry rather than
 * losing it.
 */
async function processApproved(db, cfg, driver, logger = console) {
  // Manual payouts are a human action: leave them approved and visible in the admin queue
  // rather than calling a send that cannot work.
  if (driver.isManual) return { sent: 0, queued: 0, manual: true };

  const queue = db.all("SELECT * FROM withdrawals WHERE state='approved' AND driver=? ORDER BY id",
    driver.name);
  let sent = 0;
  for (const w of queue) {
    try {
      const { txid } = await driver.send(w.address, w.send_units);
      db.tx(() => {
        const pAcc = pendingAccount(db);
        const fAcc = ledger.feesAccount(db);
        if (w.fee_units > 0) {
          ledger.transfer(db, pAcc.id, fAcc.id, w.fee_units, 'withdraw.fee', `wd:${w.id}`);
        }
        ledger.burn(db, pAcc.id, w.send_units, 'withdraw.sent', `${driver.name}:${txid}`);
        db.run("UPDATE withdrawals SET state='sent', txid=?, decided_at=? WHERE id=?",
          txid, now(), w.id);
        db.audit('system', 'withdraw.sent', { id: w.id, txid, units: w.send_units });
      });
      sent += 1;
    } catch (e) {
      logger.error(`[wallet:${driver.name}] send failed for withdrawal ${w.id}: ${e.message}`);
      db.tx(() => {
        db.run("UPDATE withdrawals SET state='failed', admin_note=? WHERE id=?",
          `send failed: ${e.message}`.slice(0, 500), w.id);
        db.audit('system', 'withdraw.failed', { id: w.id, error: e.message });
      });
    }
  }
  return { sent, queued: queue.length };
}

/**
 * Operator marks an approved withdrawal as paid by hand (manual driver, or any payout
 * sent from an external wallet). Completes the same accounting the automatic path does.
 */
function markSent(db, id, txid, actor) {
  const tx = String(txid ?? '').trim();
  if (tx.length < 4) throw new U.BadRequest('enter the transaction id you sent');
  return db.tx(() => {
    const w = db.get('SELECT * FROM withdrawals WHERE id=?', id);
    if (!w) throw new U.NotFound('no such withdrawal');
    if (w.state !== 'approved' && w.state !== 'failed') {
      throw new U.BadRequest(`withdrawal is ${w.state}, not awaiting payment`);
    }
    const pAcc = pendingAccount(db);
    const fAcc = ledger.feesAccount(db);
    if (w.fee_units > 0) {
      ledger.transfer(db, pAcc.id, fAcc.id, w.fee_units, 'withdraw.fee', `wd:${w.id}`);
    }
    ledger.burn(db, pAcc.id, w.send_units, 'withdraw.sent', `${w.driver}:${tx}`);
    db.run("UPDATE withdrawals SET state='sent', txid=?, decided_at=? WHERE id=?", tx, now(), id);
    db.audit(actor, 'withdraw.markSent', { id, txid: tx });
    return db.get('SELECT * FROM withdrawals WHERE id=?', id);
  });
}

/**
 * Operator credits a deposit by hand (manual driver). Idempotent per (driver, txid):
 * a repeat call with the same txid is rejected rather than double-crediting.
 */
function creditManualDeposit(db, cfg, driver, { userId, amountUnits, txid, address }, actor) {
  const tx = String(txid ?? '').trim();
  if (tx.length < 4) throw new U.BadRequest('transaction id required');
  if (!Number.isSafeInteger(amountUnits) || amountUnits <= 0) throw new U.BadRequest('bad amount');

  return db.tx(() => {
    const user = db.get('SELECT * FROM users WHERE id=?', userId);
    if (!user) throw new U.NotFound('no such user');
    if (db.get('SELECT 1 FROM deposits WHERE driver=? AND txid=? AND vout=0', driver.name, tx)) {
      throw new U.BadRequest('that transaction id is already credited');
    }
    db.run(
      `INSERT INTO deposits(user_id,driver,address,txid,vout,amount_units,confirmations,credited_at,created_at)
       VALUES(?,?,?,?,0,?,?,?,?)`,
      userId, driver.name, String(address ?? 'manual'), tx, amountUnits,
      cfg.wallet.minConfirmations, now(), now(),
    );
    const acct = ledger.userAccount(db, userId);
    ledger.mint(db, acct.id, amountUnits, 'deposit', `${driver.name}:${tx}`);
    db.audit(actor, 'deposit.manual', { userId, amountUnits, txid: tx });
    return { credited: amountUnits, balance: ledger.userAccount(db, userId).balance };
  });
}

/** Retry a failed send: funds are still reserved, so we just requeue it. */
function retryWithdrawal(db, id, actor) {
  return db.tx(() => {
    const w = db.get('SELECT * FROM withdrawals WHERE id=?', id);
    if (!w) throw new U.NotFound('no such withdrawal');
    if (w.state !== 'failed') throw new U.BadRequest('only failed withdrawals can be retried');
    db.run("UPDATE withdrawals SET state='approved', admin_note=NULL WHERE id=?", id);
    db.audit(actor, 'withdraw.retry', { id });
    return db.get('SELECT * FROM withdrawals WHERE id=?', id);
  });
}

/** Background loop: poll for deposits and flush the withdrawal queue. */
function startPoller(db, cfg, driver, logger = console) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncDeposits(db, cfg, driver, logger);
      await processApproved(db, cfg, driver, logger);
    } catch (e) {
      logger.error(`[wallet:${driver.name}] poller error: ${e.message}`);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, Math.max(3000, cfg.wallet.pollIntervalMs));
  handle.unref?.();
  tick();
  return () => clearInterval(handle);
}

module.exports = {
  loadDriver, addressFor, syncDeposits,
  requestWithdrawal, decideWithdrawal, processApproved, retryWithdrawal,
  markSent, creditManualDeposit,
  startPoller, pendingAccount, DRIVERS,
};
