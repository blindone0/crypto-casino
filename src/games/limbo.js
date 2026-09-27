'use strict';
// Limbo: a Pareto-distributed multiplier is drawn. Pick a target; you win it if the
// drawn multiplier lands at or above your target. P(win) = (1 - edge) / target.
const U = require('../util');
const fair = require('../fair');
const ledger = require('../ledger');
const auth = require('../auth');

const MIN_TARGET = 1.01;

/** Parse the target multiplier, snapped down to 2dp the same way the engine floors. */
function parseTarget(cfg, raw) {
  const t = Number(raw);
  if (!Number.isFinite(t)) throw new U.BadRequest('target must be a number');
  const target = Math.floor(t * 100) / 100;
  if (target < MIN_TARGET) throw new U.BadRequest(`target must be at least ${MIN_TARGET}`);
  if (target > cfg.risk.maxMultiplier) {
    throw new U.BadRequest(`target must be at most ${cfg.risk.maxMultiplier}`);
  }
  return target;
}

function play({ db, cfg, user, bank }, body) {
  const wager = U.parseAmount(body.amount);
  const target = parseTarget(cfg, body.target);
  const edge = cfg.houseEdge.limbo;
  const chance = (1 - edge) / target;

  return db.tx(() => {
    bank.checkLimits(user, wager, target);
    const seed = auth.activeSeed(db, user.id);
    const nonce = auth.claimNonce(db, seed.id);

    const drawn = fair.limboMultiplier(seed.seed, user.client_seed, nonce, edge);
    const won = drawn >= target;
    const payout = won ? U.mulUnits(wager, target) : 0;

    const betId = bank.settle({
      user,
      game: 'limbo',
      wager,
      multiplier: won ? target : 0,
      payout,
      edgeUnits: Math.floor(wager * edge),
      seedId: seed.id,
      nonce,
      clientSeed: user.client_seed,
      detail: { target, drawn, chance },
    });

    return {
      betId,
      game: 'limbo',
      won,
      drawn,
      target,
      chance,
      multiplier: target,
      wager,
      payout,
      profit: payout - wager,
      nonce,
      serverSeedHash: seed.seed_hash,
      balance: bank.balance(user.id),
    };
  });
}

module.exports = { play, parseTarget, MIN_TARGET };
