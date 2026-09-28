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
const tokenchain = require('./tokenchain');

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


// ------------------------------------------------------------- site tokens
/**
 * The tugrik bank: the same games, staked in the site token instead of the casino
 * currency.
 *
 * Every movement is a block on the token chain, so a player betting tugriks can audit
 * their own losses the same way they audit a transfer. The house is an ordinary account
 * on that chain, which means the edge accumulates somewhere anybody can look at.
 *
 * Two things are deliberately different from real money.
 *
 * The bankroll cap does not apply, because there is no bankroll: a payout comes out of
 * the house's token balance and there is nothing else it could threaten. What applies
 * instead is a hard ceiling on what the house actually holds. The supply is fixed, so the
 * house cannot pay a win it does not have the tokens for, and pretending otherwise would
 * produce a promise the chain would refuse to honour.
 *
 * Amounts are in the same hundred-millionths as everywhere else in this codebase, because
 * a tugrik is divisible to eight places. It has to be: a one-tugrik bet at 1.98x pays 1.98
 * tugriks, and a currency that could only hold whole numbers would have to round that,
 * which is a second house edge nobody agreed to.
 */
function tokenBank(db, cfg, spend) {
  const house = () => {
    // Required lazily: match.js requires bank.js indirectly through the games.
    const { houseKey } = require('./match');
    return houseKey(db).publicRaw;
  };

  const keyOf = (userId) => {
    const key = tokenchain.keyFor(db, userId);
    if (!key) throw new U.BadRequest('create a token wallet before staking tugriks');
    return key.pubkey;
  };

  /** One block, signed by the house, moving tokens either way. */
  function move(userId, delta, memo) {
    const mine = keyOf(userId);
    const theirs = house();
    if (delta === 0) return tokenchain.balanceOf(db, mine);
    const { houseTransfer } = require('./match');
    if (delta < 0) {
      // The player is paying. Their stake was authorised when they signed it into escrow;
      // see takeStake, which is where that signature is checked.
      throw new Error('tokenBank.move cannot debit a player without their signature');
    }
    tokenchain.appendBlock(db, [houseTransfer(db, mine, delta)]);
    db.audit(`user:${userId}`, 'token.bet.paid', { amount: delta, memo });
    return tokenchain.balanceOf(db, mine);
  }

  return {
    isDemo: false,
    mode: 'token',

    balance(userId) {
      const key = tokenchain.keyFor(db, userId);
      return key ? tokenchain.balanceOf(db, key.pubkey) : 0;
    },

    checkLimits(user, wager) {
      // Said plainly and first. Without this the answer to "why was my bet refused" is
      // "not enough tugriks", which is true and useless when the real answer is that
      // there is no wallet to have tugriks in.
      if (!tokenchain.keyFor(db, user.id)) {
        throw new U.BadRequest('create a token wallet before staking tugriks');
      }
      const limits = cfg.token.bet;
      if (!Number.isSafeInteger(wager) || wager < limits.min) {
        throw new U.BadRequest(
          `minimum stake is ${U.formatAmount(limits.min)} ${cfg.token.symbol}`,
        );
      }
      if (wager > limits.max) throw new U.BadRequest('stake above the table maximum');
      if (user.frozen) throw new U.Forbidden('account frozen');
      // Self-exclusion covers this too. Someone who asked to be kept away from the games
      // asked to be kept away from all of them, in every currency.
      if (user.self_excluded_until > now()) throw new U.Forbidden('self-exclusion active');
      if (this.balance(user.id) < wager) throw new U.BadRequest('not enough tugriks');
      return wager;
    },

    /**
     * The house can only pay what it holds. This is the token equivalent of the bankroll
     * cap, and it is not a policy: the supply is fixed, so a larger promise is one the
     * chain would refuse.
     */
    capPayout(wager, rawPayout) {
      const ceiling = tokenchain.balanceOf(db, house()) + wager;
      if (rawPayout <= ceiling) return { payout: rawPayout, capped: false, ceiling };
      return { payout: ceiling, capped: true, ceiling };
    },

    maxProfit: () => tokenchain.balanceOf(db, house()),

    /**
     * Take the stake.
     *
     * The player signed a transfer to the house before the bet was sent, exactly as they
     * do to enter a match. Without that signature the operator could empty an account by
     * inventing bets, so an unsigned bet is refused rather than taken on trust. The
     * signature travels on the request and is closed over when the bank is built, so no
     * game had to learn about it.
     *
     * Calling this twice cannot double-charge: the second attempt reuses a nonce the
     * chain has already spent, and the chain refuses it.
     */
    takeStake(user, wager) {
      const { escrow } = require('./match');
      if (!spend) throw new U.BadRequest('a tugrik stake must be signed');
      if (String(spend.from || '').toLowerCase() !== keyOf(user.id)) {
        throw new U.Forbidden('that key is not registered to this account');
      }
      escrow(db, spend, wager);
      return null;
    },

    settle(bet) {
      const { user, game, wager, multiplier, payout, detail, nonce, stakeTaken } = bet;
      // The instant games settle in one call and never took the stake separately, so it
      // is taken here. The persistent ones took it when the round opened.
      if (!stakeTaken) this.takeStake(user, wager);
      if (payout > 0) move(user.id, payout, game);
      db.run(
        `INSERT INTO token_bets(user_id,game,wager,multiplier,payout,profit,nonce,detail,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        user.id, game, wager, multiplier, payout, payout - wager, nonce,
        JSON.stringify(detail ?? null), now(),
      );
      return db.get('SELECT last_insert_rowid() AS id').id;
    },

    history(userId, limit = 50) {
      return db.all(
        `SELECT id,game,wager,multiplier,payout,profit,created_at
           FROM token_bets WHERE user_id=? ORDER BY id DESC LIMIT ?`,
        userId, U.clamp(Number(limit) || 50, 1, 200),
      );
    },
  };
}

/**
 * Pick the bank for a request. Anything unrecognised means real money.
 * `spend` is the player's signature over their stake, and only the token bank wants it.
 */
function bankFor(db, cfg, mode, spend) {
  if (mode === 'demo') return demoBank(db, cfg);
  if (mode === 'token') return tokenBank(db, cfg, spend);
  return realBank(db, cfg);
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

module.exports = { realBank, demoBank, tokenBank, bankFor, demoStats };
