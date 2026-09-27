'use strict';
// Puzzle: a picture hidden behind a grid of tiles, with difficulty tiers.
//
// Uncover tiles to reveal the picture piece by piece. Some tiles are broken; find one and
// the round ends. Every safe tile raises the multiplier, and clearing the whole picture
// pays the top of the ladder.
//
// The maths is the same combinatorial pricing mines uses, generalised to any grid size:
// after k safe reveals on a grid of N tiles with M broken,
//     P(all k safe) = C(N-M, k) / C(N, k)
// so the fair multiplier is the inverse, times (1 - edge). That is exact, closed form and
// not exploitable by skill: every unopened tile is equally likely, always.
//
// Difficulty changes the shape of the game rather than the house edge. An easy grid pays
// small and often; expert pays rarely and enormously. The edge is identical across all of
// them, which is the honest way to offer difficulty: you choose your variance, not your
// odds.
const U = require('../util');
const fair = require('../fair');
const auth = require('../auth');

const now = () => Math.floor(Date.now() / 1000);

/**
 * Difficulty tiers. `broken` is tuned so each tier has a recognisably different feel:
 * easy is a gentle climb, expert is a genuine gamble on the very first tap.
 */
// Grids are kept deliberately small. On a big grid the full-clear multiplier runs into
// the millions, and advertising a prize the bankroll cap can never pay is a lie told in
// numbers. These four top out at roughly 36x, 218x, 1351x and 7927x: rare, exciting, and
// actually payable.
const TIERS = {
  easy: { cols: 3, rows: 3, broken: 2, label: 'Easy' },
  medium: { cols: 4, rows: 3, broken: 3, label: 'Medium' },
  hard: { cols: 5, rows: 3, broken: 4, label: 'Hard' },
  expert: { cols: 4, rows: 4, broken: 6, label: 'Expert' },
};

/** Original artwork revealed underneath, drawn in the client. Keys only here. */
const PICTURES = ['deco', 'peacock', 'skyline', 'mandala'];

function tierOf(name) {
  const t = TIERS[name];
  if (!t) throw new U.BadRequest(`unknown difficulty; pick one of ${Object.keys(TIERS).join(', ')}`);
  return { ...t, tiles: t.cols * t.rows, safe: t.cols * t.rows - t.broken };
}

/** n choose k, exact for the sizes a 6x6 grid needs. */
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Fair multiplier after k safe reveals, floored to 2dp so rounding favours the house. */
function multiplierFor(tier, picks, edge) {
  if (picks <= 0) return 0;
  const p = choose(tier.safe, picks) / choose(tier.tiles, picks);
  if (p <= 0) return 0;
  return Math.floor(((1 - edge) / p) * 100) / 100;
}

/** The whole payout ladder for a tier, index 0 being one safe tile. */
function ladder(tierName, edge) {
  const tier = tierOf(tierName);
  const out = [];
  for (let k = 1; k <= tier.safe; k += 1) out.push(multiplierFor(tier, k, edge));
  return out;
}

/**
 * Which tiles are broken, derived from the fair stream by a Fisher-Yates shuffle, so a
 * player can replay the layout from the revealed seed and confirm nothing moved.
 */
function brokenTiles(serverSeed, clientSeed, nonce, tier) {
  const tiles = Array.from({ length: tier.tiles }, (_, i) => i);
  const fs = fair.floats(serverSeed, clientSeed, nonce, tier.tiles - 1);
  for (let i = 0; i < tier.tiles - 1; i += 1) {
    const j = i + Math.floor(fs[i] * (tier.tiles - i));
    const t = tiles[i];
    tiles[i] = tiles[j];
    tiles[j] = t;
  }
  return tiles.slice(0, tier.broken).sort((a, b) => a - b);
}

/** Which picture this round shows, also from the seed so it is not cherry-picked. */
function pictureFor(serverSeed, clientSeed, nonce) {
  const [f] = fair.floats(serverSeed, `${clientSeed}:picture`, nonce, 1);
  return PICTURES[Math.floor(f * PICTURES.length)];
}

const activeGame = (db, userId) => db.get(
  "SELECT * FROM puzzle_games WHERE user_id=? AND state='active'", userId,
);

/** Client-safe view: the broken tiles stay hidden until the round is over. */
function view(db, cfg, g, extra = {}) {
  const picks = JSON.parse(g.picks);
  const tier = tierOf(g.difficulty);
  const edge = cfg.houseEdge.puzzle;
  const current = multiplierFor(tier, picks.length, edge);
  const next = picks.length + 1 <= tier.safe ? multiplierFor(tier, picks.length + 1, edge) : null;
  return {
    gameId: g.id,
    state: g.state,
    wager: g.wager,
    difficulty: g.difficulty,
    picture: g.picture,
    cols: tier.cols,
    rows: tier.rows,
    tiles: tier.tiles,
    broken: tier.broken,
    picks,
    revealedShare: picks.length / tier.safe,
    remaining: tier.safe - picks.length,
    multiplier: current,
    nextMultiplier: next,
    cashoutValue: picks.length ? U.mulUnits(g.wager, current) : 0,
    ladder: ladder(g.difficulty, edge),
    nonce: g.nonce,
    ...extra,
  };
}

function start({ db, cfg, user, bank }, body) {
  const wager = U.parseAmount(body.amount);
  const difficulty = String(body.difficulty || 'medium');
  const tier = tierOf(difficulty);

  return db.tx(() => {
    if (activeGame(db, user.id)) throw new U.BadRequest('finish your current puzzle first');
    // Stake-side checks only; the win is bounded by capPayout when the round is cashed.
    bank.checkLimits(user, wager, 1);

    const seed = auth.activeSeed(db, user.id);
    const nonce = auth.claimNonce(db, seed.id);
    const broken = brokenTiles(seed.seed, user.client_seed, nonce, tier);
    const picture = pictureFor(seed.seed, user.client_seed, nonce);

    bank.takeStake(user, wager, `puzzle#${nonce}`);
    db.run(
      `INSERT INTO puzzle_games(user_id,wager,difficulty,picture,broken,picks,seed_id,nonce,
                                client_seed,state,mode,created_at)
       VALUES(?,?,?,?,?,'[]',?,?,?,'active',?,?)`,
      user.id, wager, difficulty, picture, JSON.stringify(broken),
      seed.id, nonce, user.client_seed, bank.mode, now(),
    );
    const g = activeGame(db, user.id);
    return {
      ...view(db, cfg, g),
      serverSeedHash: seed.seed_hash,
      maxPayout: bank.capPayout(wager, Infinity).ceiling,
      balance: bank.balance(user.id),
    };
  });
}

function reveal({ db, cfg, user, bankFor }, body) {
  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no puzzle in progress');
    const tier = tierOf(g.difficulty);
    const tile = U.toInt(body.tile, { min: 0, max: tier.tiles - 1, name: 'tile' });

    const picks = JSON.parse(g.picks);
    if (picks.includes(tile)) throw new U.BadRequest('that piece is already uncovered');

    const broken = JSON.parse(g.broken);
    const edge = cfg.houseEdge.puzzle;
    const bank = bankFor(g.mode);

    if (broken.includes(tile)) {
      db.run("UPDATE puzzle_games SET state='lost', ended_at=? WHERE id=?", now(), g.id);
      bank.settle({
        user,
        game: 'puzzle',
        wager: g.wager,
        multiplier: 0,
        payout: 0,
        edgeUnits: Math.floor(g.wager * edge),
        seedId: g.seed_id,
        nonce: g.nonce,
        clientSeed: g.client_seed,
        detail: { difficulty: g.difficulty, picks, hit: tile, broken },
        stakeTaken: true,
      });
      return {
        ...view(db, cfg, { ...g, state: 'lost' }),
        safe: false,
        hit: tile,
        broken,
        payout: 0,
        balance: bank.balance(user.id),
      };
    }

    picks.push(tile);
    db.run('UPDATE puzzle_games SET picks=? WHERE id=?', JSON.stringify(picks), g.id);
    const updated = { ...g, picks: JSON.stringify(picks) };

    // The picture is complete: pay the top of the ladder automatically.
    if (picks.length === tier.safe) {
      return { ...finish({ db, cfg, user, bankFor }, updated), safe: true, completed: true };
    }
    return { ...view(db, cfg, updated), safe: true };
  });
}

function cashout({ db, cfg, user, bankFor }) {
  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no puzzle in progress');
    if (JSON.parse(g.picks).length === 0) throw new U.BadRequest('uncover at least one piece first');
    return finish({ db, cfg, user, bankFor }, g);
  });
}

/** Pay out a puzzle. Caller must already hold a transaction. */
function finish({ db, cfg, user, bankFor }, g) {
  const bank = bankFor(g.mode);
  const tier = tierOf(g.difficulty);
  const picks = JSON.parse(g.picks);
  const broken = JSON.parse(g.broken);
  const edge = cfg.houseEdge.puzzle;
  const multiplier = multiplierFor(tier, picks.length, edge);
  const raw = U.mulUnits(g.wager, multiplier);
  const { payout, capped } = bank.capPayout(g.wager, raw);

  db.run("UPDATE puzzle_games SET state='cashed', payout=?, ended_at=? WHERE id=?",
    payout, now(), g.id);
  bank.settle({
    user,
    game: 'puzzle',
    wager: g.wager,
    multiplier: g.wager ? payout / g.wager : 0,
    payout,
    edgeUnits: Math.floor(g.wager * edge),
    seedId: g.seed_id,
    nonce: g.nonce,
    clientSeed: g.client_seed,
    detail: { difficulty: g.difficulty, picks, broken, multiplier, capped },
    stakeTaken: true,
  });

  return {
    ...view(db, cfg, { ...g, state: 'cashed' }),
    state: 'cashed',
    broken,
    multiplier,
    payout,
    capped,
    profit: payout - g.wager,
    balance: bank.balance(user.id),
  };
}

function current({ db, cfg, user }) {
  const g = activeGame(db, user.id);
  if (!g) return { state: 'none', tiers: info(cfg).tiers };
  return view(db, cfg, g);
}

/** Tier table for the rules panel: grid, broken pieces, and the full ladder. */
function info(cfg) {
  const edge = cfg.houseEdge.puzzle;
  return {
    edge,
    pictures: PICTURES,
    tiers: Object.entries(TIERS).map(([key, t]) => {
      const tier = tierOf(key);
      const rungs = ladder(key, edge);
      return {
        key,
        label: t.label,
        cols: t.cols,
        rows: t.rows,
        tiles: tier.tiles,
        broken: tier.broken,
        firstPick: rungs[0],
        complete: rungs[rungs.length - 1],
        // Chance of uncovering the whole picture, which is what expert players chase.
        completeChance: choose(tier.safe, tier.safe) / choose(tier.tiles, tier.safe),
        ladder: rungs,
      };
    }),
  };
}

module.exports = {
  TIERS, PICTURES, tierOf, choose, multiplierFor, ladder, brokenTiles, pictureFor,
  start, reveal, cashout, current, info,
};
