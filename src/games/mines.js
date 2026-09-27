'use strict';
// Mines: a 5x5 grid hides N mines. Reveal safe tiles to grow the multiplier, cash out
// before you hit one. Fair multiplier after k safe picks is C(25-N,k)/C(25,k) inverted,
// times (1 - edge). The layout is fixed by the seed the moment the round opens, so the
// server cannot move a mine under your next click.
const U = require('../util');
const fair = require('../fair');
const ledger = require('../ledger');
const auth = require('../auth');

const TILES = fair.MINES_TILES;
const now = () => Math.floor(Date.now() / 1000);

/** Payout ladder shown in the UI: index 0 is one safe pick. */
function multiplierTable(cfg, mineCount) {
  const edge = cfg.houseEdge.mines;
  const out = [];
  for (let k = 1; k <= TILES - mineCount; k += 1) out.push(fair.minesMultiplier(mineCount, k, edge));
  return out;
}

function activeGame(db, userId) {
  return db.get("SELECT * FROM mines_games WHERE user_id=? AND state='active'", userId);
}

/** Client-safe view: never includes the mine layout while the round is live. */
function view(db, cfg, g, extra = {}) {
  const picks = JSON.parse(g.picks);
  const edge = cfg.houseEdge.mines;
  const current = picks.length ? fair.minesMultiplier(g.mine_count, picks.length, edge) : 0;
  const next = picks.length + 1 <= TILES - g.mine_count
    ? fair.minesMultiplier(g.mine_count, picks.length + 1, edge)
    : null;
  return {
    gameId: g.id,
    state: g.state,
    wager: g.wager,
    mineCount: g.mine_count,
    picks,
    safeRemaining: TILES - g.mine_count - picks.length,
    multiplier: current,
    nextMultiplier: next,
    cashoutValue: picks.length ? U.mulUnits(g.wager, current) : 0,
    nonce: g.nonce,
    ...extra,
  };
}

function start({ db, cfg, user }, body) {
  const wager = U.parseAmount(body.amount);
  const mineCount = U.toInt(body.mines, { min: 1, max: 24, name: 'mines' });

  return db.tx(() => {
    if (activeGame(db, user.id)) throw new U.BadRequest('finish your current mines round first');
    // Stake-side checks only; the win side is bounded by capPayout at cashout.
    ledger.checkBetLimits(db, cfg, user, wager, 1);

    const seed = auth.activeSeed(db, user.id);
    const nonce = auth.claimNonce(db, seed.id);
    const mines = fair.minePositions(seed.seed, user.client_seed, nonce, mineCount);

    ledger.transfer(
      db,
      ledger.userAccount(db, user.id).id,
      ledger.houseAccount(db).id,
      wager, 'bet', `mines#${nonce}`,
    );

    db.run(
      `INSERT INTO mines_games(user_id,wager,mine_count,mines,picks,seed_id,nonce,client_seed,state,created_at)
       VALUES(?,?,?,?,'[]',?,?,?,'active',?)`,
      user.id, wager, mineCount, JSON.stringify(mines), seed.id, nonce, user.client_seed, now(),
    );
    const g = activeGame(db, user.id);
    return {
      ...view(db, cfg, g),
      table: multiplierTable(cfg, mineCount),
      serverSeedHash: seed.seed_hash,
      maxPayout: ledger.capPayout(db, cfg, wager, Infinity).ceiling,
      balance: ledger.userAccount(db, user.id).balance,
    };
  });
}

function reveal({ db, cfg, user }, body) {
  const tile = U.toInt(body.tile, { min: 0, max: TILES - 1, name: 'tile' });

  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no active mines round');
    const picks = JSON.parse(g.picks);
    if (picks.includes(tile)) throw new U.BadRequest('tile already revealed');

    const mines = JSON.parse(g.mines);
    const edge = cfg.houseEdge.mines;

    if (mines.includes(tile)) {
      db.run("UPDATE mines_games SET state='lost', ended_at=? WHERE id=?", now(), g.id);
      ledger.settleBet(db, cfg, {
        user,
        game: 'mines',
        wager: g.wager,
        multiplier: 0,
        payout: 0,
        edgeUnits: Math.floor(g.wager * edge),
        seedId: g.seed_id,
        nonce: g.nonce,
        clientSeed: g.client_seed,
        detail: { mineCount: g.mine_count, picks, hit: tile, mines },
        stakeTaken: true,
      });
      return {
        ...view(db, cfg, { ...g, state: 'lost' }),
        safe: false,
        hit: tile,
        mines,
        payout: 0,
        balance: ledger.userAccount(db, user.id).balance,
      };
    }

    picks.push(tile);
    db.run('UPDATE mines_games SET picks=? WHERE id=?', JSON.stringify(picks), g.id);
    const updated = { ...g, picks: JSON.stringify(picks) };

    // Clearing every safe tile ends the round at the top of the ladder.
    if (picks.length === TILES - g.mine_count) {
      return { ...finish({ db, cfg, user }, updated), safe: true, autoCashout: true };
    }
    return { ...view(db, cfg, updated), safe: true };
  });
}

function cashout({ db, cfg, user }) {
  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no active mines round');
    if (JSON.parse(g.picks).length === 0) throw new U.BadRequest('reveal at least one tile first');
    return finish({ db, cfg, user }, g);
  });
}

/** Pay out a mines round. Caller must already be inside a transaction. */
function finish({ db, cfg, user }, g) {
  const picks = JSON.parse(g.picks);
  const mines = JSON.parse(g.mines);
  const edge = cfg.houseEdge.mines;
  const multiplier = fair.minesMultiplier(g.mine_count, picks.length, edge);
  const raw = U.mulUnits(g.wager, multiplier);
  const { payout, capped } = ledger.capPayout(db, cfg, g.wager, raw);

  db.run("UPDATE mines_games SET state='cashed', payout=?, ended_at=? WHERE id=?", payout, now(), g.id);
  ledger.settleBet(db, cfg, {
    user,
    game: 'mines',
    wager: g.wager,
    multiplier: g.wager ? payout / g.wager : 0,
    payout,
    edgeUnits: Math.floor(g.wager * edge),
    seedId: g.seed_id,
    nonce: g.nonce,
    clientSeed: g.client_seed,
    detail: { mineCount: g.mine_count, picks, mines, multiplier, capped },
    stakeTaken: true,
  });

  return {
    ...view(db, cfg, { ...g, state: 'cashed' }),
    state: 'cashed',
    mines,
    multiplier,
    payout,
    capped,
    profit: payout - g.wager,
    balance: ledger.userAccount(db, user.id).balance,
  };
}

function current({ db, cfg, user }) {
  const g = activeGame(db, user.id);
  if (!g) return { state: 'none' };
  return { ...view(db, cfg, g), table: multiplierTable(cfg, g.mine_count) };
}

module.exports = { start, reveal, cashout, current, multiplierTable, TILES };
