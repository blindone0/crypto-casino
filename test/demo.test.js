'use strict';
// Free-play mode. The whole feature rests on one guarantee: play money and real money
// never touch. These tests exist to make that guarantee fail loudly if it is ever broken,
// because the failure mode is the worst kind -- the bankroll quietly paying out fake wins.
const test = require('node:test');
const assert = require('node:assert');
const { testConfig, cleanup } = require('./helpers');
const { build } = require('../src/server');
const ledger = require('../src/ledger');
const U = require('../src/util');

function makeClient(base) {
  let cookie = '';
  let csrf = null;
  return {
    async call(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
      const h = { ...headers };
      if (body !== undefined) h['content-type'] = 'application/json';
      if (cookie) h.cookie = cookie;
      if (csrf && method !== 'GET' && !('x-csrf-token' in h)) h['x-csrf-token'] = csrf;
      const res = await fetch(base + path, {
        method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        if (pair.startsWith('sid=')) cookie = pair;
      }
      const data = await res.json().catch(() => null);
      if (data?.csrf) csrf = data.csrf;
      return raw ? { status: res.status, data } : data;
    },
  };
}

async function boot(overrides) {
  const cfg = testConfig(overrides);
  const app = build(cfg);
  await app.start();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = makeClient(base);
  await client.call('/api/admin/bankroll', {
    method: 'POST', body: { action: 'add', amount: '1000' }, headers: { 'x-admin-token': cfg.adminToken },
  });
  await client.call('/api/auth/register',
    { method: 'POST', body: { username: 'skint', password: 'longpassword1' } });
  return { cfg, app, base, client };
}

const shutdown = async (app, cfg) => { await app.stop(); cleanup(cfg, app.db); };

test('someone with no money can still play, but only with play money', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));

  const me = await client.call('/api/me');
  assert.strictEqual(me.user.balance, 0, 'faucet is off in tests, so this account is broke');
  assert.ok(me.demoBalance > 0, 'but it still gets a practice balance');

  const real = await client.call('/api/bet/dice',
    { method: 'POST', body: { amount: '1', target: 5000, mode: 'under' }, raw: true });
  assert.strictEqual(real.status, 400);
  assert.match(real.data.error, /insufficient funds/);

  const demo = await client.call('/api/bet/dice',
    { method: 'POST', body: { amount: '1', target: 5000, mode: 'under', wallet: 'demo' } });
  assert.ok(typeof demo.won === 'boolean', 'the same bet works with play money');
});

test('play money never moves the bankroll or the books', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));

  const bankrollBefore = ledger.bankroll(app.db);
  const liabilitiesBefore = ledger.playerLiabilities(app.db);

  for (let i = 0; i < 40; i += 1) {
    await client.call('/api/bet/dice', {
      method: 'POST',
      body: { amount: '5', target: 9000, mode: 'under', wallet: 'demo' },
    });
  }

  assert.strictEqual(ledger.bankroll(app.db), bankrollBefore, 'bankroll must be untouched');
  assert.strictEqual(ledger.playerLiabilities(app.db), liabilitiesBefore,
    'play balances are not money owed');
  assert.ok(ledger.auditBalances(app.db).ok, 'the real books must still balance');
  assert.strictEqual(app.db.get('SELECT COUNT(*) AS n FROM bets').n, 0,
    'no play bet may appear in the real bet log');
  assert.strictEqual(app.db.get('SELECT COUNT(*) AS n FROM demo_bets').n, 40);
});

test('operator revenue reporting ignores play money entirely', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));
  const admin = { 'x-admin-token': cfg.adminToken };

  for (let i = 0; i < 10; i += 1) {
    await client.call('/api/bet/slots', { method: 'POST', body: { amount: '2', wallet: 'demo' } });
  }
  const ov = await client.call('/api/admin/overview', { headers: admin });
  assert.strictEqual(ov.windows.all.bets, 0);
  assert.strictEqual(ov.windows.all.wagered, 0);
  assert.ok(ov.audit.ok);

  // It is still visible as engagement, just not as revenue.
  const demo = await client.call('/api/admin/demo', { headers: admin });
  assert.strictEqual(demo.bets, 10);
  assert.strictEqual(demo.players, 1);
});

test('a round opened with play money cannot be settled as real money', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));

  const bankrollBefore = ledger.bankroll(app.db);
  await client.call('/api/bet/mines/start',
    { method: 'POST', body: { amount: '5', mines: 1, wallet: 'demo' } });

  // Reveal and cash out WITHOUT claiming demo: the round itself must decide.
  let cashed = null;
  for (let tile = 0; tile < 25 && !cashed; tile += 1) {
    const r = await client.call('/api/bet/mines/reveal', { method: 'POST', body: { tile } });
    if (!r.safe) break;
    if (r.autoCashout) { cashed = r; break; }
    if (tile >= 1) cashed = await client.call('/api/bet/mines/cashout', { method: 'POST' });
  }

  assert.strictEqual(ledger.bankroll(app.db), bankrollBefore,
    'a demo round must never pay out of the bankroll, whatever the request says');
  assert.ok(ledger.auditBalances(app.db).ok);
  assert.strictEqual(app.db.get('SELECT COUNT(*) AS n FROM bets').n, 0);
  assert.strictEqual(app.db.get("SELECT mode FROM mines_games ORDER BY id DESC LIMIT 1").mode, 'demo');
});

test('play money respects the table limits and self-exclusion', async (t) => {
  const { cfg, app, base, client } = await boot();
  t.after(() => shutdown(app, cfg));

  const tooSmall = await client.call('/api/bet/dice', {
    method: 'POST', body: { amount: '0.00000001', target: 5000, mode: 'under', wallet: 'demo' }, raw: true,
  });
  assert.strictEqual(tooSmall.status, 400);

  const tooBig = await client.call('/api/bet/dice', {
    method: 'POST',
    body: { amount: U.formatAmount(cfg.risk.maxBetUnits + U.UNIT), target: 5000, mode: 'under', wallet: 'demo' },
    raw: true,
  });
  assert.strictEqual(tooBig.status, 400);

  // Someone who asked to be kept away from the games stays away from all of them.
  await client.call('/api/me/limits/self-exclude', { method: 'POST', body: { days: 3 } });
  const back = makeClient(base);
  await back.call('/api/auth/login',
    { method: 'POST', body: { username: 'skint', password: 'longpassword1' } });
  const blocked = await back.call('/api/bet/dice', {
    method: 'POST', body: { amount: '1', target: 5000, mode: 'under', wallet: 'demo' }, raw: true,
  });
  assert.strictEqual(blocked.status, 403, 'self-exclusion must cover practice mode too');
});

test('the practice balance can be refilled, but only when it is nearly gone', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));

  const early = await client.call('/api/demo/topup', { method: 'POST', raw: true });
  assert.strictEqual(early.status, 400, 'a full balance cannot be topped up');

  // Drain it down below the threshold.
  app.db.run('UPDATE demo_balances SET balance=? WHERE user_id=1', 1000);
  const r = await client.call('/api/demo/topup', { method: 'POST' });
  assert.strictEqual(r.balance, cfg.demo.topUpToUnits);
  assert.ok(ledger.auditBalances(app.db).ok, 'free money must not appear in the real ledger');
});

test('play money cannot be withdrawn', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));

  const demo = await client.call('/api/demo');
  assert.ok(demo.balance > cfg.wallet.minWithdrawalUnits, 'there is plenty of play money');

  // The withdrawal path only knows about the real ledger, so this must fail on funds.
  const r = await client.call('/api/wallet/withdraw', {
    method: 'POST', body: { address: 'mock1qdestination', amount: '50' }, raw: true,
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /insufficient funds/);
});

test('turning practice mode off closes the door', async (t) => {
  const { cfg, app, client } = await boot({ demo: { enabled: false } });
  t.after(() => shutdown(app, cfg));

  const r = await client.call('/api/bet/dice', {
    method: 'POST', body: { amount: '1', target: 5000, mode: 'under', wallet: 'demo' }, raw: true,
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /disabled/);
});

test('the dice direction field was not broken by the wallet field', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));
  // `mode` means roll direction and `wallet` means which money: overloading one field
  // for both would have made "play for free" and "roll over" the same request.
  for (const direction of ['under', 'over']) {
    const r = await client.call('/api/bet/dice', {
      method: 'POST',
      body: { amount: '1', target: direction === 'over' ? 5000 : 5000, mode: direction, wallet: 'demo' },
    });
    assert.strictEqual(r.mode, direction, 'direction must survive alongside the wallet flag');
  }
});
