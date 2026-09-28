'use strict';
// Кости: two six-sided dice, call the total before the throw.
//
// WHY THIS IS A SEPARATE GAME FROM `dice.js`
//
// `dice.js` is the threshold game every crypto casino has: one number from 0 to 99.99, a
// slider, over or under. It is a fine game and it stays. But it is not *dice* — you asked
// for the classic: guess a number in a range and throw real dice at it. Those are
// different games with different shapes, and bolting one onto the other would have given
// a pair of cubes showing "73.41", which is a picture that lies about what is happening.
//
// WHERE THE RANDOMNESS ACTUALLY COMES FROM
//
// The seed. Not the physics.
//
// This matters more than it sounds and it is the whole design. The browser will tumble
// two dice with a physics simulation, and it would be natural to let where they land
// decide the result. That would be unverifiable — physics is floating point, it differs
// between machines, and nobody can check it afterwards. So the arithmetic here draws the
// faces from `serverSeed + clientSeed + nonce`, exactly like every other game on the
// site, and the animation is told what it must land on. The tumble is honest decoration:
// it shows you a result that was already decided and can be checked later.
//
// A player can verify a throw with the same tool they verify a spin with. If the
// animation is ever wrong, the number is still right.
//
// THE ODDS
//
// Two dice give 36 equally likely ordered outcomes, and the sums are not uniform — 7
// happens six ways, 2 and 12 happen one way each. The pay table is that arithmetic with
// the house edge applied once, so nothing here is a judgement call:
//
//     sum   ways   chance    pays (1% edge)
//      2      1     2.78%      35.64x
//      7      6    16.67%       5.94x
//     12      1     2.78%      35.64x
//
// A range bet — "5 to 9" — is just the ways in that range added up. Same edge either way,
// which is the property that makes offering the choice safe.

const U = require('../util');
const fair = require('../fair');
const auth = require('../auth');

/** Two dice. Six faces each. Everything below is derived from these two numbers. */
const DICE = 2;
const FACES = 6;

const MIN_SUM = DICE;            // 2
const MAX_SUM = DICE * FACES;    // 12

/**
 * How many of the 36 ordered outcomes give each sum.
 *
 * Counted rather than typed. A hand-written table is a transcription error waiting to
 * become a payout error, and this is the number the entire pay table is built on.
 */
const WAYS = (() => {
  const w = new Map();
  for (let a = 1; a <= FACES; a += 1) {
    for (let b = 1; b <= FACES; b += 1) {
      w.set(a + b, (w.get(a + b) || 0) + 1);
    }
  }
  return w;
})();

const TOTAL_WAYS = FACES ** DICE;   // 36

/**
 * A bet is a contiguous range of sums, `[low, high]`.
 *
 * One number is the range `[n, n]`, which keeps a single shape for both and means the
 * odds arithmetic never has a special case. A range is the natural generalisation and it
 * is what makes the game interesting past the first ten throws: "7 or 8" is a real
 * decision against "7".
 */
function parseCall(body) {
  const low = U.toInt(body.low, { min: MIN_SUM, max: MAX_SUM, name: 'low' });
  const high = body.high === undefined || body.high === null || body.high === ''
    ? low
    : U.toInt(body.high, { min: MIN_SUM, max: MAX_SUM, name: 'high' });
  if (high < low) throw new U.BadRequest('the high end of a call cannot be below the low end');
  // The whole board is not a bet, it is a refund with extra steps — and at a house edge
  // it is a guaranteed loss dressed up as a certainty. Refuse it rather than sell it.
  if (low === MIN_SUM && high === MAX_SUM) {
    throw new U.BadRequest('that call covers every possible throw, so there is nothing to win');
  }
  return { low, high };
}

/** How many of the 36 outcomes win this call. */
function waysFor(low, high) {
  let n = 0;
  for (let sum = low; sum <= high; sum += 1) n += WAYS.get(sum) || 0;
  return n;
}

/**
 * What a call pays, before the house's own ceiling is applied.
 *
 * The edge is taken once, here, at the top. Anywhere else and it would compound.
 */
function quote(cfg, low, high) {
  const ways = waysFor(low, high);
  if (!ways) throw new U.BadRequest('no throw can land in that call');
  const chance = ways / TOTAL_WAYS;
  return {
    ways,
    chance,
    multiplier: fair.payoutMultiplier(chance, cfg.houseEdge.bones),
  };
}

/**
 * The whole board, so a player can see every price before choosing one.
 *
 * Shown up front rather than after a click: the point of a pay table is that the offer is
 * legible before you take it.
 */
function payTable(cfg) {
  const rows = [];
  for (let sum = MIN_SUM; sum <= MAX_SUM; sum += 1) {
    const { ways, chance, multiplier } = quote(cfg, sum, sum);
    rows.push({ sum, ways, chance, multiplier });
  }
  return rows;
}

/**
 * The two faces, drawn from the round's own seed.
 *
 * Two floats, one per die, from the same stream every other game uses — so a throw
 * replays exactly from `serverSeed`, `clientSeed` and `nonce`, and the verifier already
 * on the site can check it without being taught anything new.
 */
function rollFaces(serverSeed, clientSeed, nonce) {
  const fs = fair.floats(serverSeed, `${clientSeed}:bones`, nonce, DICE);
  return fs.map((f) => 1 + Math.floor(f * FACES));
}

function play({ db, cfg, user, bank }, body) {
  const wager = U.parseAmount(body.amount);
  const { low, high } = parseCall(body);
  const { ways, chance, multiplier } = quote(cfg, low, high);
  const edge = cfg.houseEdge.bones;

  return db.tx(() => {
    bank.checkLimits(user, wager, multiplier);
    const seed = auth.activeSeed(db, user.id);
    const nonce = auth.claimNonce(db, seed.id);

    const faces = rollFaces(seed.seed, user.client_seed, nonce);
    const sum = faces.reduce((a, b) => a + b, 0);
    const won = sum >= low && sum <= high;

    const raw = won ? U.mulUnits(wager, multiplier) : 0;
    // The house can only pay what it holds. Every game here caps, and the two that did
    // not once refused whole rounds rather than paying what they could.
    const { payout, capped } = bank.capPayout(wager, raw);

    const betId = bank.settle({
      user,
      game: 'bones',
      wager,
      multiplier: won ? multiplier : 0,
      payout,
      edgeUnits: Math.floor(wager * edge),
      seedId: seed.id,
      nonce,
      clientSeed: user.client_seed,
      detail: { low, high, faces, sum, ways, chance, callMultiplier: multiplier, capped },
    });

    return {
      betId,
      game: 'bones',
      won,
      faces,
      sum,
      low,
      high,
      ways,
      chance,
      multiplier,
      wager,
      payout,
      profit: payout - wager,
      capped,
      nonce,
      serverSeedHash: seed.seed_hash,
      balance: bank.balance(user.id),
    };
  });
}

module.exports = {
  DICE, FACES, MIN_SUM, MAX_SUM, TOTAL_WAYS, WAYS,
  parseCall, waysFor, quote, payTable, rollFaces, play,
};
