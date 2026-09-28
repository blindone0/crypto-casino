'use strict';
// HTTP server, router and the whole API surface. Zero dependencies: node:http only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const U = require('./util');
const configMod = require('./config');
const dbMod = require('./db');
const auth = require('./auth');
const ledger = require('./ledger');
const limits = require('./limits');
const fair = require('./fair');
const adminApi = require('./admin');
const bankMod = require('./bank');
const tokenchain = require('./tokenchain');
const solo = require('./solo');
const jigsaw = require('./games/jigsaw');
const arcade = require('./arcade');
// Named `matches`, not `match`: build() declares its own local `match(method, pathname)`
// for route lookup, and a function declaration shadows the module import inside it.
const matches = require('./match');
const geoMod = require('./geo');
const dice = require('./games/dice');
const limbo = require('./games/limbo');
const mines = require('./games/mines');
const slots = require('./games/slots');
const preferans = require('./games/preferans');
const puzzle = require('./games/puzzle');
const debertz = require('./games/debertz');
const crashMod = require('./games/crash');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function build(cfg) {
  const db = dbMod.open(cfg.dbPath);
  const bankFor = (spend) => bankMod.bankFor(db, cfg, spend);
  const crash = crashMod.createCrash({ db, cfg, bankFor });
  const geo = geoMod.createGeo(cfg);
  const publicDir = path.join(cfg.root, 'public');

  // ---------------------------------------------------------------- logging
  const LEVELS = { quiet: 0, info: 1, debug: 2 };
  const level = LEVELS[cfg.logLevel] ?? LEVELS.info;

  const logLine = (method, pathname, status, ms, note) => {
    const stamp = new Date().toISOString().slice(11, 23);
    console.log(
      `${stamp} ${String(status).padEnd(3)} ${method.padEnd(4)} ${pathname} ${ms}ms`
      + `${note ? `  ${note}` : ''}`,
    );
  };

  // ---------------------------------------------------------------- routing
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    // Registering the same method and path twice is always a mistake, and a silent one:
    // the first handler wins and the second is dead code that looks alive. It happened
    // once with /api/admin/token, where the newer of the two was simply never reached.
    if (routes.some((r) => r.method === method && r.parts.join('/') === pattern.replace(/^\/+/, ''))) {
      throw new Error(`duplicate route: ${method} ${pattern}`);
    }
    return routes.push({
      method, parts: pattern.split('/').filter(Boolean), handler, ...opts,
    });
  };

  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i += 1) {
        const p = r.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]);
        else if (p !== parts[i]) { ok = false; break; }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  // ------------------------------------------------------------------ auth
  function currentUser(req) {
    const cookies = U.parseCookies(req.headers.cookie);
    const found = auth.sessionFrom(db, cookies.sid);
    if (!found) return null;
    const user = limits.applyPendingLimits(db, found.user);
    return { ...found, user };
  }

  function requireUser(ctx) {
    if (!ctx.auth) throw new U.Unauthorized();
    return ctx.auth.user;
  }

  /** Mutating cookie-authenticated requests must echo the CSRF token. */
  function checkCsrf(req, ctx) {
    if (!ctx.auth) return;
    const sent = req.headers['x-csrf-token'];
    if (!U.safeEqual(sent, ctx.auth.session.csrf)) throw new U.Forbidden('bad or missing CSRF token');
  }

  function requireAdmin(req, ctx) {
    const tokenHeader = req.headers['x-admin-token'];
    if (cfg.adminToken && tokenHeader && U.safeEqual(tokenHeader, cfg.adminToken)) {
      return { actor: 'admin:token' };
    }
    const user = ctx.auth?.user;
    if (user && user.role === 'admin') {
      checkCsrf(req, ctx);
      return { actor: `admin:${user.id}` };
    }
    throw new U.Forbidden('admin access required');
  }

  const setSession = (res, token) => res.setHeader('set-cookie', U.cookieHeader('sid', token, {
    maxAge: cfg.sessionTtlSec, secure: cfg.secureCookies,
  }));

  // ------------------------------------------------------------ public info
  add('GET', '/api/config', async () => ({
    siteName: cfg.siteName,
    locale: cfg.defaultLocale,
    // There is one currency, so the ticker is the tugrik symbol and nothing chooses.
    currency: cfg.token.symbol,
    unit: U.UNIT,
    houseEdge: cfg.houseEdge,
    risk: {
      // The stake bounds a client should enforce. They come from the token config now:
      // the old `risk.minBetUnits`/`maxBetUnits` priced credits, which no longer exist.
      minBetUnits: cfg.token.bet.min,
      maxBetUnits: cfg.token.bet.max,
      maxMultiplier: cfg.risk.maxMultiplier,
    },
    rakeback: cfg.rakeback,
    referralCommission: cfg.referralCommission,
    token: { enabled: cfg.token.enabled, symbol: cfg.token.symbol },
    arcade: { enabled: cfg.arcade.enabled, tokenCost: cfg.arcade.tokenCost },
    match: {
      enabled: cfg.match.enabled,
      rake: cfg.match.rake,
      minStake: cfg.match.minStake,
      maxStake: cfg.match.maxStake,
    },
    crashCommitment: crash.commitment,
    dice: { minWinCount: dice.MIN_WIN_COUNT, maxWinCount: dice.MAX_WIN_COUNT },
    slots: { rtp: slots.machineFor(cfg.houseEdge.slots).rtp, lines: slots.LINES },
  }));

  add('GET', '/api/stats/recent', async () => ({
    bets: db.all(
      `SELECT b.id,b.game,b.wager,b.multiplier,b.payout,b.profit,b.created_at,u.username
         FROM bets b JOIN users u ON u.id=b.user_id ORDER BY b.id DESC LIMIT 20`,
    ),
    biggest: db.all(
      `SELECT b.id,b.game,b.wager,b.multiplier,b.payout,b.profit,b.created_at,u.username
         FROM bets b JOIN users u ON u.id=b.user_id WHERE b.profit > 0
        ORDER BY b.profit DESC LIMIT 10`,
    ),
  }));

  // ------------------------------------------------------------------ accounts
  add('POST', '/api/auth/register', async (ctx, req, res) => {
    const body = await U.readJsonBody(req);
    const user = auth.register(db, cfg, { ...body, ip: ctx.ip });
    const { token, csrf } = auth.login(db, cfg, {
      username: user.username, password: body.password, ip: ctx.ip,
    });
    setSession(res, token);
    return { csrf, user: auth.publicUser(db, user) };
  });

  add('POST', '/api/auth/login', async (ctx, req, res) => {
    const body = await U.readJsonBody(req);
    const { token, csrf, user } = auth.login(db, cfg, { ...body, ip: ctx.ip });
    setSession(res, token);
    return { csrf, user: auth.publicUser(db, user) };
  });

  add('POST', '/api/auth/logout', async (ctx, req, res) => {
    const cookies = U.parseCookies(req.headers.cookie);
    auth.logout(db, cookies.sid);
    res.setHeader('set-cookie', U.cookieHeader('sid', '', { maxAge: 0, secure: cfg.secureCookies }));
    return { ok: true };
  });

  add('GET', '/api/me', async (ctx) => {
    const user = requireUser(ctx);
    return {
      user: auth.publicUser(db, user),
      csrf: ctx.auth.session.csrf,
      play: limits.playTimeToday(db, user.id),
    };
  });

  add('POST', '/api/me/password', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    auth.changePassword(db, user, { current: body.current, next: body.next });
    return { ok: true, note: 'signed out everywhere; sign in again' };
  });

  add('POST', '/api/me/client-seed', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    auth.setClientSeed(db, user.id, body.seed);
    const fresh = db.get('SELECT * FROM users WHERE id=?', user.id);
    return { user: auth.publicUser(db, fresh) };
  });

  add('POST', '/api/me/rotate-seed', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    const { revealed, active } = auth.rotateSeed(db, user.id);
    return {
      revealedSeed: revealed?.seed ?? null,
      revealedHash: revealed?.seed_hash ?? null,
      revealedNonces: revealed?.nonce ?? 0,
      newHash: active.seed_hash,
    };
  });

  add('GET', '/api/me/bets', async (ctx, req) => {
    const user = requireUser(ctx);
    const url = new URL(req.url, 'http://x');
    const limit = U.clamp(Number(url.searchParams.get('limit')) || 50, 1, 200);
    return {
      bets: db.all(
        `SELECT id,game,wager,multiplier,payout,profit,nonce,client_seed,detail,created_at,seed_id
           FROM bets WHERE user_id=? ORDER BY id DESC LIMIT ?`, user.id, limit,
      ),
    };
  });

  add('POST', '/api/me/rakeback/claim', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    return db.tx(() => {
      const rb = ledger.userAccount(db, user.id, 'rakeback');
      if (rb.balance <= 0) throw new U.BadRequest('no rakeback to claim yet');
      const amount = rb.balance;
      ledger.transfer(db, rb.id, ledger.userAccount(db, user.id).id, amount, 'rakeback.claim', null);
      return { claimed: amount, balance: ledger.userAccount(db, user.id).balance };
    });
  });

  add('POST', '/api/me/affiliate/claim', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    return db.tx(() => {
      const aff = ledger.affiliateAccount(db, user.id);
      if (aff.balance <= 0) throw new U.BadRequest('no commission to claim yet');
      const amount = aff.balance;
      ledger.transfer(db, aff.id, ledger.userAccount(db, user.id).id, amount, 'referral.claim', null);
      return { claimed: amount, balance: ledger.userAccount(db, user.id).balance };
    });
  });

  add('GET', '/api/me/affiliate', async (ctx) => {
    const user = requireUser(ctx);
    return {
      code: user.referral_code,
      link: `${cfg.publicUrl}/?ref=${encodeURIComponent(user.referral_code)}`,
      commission: cfg.referralCommission,
      players: db.get('SELECT COUNT(*) AS n FROM users WHERE referred_by=?', user.id).n,
      earned: db.get(
        'SELECT COALESCE(SUM(amount_units),0) AS n FROM referral_earnings WHERE affiliate_id=?', user.id,
      ).n,
      unpaid: ledger.affiliateAccount(db, user.id).balance,
    };
  });

  add('POST', '/api/me/limits/self-exclude', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return limits.setSelfExclusion(db, cfg, user, body.days);
  });

  add('POST', '/api/me/limits/max-bet', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return limits.setMaxBet(db, user, body.amount);
  });

  // --------------------------------------------------------------- games
  /**
   * Build the context a game runs in.
   *
   * This used to pick a bank from a `wallet` field on the request body. There is one
   * currency now, so the only thing it still carries is `spend` — the player's signature
   * over their stake, which the bank closes over. Games that persist a round keep
   * `bankFor` so they can settle a round opened before this change.
   */
  const gameCtx = (ctx, spend) => {
    const user = requireUser(ctx);
    limits.requireNotExcluded(user);
    if (!cfg.token.enabled) throw new U.BadRequest('the site token is disabled');
    return { db, cfg, user, bank: bankFor(spend), bankFor };
  };

  add('POST', '/api/bet/dice', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return dice.play(gameCtx(ctx, body.spend), body);
  });

  add('POST', '/api/bet/limbo', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return limbo.play(gameCtx(ctx, body.spend), body);
  });

  add('POST', '/api/bet/mines/start', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return mines.start(gameCtx(ctx, body.spend), body);
  });

  add('POST', '/api/bet/mines/reveal', async (ctx, req) => {
    checkCsrf(req, ctx);
    // No mode here on purpose: the round already knows which bank it belongs to.
    return mines.reveal(gameCtx(ctx), await U.readJsonBody(req));
  });

  add('POST', '/api/bet/mines/cashout', async (ctx, req) => {
    checkCsrf(req, ctx);
    return mines.cashout(gameCtx(ctx));
  });

  add('GET', '/api/bet/mines/current', async (ctx) => {
    const user = requireUser(ctx);
    return mines.current({ db, cfg, user });
  });

  add('POST', '/api/bet/slots', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return slots.play(gameCtx(ctx, body.spend), body);
  });

  add('GET', '/api/bet/slots/info', async () => slots.info(cfg));

  // ---------------------------------------------------------------- puzzle
  add('POST', '/api/bet/puzzle/start', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return puzzle.start(gameCtx(ctx, body.spend), body);
  });

  add('POST', '/api/bet/puzzle/reveal', async (ctx, req) => {
    checkCsrf(req, ctx);
    return puzzle.reveal(gameCtx(ctx), await U.readJsonBody(req));
  });

  add('POST', '/api/bet/puzzle/cashout', async (ctx, req) => {
    checkCsrf(req, ctx);
    return puzzle.cashout(gameCtx(ctx));
  });

  add('GET', '/api/bet/puzzle/current', async (ctx) => {
    const user = requireUser(ctx);
    return puzzle.current({ db, cfg, user });
  });

  add('GET', '/api/bet/puzzle/info', async () => puzzle.info(cfg));

  // --------------------------------------------------------------- debertz
  add('POST', '/api/bet/debertz/start', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return debertz.start(gameCtx(ctx, body.spend), body);
  });

  add('POST', '/api/bet/debertz/trump', async (ctx, req) => {
    checkCsrf(req, ctx);
    return debertz.chooseTrump(gameCtx(ctx), await U.readJsonBody(req));
  });

  add('POST', '/api/bet/debertz/play', async (ctx, req) => {
    checkCsrf(req, ctx);
    return debertz.playCard(gameCtx(ctx), await U.readJsonBody(req));
  });

  add('GET', '/api/bet/debertz/current', async (ctx) => {
    const user = requireUser(ctx);
    return debertz.current({ db, cfg, user });
  });

  add('GET', '/api/bet/debertz/info', async () => debertz.info(cfg));

  // ------------------------------------------------------------- preferans
  add('POST', '/api/bet/preferans/start', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return preferans.start(gameCtx(ctx, body.spend), body);
  });

  add('POST', '/api/bet/preferans/trump', async (ctx, req) => {
    checkCsrf(req, ctx);
    return preferans.chooseTrump(gameCtx(ctx), await U.readJsonBody(req));
  });

  add('POST', '/api/bet/preferans/discard', async (ctx, req) => {
    checkCsrf(req, ctx);
    return preferans.discard(gameCtx(ctx), await U.readJsonBody(req));
  });

  add('POST', '/api/bet/preferans/play', async (ctx, req) => {
    checkCsrf(req, ctx);
    return preferans.playCard(gameCtx(ctx), await U.readJsonBody(req));
  });

  add('GET', '/api/bet/preferans/current', async (ctx) => {
    const user = requireUser(ctx);
    return preferans.current({ db, cfg, user });
  });

  add('GET', '/api/bet/preferans/info', async () => preferans.info(cfg));

  add('GET', '/api/bet/mines/table', async (ctx, req) => {
    const url = new URL(req.url, 'http://x');
    const n = U.toInt(url.searchParams.get('mines') ?? 3, { min: 1, max: 24, name: 'mines' });
    return { mineCount: n, table: mines.multiplierTable(cfg, n) };
  });

  // ---------------------------------------------------------------- crash
  add('GET', '/api/crash/state', async () => crash.state());

  add('POST', '/api/crash/bet', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    // The signature has to travel with the stake. It did not before: this route read the
    // wallet name and threw the signature away, so `takeStake` refused every tugrik crash
    // bet. Nobody hit it because nobody played crash in tugriks; with one currency, every
    // crash bet hits it.
    const { user } = gameCtx(ctx, body.spend);
    return crash.placeBet(user, body, body.spend);
  });

  add('POST', '/api/crash/cashout', async (ctx, req) => {
    checkCsrf(req, ctx);
    const { user } = gameCtx(ctx);
    return crash.cashout(user);
  });

  add('GET', '/api/crash/mine', async (ctx) => {
    const user = requireUser(ctx);
    return { bet: crash.myBet(user) };
  });

  // ---------------------------------------------------------------- jigsaw
  //
  // A skill game, so the clock lives on this side of the wire and the finish is verified
  // rather than reported. `solve` takes the arrangement and checks it; nothing the client
  // says about its own timing is used.
  add('POST', '/api/bet/jigsaw/start', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return jigsaw.start(gameCtx(ctx, body.spend), body);
  });

  add('POST', '/api/bet/jigsaw/solve', async (ctx, req) => {
    checkCsrf(req, ctx);
    return jigsaw.solve(gameCtx(ctx), await U.readJsonBody(req));
  });

  add('POST', '/api/bet/jigsaw/give', async (ctx, req) => {
    checkCsrf(req, ctx);
    return jigsaw.give(gameCtx(ctx));
  });

  add('GET', '/api/bet/jigsaw/current', async (ctx) => jigsaw.current(gameCtx(ctx)));

  // ----------------------------------------------------------- singleplayer
  //
  // No stake, no escrow, no signature: these routes never touch a bank. That is the whole
  // reason they are a handful of lines — the match framework's weight is all in protecting
  // money, and there is none here.
  add('POST', '/api/solo/start', async (ctx, req) => {
    checkCsrf(req, ctx);
    const user = requireUser(ctx);
    const body = await U.readJsonBody(req);
    return solo.start(db, cfg, user, String(body.game || ''));
  });

  add('GET', '/api/solo/current', async (ctx, req) => {
    const user = requireUser(ctx);
    const url = new URL(req.url, 'http://x');
    return { game: solo.current(db, user.id, String(url.searchParams.get('game') || '')) };
  });

  add('POST', '/api/solo/move', async (ctx, req) => {
    checkCsrf(req, ctx);
    const user = requireUser(ctx);
    const { game, ...payload } = await U.readJsonBody(req);
    return solo.move(db, cfg, user, String(game || ''), payload);
  });

  add('POST', '/api/solo/quit', async (ctx, req) => {
    checkCsrf(req, ctx);
    const user = requireUser(ctx);
    const body = await U.readJsonBody(req);
    return solo.quit(db, user, String(body.game || ''));
  });

  // ------------------------------------------------------------ site token
  add('GET', '/api/token', async (ctx) => {
    const user = requireUser(ctx);
    if (!cfg.token.enabled) return { enabled: false };
    const key = tokenchain.keyFor(db, user.id);
    const tip = tokenchain.head(db);
    return {
      enabled: true,
      symbol: cfg.token.symbol,
      welcomeGrant: cfg.token.welcomeGrant,
      serverKey: tokenchain.serverKey(db).publicRaw,
      chain: tokenchain.CHAIN_ID,
      pubkey: key ? key.pubkey : null,
      balance: key ? tokenchain.balanceOf(db, key.pubkey) : 0,
      nextNonce: key ? tokenchain.nextNonce(db, key.pubkey) : 0,
      height: tip ? tip.height : -1,
      head: tip ? tip.hash : null,
      // Where a stake is signed to. The wallet needs it to bet, not only to enter a match.
      houseKey: matches.houseKey(db).publicRaw,
      // The largest win the house could actually pay, which is simply what it holds. Not
      // a policy and not a configured number: the supply is fixed, so a bigger promise is
      // one the chain would refuse. It moves as the house wins and loses, which is why it
      // rides on this endpoint rather than on the boot-time config.
      maxWin: tokenchain.balanceOf(db, matches.houseKey(db).publicRaw),
      betLimits: cfg.token.bet,
      // Read off the chain, not off the config, so what a player is shown is what the
      // ledger actually says. The cap is checkable: every token was minted in block zero
      // and the verifier refuses a chain that mints anywhere else.
      supply: tokenchain.supply(db),
      maxSupply: cfg.token.maxSupply,
    };
  });

  add('POST', '/api/token/key', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    if (!cfg.token.enabled) throw new U.BadRequest('the site token is disabled');
    const body = await U.readJsonBody(req);
    return tokenchain.registerKey(db, user.id, body.pubkey, cfg, { replace: !!body.replace });
  });

  add('POST', '/api/token/transfer', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    if (!cfg.token.enabled) throw new U.BadRequest('the site token is disabled');
    const body = await U.readJsonBody(req);
    const key = tokenchain.keyFor(db, user.id);
    // The signature is what authorises the move, but a session may only submit its own
    // key: otherwise one account could spend another account rate limit and quota.
    if (!key || key.pubkey !== String(body.from || '').toLowerCase()) {
      throw new U.Forbidden('that key is not registered to this account');
    }
    return tokenchain.submitTransfer(db, body);
  });

  add('GET', '/api/token/chain', async (ctx, req) => {
    const url = new URL(req.url, 'http://x');
    return tokenchain.chainSlice(db, url.searchParams.get('from'), url.searchParams.get('limit'));
  });

  add('GET', '/api/token/head', async () => {
    const tip = tokenchain.head(db);
    return {
      chain: tokenchain.CHAIN_ID,
      serverKey: tokenchain.serverKey(db).publicRaw,
      height: tip ? tip.height : -1,
      head: tip ? tip.hash : null,
      signature: tip ? tip.signature : null,
    };
  });

  // The token economy. Every figure is read by replaying the chain rather than from a
  // stored total, including the verification flag, which is the only number here worth
  // much: a ledger that does not verify makes all the others a guess.
  add('GET', '/api/admin/token', async (ctx, req) => {
    requireAdmin(req, ctx);
    const check = tokenchain.verifyChain(db);
    const tip = tokenchain.head(db);
    return {
      ...tokenchain.supply(db),
      house: tokenchain.balanceOf(db, matches.houseKey(db).publicRaw),
      serverKey: tokenchain.serverKey(db).publicRaw,
      accounts: db.get('SELECT COUNT(*) AS n FROM token_balances').n,
      blocks: tip ? tip.height + 1 : 0,
      verifies: check.ok,
      reason: check.ok ? null : check.reason,
      symbol: cfg.token.symbol,
    };
  });

  // ---------------------------------------------------------------- arcade
  add('GET', '/api/arcade', async (ctx) => {
    const user = ctx.auth ? ctx.auth.user : null;
    return arcade.overview(db, cfg, user);
  });

  add('POST', '/api/arcade/play', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    if (!cfg.arcade.enabled) throw new U.BadRequest('the arcade is closed');
    return arcade.insertToken(db, cfg, user, await U.readJsonBody(req));
  });

  // A free play, for practice mode. Costs nothing and cannot reach the leaderboard, so
  // there is nothing here to protect but the rate limiter the router already applies.
  add('POST', '/api/arcade/practice', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return arcade.practicePlay(db, cfg, user, body.game);
  });

  add('POST', '/api/arcade/score', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    return arcade.submitScore(db, cfg, user, await U.readJsonBody(req));
  });

  add('GET', '/api/arcade/leaderboard', async (ctx, req) => {
    const url = new URL(req.url, 'http://x');
    return { scores: arcade.leaderboard(db, url.searchParams.get('game'), url.searchParams.get('limit')) };
  });

  // The imported puzzle pictures, as data URIs. Cached in memory because the file does
  // not change while the server is running: the importer says to restart, and this is why.
  let picturePack = null;
  add('GET', '/api/puzzle/pictures', async () => {
    if (!picturePack) {
      picturePack = { pictures: {} };
      try {
        const file = path.join(cfg.dataDir, 'puzzle-pictures.json');
        if (fs.existsSync(file)) {
          const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
          for (const [key, pic] of Object.entries(pack.pictures || {})) {
            picturePack.pictures[key] = `data:${pic.mime};base64,${pic.data}`;
          }
        }
      } catch { /* no pack; the drawn pictures stand alone */ }
    }
    return picturePack;
  });

  add('GET', '/api/admin/arcade', async (ctx, req) => {
    requireAdmin(req, ctx);
    return arcade.stats(db);
  });


  // --------------------------------------------------------------- matches
  // Head-to-head games for tokens. Every one of these goes through src/match.js, which
  // holds the board and checks the move; nothing here trusts the client for anything
  // beyond which move it would like to make.
  add('GET', '/api/match', async (ctx) => {
    const user = ctx.auth ? ctx.auth.user : null;
    return matches.lobby(db, cfg, user);
  });

  add('GET', '/api/match/one', async (ctx, req) => {
    const url = new URL(req.url, 'http://x');
    const user = ctx.auth ? ctx.auth.user : null;
    return matches.detail(db, cfg, user, url.searchParams.get('id'));
  });

  add('POST', '/api/match/create', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    return matches.create(db, cfg, user, await U.readJsonBody(req));
  });

  add('POST', '/api/match/join', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    return matches.join(db, cfg, user, await U.readJsonBody(req));
  });

  add('POST', '/api/match/cancel', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    return matches.cancel(db, user, (await U.readJsonBody(req)).id);
  });

  add('POST', '/api/match/move', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    return matches.act(db, cfg, user, await U.readJsonBody(req));
  });

  add('POST', '/api/match/resign', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    return matches.resign(db, cfg, user, (await U.readJsonBody(req)).id);
  });

  add('POST', '/api/match/timeout', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    return matches.claimTimeout(db, cfg, user, (await U.readJsonBody(req)).id);
  });

  add('GET', '/api/admin/matches', async (ctx, req) => {
    requireAdmin(req, ctx);
    return matches.stats(db);
  });

  // -------------------------------------------------------------- fairness
  add('GET', '/api/fair/seed', async (ctx) => {
    const user = requireUser(ctx);
    const seed = auth.activeSeed(db, user.id);
    return {
      serverSeedHash: seed.seed_hash,
      clientSeed: user.client_seed,
      nonce: seed.nonce,
      revealed: db.all(
        `SELECT seed, seed_hash, nonce, created_at, revealed_at FROM server_seeds
          WHERE user_id=? AND active=0 ORDER BY id DESC LIMIT 10`, user.id,
      ),
      crashCommitment: crash.commitment,
    };
  });

  add('POST', '/api/fair/verify', async (ctx, req) => {
    const body = await U.readJsonBody(req);
    const game = String(body.game || 'dice');
    if (!['dice', 'limbo', 'crash', 'mines'].includes(game)) throw new U.BadRequest('unknown game');
    const serverSeed = String(body.serverSeed || '');
    if (!/^[0-9a-f]{8,128}$/i.test(serverSeed)) throw new U.BadRequest('server seed must be hex');
    const out = fair.replay({
      game,
      serverSeed,
      clientSeed: String(body.clientSeed ?? ''),
      nonce: U.toInt(body.nonce ?? 0, { min: 0, max: 1e12, name: 'nonce' }),
      edge: cfg.houseEdge[game],
      target: body.target == null ? null : Number(body.target),
      mode: body.mode === 'over' ? 'over' : 'under',
      mineCount: body.mineCount == null ? 3 : U.toInt(body.mineCount, { min: 1, max: 24, name: 'mineCount' }),
      picks: body.picks == null ? 0 : U.toInt(body.picks, { min: 0, max: 24, name: 'picks' }),
    });
    return { game, serverSeedHash: fair.sha256hex(serverSeed), result: out };
  });

  add('GET', '/api/fair/crash-chain', async (req) => {
    const rounds = db.all(
      `SELECT id, crash_point, seed, seed_hash FROM crash_rounds
        WHERE state='ended' ORDER BY id DESC LIMIT 50`,
    );
    return { commitment: crash.commitment, rounds };
  });

  // ----------------------------------------------------------------- admin
  add('GET', '/api/admin/overview', async (ctx, req) => {
    requireAdmin(req, ctx);
    return adminApi.overview(db, cfg);
  });

  add('GET', '/api/admin/series', async (ctx, req) => {
    requireAdmin(req, ctx);
    const url = new URL(req.url, 'http://x');
    return { series: adminApi.dailySeries(db, U.clamp(Number(url.searchParams.get('days')) || 30, 1, 365)) };
  });

  add('GET', '/api/admin/demo', async (ctx, req) => {
    requireAdmin(req, ctx);
    return bankMod.demoStats(db);
  });

  add('GET', '/api/admin/risk', async (ctx, req) => {
    requireAdmin(req, ctx);
    return { ...adminApi.riskReport(db, cfg), geo: geo.stats() };
  });

  add('GET', '/api/admin/users', async (ctx, req) => {
    requireAdmin(req, ctx);
    const url = new URL(req.url, 'http://x');
    return adminApi.listUsers(db, {
      q: url.searchParams.get('q') || '',
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
    });
  });

  add('GET', '/api/admin/users/:id', async (ctx, req, res, params) => {
    requireAdmin(req, ctx);
    return adminApi.userDetail(db, U.toInt(params.id, { min: 1, name: 'id' }));
  });

  add('POST', '/api/admin/users/:id/freeze', async (ctx, req, res, params) => {
    const { actor } = requireAdmin(req, ctx);
    const body = await U.readJsonBody(req);
    return adminApi.setFrozen(db, U.toInt(params.id, { min: 1, name: 'id' }), !!body.frozen, actor);
  });

  add('POST', '/api/admin/bankroll', async (ctx, req) => {
    const { actor } = requireAdmin(req, ctx);
    const body = await U.readJsonBody(req);
    const units = U.parseAmount(body.amount);
    return body.action === 'remove'
      ? adminApi.removeBankroll(db, units, actor, body.note)
      : adminApi.addBankroll(db, units, actor, body.note);
  });

  add('POST', '/api/admin/fees/sweep', async (ctx, req) => {
    const { actor } = requireAdmin(req, ctx);
    return adminApi.sweepFees(db, actor);
  });

  add('GET', '/api/admin/audit', async (ctx, req) => {
    requireAdmin(req, ctx);
    const url = new URL(req.url, 'http://x');
    return { entries: adminApi.auditTail(db, url.searchParams.get('limit')) };
  });

  add('GET', '/api/admin/affiliates', async (ctx, req) => {
    requireAdmin(req, ctx);
    return { affiliates: adminApi.affiliateReport(db) };
  });

  // ------------------------------------------------------------ static files
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html'
      : pathname === '/admin' ? 'admin.html'
        : pathname === '/verify' ? 'verify.html'
          : pathname.replace(/^\/+/, '');
    // public/package.json exists only to mark that tree as ESM for Node's resolver when
    // the test suite imports the browser game modules. Nothing should fetch it.
    if (path.basename(rel).toLowerCase() === 'package.json') {
      U.sendJson(res, 404, { error: 'not found' });
      return;
    }
    const target = path.resolve(publicDir, rel);
    if (!target.startsWith(publicDir)) {
      U.sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    if (!MIME[ext]) {
      U.sendJson(res, 404, { error: 'not found' });
      return;
    }
    fs.stat(target, (statErr, st) => {
      if (statErr || !st.isFile()) {
        U.sendJson(res, 404, { error: 'not found' });
        return;
      }
      // Revalidate every time with an ETag rather than caching blind for N seconds:
      // assets update the moment they change on disk, and unchanged ones cost a 304.
      const etag = `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'no-cache' });
        res.end();
        return;
      }
      fs.readFile(target, (err, data) => {
        if (err) {
          U.sendJson(res, 404, { error: 'not found' });
          return;
        }
        res.writeHead(200, {
          'content-type': MIME[ext],
          'content-length': data.length,
          'cache-control': ext === '.html' ? 'no-store' : 'no-cache',
          etag,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'same-origin',
        });
        res.end(data);
      });
    });
  }

  // ------------------------------------------------------------ the listener
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {
      U.sendJson(res, 400, { error: 'bad request line' });
      return;
    }

    // Security headers on every response. The CSP is strict: no inline script, no CDN.
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
      + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");

    const ip = U.clientIp(req, cfg.trustProxy);

    // Jurisdiction filter, before anything else: a blocked visitor should not be able to
    // reach the games, the API or even the page. Inert unless geo.enabled and (by
    // default) NODE_ENV=production, and never applied to loopback or private addresses.
    const geoBlock = geo.check(req, ip);
    if (geoBlock) {
      res.writeHead(geoBlock.status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(`${geoBlock.reason}\n`);
      return;
    }

    // Server-sent events for crash: handled before the JSON router.
    if (pathname === '/api/crash/stream' && req.method === 'GET') {
      crash.subscribe(req, res);
      return;
    }

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        U.sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      serveStatic(req, res, pathname);
      return;
    }

    let ctx = null;
    try {
      limits.enforce(db, cfg, ip, pathname);
      const m = match(req.method, pathname);
      if (!m) throw new U.NotFound('no such endpoint');

      ctx = { ip, auth: currentUser(req), db, cfg };
      const out = await m.route.handler(ctx, req, res, m.params);
      if (!res.writableEnded) U.sendJson(res, 200, out ?? { ok: true });
      if (level >= LEVELS.debug) logLine(req.method, pathname, 200, Date.now() - started);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) {
        console.error(`[500] ${req.method} ${pathname}: ${e.stack || e.message}`);
      } else if (level >= LEVELS.info) {
        // Why a request was refused. The single most useful line in this file while
        // anything is being built, and until now it was visible nowhere: the server only
        // logged its own faults, never the ones it was reporting back to a client.
        const who = ctx?.auth?.user ? `user:${ctx.auth.user.id}` : 'anon';
        logLine(req.method, pathname, status, Date.now() - started, `${who}  ${e.message}`);
      }
      if (!res.writableEnded) {
        // A rejected oversized body leaves unread bytes on the wire, so close the
        // connection after answering rather than trying to reuse it.
        if (status === 413) res.setHeader('connection', 'close');
        U.sendJson(res, status, { error: status >= 500 ? 'internal error' : e.message });
      }
    } finally {
      if (Date.now() - started > 1000) {
        console.warn(`[slow] ${req.method} ${pathname} ${Date.now() - started}ms`);
      }
    }
  });

  let sweeper = null;
  let heartbeats = null;

  function start() {
    // Bootstrap: an admin token so the panel is reachable before any account exists.
    if (!cfg.adminToken) {
      cfg.adminToken = crypto.randomBytes(24).toString('base64url');
      configMod.save({ adminToken: cfg.adminToken });
      console.log(`\n  Admin token written to config.json:\n  ${cfg.adminToken}\n`);
    }
    crash.start();
    // The chain is created here rather than on the first wallet registration. It used to
    // be lazy, which meant whoever signed up first silently triggered a 21,000,000-tugrik
    // genesis mint inside their own request. Idempotent: it returns immediately if a head
    // already exists.
    tokenchain.ensureGenesis(db, cfg);

    // Rate-limit rows, and tables nobody is coming back to.
    //
    // Run once on the way up as well as on the timer: a server that was down for a day
    // comes back to challenges that expired while it was off, and those stakes should be
    // released now rather than ten minutes from now.
    // Before anything else looks at a clock: an outage is not a player thinking.
    try {
      const credited = matches.creditDowntime(db, cfg);
      if (credited.matches && level >= LEVELS.info) {
        console.log(`  gave back ${Math.round(credited.down / 1000)}s of downtime `
          + `to ${credited.matches} table(s)`);
      }
    } catch (e) {
      console.error(`  downtime credit failed: ${e.message}`);
    }
    const beat = setInterval(() => {
      try { matches.heartbeat(db); } catch { /* the next one will do */ }
    }, (cfg.match.heartbeatSeconds || 15) * 1000);
    beat.unref?.();
    heartbeats = beat;

    const housekeeping = () => {
      limits.sweep(db);
      try {
        const swept = matches.sweep(db, cfg);
        const touched = swept.expired + swept.resolved + swept.refunded + swept.failed;
        if (touched && level >= LEVELS.info) {
          console.log(`  match sweep: ${swept.expired} expired, ${swept.resolved} settled, `
            + `${swept.refunded} refunded, ${swept.failed} failed`);
        }
      } catch (e) {
        // Housekeeping must never take the server down with it.
        console.error(`  match sweep failed: ${e.message}`);
      }
    };
    housekeeping();
    sweeper = setInterval(housekeeping, 600000);
    sweeper.unref?.();

    return new Promise((resolve) => {
      server.listen(cfg.port, cfg.host, () => {
        const supply = tokenchain.supply(db);
        console.log(`  ${cfg.siteName} listening on http://${cfg.host}:${cfg.port}`);
        // `circulating` counts the treasury too, so what players actually hold is the
        // difference. Printing `circulating` here would read as if every tugrik were out.
        const held = supply.circulating - supply.treasury;
        console.log(`  treasury: ${U.formatAmount(supply.treasury)} ${cfg.token.symbol}`
          + `   held by players: ${U.formatAmount(held)} ${cfg.token.symbol}`);
        console.log(`  log level: ${cfg.logLevel}   (CASINO_LOG=debug logs every request)`);
        if (supply.treasury === 0) {
          console.log('  the treasury is empty: new players will not receive a welcome grant');
        }
        resolve(server);
      });
    });
  }

  function stop() {
    crash.stop();
    if (sweeper) clearInterval(sweeper);
    if (heartbeats) clearInterval(heartbeats);
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, db, cfg, crash, geo, start, stop };
}

if (require.main === module) {
  const cfg = configMod.load();
  const app = build(cfg);
  app.start().catch((e) => {
    console.error(`failed to start: ${e.message}`);
    process.exit(1);
  });
  const bye = () => { app.stop().finally(() => process.exit(0)); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { build };
