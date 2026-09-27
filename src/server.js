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
const walletApi = require('./wallet');
const treasury = require('./treasury');
const bankMod = require('./bank');
const geoMod = require('./geo');
const dice = require('./games/dice');
const limbo = require('./games/limbo');
const mines = require('./games/mines');
const slots = require('./games/slots');
const preferans = require('./games/preferans');
const puzzle = require('./games/puzzle');
const crashMod = require('./games/crash');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function build(cfg) {
  const db = dbMod.open(cfg.dbPath);
  const driver = walletApi.loadDriver(cfg);
  const bankFor = (mode) => bankMod.bankFor(db, cfg, mode);
  const crash = crashMod.createCrash({ db, cfg, bankFor });
  const geo = geoMod.createGeo(cfg);
  const publicDir = path.join(cfg.root, 'public');

  // ---------------------------------------------------------------- routing
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => routes.push({
    method, parts: pattern.split('/').filter(Boolean), handler, ...opts,
  });

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
    currency: cfg.currencyLabel,
    unit: U.UNIT,
    houseEdge: cfg.houseEdge,
    risk: {
      minBetUnits: cfg.risk.minBetUnits,
      maxBetUnits: cfg.risk.maxBetUnits,
      maxMultiplier: cfg.risk.maxMultiplier,
      maxProfitPerBet: ledger.maxProfitAllowed(db, cfg),
    },
    wallet: {
      driver: driver.name,
      label: driver.label,
      minConfirmations: cfg.wallet.minConfirmations,
      minDeposit: cfg.wallet.minDepositUnits,
      minWithdrawal: cfg.wallet.minWithdrawalUnits,
      withdrawalFee: cfg.wallet.withdrawalFeeUnits,
      isMock: !!driver.isMock,
      isManual: !!driver.isManual,
      depositNote: driver.depositNote || null,
    },
    rakeback: cfg.rakeback,
    referralCommission: cfg.referralCommission,
    demo: { enabled: cfg.demo.enabled, startingUnits: cfg.demo.startingUnits },
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
      maxProfitPerBet: ledger.maxProfitAllowed(db, cfg),
      demoEnabled: cfg.demo.enabled,
      demoBalance: cfg.demo.enabled ? bankMod.demoBank(db, cfg).balance(user.id) : 0,
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
    * Build the context a game runs in. `mode` picks which bank the stake and payout move
    * through; anything but an explicit "demo" is real money. Games that persist a round
    * also get `bankFor`, so they can settle against the bank the round was opened with
    * rather than whatever the current request claims.
    */
  const gameCtx = (ctx, mode) => {
    const user = requireUser(ctx);
    limits.requireNotExcluded(user);
    const wanted = mode === 'demo' ? 'demo' : 'real';
    if (wanted === 'demo' && !cfg.demo.enabled) throw new U.BadRequest('practice mode is disabled');
    return { db, cfg, user, bank: bankFor(wanted), bankFor };
  };

  /**
   * Which bank a bet should move through. Deliberately called `wallet` and not `mode`:
   * dice already uses `mode` for the roll direction, and overloading it would have made
   * "play for free" and "roll over" the same field.
   */
  const modeOf = (src) => (src?.wallet === 'demo' ? 'demo' : 'real');

  add('POST', '/api/bet/dice', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return dice.play(gameCtx(ctx, modeOf(body)), body);
  });

  add('POST', '/api/bet/limbo', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return limbo.play(gameCtx(ctx, modeOf(body)), body);
  });

  add('POST', '/api/bet/mines/start', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return mines.start(gameCtx(ctx, modeOf(body)), body);
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
    return slots.play(gameCtx(ctx, modeOf(body)), body);
  });

  add('GET', '/api/bet/slots/info', async () => slots.info(cfg));

  // ---------------------------------------------------------------- puzzle
  add('POST', '/api/bet/puzzle/start', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return puzzle.start(gameCtx(ctx, modeOf(body)), body);
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

  // ------------------------------------------------------------- preferans
  add('POST', '/api/bet/preferans/start', async (ctx, req) => {
    checkCsrf(req, ctx);
    const body = await U.readJsonBody(req);
    return preferans.start(gameCtx(ctx, modeOf(body)), body);
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
    const mode = modeOf(body);
    const { user } = gameCtx(ctx, mode);
    return crash.placeBet(user, body, mode);
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

  // ------------------------------------------------------------ free play
  add('GET', '/api/demo', async (ctx) => {
    const user = requireUser(ctx);
    const demo = bankMod.demoBank(db, cfg);
    return {
      enabled: cfg.demo.enabled,
      balance: demo.balance(user.id),
      startingUnits: cfg.demo.startingUnits,
      topUpBelowUnits: cfg.demo.topUpBelowUnits,
      bets: demo.history(user.id, 40),
    };
  });

  add('POST', '/api/demo/topup', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    if (!cfg.demo.enabled) throw new U.BadRequest('practice mode is disabled');
    return bankMod.demoBank(db, cfg).topUp(user.id);
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

  // ---------------------------------------------------------------- wallet
  add('GET', '/api/wallet/deposit', async (ctx) => {
    const user = requireUser(ctx);
    const row = await walletApi.addressFor(db, driver, user.id);
    return {
      driver: driver.name,
      label: driver.label,
      address: row.address,
      memo: row.memo ?? null,
      minConfirmations: cfg.wallet.minConfirmations,
      note: driver.depositNote ?? null,
      isMock: !!driver.isMock,
    };
  });

  add('POST', '/api/wallet/withdraw', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    limits.requireNotExcluded(user);
    const body = await U.readJsonBody(req);
    return walletApi.requestWithdrawal(db, cfg, driver, user, body, ctx.ip);
  });

  add('GET', '/api/wallet/history', async (ctx) => {
    const user = requireUser(ctx);
    return {
      deposits: db.all(
        'SELECT id,txid,amount_units,confirmations,credited_at,created_at FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 50',
        user.id,
      ),
      withdrawals: db.all(
        'SELECT id,address,amount_units,fee_units,send_units,state,txid,requested_at FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 50',
        user.id,
      ),
    };
  });

  // Mock-driver test hook so the deposit path can be exercised without a chain.
  add('POST', '/api/wallet/simulate-deposit', async (ctx, req) => {
    const user = requireUser(ctx);
    checkCsrf(req, ctx);
    if (!driver.isMock) throw new U.Forbidden('only available with the mock wallet driver');
    const body = await U.readJsonBody(req);
    const units = U.parseAmount(body.amount ?? '1');
    const row = await walletApi.addressFor(db, driver, user.id);
    const sim = driver.simulate(row.address, units);
    await walletApi.syncDeposits(db, cfg, driver);
    return { ...sim, note: `credits after ${cfg.wallet.minConfirmations} polls`, address: row.address };
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

  add('POST', '/api/admin/users/:id/adjust', async (ctx, req, res, params) => {
    const { actor } = requireAdmin(req, ctx);
    const body = await U.readJsonBody(req);
    const sign = body.direction === 'debit' ? -1 : 1;
    const units = sign * U.parseAmount(body.amount);
    return adminApi.adjustBalance(db, U.toInt(params.id, { min: 1, name: 'id' }), units, actor, body.note);
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

  add('GET', '/api/admin/withdrawals', async (ctx, req) => {
    requireAdmin(req, ctx);
    const url = new URL(req.url, 'http://x');
    return { withdrawals: adminApi.withdrawalQueue(db, url.searchParams.get('state')) };
  });

  add('POST', '/api/admin/withdrawals/:id/decide', async (ctx, req, res, params) => {
    const { actor } = requireAdmin(req, ctx);
    const body = await U.readJsonBody(req);
    const out = walletApi.decideWithdrawal(
      db, U.toInt(params.id, { min: 1, name: 'id' }), !!body.approve, body.note, actor,
    );
    // Push it out immediately rather than waiting for the next poll.
    walletApi.processApproved(db, cfg, driver).catch(() => {});
    return out;
  });

  add('POST', '/api/admin/withdrawals/:id/mark-sent', async (ctx, req, res, params) => {
    const { actor } = requireAdmin(req, ctx);
    const body = await U.readJsonBody(req);
    return walletApi.markSent(db, U.toInt(params.id, { min: 1, name: 'id' }), body.txid, actor);
  });

  add('POST', '/api/admin/withdrawals/:id/retry', async (ctx, req, res, params) => {
    const { actor } = requireAdmin(req, ctx);
    const out = walletApi.retryWithdrawal(db, U.toInt(params.id, { min: 1, name: 'id' }), actor);
    walletApi.processApproved(db, cfg, driver).catch(() => {});
    return out;
  });

  add('POST', '/api/admin/deposits/credit', async (ctx, req) => {
    const { actor } = requireAdmin(req, ctx);
    const body = await U.readJsonBody(req);
    return walletApi.creditManualDeposit(db, cfg, driver, {
      userId: U.toInt(body.userId, { min: 1, name: 'userId' }),
      amountUnits: U.parseAmount(body.amount),
      txid: body.txid,
      address: body.address,
    }, actor);
  });

  // -------------------------------------------------------------- treasury
  add('GET', '/api/admin/treasury', async (ctx, req) => {
    requireAdmin(req, ctx);
    return {
      addresses: treasury.list(cfg),
      exposure: treasury.exposure(db, cfg),
      minPayout: cfg.treasury.minPayoutUnits,
      requireWhitelist: cfg.treasury.requireWhitelist,
      totalPaidOut: treasury.totalPaidOut(db),
      history: treasury.history(db, 50),
      activeDriver: driver.name,
      isManual: !!driver.isManual,
    };
  });

  add('POST', '/api/admin/treasury/addresses', async (ctx, req) => {
    const { actor } = requireAdmin(req, ctx);
    const body = await U.readJsonBody(req);
    const out = treasury.addAddress(cfg, body);
    db.audit(actor, 'treasury.address.add', out.added);
    return out;
  });

  add('POST', '/api/admin/treasury/addresses/remove', async (ctx, req) => {
    const { actor } = requireAdmin(req, ctx);
    const body = await U.readJsonBody(req);
    const out = treasury.removeAddress(cfg, body.address);
    db.audit(actor, 'treasury.address.remove', out);
    return out;
  });

  add('POST', '/api/admin/treasury/payout', async (ctx, req) => {
    const { actor } = requireAdmin(req, ctx);
    const body = await U.readJsonBody(req);
    return treasury.payout(db, cfg, driver, body, actor);
  });

  add('POST', '/api/admin/treasury/payout/:id/mark-sent', async (ctx, req, res, params) => {
    const { actor } = requireAdmin(req, ctx);
    const body = await U.readJsonBody(req);
    return treasury.markPayoutSent(db, U.toInt(params.id, { min: 1, name: 'id' }), body.txid, actor);
  });

  add('POST', '/api/admin/treasury/payout/:id/cancel', async (ctx, req, res, params) => {
    const { actor } = requireAdmin(req, ctx);
    return treasury.cancelPayout(db, U.toInt(params.id, { min: 1, name: 'id' }), actor);
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

  add('GET', '/api/admin/wallet', async (ctx, req) => {
    requireAdmin(req, ctx);
    try {
      return { driver: driver.name, info: await driver.info() };
    } catch (e) {
      return { driver: driver.name, error: e.message };
    }
  });

  // ------------------------------------------------------------ static files
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html'
      : pathname === '/admin' ? 'admin.html'
        : pathname === '/verify' ? 'verify.html'
          : pathname.replace(/^\/+/, '');
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

    try {
      limits.enforce(db, cfg, ip, pathname);
      const m = match(req.method, pathname);
      if (!m) throw new U.NotFound('no such endpoint');

      const ctx = { ip, auth: currentUser(req), db, cfg };
      const out = await m.route.handler(ctx, req, res, m.params);
      if (!res.writableEnded) U.sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) {
        console.error(`[500] ${req.method} ${pathname}: ${e.stack || e.message}`);
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

  let stopPoller = null;
  let sweeper = null;

  function start() {
    // Bootstrap: an admin token so the panel is reachable before any account exists.
    if (!cfg.adminToken) {
      cfg.adminToken = crypto.randomBytes(24).toString('base64url');
      configMod.save({ adminToken: cfg.adminToken });
      console.log(`\n  Admin token written to config.json:\n  ${cfg.adminToken}\n`);
    }
    crash.start();
    stopPoller = walletApi.startPoller(db, cfg, driver);
    sweeper = setInterval(() => limits.sweep(db), 600000);
    sweeper.unref?.();

    return new Promise((resolve) => {
      server.listen(cfg.port, cfg.host, () => {
        const bank = U.formatAmount(ledger.bankroll(db));
        console.log(`  ${cfg.siteName} listening on http://${cfg.host}:${cfg.port}`);
        console.log(`  wallet driver: ${driver.name}   bankroll: ${bank} ${cfg.currencyLabel}`);
        if (ledger.bankroll(db) === 0) {
          console.log('  bankroll is empty: fund it in the admin panel or no bets can be accepted');
        }
        resolve(server);
      });
    });
  }

  function stop() {
    crash.stop();
    if (stopPoller) stopPoller();
    if (sweeper) clearInterval(sweeper);
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, db, cfg, driver, crash, geo, start, stop };
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
