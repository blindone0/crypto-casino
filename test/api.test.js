'use strict';
// End-to-end tests against a real HTTP server: the full path a player or operator takes,
// plus the security controls that are supposed to stop the paths they should not take.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, cleanup } = require('./helpers');
const { build } = require('../src/server');
const U = require('../src/util');
const tc = require('../src/tokenchain');

const TUG = 100000000;

/** Tiny client that remembers cookies and the CSRF token, like a browser would. */
function makeClient(base) {
  let cookie = '';
  let csrf = null;
  return {
    get csrf() { return csrf; },
    setCsrf(v) { csrf = v; },
    clear() { cookie = ''; csrf = null; },
    async call(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
      const h = { ...headers };
      if (body !== undefined) h['content-type'] = 'application/json';
      if (cookie) h.cookie = cookie;
      if (csrf && method !== 'GET' && !('x-csrf-token' in h)) h['x-csrf-token'] = csrf;
      const res = await fetch(base + path, {
        method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.getSetCookie?.() ?? [];
      for (const c of set) {
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
  return { cfg, app, base, client: makeClient(base) };
}

async function shutdown(app, cfg) {
  await app.stop();
  cleanup(cfg, app.db);
}

const admin = (cfg) => ({ 'x-admin-token': cfg.adminToken });

/**
 * Register, then create the tugrik wallet the way the browser does: a key derived on the
 * client and posted to the server, which pays the welcome grant out of the treasury.
 *
 * This is how a player gets money now. There is no deposit to make and no bankroll to
 * credit them from — the grant is the only way tugriks reach a new account.
 */
async function wallet(client, username, password = 'longpassword1') {
  const reg = await client.call('/api/auth/register', { method: 'POST', body: { username, password } });
  const seed = crypto.randomBytes(32).toString('hex');
  const priv = tc.privateKeyFromSeed(seed);
  const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
  await client.call('/api/token/key', { method: 'POST', body: { pubkey: pub } });
  return { reg, priv, pub };
}

/**
 * Put tugriks in the house so it can pay a win.
 *
 * The house builds its float from losing bets in normal play; a fresh test server has
 * none, and `capPayout` will not promise more than the house holds — correctly, since the
 * supply is fixed and the chain would refuse the block. So the float is seeded from the
 * treasury, which is the only place tugriks come from.
 */
function fundHouse(app, units) {
  const matches = require('../src/match');
  const house = matches.houseKey(app.db).publicRaw;
  tc.appendBlock(app.db, [tc.treasuryTransfer(app.db, house, units)]);
}

/**
 * Sign a stake to the house, exactly as public/app.js does before every bet.
 *
 * Every bet is a transfer on the chain now, so nothing can be wagered without this: the
 * operator cannot place a bet on someone's behalf, which is the property the whole token
 * design exists to give.
 */
async function spendFor(client, w, amountUnits) {
  const info = await client.call('/api/token');
  const tx = {
    type: 'transfer', from: w.pub, to: info.houseKey, amount: amountUnits, nonce: info.nextNonce,
  };
  const sig = crypto.sign(null, Buffer.from(tc.canonical(tc.transferPayload(tx))), w.priv).toString('hex');
  return { from: w.pub, nonce: tx.nonce, sig };
}

test('a player registers, is granted tugriks, bets and it lands on the chain', async (t) => {
  const { cfg, app, base, client } = await boot();
  t.after(() => shutdown(app, cfg));

  const w = await wallet(client, 'alice');
  assert.strictEqual(w.reg.user.username, 'alice');
  assert.strictEqual(w.reg.user.role, 'admin', 'the first account becomes the operator');
  assert.match(w.reg.user.serverSeedHash, /^[0-9a-f]{64}$/);

  // No deposit anywhere in this test, which is the point: registering a wallet is what
  // funds an account now, out of a fixed supply rather than out of thin air.
  const info = await client.call('/api/token');
  assert.strictEqual(info.balance, cfg.token.welcomeGrant);
  fundHouse(app, 100 * TUG);

  const spend = await spendFor(client, w, 2 * TUG);
  const bet = await client.call('/api/bet/dice',
    { method: 'POST', body: { amount: '2', target: 5000, mode: 'under', spend } });
  assert.ok(typeof bet.won === 'boolean');
  assert.strictEqual(bet.multiplier, 1.98);
  assert.strictEqual(bet.payout, bet.won ? U.mulUnits(bet.wager, 1.98) : 0);

  // The stake really moved on the chain, and the chain still verifies.
  const after = await client.call('/api/token');
  const expected = cfg.token.welcomeGrant - 2 * TUG + (bet.won ? bet.payout : 0);
  assert.strictEqual(after.balance, expected, 'the balance is whatever the chain says');
  assert.strictEqual(tc.verifyChain(app.db).ok, true);

  const ov = await client.call('/api/admin/overview', { headers: admin(cfg) });
  assert.strictEqual(ov.windows.all.bets, 1, 'the round is written down once');
  assert.strictEqual(ov.windows.all.wagered, 2 * TUG);
});

test('a bet beyond the balance is refused and nothing moves', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));
  const w = await wallet(client, 'broke');

  const tooMuch = cfg.token.welcomeGrant + 10 * TUG;
  const spend = await spendFor(client, w, tooMuch);
  const r = await client.call('/api/bet/dice',
    { method: 'POST', body: { amount: String(tooMuch / TUG), target: 5000, mode: 'under', spend }, raw: true });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /not enough tugriks|table maximum/);

  const info = await client.call('/api/token');
  assert.strictEqual(info.balance, cfg.token.welcomeGrant, 'not a single tugrik moved');
  const ov = await client.call('/api/admin/overview', { headers: admin(cfg) });
  assert.strictEqual(ov.windows.all.bets, 0, 'a refused bet must not be recorded');
});

test('dice rejects out-of-range targets', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));
  const w = await wallet(client, 'edge');
  fundHouse(app, 100 * TUG);
  for (const target of [0, 50, 9999, 9990]) {
    const r = await client.call('/api/bet/dice',
      { method: 'POST', body: { amount: '1', target, mode: 'under', spend: await spendFor(client, w, TUG) }, raw: true });
    assert.strictEqual(r.status, 400, `target ${target} should be refused`);
  }
});

test('mines pays the ladder and refuses a second concurrent round', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));
  const w = await wallet(client, 'miner');
  fundHouse(app, 100 * TUG);

  const g = await client.call('/api/bet/mines/start', { method: 'POST', body: { amount: '1', mines: 3, spend: await spendFor(client, w, TUG) } });
  assert.strictEqual(g.mineCount, 3);
  assert.strictEqual(g.state, 'active');

  const dup = await client.call('/api/bet/mines/start',
    { method: 'POST', body: { amount: '1', mines: 3, spend: await spendFor(client, w, TUG) }, raw: true });
  assert.strictEqual(dup.status, 400);
  assert.match(dup.data.error, /current mines round/);

  // Reveal until we either bust or bank a win; both outcomes must settle cleanly.
  let result = null;
  for (let tile = 0; tile < 25; tile += 1) {
    const r = await client.call('/api/bet/mines/reveal', { method: 'POST', body: { tile } });
    if (!r.safe) { result = 'lost'; assert.ok(Array.isArray(r.mines)); break; }
    if (r.autoCashout) { result = 'cashed'; break; }
    if (tile >= 1) {
      const c = await client.call('/api/bet/mines/cashout', { method: 'POST' });
      assert.ok(c.payout > 0);
      result = 'cashed';
      break;
    }
  }
  assert.ok(result, 'the round must reach a terminal state');
  const ov = await client.call('/api/admin/overview', { headers: admin(cfg) });
  assert.ok(ov.audit.ok);
  assert.strictEqual(ov.windows.all.perGame.find((x) => x.game === 'mines').bets, 1);
});

test('mines will not reveal the same tile twice', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));
  const w = await wallet(client, 'twice');
  fundHouse(app, 100 * TUG);
  await client.call('/api/bet/mines/start', { method: 'POST', body: { amount: '1', mines: 1 } });
  const first = await client.call('/api/bet/mines/reveal', { method: 'POST', body: { tile: 0 } });
  if (first.safe) {
    const again = await client.call('/api/bet/mines/reveal', { method: 'POST', body: { tile: 0 }, raw: true });
    assert.strictEqual(again.status, 400);
    assert.match(again.data.error, /already revealed/);
  }
});

test('provably fair: a bet replays to the same result after the seed is revealed', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));
  const fair = require('../src/fair');

  const w = await wallet(client, 'auditor');
  fundHouse(app, 100 * TUG);

  const committed = (await client.call('/api/fair/seed')).serverSeedHash;
  const bet = await client.call('/api/bet/dice',
    { method: 'POST', body: { amount: '1', target: 2500, mode: 'under', spend: await spendFor(client, w, TUG) } });

  const rot = await client.call('/api/me/rotate-seed', { method: 'POST' });
  assert.strictEqual(rot.revealedHash, committed, 'the revealed seed must be the committed one');
  assert.strictEqual(fair.sha256hex(rot.revealedSeed), committed);

  const me = await client.call('/api/me');
  const v = await client.call('/api/fair/verify', {
    method: 'POST',
    body: {
      game: 'dice', serverSeed: rot.revealedSeed, clientSeed: me.user.clientSeed,
      nonce: bet.nonce, target: 2500, mode: 'under',
    },
  });
  assert.strictEqual(v.result.roll, bet.roll, 'independent replay must reproduce the roll');
});

test('changing the client seed rotates the chain and resets the counter', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));
  await client.call('/api/auth/register',
    { method: 'POST', body: { username: 'seeder', password: 'longpassword1' } });

  const before = await client.call('/api/fair/seed');
  const out = await client.call('/api/me/client-seed', { method: 'POST', body: { seed: 'my-own-seed' } });
  assert.strictEqual(out.user.clientSeed, 'my-own-seed');
  assert.notStrictEqual(out.user.serverSeedHash, before.serverSeedHash);
  assert.strictEqual(out.user.nonce, 0);

  const bad = await client.call('/api/me/client-seed', { method: 'POST', body: { seed: '' }, raw: true });
  assert.strictEqual(bad.status, 400);
});

test('mutating requests without a CSRF token are refused', async (t) => {
  const { cfg, app, client } = await boot();
  t.after(() => shutdown(app, cfg));
  await client.call('/api/admin/bankroll',
    { method: 'POST', body: { action: 'add', amount: '100' }, headers: admin(cfg) });
  await client.call('/api/auth/register',
    { method: 'POST', body: { username: 'victim', password: 'longpassword1' } });

  const r = await client.call('/api/bet/dice', {
    method: 'POST',
    body: { amount: '0.01', target: 5000, mode: 'under' },
    headers: { 'x-csrf-token': 'wrong-token' },
    raw: true,
  });
  assert.strictEqual(r.status, 403);
  assert.match(r.data.error, /CSRF/);
});

test('admin endpoints reject a bad token and a non-admin session', async (t) => {
  const { cfg, app, base, client } = await boot();
  t.after(() => shutdown(app, cfg));

  const anon = await fetch(`${base}/api/admin/overview`);
  assert.strictEqual(anon.status, 403);

  const wrong = await fetch(`${base}/api/admin/overview`, { headers: { 'x-admin-token': 'nope' } });
  assert.strictEqual(wrong.status, 403);

  // First account is the operator; a second one is an ordinary player.
  await client.call('/api/auth/register',
    { method: 'POST', body: { username: 'first', password: 'longpassword1' } });
  const player = makeClient(base);
  await player.call('/api/auth/register',
    { method: 'POST', body: { username: 'second', password: 'longpassword1' } });
  const r = await player.call('/api/admin/overview', { raw: true });
  assert.strictEqual(r.status, 403);
});

test('signed-out callers cannot reach player endpoints', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(() => shutdown(app, cfg));
  for (const path of ['/api/me', '/api/token', '/api/fair/seed', '/api/me/bets']) {
    const res = await fetch(base + path);
    assert.strictEqual(res.status, 401, `${path} should require a session`);
  }
});

test('registration rejects weak input and duplicate names', async (t) => {
  const { cfg, app, base, client } = await boot();
  t.after(() => shutdown(app, cfg));

  const bad = [
    { username: 'ab', password: 'longpassword1' },
    { username: 'has space', password: 'longpassword1' },
    { username: 'fine', password: 'short' },
  ];
  for (const body of bad) {
    const r = await client.call('/api/auth/register', { method: 'POST', body, raw: true });
    assert.strictEqual(r.status, 400, `should reject ${JSON.stringify(body)}`);
  }
  await client.call('/api/auth/register',
    { method: 'POST', body: { username: 'taken', password: 'longpassword1' } });
  const dup = await makeClient(base).call('/api/auth/register',
    { method: 'POST', body: { username: 'TAKEN', password: 'longpassword1' }, raw: true });
  assert.strictEqual(dup.status, 400, 'names must be unique case-insensitively');
});

test('a wrong password fails and does not reveal whether the user exists', async (t) => {
  const { cfg, app, base, client } = await boot();
  t.after(() => shutdown(app, cfg));
  await client.call('/api/auth/register',
    { method: 'POST', body: { username: 'real', password: 'longpassword1' } });

  const c = makeClient(base);
  const wrongPw = await c.call('/api/auth/login',
    { method: 'POST', body: { username: 'real', password: 'wrongpassword' }, raw: true });
  const noUser = await c.call('/api/auth/login',
    { method: 'POST', body: { username: 'ghost', password: 'wrongpassword' }, raw: true });
  assert.strictEqual(wrongPw.status, 401);
  assert.strictEqual(noUser.status, 401);
  assert.strictEqual(wrongPw.data.error, noUser.data.error, 'errors must be indistinguishable');
});

test('rate limiting kicks in on the auth endpoints', async (t) => {
  const { cfg, app, base } = await boot({ rateLimits: { '/api/auth': [5, 60], default: [600, 60] } });
  t.after(() => shutdown(app, cfg));

  let sawLimit = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `u${i}`, password: 'wrongpassword' }),
    });
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'repeated login attempts should be throttled');
});

test('static files are served and directory traversal is blocked', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(() => shutdown(app, cfg));

  const page = await fetch(`${base}/`);
  assert.strictEqual(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);

  for (const path of ['/../config.json', '/../src/config.js', '/..%2fconfig.json']) {
    const res = await fetch(base + path);
    assert.ok(res.status === 403 || res.status === 404, `${path} must not be served (${res.status})`);
    const body = await res.text();
    assert.ok(!body.includes('adminToken'), 'config must never leak');
  }
});

test('oversized and malformed bodies are rejected cleanly', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(() => shutdown(app, cfg));

  const huge = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'x'.repeat(200000), password: 'y' }),
  });
  assert.strictEqual(huge.status, 413, 'an oversized body must get a clean 413, not a reset');
  assert.match((await huge.json()).error, /too large/);

  const junk = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  assert.strictEqual(junk.status, 400);
});

test('self-exclusion locks the account out of betting', async (t) => {
  const { cfg, app, base, client } = await boot();
  t.after(() => shutdown(app, cfg));
  const w = await wallet(client, 'breaker');
  fundHouse(app, 100 * TUG);
  await client.call('/api/me/limits/self-exclude', { method: 'POST', body: { days: 7 } });

  // Self-exclusion also kills every session, so signing back in is the only way to test.
  const back = makeClient(base);
  await back.call('/api/auth/login',
    { method: 'POST', body: { username: 'breaker', password: 'longpassword1' } });
  const r = await back.call('/api/bet/dice',
    { method: 'POST', body: { amount: '0.01', target: 5000, mode: 'under' }, raw: true });
  assert.strictEqual(r.status, 403);
  assert.match(r.data.error, /self-exclusion/);
});

test('crash exposes a commitment and a verifiable chain', async (t) => {
  // Fast pacing so the test is deterministic. A production round can run for a minute
  // when the crash point is high, which is exactly what used to make this flaky.
  // growth only changes how fast the multiplier climbs, never the crash distribution.
  const { cfg, app, client } = await boot({
    crash: { bettingMs: 250, endedMs: 150, tickMs: 25, growth: 4, chainLength: 40 },
  });
  t.after(() => shutdown(app, cfg));
  const fair = require('../src/fair');

  const conf = await client.call('/api/config');
  assert.match(conf.crashCommitment, /^[0-9a-f]{64}$/);

  // Wait for at least one round to finish so a seed has been revealed.
  const deadline = Date.now() + 20000;
  let chain = await client.call('/api/fair/crash-chain');
  while (chain.rounds.length < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    chain = await client.call('/api/fair/crash-chain');
  }
  assert.ok(chain.rounds.length >= 1, 'at least one round should have ended');

  const ordered = [...chain.rounds].sort((a, b) => a.id - b.id);
  for (const [i, round] of ordered.entries()) {
    const expected = i === 0 ? chain.commitment : ordered[i - 1].seed;
    assert.strictEqual(fair.sha256hex(round.seed), expected,
      `round ${round.id} does not hash to its predecessor`);
    assert.strictEqual(fair.sha256hex(round.seed), round.seed_hash === expected
      ? expected : fair.sha256hex(round.seed));
    assert.ok(round.crash_point >= 1);
  }
});
