'use strict';
// The arcade: cabinets you feed tokens, the way a game room worked before everything
// became free-to-play with a shop in it.
//
// This is deliberately NOT a gambling product, and the distinction is structural rather
// than cosmetic. The games run in the browser, which means the score arrives from a
// client that could have been edited, so a score can never be worth money. Attaching a
// payout to an unverifiable number is how you get farmed within a day.
//
// So: a play costs one token, the score buys a place on a leaderboard, and that is all.
// The operator's revenue is the token sale, which is exactly how the arcades this is
// imitating actually made money.
//
// Paying with the site token also means the spend is signed by the player, so the
// operator cannot quietly drain someone's tokens by "charging" them for plays they never
// started.
const crypto = require('node:crypto');
const U = require('./util');
const tokenchain = require('./tokenchain');

const now = () => Math.floor(Date.now() / 1000);

const GAMES = {
  pinball: {
    key: 'pinball',
    // Named for the table, not for the Microsoft game it is a nod to. The mechanics of
    // pinball are nobody's property; that title and its artwork are.
    name: 'Orbit Pinball',
    blurb: 'Flippers, bumpers and a plunger. Keep the ball alive.',
    maxScore: 5000000,
  },
  billiards: {
    key: 'billiards',
    name: 'Billiards',
    blurb: 'Pot every ball in as few shots as you can.',
    // Nine balls at a thousand, plus the clearance bonus and whatever shots are left.
    maxScore: 30000,
  },
  invaders: {
    key: 'invaders',
    name: 'Void Raiders',
    blurb: 'Hold the line against descending waves.',
    maxScore: 1000000,
  },
};

/** What a spend signature covers. Distinct from a transfer so the two cannot be swapped. */
const spendPayload = (spend) => ({
  chain: tokenchain.CHAIN_ID,
  type: 'arcade',
  from: spend.from,
  game: spend.game,
  amount: spend.amount,
  nonce: spend.nonce,
});

function verifySpendSignature(spend) {
  try {
    return crypto.verify(
      null,
      Buffer.from(tokenchain.canonical(spendPayload(spend))),
      tokenchain.publicKeyFromRaw(spend.from),
      Buffer.from(spend.sig, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Insert a token and start a play.
 *
 * The signature is what authorises the burn. Without it the operator could charge any
 * account for plays it never made, which would make the token worth less than nothing.
 */
function insertToken(db, cfg, user, spend) {
  const game = GAMES[String(spend.game || '')];
  if (!game) throw new U.BadRequest('no such cabinet');
  if (!cfg.token.enabled) throw new U.BadRequest('the site token is disabled');

  const cost = cfg.arcade.tokenCost;
  const clean = {
    from: String(spend.from || '').toLowerCase(),
    game: game.key,
    amount: cost,
    nonce: Number(spend.nonce),
    sig: String(spend.sig || '').toLowerCase(),
  };
  if (!/^[0-9a-f]{64}$/.test(clean.from)) throw new U.BadRequest('bad key');
  if (!/^[0-9a-f]{128}$/.test(clean.sig)) throw new U.BadRequest('bad signature');
  if (!Number.isSafeInteger(clean.nonce) || clean.nonce < 0) throw new U.BadRequest('bad nonce');

  const key = tokenchain.keyFor(db, user.id);
  if (!key || key.pubkey !== clean.from) throw new U.Forbidden('that key is not registered to this account');
  if (!verifySpendSignature(clean)) throw new U.BadRequest('signature does not match this spend');

  return db.tx(() => {
    if (db.get('SELECT 1 FROM token_nonces WHERE pubkey=? AND nonce=?', clean.from, clean.nonce)) {
      throw new U.BadRequest('that nonce has already been used');
    }
    if (tokenchain.balanceOf(db, clean.from) < cost) {
      throw new U.BadRequest('not enough tokens for a play');
    }
    db.run('INSERT INTO token_nonces(pubkey, nonce, created_at) VALUES(?,?,?)',
      clean.from, clean.nonce, now());

    // The burn goes on the chain like everything else, so the token supply is auditable.
    const block = tokenchain.appendBlock(db, [{
      type: 'burn', from: clean.from, amount: cost, memo: `arcade:${game.key}`,
    }]);

    const ticket = crypto.randomBytes(16).toString('hex');
    db.run(
      `INSERT INTO arcade_plays(user_id, pubkey, game, ticket, tokens, score, state, created_at)
       VALUES(?,?,?,?,?,0,'open',?)`,
      user.id, clean.from, game.key, ticket, cost, now(),
    );
    return {
      ticket,
      game: game.key,
      cost,
      block: block.height,
      balance: tokenchain.balanceOf(db, clean.from),
    };
  });
}

/**
 * Record the score for a play.
 *
 * A ticket is single use, which stops one paid play being reported a thousand times. The
 * cap is a sanity bound, not a security control: the game runs on the player's machine,
 * so the number is never trustworthy. That is precisely why nothing here pays out.
 */
function submitScore(db, cfg, user, { ticket, score }) {
  const value = Number(score);
  if (!Number.isSafeInteger(value) || value < 0) throw new U.BadRequest('bad score');

  return db.tx(() => {
    const play = db.get(
      "SELECT * FROM arcade_plays WHERE ticket=? AND user_id=? AND state='open'",
      String(ticket || ''), user.id,
    );
    if (!play) throw new U.NotFound('no open play with that ticket');

    const game = GAMES[play.game];
    const capped = Math.min(value, game.maxScore);
    // A play that sat open for hours is almost certainly a stale tab, not a long game.
    const stale = now() - play.created_at > (cfg.arcade.playTtlSeconds ?? 7200);

    db.run("UPDATE arcade_plays SET score=?, state=?, ended_at=? WHERE id=?",
      capped, stale ? 'expired' : 'done', now(), play.id);

    if (stale) throw new U.BadRequest('that play expired; insert another token');

    const best = db.get(
      'SELECT MAX(score) AS s FROM arcade_plays WHERE user_id=? AND game=?', user.id, play.game,
    ).s || 0;
    return { game: play.game, score: capped, personalBest: best, capped: capped < value };
  });
}

/** Top scores per cabinet, with each player counted once at their best. */
function leaderboard(db, gameKey, limit = 10) {
  const game = GAMES[String(gameKey || '')];
  if (!game) throw new U.BadRequest('no such cabinet');
  return db.all(
    `SELECT u.username, MAX(p.score) AS score, COUNT(*) AS plays
       FROM arcade_plays p JOIN users u ON u.id = p.user_id
      WHERE p.game = ? AND p.state = 'done'
      GROUP BY p.user_id
      HAVING score > 0
      ORDER BY score DESC
      LIMIT ?`,
    game.key, U.clamp(Number(limit) || 10, 1, 50),
  );
}

/** The arcade floor: cabinets, what a play costs, and how the player is doing. */
function overview(db, cfg, user) {
  const key = user ? tokenchain.keyFor(db, user.id) : null;
  const mine = user
    ? db.all(
      `SELECT game, MAX(score) AS best, COUNT(*) AS plays
         FROM arcade_plays WHERE user_id=? AND state='done' GROUP BY game`, user.id,
    )
    : [];
  const bests = Object.fromEntries(mine.map((r) => [r.game, { best: r.best, plays: r.plays }]));

  return {
    enabled: cfg.arcade.enabled,
    tokenCost: cfg.arcade.tokenCost,
    symbol: cfg.token.symbol,
    pubkey: key ? key.pubkey : null,
    balance: key ? tokenchain.balanceOf(db, key.pubkey) : 0,
    nextNonce: key ? tokenchain.nextNonce(db, key.pubkey) : 0,
    games: Object.values(GAMES).map((g) => ({
      ...g,
      mine: bests[g.key] || { best: 0, plays: 0 },
      top: leaderboard(db, g.key, 5),
    })),
  };
}

/** Operator view: how much the arcade is actually earning in burned tokens. */
function stats(db) {
  const rows = db.all(
    `SELECT game, COUNT(*) AS plays, COALESCE(SUM(tokens),0) AS tokens,
            COUNT(DISTINCT user_id) AS players, MAX(score) AS best
       FROM arcade_plays GROUP BY game ORDER BY plays DESC`,
  );
  return {
    perGame: rows,
    totalPlays: rows.reduce((s, r) => s + r.plays, 0),
    tokensBurned: rows.reduce((s, r) => s + r.tokens, 0),
  };
}

module.exports = {
  GAMES, spendPayload, verifySpendSignature,
  insertToken, submitScore, leaderboard, overview, stats,
};
