'use strict';
// Operator functions: the P&L view, risk posture, bankroll control, player management
// and the withdrawal queue.
//
// The numbers that decide whether this business works:
//   wagered        - total volume. Revenue scales with this, not with player losses.
//   ggrTheoretical - wagered * houseEdge. What the maths owes you.
//   ggrActual      - what you actually kept. Converges to theoretical as volume grows.
//   hold           - ggrActual / wagered. Should sit near your configured edge.
//   bankroll       - operator capital backing the games.
//   liabilities    - the sum of player balances. You owe this. It is not yours.
//   freeCapital    - bankroll minus what you owe. Negative means you are insolvent.
const U = require('./util');
const ledger = require('./ledger');

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

function overview(db, cfg) {
  const bankroll = ledger.bankroll(db);
  const liabilities = ledger.playerLiabilities(db);
  const fees = ledger.feesAccount(db).balance;
  const pending = db.get(
    "SELECT COALESCE(SUM(balance),0) AS n FROM accounts WHERE owner_type='pending'",
  ).n;
  const affiliateOwed = db.get(
    "SELECT COALESCE(SUM(balance),0) AS n FROM accounts WHERE owner_type='affiliate'",
  ).n;
  const rakebackOwed = db.get(
    "SELECT COALESCE(SUM(balance),0) AS n FROM accounts WHERE owner_type='user' AND kind='rakeback'",
  ).n;

  const windows = {
    today: ledger.houseStats(db, now() - DAY),
    week: ledger.houseStats(db, now() - 7 * DAY),
    month: ledger.houseStats(db, now() - 30 * DAY),
    all: ledger.houseStats(db, 0),
  };

  const users = db.get('SELECT COUNT(*) AS n FROM users').n;
  const activeToday = db.get(
    'SELECT COUNT(DISTINCT user_id) AS n FROM bets WHERE created_at >= ?', now() - DAY,
  ).n;

  return {
    bankroll,
    liabilities,
    pendingWithdrawals: pending,
    freeCapital: bankroll - liabilities,
    feesCollected: fees,
    affiliateOwed,
    rakebackOwed,
    maxProfitPerBet: ledger.maxProfitAllowed(db, cfg),
    users,
    activeToday,
    windows,
    audit: ledger.auditBalances(db),
    config: {
      houseEdge: cfg.houseEdge,
      risk: cfg.risk,
      referralCommission: cfg.referralCommission,
      rakeback: cfg.rakeback,
    },
  };
}

/** GGR per day for the last N days, for the dashboard chart. */
function dailySeries(db, days = 30) {
  const from = now() - days * DAY;
  const rows = db.all(
    `SELECT CAST(created_at / 86400 AS INTEGER) AS day,
            COUNT(*)                        AS bets,
            COALESCE(SUM(wager),0)          AS wagered,
            COALESCE(SUM(wager - payout),0) AS ggr,
            COALESCE(SUM(edge_units),0)     AS theoretical
       FROM bets WHERE created_at >= ?
      GROUP BY day ORDER BY day`,
    from,
  );
  return rows.map((r) => ({
    date: new Date(r.day * DAY * 1000).toISOString().slice(0, 10),
    bets: r.bets,
    wagered: r.wagered,
    ggr: r.ggr,
    theoretical: r.theoretical,
  }));
}

/**
 * Risk posture. The question this answers: if the worst plausible run happens, do you
 * still have a business tomorrow?
 */
function riskReport(db, cfg) {
  const bankroll = ledger.bankroll(db);
  const maxProfit = ledger.maxProfitAllowed(db, cfg);
  const liabilities = ledger.playerLiabilities(db);

  const biggestWin = db.get('SELECT COALESCE(MAX(profit),0) AS n FROM bets').n;
  const worstDay = db.all(
    `SELECT CAST(created_at / 86400 AS INTEGER) AS day, SUM(wager - payout) AS ggr
       FROM bets GROUP BY day ORDER BY ggr ASC LIMIT 1`,
  )[0];

  const stats = ledger.houseStats(db, 0);
  return {
    bankroll,
    liabilities,
    freeCapital: bankroll - liabilities,
    maxProfitPerBet: maxProfit,
    maxLossesAbsorbable: maxProfit > 0 ? Math.floor(bankroll / maxProfit) : null,
    biggestWinPaid: biggestWin,
    worstDayGgr: worstDay ? worstDay.ggr : 0,
    holdActual: stats.holdActual,
    holdTheoretical: stats.holdTheoretical,
    // A hold far below theoretical over high volume means variance or a bug.
    holdGap: stats.holdTheoretical - stats.holdActual,
    volumeNeededForConfidence: stats.wagered
      ? Math.max(0, Math.ceil(1000 / Math.max(cfg.houseEdge.dice, 0.001)) - stats.bets)
      : null,
  };
}

// --------------------------------------------------------------- bankroll
/** Operator puts capital in. This is what makes the games payable. */
function addBankroll(db, units, actor, note) {
  if (!Number.isSafeInteger(units) || units <= 0) throw new U.BadRequest('bad amount');
  return db.tx(() => {
    const h = ledger.houseAccount(db);
    ledger.mint(db, h.id, units, 'bankroll.in', note || 'operator deposit');
    db.audit(actor, 'bankroll.add', { units, note });
    return { bankroll: ledger.bankroll(db) };
  });
}

/**
 * Operator takes profit out. Refuses to leave the house unable to cover player balances,
 * because paying yourself out of customer funds is how a site dies.
 */
function removeBankroll(db, units, actor, note) {
  if (!Number.isSafeInteger(units) || units <= 0) throw new U.BadRequest('bad amount');
  return db.tx(() => {
    const h = ledger.houseAccount(db);
    const free = ledger.bankroll(db) - ledger.playerLiabilities(db);
    if (units > free) {
      throw new U.BadRequest(
        `only ${U.formatAmount(Math.max(0, free))} is free capital; the rest backs player balances`,
      );
    }
    ledger.burn(db, h.id, units, 'bankroll.out', note || 'operator withdrawal');
    db.audit(actor, 'bankroll.remove', { units, note });
    return { bankroll: ledger.bankroll(db) };
  });
}

/** Move collected withdrawal fees into the bankroll. */
function sweepFees(db, actor) {
  return db.tx(() => {
    const f = ledger.feesAccount(db);
    const h = ledger.houseAccount(db);
    if (f.balance <= 0) return { swept: 0, bankroll: ledger.bankroll(db) };
    const amount = f.balance;
    ledger.transfer(db, f.id, h.id, amount, 'fees.sweep', 'fees to bankroll');
    db.audit(actor, 'fees.sweep', { units: amount });
    return { swept: amount, bankroll: ledger.bankroll(db) };
  });
}

// ------------------------------------------------------------------ players
function listUsers(db, { q = '', limit = 50, offset = 0 } = {}) {
  const like = `%${String(q).toLowerCase()}%`;
  const rows = db.all(
    `SELECT u.id, u.username, u.role, u.frozen, u.created_at, u.last_seen_at,
            u.self_excluded_until, u.referral_code, u.referred_by,
            COALESCE(a.balance,0)                AS balance,
            COALESCE(b.wagered,0)                AS wagered,
            COALESCE(b.bets,0)                   AS bets,
            COALESCE(b.net,0)                    AS house_net
       FROM users u
       LEFT JOIN accounts a ON a.owner_type='user' AND a.owner_id=u.id AND a.kind='main'
       LEFT JOIN (SELECT user_id, COUNT(*) bets, SUM(wager) wagered, SUM(wager - payout) net
                    FROM bets GROUP BY user_id) b ON b.user_id = u.id
      WHERE (? = '' OR LOWER(u.username) LIKE ?)
      ORDER BY wagered DESC, u.id DESC
      LIMIT ? OFFSET ?`,
    String(q), like, U.clamp(Number(limit) || 50, 1, 200), Math.max(0, Number(offset) || 0),
  );
  const total = db.get('SELECT COUNT(*) AS n FROM users').n;
  return { users: rows, total };
}

function userDetail(db, id) {
  const user = db.get('SELECT * FROM users WHERE id=?', id);
  if (!user) throw new U.NotFound('no such user');
  const main = ledger.userAccount(db, id);
  const rake = ledger.userAccount(db, id, 'rakeback');
  const aff = ledger.affiliateAccount(db, id);
  const bets = db.all(
    'SELECT id,game,wager,multiplier,payout,profit,created_at FROM bets WHERE user_id=? ORDER BY id DESC LIMIT 50',
    id,
  );
  const stats = db.get(
    `SELECT COUNT(*) AS bets, COALESCE(SUM(wager),0) AS wagered,
            COALESCE(SUM(wager - payout),0) AS house_net, COALESCE(SUM(edge_units),0) AS theoretical
       FROM bets WHERE user_id=?`,
    id,
  );
  return {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      frozen: !!user.frozen,
      createdAt: user.created_at,
      lastSeenAt: user.last_seen_at,
      selfExcludedUntil: user.self_excluded_until,
      referralCode: user.referral_code,
      referredBy: user.referred_by,
      maxBetCap: user.max_bet_cap,
    },
    balances: { main: main.balance, rakeback: rake.balance, affiliate: aff.balance },
    stats,
    bets,
    referrals: db.get('SELECT COUNT(*) AS n FROM users WHERE referred_by=?', id).n,
  };
}

function setFrozen(db, id, frozen, actor) {
  return db.tx(() => {
    const user = db.get('SELECT * FROM users WHERE id=?', id);
    if (!user) throw new U.NotFound('no such user');
    db.run('UPDATE users SET frozen=? WHERE id=?', frozen ? 1 : 0, id);
    if (frozen) db.run('DELETE FROM sessions WHERE user_id=?', id);
    db.audit(actor, frozen ? 'user.freeze' : 'user.unfreeze', { id });
    return { id, frozen: !!frozen };
  });
}

const auditTail = (db, limit = 100) => db.all(
  'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', U.clamp(Number(limit) || 100, 1, 500),
);

/** Affiliate leaderboard: who is actually bringing volume. */
const affiliateReport = (db) => db.all(
  `SELECT u.id, u.username, u.referral_code,
          COUNT(DISTINCT r.player_id)          AS players,
          COALESCE(SUM(r.amount_units),0)      AS earned,
          COALESCE(a.balance,0)                AS unpaid
     FROM users u
     LEFT JOIN referral_earnings r ON r.affiliate_id = u.id
     LEFT JOIN accounts a ON a.owner_type='affiliate' AND a.owner_id=u.id
    GROUP BY u.id HAVING players > 0 OR earned > 0
    ORDER BY earned DESC LIMIT 100`,
);

module.exports = {
  overview, dailySeries, riskReport,
  addBankroll, removeBankroll, sweepFees,
  listUsers, userDetail, setFrozen,
  auditTail, affiliateReport,
};
