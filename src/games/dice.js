'use strict';
// Dice: 10000 equally likely outcomes shown as 0.00 - 99.99. Pick a threshold and a
// direction; the payout multiplier is (1 - edge) / winChance.
const U = require('../util');
const fair = require('../fair');
const ledger = require('../ledger');
const auth = require('../auth');

const MIN_WIN_COUNT = 100;  // 1.00% win chance  -> about 99x max payout
const MAX_WIN_COUNT = 9500; // 95.00% win chance -> about 1.04x min payout

function quote(cfg, target, mode) {
  const winCount = fair.diceWinCount(target, mode);
  if (winCount < MIN_WIN_COUNT || winCount > MAX_WIN_COUNT) {
    throw new U.BadRequest('target out of range (win chance must be between 1% and 95%)');
  }
  const chance = winCount / fair.DICE_OUTCOMES;
  return { chance, multiplier: fair.payoutMultiplier(chance, cfg.houseEdge.dice) };
}

function play({ db, cfg, user, bank }, body) {
  const wager = U.parseAmount(body.amount);
  const mode = body.mode === 'over' ? 'over' : 'under';
  const target = U.toInt(body.target, { min: 0, max: 9999, name: 'target' });
  const { chance, multiplier } = quote(cfg, target, mode);
  const edge = cfg.houseEdge.dice;

  return db.tx(() => {
    bank.checkLimits(user, wager, multiplier);
    const seed = auth.activeSeed(db, user.id);
    const nonce = auth.claimNonce(db, seed.id);

    const roll = fair.diceRoll(seed.seed, user.client_seed, nonce);
    const won = fair.diceWins(roll, target, mode);
    const raw = won ? U.mulUnits(wager, multiplier) : 0;
    // The house can only pay what it holds, and this is where that gets enforced.
    //
    // Dice and limbo were the only two games that skipped this — crash, mines and
    // slots have always capped. The consequence was not a quiet overpayment but a hard
    // failure: the chain refused a transfer the house could not cover, so the whole bet
    // came back as "insufficient token balance" on an account holding 995 tugriks. A win
    // the house cannot afford in full should pay what it can, not refuse the round.
    const { payout, capped } = bank.capPayout(wager, raw);

    const betId = bank.settle({
      user,
      game: 'dice',
      wager,
      multiplier: won ? multiplier : 0,
      payout,
      edgeUnits: Math.floor(wager * edge),
      seedId: seed.id,
      nonce,
      clientSeed: user.client_seed,
      detail: { target, mode, roll, chance, targetMultiplier: multiplier, capped },
    });

    return {
      betId,
      game: 'dice',
      won,
      roll,
      rollDisplay: (roll / 100).toFixed(2),
      target,
      mode,
      chance,
      multiplier,
      wager,
      payout,
      profit: payout - wager,
      nonce,
      serverSeedHash: seed.seed_hash,
      balance: bank.balance(user.id),
    };
  });
}

module.exports = { play, quote, MIN_WIN_COUNT, MAX_WIN_COUNT };
