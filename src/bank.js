'use strict';
// The banking interface every game talks to, so a game does not know or care whether it
// is moving real money or play money.
//
// Why the separation is strict:
// Demo money must never touch the real ledger. If it did, a demo win would be paid out
// of the operator's bankroll, demo balances would inflate the "owed to players" figure,
// and the books-balance audit would be measuring fiction. So the demo bank is a wholly
// separate store with its own balances and its own bet log, and the operator's P&L never
// sees it.
//
// What demo players still get: the identical games, the identical maths, the identical
// provably-fair seed chain. The only difference is which ledger the numbers land in.
const U = require('./util');
const ledger = require('./ledger');

const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------- real money
function realBank(db, cfg) {
  return {
    isDemo: false,
    mode: 'real',

    balance: (userId) => ledger.userAccount(db, userId).balance,

    checkLimits(user, wager, maxMultiplier) {
      return ledger.checkBetLimits(db, cfg, user, wager, maxMultiplier);
    },

    capPayout(wager, rawPayout) {
      return ledger.capPayout(db, cfg, wager, rawPayout);
    },

    maxProfit: () => ledger.maxProfitAllowed(db, cfg),

    takeStake(user, wager, memo) {
      return ledger.transfer(
        db,
        ledger.userAccount(db, user.id).id,
        ledger.houseAccount(db).id,
        wager, 'bet', memo,
      );
    },

    settle(bet) {
      return ledger.settleBet(db, cfg, bet);
    },
  };
}

// -------------------------------------------------------------- play money
/**
 * Demo bank. Balances live in `demo_balances` and bets in `demo_bets`; nothing here
 * touches accounts, ledger, bets or the bankroll.
 */
function demoBank(db, cfg) {
  const limits = cfg.demo || {};
  const startingUnits = limits.startingUnits ?? 1000 * U.UNIT;
  const topUpTo = limits.topUpToUnits ?? startingUnits;
  const topUpBelow = limits.topUpBelowUnits ?? Math.floor(startingUnits / 100);

  function row(userId) {
    let r = db.get('SELECT * FROM demo_balances WHERE user_id=?', userId);
    if (!r) {
      db.run('INSERT INTO demo_balances(user_id,balance,created_at,updated_at) VALUES(?,?,?,?)',
        userId, startingUnits, now(), now());
      r = db.get('SELECT * FROM demo_balances WHERE user_id=?', userId);
    }
    return r;
  }

  function move(userId, delta) {
    const r = row(userId);
    const next = r.balance + delta;
    if (next < 0) throw new U.BadRequest('insufficient play balance');
    if (!Number.isSafeInteger(next)) throw new U.BadRequest('balance overflow');
    db.run('UPDATE demo_balances SET balance=?, updated_at=? WHERE user_id=?', next, now(), userId);
    return next;
  }

  return {
    isDemo: true,
    mode: 'demo',

    balance: (userId) => row(userId).balance,

    /**
     * Play money still respects the table minimum and maximum, so the game feels the
     * same. It deliberately does NOT respect the bankroll cap: there is no bankroll to
     * protect, and a demo player hitting an invisible ceiling would just be confusing.
     */
    checkLimits(user, wager) {
      const r = cfg.risk;
      if (!Number.isSafeInteger(wager) || wager < r.minBetUnits) {
        throw new U.BadRequest(`minimum bet is ${r.minBetUnits} units`);
      }
      if (wager > r.maxBetUnits) throw new U.BadRequest('bet above table maximum');
      if (user.frozen) throw new U.Forbidden('account frozen');
      // Self-exclusion covers play money too. Someone who asked to be kept away from the
      // games asked to be kept away from all of them.
      if (user.self_excluded_until > now()) throw new U.Forbidden('self-exclusion active');
      if (this.balance(user.id) < wager) throw new U.BadRequest('insufficient play balance');
      return wager;
    },

    // No bankroll to blow up, so an open-ended win is capped only by sane arithmetic.
    capPayout: (wager, rawPayout) => ({ payout: rawPayout, capped: false, ceiling: Infinity }),

    maxProfit: () => Number.MAX_SAFE_INTEGER,

    takeStake(user, wager) {
      move(user.id, -wager);
      return null;
    },

    settle(bet) {
      const { user, game, wager, multiplier, payout, detail, nonce, stakeTaken } = bet;
      if (!stakeTaken) move(user.id, -wager);
      if (payout > 0) move(user.id, payout);
      db.run(
        `INSERT INTO demo_bets(user_id,game,wager,multiplier,payout,profit,nonce,detail,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        user.id, game, wager, multiplier, payout, payout - wager, nonce,
        JSON.stringify(detail ?? null), now(),
      );
      return db.get('SELECT last_insert_rowid() AS id').id;
    },

    /** Refill a spent play balance. Free, unlimited, and worth nothing. */
    topUp(userId) {
      const r = row(userId);
      if (r.balance >= topUpBelow) {
        throw new U.BadRequest(
          `top-up is available once your play balance drops below ${U.formatAmount(topUpBelow)}`,
        );
      }
      db.run('UPDATE demo_balances SET balance=?, updated_at=? WHERE user_id=?',
        topUpTo, now(), userId);
      db.audit(`user:${userId}`, 'demo.topup', { to: topUpTo });
      return { balance: topUpTo, added: topUpTo - r.balance };
    },

    history(userId, limit = 50) {
      return db.all(
        `SELECT id,game,wager,multiplier,payout,profit,created_at
           FROM demo_bets WHERE user_id=? ORDER BY id DESC LIMIT ?`,
        userId, U.clamp(Number(limit) || 50, 1, 200),
      );
    },
  };
}

/** Pick the bank for a request. Anything but an explicit demo mode means real money. */
function bankFor(db, cfg, mode) {
  return mode === 'demo' ? demoBank(db, cfg) : realBank(db, cfg);
}

/** Aggregate play-money activity, so the operator can see engagement without P&L noise. */
function demoStats(db) {
  const b = db.get(
    `SELECT COUNT(*) AS bets, COUNT(DISTINCT user_id) AS players,
            COALESCE(SUM(wager),0) AS wagered, COALESCE(SUM(payout),0) AS paid
       FROM demo_bets`,
  );
  return {
    ...b,
    balances: db.get('SELECT COALESCE(SUM(balance),0) AS n FROM demo_balances').n,
    accounts: db.get('SELECT COUNT(*) AS n FROM demo_balances').n,
  };
}

module.exports = { realBank, demoBank, bankFor, demoStats };
