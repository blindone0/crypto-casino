'use strict';
// A real slot machine: 5 reels, 3 rows, 20 fixed paylines, wilds, scatters and free spins.
//
// Two things make this different from the usual slot implementation.
//
// 1. It is provably fair. The five reel stops come from the same HMAC-SHA256 stream every
//    other game here uses, so a player can recompute the exact screen from the revealed
//    seed. Commercial slots ask you to trust a certified RNG you cannot see; this one you
//    can check yourself.
//
// 2. Its RTP is computed exactly, not sampled. Because each payline takes one symbol from
//    each reel, and a uniform reel stop makes that symbol uniform over the strip, the line
//    return is an exact sum over 11^5 symbol combinations. Scatters need the 3-row window,
//    so their distribution is enumerated per reel and convolved. The paytable is then
//    scaled so the finished machine lands on the configured house edge, and the scaling
//    factor is solved for rather than guessed.
const U = require('../util');
const fair = require('../fair');
const ledger = require('../ledger');
const auth = require('../auth');

const REELS = 5;
const ROWS = 3;

// Paylines as a row index per reel. Standard 20-line layout: straights, Vs and zigzags.
const PAYLINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0],
  [1, 0, 0, 0, 1], [1, 2, 2, 2, 1],
  [0, 1, 1, 1, 0], [2, 1, 1, 1, 2],
  [1, 0, 1, 2, 1], [1, 2, 1, 0, 1],
  [0, 0, 1, 0, 0], [2, 2, 1, 2, 2],
  [1, 1, 0, 1, 1], [1, 1, 2, 1, 1],
  [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
  [0, 2, 0, 2, 0],
];
const LINES = PAYLINES.length;

const WILD = 'WILD';
const SCATTER = 'SCAT';

// Reel strips. Wilds appear only on the middle three reels, which is the usual design:
// it keeps five-of-a-kind wild lines rare and the maths well behaved.
const STRIPS = [
  ['T', 'J', 'CROWN', 'Q', 'K', 'T', 'BELL', 'A', 'J', 'GEM', 'Q', 'T', 'K', 'SCAT', 'J',
    'A', 'BELL', 'Q', 'T', 'K', 'GEM', 'J', 'Q', 'A', 'T', 'BELL', 'K', 'J', 'CROWN', 'Q', 'T', 'A'],
  ['K', 'Q', 'T', 'BELL', 'J', 'A', 'WILD', 'Q', 'K', 'GEM', 'T', 'J', 'SCAT', 'A', 'Q',
    'BELL', 'K', 'T', 'CROWN', 'J', 'Q', 'A', 'GEM', 'T', 'K', 'WILD', 'J', 'Q', 'BELL', 'A', 'T', 'K'],
  ['Q', 'A', 'J', 'GEM', 'T', 'K', 'WILD', 'Q', 'BELL', 'J', 'A', 'SCAT', 'T', 'Q', 'CROWN',
    'K', 'J', 'GEM', 'A', 'T', 'WILD', 'Q', 'K', 'BELL', 'J', 'T', 'A', 'WILD', 'Q', 'GEM', 'K', 'J'],
  ['J', 'K', 'A', 'BELL', 'Q', 'T', 'WILD', 'J', 'GEM', 'K', 'A', 'SCAT', 'Q', 'J', 'BELL',
    'T', 'K', 'CROWN', 'A', 'Q', 'WILD', 'J', 'T', 'GEM', 'K', 'A', 'Q', 'BELL', 'J', 'T', 'WILD', 'K'],
  ['A', 'T', 'K', 'GEM', 'J', 'Q', 'BELL', 'A', 'T', 'CROWN', 'K', 'J', 'SCAT', 'Q', 'A',
    'BELL', 'T', 'K', 'GEM', 'J', 'Q', 'A', 'BELL', 'T', 'CROWN', 'K', 'Q', 'J', 'A', 'GEM', 'T', 'Q'],
];

// Base paytable in multiples of the LINE bet, for 3, 4 and 5 of a kind. These are the
// shape of the machine; computeRtp scales them all by one factor to hit the target edge.
const BASE_PAYS = {
  T: [0.4, 1.5, 6],
  J: [0.4, 1.5, 6],
  Q: [0.5, 2, 8],
  K: [0.5, 2, 8],
  A: [0.6, 2.5, 10],
  BELL: [1, 4, 15],
  GEM: [2, 8, 30],
  CROWN: [3, 12, 60],
  WILD: [5, 25, 150],
};
// Scatter pays multiples of the TOTAL bet and is counted anywhere on screen.
// Scatter pays are deliberately modest. Putting a large share of the RTP into a rare
// event raises variance, and variance is what busts a small bankroll; the line game
// should carry most of the return.
const BASE_SCATTER = { 3: 0.4, 4: 2, 5: 10 };
const FREE_SPINS = { 3: 8, 4: 12, 5: 20 };
const FREE_SPIN_MULTIPLIER = 2;

const SYMBOLS = [...Object.keys(BASE_PAYS), SCATTER];
const PAYING = Object.keys(BASE_PAYS);

// ------------------------------------------------------------------ maths
/** Per-reel symbol probability for one payline position. */
function reelProbabilities() {
  return STRIPS.map((strip) => {
    const p = Object.create(null);
    for (const s of strip) p[s] = (p[s] || 0) + 1 / strip.length;
    return p;
  });
}

/**
 * Best line payout for one row of five symbols, in line-bet units.
 * A run counts from the left; wilds substitute for everything except scatter.
 */
function linePayout(row, pays) {
  let best = 0;
  for (const sym of PAYING) {
    let run = 0;
    for (let i = 0; i < REELS; i += 1) {
      const cell = row[i];
      const matches = sym === WILD ? cell === WILD : (cell === sym || cell === WILD);
      if (!matches) break;
      run += 1;
    }
    if (run >= 3) {
      const pay = pays[sym][run - 3];
      if (pay > best) best = pay;
    }
  }
  return best;
}

/**
 * Exact expected line return per spin, as a multiple of the TOTAL bet.
 * Enumerates every symbol combination (11^5 = 161051), weighted by its probability.
 * Positions on a single payline are independent across reels, which is what makes this
 * a closed-form sum rather than a simulation.
 */
function exactLineRtp(pays) {
  const probs = reelProbabilities();
  const row = new Array(REELS);
  let total = 0;

  const walk = (reel, p) => {
    if (p === 0) return;
    if (reel === REELS) {
      const pay = linePayout(row, pays);
      if (pay > 0) total += p * pay;
      return;
    }
    for (const sym of SYMBOLS) {
      const ps = probs[reel][sym];
      if (!ps) continue;
      row[reel] = sym;
      walk(reel + 1, p * ps);
    }
  };
  walk(0, 1);

  // `total` is the expected payout of ONE line in line-bet units. All 20 lines share the
  // same distribution, so the expected total payout is 20 x total line-bet units, and the
  // total bet is 20 line-bets. The two cancel: expected return per unit staked is `total`.
  return total;
}

/** Distribution of scatter counts in one reel's visible 3-row window. */
function scatterDistPerReel(reelIndex) {
  const strip = STRIPS[reelIndex];
  const L = strip.length;
  const dist = [0, 0, 0, 0];
  for (let stop = 0; stop < L; stop += 1) {
    let n = 0;
    for (let r = 0; r < ROWS; r += 1) if (strip[(stop + r) % L] === SCATTER) n += 1;
    dist[n] += 1 / L;
  }
  return dist;
}

/** Exact distribution of total scatters on screen, by convolving the five reels. */
function scatterDistribution() {
  let dist = [1];
  for (let i = 0; i < REELS; i += 1) {
    const reel = scatterDistPerReel(i);
    const next = new Array(dist.length + reel.length - 1).fill(0);
    for (let a = 0; a < dist.length; a += 1) {
      if (!dist[a]) continue;
      for (let b = 0; b < reel.length; b += 1) {
        if (!reel[b]) continue;
        next[a + b] += dist[a] * reel[b];
      }
    }
    dist = next;
  }
  return dist;
}

/**
 * Exact total RTP for a given scaling factor applied to the paytable.
 * Free spins are modelled exactly because they replay the same machine at the same stake
 * with a fixed multiplier, and retriggers are disabled so the series terminates.
 */
function exactRtp(scale) {
  const pays = scaledPays(scale);
  const lineRtp = exactLineRtp(pays);
  const scatDist = scatterDistribution();

  let scatterPay = 0;
  let freeSpinValue = 0;
  for (let n = 3; n < scatDist.length; n += 1) {
    const p = scatDist[n] || 0;
    if (!p) continue;
    const capped = Math.min(n, 5);
    scatterPay += p * floor2((BASE_SCATTER[capped] || 0) * scale);
    freeSpinValue += p * (FREE_SPINS[capped] || 0) * FREE_SPIN_MULTIPLIER * lineRtp;
  }
  return { total: lineRtp + scatterPay + freeSpinValue, lineRtp, scatterPay, freeSpinValue };
}

const floor2 = (x) => Math.floor(x * 100) / 100;

function scaledPays(scale) {
  const out = Object.create(null);
  for (const [sym, arr] of Object.entries(BASE_PAYS)) {
    // Floor every entry: rounding a payout down always favours the house.
    out[sym] = arr.map((v) => floor2(v * scale));
  }
  return out;
}

/**
 * Solve for the paytable scale that lands as close as possible to the target RTP without
 * exceeding it. Binary search, because flooring each entry to 2dp makes the relationship
 * between scale and RTP a staircase rather than a straight line.
 */
function solveScale(targetRtp, tolerance = 0.002) {
  // Find an upper bound that actually overshoots the target before searching. A fixed
  // ceiling is how you end up silently shipping a 35% machine because the search
  // clamped: the paytable shape decides the scale needed, so discover it.
  let hi = 1;
  let guard = 0;
  while (exactRtp(hi).total <= targetRtp) {
    hi *= 2;
    guard += 1;
    if (guard > 40) throw new Error('slots: no paytable scale reaches the target RTP');
  }

  let lo = hi / 2;
  let best = { scale: lo, rtp: exactRtp(lo).total };
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    const rtp = exactRtp(mid).total;
    if (rtp <= targetRtp) {
      if (rtp > best.rtp) best = { scale: mid, rtp };
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Refuse to build a machine that misses its target. A slot quietly running far under
  // its configured RTP is the worst possible failure here: it looks fine, it pays the
  // house more than intended, and nobody notices until players do.
  if (best.rtp > targetRtp || targetRtp - best.rtp > tolerance) {
    throw new Error(
      `slots: solved RTP ${(best.rtp * 100).toFixed(3)}% misses the target `
      + `${(targetRtp * 100).toFixed(2)}% by more than ${(tolerance * 100).toFixed(2)}%`,
    );
  }
  return best;
}

// Machines are built once per edge value and cached: solving costs a few hundred
// enumerations of 161k combinations, which is fine at boot but not per spin.
const machineCache = new Map();

function machineFor(edge) {
  const key = String(edge);
  if (machineCache.has(key)) return machineCache.get(key);
  const target = 1 - edge;
  const solved = solveScale(target);
  const pays = scaledPays(solved.scale);
  const parts = exactRtp(solved.scale);
  const scatter = {};
  for (const [n, v] of Object.entries(BASE_SCATTER)) scatter[n] = floor2(v * solved.scale);
  const machine = {
    pays,
    scatter,
    freeSpins: FREE_SPINS,
    freeSpinMultiplier: FREE_SPIN_MULTIPLIER,
    rtp: parts.total,
    targetRtp: target,
    actualEdge: 1 - parts.total,
    breakdown: parts,
    scale: solved.scale,
  };
  machineCache.set(key, machine);
  return machine;
}

// ------------------------------------------------------------------ spins
/** Turn five reel stops into the visible 3x5 grid, indexed [reel][row]. */
function screenFrom(stops) {
  return stops.map((stop, i) => {
    const strip = STRIPS[i];
    return Array.from({ length: ROWS }, (_, r) => strip[(stop + r) % strip.length]);
  });
}

/** Evaluate one screen. Returns line wins and scatter count in line-bet units. */
function evaluate(screen, machine) {
  const wins = [];
  for (const [index, line] of PAYLINES.entries()) {
    const row = line.map((r, reel) => screen[reel][r]);
    const pay = linePayout(row, machine.pays);
    if (pay > 0) {
      // Work out how long the winning run was, for the UI highlight.
      let best = { sym: null, run: 0, pay: 0 };
      for (const sym of PAYING) {
        let run = 0;
        for (let i = 0; i < REELS; i += 1) {
          const cell = row[i];
          const ok = sym === WILD ? cell === WILD : (cell === sym || cell === WILD);
          if (!ok) break;
          run += 1;
        }
        if (run >= 3 && machine.pays[sym][run - 3] > best.pay) {
          best = { sym, run, pay: machine.pays[sym][run - 3] };
        }
      }
      wins.push({ line: index, symbol: best.sym, count: best.run, pay: best.pay, rows: line });
    }
  }
  let scatters = 0;
  for (const reel of screen) for (const cell of reel) if (cell === SCATTER) scatters += 1;
  return { wins, scatters };
}

/**
 * One spin from the fair stream. `cursorBase` separates the base spin from each free spin
 * so they draw different stops from the same nonce.
 */
function spinOnce(serverSeed, clientSeed, nonce, machine, spinIndex) {
  // Five floats per spin, offset so free spins never reuse the base spin's stops.
  const all = fair.floats(serverSeed, clientSeed, nonce, REELS * (spinIndex + 1));
  const used = all.slice(REELS * spinIndex, REELS * (spinIndex + 1));
  const stops = used.map((f, i) => Math.floor(f * STRIPS[i].length));
  const screen = screenFrom(stops);
  const { wins, scatters } = evaluate(screen, machine);
  const lineTotal = wins.reduce((s, w) => s + w.pay, 0);
  return { stops, screen, wins, scatters, lineTotal };
}

/** Public description of the machine, for the paytable panel in the UI. */
function info(cfg) {
  const edge = cfg.houseEdge.slots;
  const m = machineFor(edge);
  return {
    reels: REELS,
    rows: ROWS,
    lines: LINES,
    paylines: PAYLINES,
    symbols: SYMBOLS,
    pays: m.pays,
    scatter: m.scatter,
    freeSpins: m.freeSpins,
    freeSpinMultiplier: m.freeSpinMultiplier,
    rtp: m.rtp,
    edge: m.actualEdge,
    strips: STRIPS,
  };
}

// ------------------------------------------------------------------- play
function play({ db, cfg, user }, body) {
  const wager = U.parseAmount(body.amount);
  const edge = cfg.houseEdge.slots;
  const machine = machineFor(edge);

  return db.tx(() => {
    // Stake-side checks only: the win is bounded by capPayout, exactly as mines and
    // crash do, because a slot has no fixed ceiling once free spins are in play.
    ledger.checkBetLimits(db, cfg, user, wager, 1);

    const seed = auth.activeSeed(db, user.id);
    const nonce = auth.claimNonce(db, seed.id);

    const base = spinOnce(seed.seed, user.client_seed, nonce, machine, 0);

    // Line pays are in line-bet units; dividing by the line count turns them into a
    // multiple of the total bet. Scatter already pays on the total bet.
    let totalMultiplier = base.lineTotal / LINES;
    const scatterCount = Math.min(base.scatters, 5);
    if (scatterCount >= 3) totalMultiplier += machine.scatter[scatterCount] || 0;

    // Free spins resolve here, in the same request, so the round is atomic. Retriggers
    // are off, which is what keeps the RTP above exactly computable.
    const freeSpins = [];
    const awarded = scatterCount >= 3 ? (machine.freeSpins[scatterCount] || 0) : 0;
    for (let i = 0; i < awarded; i += 1) {
      const fs = spinOnce(seed.seed, user.client_seed, nonce, machine, i + 1);
      const mult = (fs.lineTotal / LINES) * machine.freeSpinMultiplier;
      totalMultiplier += mult;
      freeSpins.push({
        screen: fs.screen, wins: fs.wins, stops: fs.stops, multiplier: mult,
      });
    }

    const raw = U.mulUnits(wager, totalMultiplier);
    const { payout, capped } = ledger.capPayout(db, cfg, wager, raw);

    const betId = ledger.settleBet(db, cfg, {
      user,
      game: 'slots',
      wager,
      multiplier: wager ? payout / wager : 0,
      payout,
      edgeUnits: Math.floor(wager * edge),
      seedId: seed.id,
      nonce,
      clientSeed: user.client_seed,
      detail: {
        stops: base.stops,
        wins: base.wins,
        scatters: base.scatters,
        freeSpins: awarded,
        capped,
      },
    });

    return {
      betId,
      game: 'slots',
      won: payout > 0,
      screen: base.screen,
      stops: base.stops,
      wins: base.wins,
      scatters: base.scatters,
      freeSpinsAwarded: awarded,
      freeSpins,
      multiplier: totalMultiplier,
      capped,
      wager,
      payout,
      profit: payout - wager,
      nonce,
      serverSeedHash: seed.seed_hash,
      balance: ledger.userAccount(db, user.id).balance,
    };
  });
}

module.exports = {
  play, info, machineFor, exactRtp, exactLineRtp, scatterDistribution,
  screenFrom, evaluate, spinOnce, solveScale,
  REELS, ROWS, LINES, PAYLINES, STRIPS, SYMBOLS, WILD, SCATTER, BASE_PAYS,
};
