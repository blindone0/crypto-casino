'use strict';
// The banking interface every game talks to.
//
// There used to be three banks here — real credits, play money and tugriks — and a game
// was handed whichever one the request named. There is one now. Tugriks are the only
// money on the site, so there is nothing to choose between and no way for a game to reach
// the wrong ledger.
//
// What that buys, beyond the obvious: a stake can no longer be taken without the player's
// signature, because the only bank there is demands one. Under the old arrangement the
// operator could move a credit balance unilaterally; here the chain refuses.
const U = require('./util');
const ledger = require('./ledger');
const tokenchain = require('./tokenchain');

const now = () => Math.floor(Date.now() / 1000);

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
    // Games stamp this into their own `mode` column so a round that is already open
    // settles through the bank it started in. There is only one now, but the column
    // still tells you what a historic row was played with.
    mode: 'token',

    balance(userId) {
      const key = tokenchain.keyFor(db, userId);
      return key ? tokenchain.balanceOf(db, key.pubkey) : 0;
    },

    checkLimits(user, wager) {
      // A wallet is made at registration, so this cannot happen through the interface.
      // It stays because the server must not assume the interface is the only caller.
      if (!tokenchain.keyFor(db, user.id)) {
        throw new U.BadRequest('this account has no tugrik wallet');
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

    /**
     * Pay the round out and write it down.
     *
     * The record goes in `bets`, which is the same table every other bet has always used
     * and the only one carrying `seed_id` and `client_seed`. That matters more than it
     * looks: those two columns are what a player replays to check the round was not
     * decided after they bet. Tugrik bets used to go into `token_bets`, which has neither,
     * so until now a tugrik round could not be verified at all — and tugriks are the only
     * money there is. Writing one record for one currency fixes that and removes the
     * second history nobody could read.
     */
    settle(bet) {
      const { user, wager, payout, stakeTaken } = bet;
      // The instant games settle in one call and never took the stake separately, so it
      // is taken here. The persistent ones took it when the round opened.
      if (!stakeTaken) this.takeStake(user, wager);
      if (payout > 0) move(user.id, payout, bet.game);
      return ledger.recordBet(db, cfg, bet);
    },

    history(userId, limit = 50) {
      return db.all(
        `SELECT id,game,wager,multiplier,payout,profit,created_at
           FROM bets WHERE user_id=? ORDER BY id DESC LIMIT ?`,
        userId, U.clamp(Number(limit) || 50, 1, 200),
      );
    },
  };
}

/**
 * The bank for a request.
 *
 * There is only one, so this no longer chooses anything — it exists because every game
 * calls it, and because `spend` (the player's signature over their stake) has to be
 * closed over per request rather than threaded through every game as an argument.
 */
function bankFor(db, cfg, spend) {
  return tokenBank(db, cfg, spend);
}

module.exports = { tokenBank, bankFor };
