'use strict';
// Mines: a 5x5 grid hides N mines. Reveal safe tiles to grow the multiplier, cash out
// before you hit one. Fair multiplier after k safe picks is C(25-N,k)/C(25,k) inverted,
// times (1 - edge). The layout is fixed by the seed the moment the round opens, so the
// server cannot move a mine under your next click.
const U = require('../util');
const fair = require('../fair');
const ledger = require('../ledger');
const auth = require('../auth');
const events = require('../events');
const tokenchain = require('../tokenchain');

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

function start({ db, cfg, user, bank }, body) {
  const wager = U.parseAmount(body.amount);
  const mineCount = U.toInt(body.mines, { min: 1, max: 24, name: 'mines' });

  return db.tx(() => {
    if (activeGame(db, user.id)) throw new U.BadRequest('finish your current mines round first');
    // Stake-side checks only; the win side is bounded by capPayout at cashout.
    bank.checkLimits(user, wager, 1);

    const seed = auth.activeSeed(db, user.id);
    const nonce = auth.claimNonce(db, seed.id);
    const mines = fair.minePositions(seed.seed, user.client_seed, nonce, mineCount);

    bank.takeStake(user, wager, `mines#${nonce}`);

    db.run(
      `INSERT INTO mines_games(user_id,wager,mine_count,mines,picks,seed_id,nonce,client_seed,state,mode,created_at)
       VALUES(?,?,?,?,'[]',?,?,?,'active',?,?)`,
      user.id, wager, mineCount, JSON.stringify(mines), seed.id, nonce, user.client_seed,
      bank.mode, now(),
    );
    const g = activeGame(db, user.id);
    // On the record: the round, its stake, and a commitment to the layout. The layout
    // itself is revealed when the round ends, and the hash is what lets anyone check
    // that no mine moved between the two.
    const opened = events.emit(db, cfg, {
      g: 'mines',
      r: g.id,
      k: 'o',
      a: [wager, mineCount, tokenchain.sha256(tokenchain.canonical(mines))],
      userId: user.id,
      pubkey: tokenchain.keyFor(db, user.id)?.pubkey || null,
    });
    return {
      ...view(db, cfg, g),
      event: opened && events.shown(opened),
      table: multiplierTable(cfg, mineCount),
      serverSeedHash: seed.seed_hash,
      maxPayout: bank.capPayout(wager, Infinity).ceiling,
      balance: bank.balance(user.id),
    };
  });
}

function reveal({ db, cfg, user, bankFor }, body) {
  const tile = U.toInt(body.tile, { min: 0, max: TILES - 1, name: 'tile' });

  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no active mines round');
    const picks = JSON.parse(g.picks);
    if (picks.includes(tile)) throw new U.BadRequest('tile already revealed');

    const mines = JSON.parse(g.mines);
    const edge = cfg.houseEdge.mines;
    // Settle against the bank this round was opened with, not the one the request asks
    // for: a round started with play money must never pay out real money.
    const bank = bankFor();
    const step = events.emit(db, cfg, { g: 'mines', r: g.id, k: 'r', a: [tile] });
    const event = step && events.shown(step);

    if (mines.includes(tile)) {
      db.run("UPDATE mines_games SET state='lost', ended_at=? WHERE id=?", now(), g.id);
      events.emit(db, cfg, { g: 'mines', r: g.id, k: 'f', a: [0, 0, mines] });
      events.close(db, { g: 'mines', r: g.id });
      bank.settle({
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
        logged: true,
      });
      return {
        ...view(db, cfg, { ...g, state: 'lost' }),
        event,
        safe: false,
        hit: tile,
        mines,
        payout: 0,
        balance: bank.balance(user.id),
      };
    }

    picks.push(tile);
    db.run('UPDATE mines_games SET picks=? WHERE id=?', JSON.stringify(picks), g.id);
    const updated = { ...g, picks: JSON.stringify(picks) };

    // Clearing every safe tile ends the round at the top of the ladder.
    if (picks.length === TILES - g.mine_count) {
      return { ...finish({ db, cfg, user, bankFor }, updated), event, safe: true, autoCashout: true };
    }
    return { ...view(db, cfg, updated), event, safe: true };
  });
}

function cashout({ db, cfg, user, bankFor }, body = {}) {
  return db.tx(() => {
    const g = activeGame(db, user.id);
    if (!g) throw new U.NotFound('no active mines round');
    if (JSON.parse(g.picks).length === 0) throw new U.BadRequest('reveal at least one tile first');
    return finish({ db, cfg, user, bankFor }, g, body);
  });
}

/** Pay out a mines round. Caller must already be inside a transaction. */
function finish({ db, cfg, user, bankFor }, g, body = {}) {
  const bank = bankFor();
  const picks = JSON.parse(g.picks);
  const mines = JSON.parse(g.mines);
  const edge = cfg.houseEdge.mines;
  const multiplier = fair.minesMultiplier(g.mine_count, picks.length, edge);
  const raw = U.mulUnits(g.wager, multiplier);
  const { payout, capped } = bank.capPayout(g.wager, raw);

  db.run("UPDATE mines_games SET state='cashed', payout=?, ended_at=? WHERE id=?", payout, now(), g.id);
  // The player's signature over the round so far, if the request carried one, goes on
  // the cashout event: the record of this round is then theirs as much as the house's.
  const att = events.attest(db, cfg, {
    g: 'mines', r: g.id, sig: body.roundSig, pubkey: tokenchain.keyFor(db, user.id)?.pubkey || null,
  });
  const sig = att.attested ? String(body.roundSig) : null;
  events.emit(db, cfg, { g: 'mines', r: g.id, k: 'c', a: [payout, multiplier, mines], sig });
  events.close(db, { g: 'mines', r: g.id, sig });
  bank.settle({
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
    logged: true,
  });

  return {
    ...view(db, cfg, { ...g, state: 'cashed' }),
    state: 'cashed',
    mines,
    multiplier,
    payout,
    capped,
    profit: payout - g.wager,
    attested: att.attested,
    balance: bank.balance(user.id),
  };
}

function current({ db, cfg, user }) {
  const g = activeGame(db, user.id);
  if (!g) return { state: 'none' };
  return {
    ...view(db, cfg, g),
    table: multiplierTable(cfg, g.mine_count),
    // The round's record so far, for a browser that reopened it to fold again.
    events: events.history(db, 'mines', g.id).map(events.shown),
  };
}

module.exports = { start, reveal, cashout, current, multiplierTable, TILES };
