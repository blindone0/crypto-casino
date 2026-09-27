'use strict';
// Provably-fair engine (commit/reveal, HMAC-SHA256 chain).
//
// How trust works here:
//   1. Server generates a 32-byte serverSeed and publishes sha256(serverSeed) BEFORE any bet.
//   2. Player supplies a clientSeed they control, plus an incrementing nonce per bet.
//   3. Outcome bytes = HMAC-SHA256(key = serverSeed, msg = clientSeed:nonce:cursor).
//   4. When the seed is rotated the old serverSeed is revealed, so every past bet can be
//      recomputed and checked against the published hash.
// The server cannot change an outcome after the fact without breaking the published hash,
// and it cannot predict outcomes without knowing the clientSeed the player chose.
const crypto = require('node:crypto');

/** Raw 32 bytes for one (seed, client, nonce, cursor) point on the chain. */
function hmacBytes(serverSeed, clientSeed, nonce, cursor = 0) {
  return crypto
    .createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}:${cursor}`)
    .digest();
}

/**
 * Convert 4 bytes to a uniform float in [0, 1) the way the industry standard does:
 * byte0/256 + byte1/256^2 + byte2/256^3 + byte3/256^4.
 */
function bytesToFloat(b, off) {
  return (
    b[off] / 256 +
    b[off + 1] / 256 ** 2 +
    b[off + 2] / 256 ** 3 +
    b[off + 3] / 256 ** 4
  );
}

/** N uniform floats in [0, 1), 8 per HMAC round, cursor advancing as needed. */
function floats(serverSeed, clientSeed, nonce, count) {
  const out = [];
  let cursor = 0;
  while (out.length < count) {
    const bytes = hmacBytes(serverSeed, clientSeed, nonce, cursor);
    for (let i = 0; i + 4 <= bytes.length && out.length < count; i += 4) {
      out.push(bytesToFloat(bytes, i));
    }
    cursor += 1;
  }
  return out;
}

// ------------------------------------------------------------------ dice
// 10000 equally likely outcomes: integer 0..9999, displayed as roll/100 (0.00 .. 99.99).
const DICE_OUTCOMES = 10000;

function diceRoll(serverSeed, clientSeed, nonce) {
  const [f] = floats(serverSeed, clientSeed, nonce, 1);
  return Math.floor(f * DICE_OUTCOMES); // 0 .. 9999
}

/**
 * Winning-outcome count for a dice bet.
 * target is in hundredths (5000 == 50.00). mode is 'under' or 'over'.
 *   under: win when roll <  target   -> `target` winning outcomes
 *   over:  win when roll >  target   -> 9999 - target winning outcomes
 */
function diceWinCount(target, mode) {
  return mode === 'over' ? DICE_OUTCOMES - 1 - target : target;
}

function diceWins(roll, target, mode) {
  return mode === 'over' ? roll > target : roll < target;
}

// ----------------------------------------------------------------- limbo
/**
 * Pareto draw: P(raw >= x) = 1/x. Multiplying by (1 - edge) puts the house edge in.
 * Result is floored to 2dp, with 1.00 meaning "instant bust".
 */
function limboMultiplier(serverSeed, clientSeed, nonce, edge) {
  const [f] = floats(serverSeed, clientSeed, nonce, 1);
  const raw = 1 / (1 - f);
  const m = Math.floor(raw * (1 - edge) * 100) / 100;
  return Math.max(1, m);
}

// ----------------------------------------------------------------- crash
/** Same distribution as limbo but drawn once per shared round. */
function crashPoint(serverSeed, roundNonce, edge, publicSalt = 'crash') {
  const [f] = floats(serverSeed, publicSalt, roundNonce, 1);
  const raw = 1 / (1 - f);
  const m = Math.floor(raw * (1 - edge) * 100) / 100;
  return Math.max(1, m);
}

// ----------------------------------------------------------------- mines
const MINES_TILES = 25;

/**
 * Fisher-Yates shuffle of tiles 0..24 driven by the fair float stream; the first
 * `mineCount` entries of the shuffled array are the mine positions. Deterministic,
 * so a player can replay it from the revealed seed.
 */
function minePositions(serverSeed, clientSeed, nonce, mineCount) {
  const tiles = Array.from({ length: MINES_TILES }, (_, i) => i);
  const fs = floats(serverSeed, clientSeed, nonce, MINES_TILES - 1);
  for (let i = 0; i < MINES_TILES - 1; i += 1) {
    const j = i + Math.floor(fs[i] * (MINES_TILES - i));
    const t = tiles[i];
    tiles[i] = tiles[j];
    tiles[j] = t;
  }
  return tiles.slice(0, mineCount).sort((a, b) => a - b);
}

/** n choose k, exact for the small values mines needs. */
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/**
 * Fair multiplier after revealing `picks` safe tiles with `mineCount` mines hidden.
 * P(all picks safe) = C(25-M, k) / C(25, k), so the fair payout is the inverse.
 */
function minesMultiplier(mineCount, picks, edge) {
  if (picks <= 0) return 1;
  const p = choose(MINES_TILES - mineCount, picks) / choose(MINES_TILES, picks);
  if (p <= 0) return 0;
  return floor2((1 - edge) / p);
}

// ------------------------------------------------------------------ util
/** Truncate to 2dp, always downward, so rounding never leaks money to the player. */
const floor2 = (x) => Math.floor(x * 100) / 100;

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newServerSeed = () => crypto.randomBytes(32).toString('hex');

/**
 * Recompute any bet from its stored parameters. This is what the /api/fair/verify
 * endpoint and the offline verifier page both use, so there is exactly one source of truth.
 */
function replay({ game, serverSeed, clientSeed, nonce, edge, target, mode, mineCount, picks }) {
  switch (game) {
    case 'dice': {
      const roll = diceRoll(serverSeed, clientSeed, nonce);
      const won = diceWins(roll, target, mode);
      const count = diceWinCount(target, mode);
      return {
        roll,
        rollDisplay: (roll / 100).toFixed(2),
        won,
        winChance: count / DICE_OUTCOMES,
        multiplier: payoutMultiplier(count / DICE_OUTCOMES, edge),
      };
    }
    case 'limbo': {
      const m = limboMultiplier(serverSeed, clientSeed, nonce, edge);
      return { multiplier: m, won: target != null ? m >= target : null };
    }
    case 'crash': {
      const m = crashPoint(serverSeed, nonce, edge, clientSeed || 'crash');
      return { crashPoint: m };
    }
    case 'mines': {
      const mines = minePositions(serverSeed, clientSeed, nonce, mineCount);
      return {
        mines,
        multiplier: minesMultiplier(mineCount, picks || 0, edge),
      };
    }
    default:
      throw new Error(`unknown game: ${game}`);
  }
}

/** Fair odds with the house edge applied, floored to 2dp. */
function payoutMultiplier(winChance, edge) {
  if (!(winChance > 0 && winChance < 1)) throw new Error('winChance must be in (0,1)');
  return floor2((1 - edge) / winChance);
}

module.exports = {
  DICE_OUTCOMES, MINES_TILES,
  hmacBytes, bytesToFloat, floats,
  diceRoll, diceWinCount, diceWins,
  limboMultiplier, crashPoint,
  minePositions, minesMultiplier, choose,
  payoutMultiplier, floor2, sha256hex, newServerSeed,
  replay,
};
