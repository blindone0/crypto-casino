'use strict';
// Money movement. Every function here is synchronous and must be called inside db.tx().
//
// Accounting model
//   Internal transfers (bet, payout, fee, referral, rakeback) write TWO ledger rows
//   sharing one tx_id, with deltas summing to zero.
//   External flows (a crypto deposit arriving, a withdrawal being broadcast) write ONE
//   row, because the counterparty is the blockchain rather than another account here.
//   So: sum(accounts.balance) == sum(ledger.delta) at all times. The audit test asserts it.
//
// The CHECK(balance >= 0) constraint is the last line of defence against a negative
// balance; the risk caps in settleBet are the first.
const { randomUUID } = require('node:crypto');
const { BadRequest, Forbidden } = require('./util');

const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------ accounts
function ensureAccount(db, ownerType, ownerId, kind = 'main') {
  const sel = 'SELECT * FROM accounts WHERE owner_type=? AND owner_id IS ? AND kind=?';
  let row = db.get(sel, ownerType, ownerId, kind);
  if (!row) {
    db.run(
      'INSERT INTO accounts(owner_type,owner_id,kind,balance,created_at) VALUES(?,?,?,0,?)',
      ownerType, ownerId, kind, now(),
    );
    row = db.get(sel, ownerType, ownerId, kind);
  }
  return row;
}

const userAccount = (db, userId, kind = 'main') => ensureAccount(db, 'user', userId, kind);
const houseAccount = (db) => ensureAccount(db, 'house', null, 'main');
const feesAccount = (db) => ensureAccount(db, 'fees', null, 'main');
const affiliateAccount = (db, userId) => ensureAccount(db, 'affiliate', userId, 'main');

function balanceOf(db, accountId) {
  const row = db.get('SELECT balance FROM accounts WHERE id=?', accountId);
  return row ? row.balance : 0;
}

/** House bankroll: what is actually available to pay winners right now. */
const bankroll = (db) => houseAccount(db).balance;

// ------------------------------------------------------------ primitives
function post(db, accountId, delta, kind, memo, txId) {
  const before = db.get('SELECT balance FROM accounts WHERE id=?', accountId);
  if (!before) throw new Error(`no such account ${accountId}`);
  const after = before.balance + delta;
  if (!Number.isSafeInteger(after)) throw new BadRequest('balance overflow');
  if (after < 0) throw new BadRequest('insufficient funds');
  db.run('UPDATE accounts SET balance=? WHERE id=?', after, accountId);
  db.run(
    'INSERT INTO ledger(tx_id,account_id,delta,balance_after,kind,memo,created_at) VALUES(?,?,?,?,?,?,?)',
    txId, accountId, delta, after, kind, memo ?? null, now(),
  );
  return after;
}

/** Internal move between two accounts. Balanced: two rows, one tx_id. */
function transfer(db, fromId, toId, units, kind, memo) {
  if (!Number.isSafeInteger(units) || units < 0) throw new BadRequest('bad transfer amount');
  if (units === 0) return null;
  const txId = randomUUID();
  post(db, fromId, -units, kind, memo, txId);
  post(db, toId, units, kind, memo, txId);
  return txId;
}

/** External money in (crypto deposit confirmed). Single-sided by design. */
function mint(db, toId, units, kind, memo) {
  if (!Number.isSafeInteger(units) || units <= 0) throw new BadRequest('bad mint amount');
  const txId = randomUUID();
  post(db, toId, units, kind, memo, txId);
  return txId;
}

/** External money out (withdrawal broadcast). Single-sided by design. */
function burn(db, fromId, units, kind, memo) {
  if (!Number.isSafeInteger(units) || units <= 0) throw new BadRequest('bad burn amount');
  const txId = randomUUID();
  post(db, fromId, -units, kind, memo, txId);
  return txId;
}

// ------------------------------------------------------------ risk limits
/**
 * Largest profit a single bet may win. This is the control that keeps one lucky
 * player from taking the whole bankroll: no matter the multiplier, max win is a
 * fixed slice of what the house holds.
 */
function maxProfitAllowed(db, cfg) {
  return Math.floor(bankroll(db) * cfg.risk.bankrollRiskFraction);
}

/**
 * Validate a wager against global caps, the player's own cap, and the bankroll.
 * `maxMultiplier` is the largest multiplier this bet could pay.
 * Throws with a player-readable message; returns the wager on success.
 */
function checkBetLimits(db, cfg, user, wager, maxMultiplier) {
  const r = cfg.risk;
  if (!Number.isSafeInteger(wager) || wager < r.minBetUnits) {
    throw new BadRequest(`minimum bet is ${r.minBetUnits} units`);
  }
  if (wager > r.maxBetUnits) throw new BadRequest('bet above table maximum');
  if (user.max_bet_cap > 0 && wager > user.max_bet_cap) {
    throw new BadRequest('bet above your self-imposed limit');
  }
  if (user.frozen) throw new Forbidden('account frozen');
  if (user.self_excluded_until > now()) throw new Forbidden('self-exclusion active');

  const potentialProfit = Math.floor(wager * maxMultiplier) - wager;
  const cap = maxProfitAllowed(db, cfg);
  if (potentialProfit > cap) {
    throw new BadRequest(
      `max win on this bet would be ${potentialProfit} units but the table limit is ${cap}; lower your stake or multiplier`,
    );
  }
  // Hard floor: never accept a bet the bankroll literally cannot pay.
  if (potentialProfit > bankroll(db)) throw new BadRequest('bankroll too low for this bet');
  return wager;
}

/**
 * Cap a win at the bankroll-derived max profit.
 *
 * Games where the player chooses when to stop (mines, crash) have no fixed ceiling on
 * the multiplier, so instead of refusing large stakes we accept the bet and cap the
 * payout, the way commercial sites publish a "max profit per bet". The cap is always
 * strictly below the bankroll, so the house can always honour it.
 */
function capPayout(db, cfg, wager, rawPayout) {
  const ceiling = wager + maxProfitAllowed(db, cfg);
  if (rawPayout <= ceiling) return { payout: rawPayout, capped: false, ceiling };
  return { payout: ceiling, capped: true, ceiling };
}

// ------------------------------------------------------------ settlement
/**
 * Atomically settle one resolved bet.
 *
 * Money path: wager moves player -> house, then any payout moves house -> player.
 * `edgeUnits` is the theoretical hold (wager * houseEdge) and drives affiliate
 * commission and rakeback, both of which are paid out of the edge, never out of
 * the stake, so they can shrink the margin but can never invert it.
 *
 * Call inside db.tx(). Returns the bet row id. Moves no money: the bank that called
 * it has already moved the stake and the payout in whatever it holds. This writes the
 * record — including the seed, nonce and client seed a player needs to verify the
 * round — which is the part that must happen for every bet in every currency.
 */
function recordBet(db, cfg, {
  user, game, wager, multiplier, payout, edgeUnits = 0,
  seedId = null, nonce = 0, clientSeed = '', detail = null,
}) {
  // `edge_units` and `client_seed` are NOT NULL, and not every caller has a seed: the
  // arcade and a settled match are money moving without a dice roll behind it. The games
  // that do have one always pass it, so defaulting here loses nothing and stops a
  // settlement throwing on a column it was never going to fill.

  db.run(
    `INSERT INTO bets(user_id,game,wager,multiplier,payout,profit,edge_units,seed_id,nonce,client_seed,detail,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    user.id, game, wager, multiplier, payout, payout - wager, edgeUnits,
    seedId, nonce, clientSeed, JSON.stringify(detail), now(),
  );
  const betId = db.get('SELECT last_insert_rowid() AS id').id;

  payCommissions(db, cfg, user, edgeUnits, betId);
  return betId;
}

// `payCommissions` moves credits, and credits no longer exist as a player currency.
// Both dials are off in the shipped config, so this is a no-op; it is kept whole rather
// than deleted because paying them in tugriks later is a small change, and deleting the
// referral and rakeback plumbing to re-add it would not be.

/** Affiliate commission and player rakeback, both carved out of the theoretical edge. */
function payCommissions(db, cfg, user, edgeUnits, betId) {
  const hAcc = houseAccount(db);

  if (user.referred_by && cfg.referralCommission > 0) {
    const cut = Math.floor(edgeUnits * cfg.referralCommission);
    if (cut > 0 && balanceOf(db, hAcc.id) >= cut) {
      const aff = affiliateAccount(db, user.referred_by);
      transfer(db, hAcc.id, aff.id, cut, 'referral', `bet:${betId}`);
      db.run(
        'INSERT INTO referral_earnings(affiliate_id,player_id,bet_id,amount_units,created_at) VALUES(?,?,?,?,?)',
        user.referred_by, user.id, betId, cut, now(),
      );
    }
  }

  if (cfg.rakeback.enabled && cfg.rakeback.rate > 0) {
    const back = Math.floor(edgeUnits * cfg.rakeback.rate);
    if (back > 0 && balanceOf(db, hAcc.id) >= back) {
      const rb = userAccount(db, user.id, 'rakeback');
      transfer(db, hAcc.id, rb.id, back, 'rakeback', `bet:${betId}`);
    }
  }
}

// ------------------------------------------------------------ reporting
/**
 * Operator P&L. `actual` is real money won from players; `theoretical` is what the
 * edge says you should make. Over enough volume they converge; a big gap means either
 * variance or a bug, which is exactly why both are reported.
 */
function houseStats(db, sinceTs = 0) {
  const b = db.get(
    `SELECT COUNT(*) AS bets,
            COALESCE(SUM(wager),0)      AS wagered,
            COALESCE(SUM(payout),0)     AS paid,
            COALESCE(SUM(edge_units),0) AS theoretical
       FROM bets WHERE created_at >= ?`,
    sinceTs,
  );
  const perGame = db.all(
    `SELECT game,
            COUNT(*) AS bets,
            COALESCE(SUM(wager),0)          AS wagered,
            COALESCE(SUM(wager - payout),0) AS ggr,
            COALESCE(SUM(edge_units),0)     AS theoretical
       FROM bets WHERE created_at >= ? GROUP BY game ORDER BY wagered DESC`,
    sinceTs,
  );
  const actual = b.wagered - b.paid;
  return {
    bets: b.bets,
    wagered: b.wagered,
    paid: b.paid,
    ggrActual: actual,
    ggrTheoretical: b.theoretical,
    holdActual: b.wagered ? actual / b.wagered : 0,
    holdTheoretical: b.wagered ? b.theoretical / b.wagered : 0,
    perGame,
  };
}

/** Sum of every player balance: the liability side of the book. */
function playerLiabilities(db) {
  const row = db.get("SELECT COALESCE(SUM(balance),0) AS n FROM accounts WHERE owner_type='user'");
  return row.n;
}

/** Internal consistency check: account balances must equal the ledger sum. */
function auditBalances(db) {
  const acc = db.get('SELECT COALESCE(SUM(balance),0) AS n FROM accounts').n;
  const led = db.get('SELECT COALESCE(SUM(delta),0) AS n FROM ledger').n;
  return { accounts: acc, ledger: led, ok: acc === led };
}

module.exports = {
  ensureAccount, userAccount, houseAccount, feesAccount, affiliateAccount,
  balanceOf, bankroll,
  transfer, mint, burn, post,
  maxProfitAllowed, checkBetLimits, capPayout,
  recordBet, payCommissions,
  houseStats, playerLiabilities, auditBalances,
};
