'use strict';
// The match routes, over real HTTP.
//
// src/match.js is tested directly in match.test.js. This file exists because a module can
// be perfectly correct and still be unreachable: the first version of these routes threw
// on every request, because build() declares a local `match(method, pathname)` for route
// lookup and a function declaration shadows the module import inside it. Nothing that
// tests the module in isolation can catch that. Only asking the server can.
//
// So these tests are deliberately shallow and deliberately end-to-end: every route is
// called at least once, and the ones that move money are called by two real accounts
// playing a real game to a real finish.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, cleanup } = require('./helpers');
const { build } = require('../src/server');
const tc = require('../src/tokenchain');

// A tugrik is divisible to eight places, like everything else here, so every stake below
// is written as whole tugriks times TUG. Bare numbers would be hundred-millionths of a
// coin and far under the table minimum.
const TUG = 100000000;

function makeClient(base) {
  let cookie = '';
  let csrf = null;
  return {
    async call(path, { method = 'GET', body } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
      const res = await fetch(base + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        if (pair.startsWith('sid=')) cookie = pair;
      }
      const data = await res.json().catch(() => null);
      if (data?.csrf) csrf = data.csrf;
      return { status: res.status, data };
    },
  };
}

async function boot(overrides) {
  const cfg = testConfig(overrides);
  const app = build(cfg);
  await app.start();
  return { cfg, app, base: `http://127.0.0.1:${app.server.address().port}` };
}

/**
 * A signed-in player with a token wallet, the way the browser sets one up: a key derived
 * locally, registered with the server, which mints the welcome grant on the chain.
 */
async function player(base, username) {
  const client = makeClient(base);
  const reg = await client.call('/api/auth/register', {
    method: 'POST', body: { username, password: 'Correct-Horse-9' },
  });
  assert.strictEqual(reg.status, 200, `register failed: ${JSON.stringify(reg.data)}`);

  const seed = crypto.randomBytes(32).toString('hex');
  const priv = tc.privateKeyFromSeed(seed);
  const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
  const out = await client.call('/api/token/key', { method: 'POST', body: { pubkey: pub } });
  assert.strictEqual(out.status, 200, `token register failed: ${JSON.stringify(out.data)}`);
  return { client, priv, pub, username };
}

/** Sign a stake into escrow, exactly as public/app.js does it. */
async function stake(p, amount) {
  const { data: lobby } = await p.client.call('/api/match');
  const tx = {
    type: 'transfer', from: p.pub, to: lobby.houseKey, amount, nonce: lobby.nextNonce,
  };
  const sig = crypto.sign(
    null, Buffer.from(tc.canonical(tc.transferPayload(tx))), p.priv,
  ).toString('hex');
  return { from: p.pub, nonce: tx.nonce, sig };
}

test('every match route answers, and a full game settles over HTTP', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(async () => { await app.stop(); cleanup(cfg, app.db); });

  const alice = await player(base, 'alice');
  const bob = await player(base, 'bob');

  // --- the lobby is reachable at all. This is the assertion the shadowing bug failed.
  const lobby = await alice.client.call('/api/match');
  assert.strictEqual(lobby.status, 200, `lobby: ${JSON.stringify(lobby.data)}`);
  assert.ok(lobby.data.games.some((g) => g.key === 'chess'));
  assert.strictEqual(lobby.data.symbol, cfg.token.symbol);
  assert.match(lobby.data.houseKey, /^[0-9a-f]{64}$/);
  assert.strictEqual(lobby.data.balance, cfg.token.welcomeGrant);

  // --- post a challenge
  const made = await alice.client.call('/api/match/create', {
    method: 'POST',
    body: { game: 'chess', stake: 100 * TUG, spend: await stake(alice, 100 * TUG) },
  });
  assert.strictEqual(made.status, 200, `create: ${JSON.stringify(made.data)}`);
  const id = made.data.id;

  // Bob sees it waiting.
  const seen = await bob.client.call('/api/match');
  assert.ok(seen.data.open.some((m) => m.id === id && m.host === 'alice'));

  // --- take it up
  const joined = await bob.client.call('/api/match/join', {
    method: 'POST', body: { id, spend: await stake(bob, 100 * TUG) },
  });
  assert.strictEqual(joined.status, 200, `join: ${JSON.stringify(joined.data)}`);

  // --- the board is visible to both, from each one's own side
  const aView = await alice.client.call(`/api/match/one?id=${id}`);
  const bView = await bob.client.call(`/api/match/one?id=${id}`);
  assert.strictEqual(aView.status, 200);
  assert.strictEqual(aView.data.seat, 0);
  assert.strictEqual(bView.data.seat, 1);
  assert.strictEqual(aView.data.view.fen, bView.data.view.fen);
  assert.strictEqual(aView.data.view.legal.length, 20);

  const players = [alice, bob];

  // --- an illegal move is refused by the server, not merely discouraged by the client
  const mover = players[aView.data.toMove];
  const bad = await mover.client.call('/api/match/move', {
    method: 'POST', body: { id, move: 'e2e5' },
  });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.data.error, /illegal move/);

  // --- a move by the player whose turn it is not
  const waiting = players[1 - aView.data.toMove];
  const wrongTurn = await waiting.client.call('/api/match/move', {
    method: 'POST', body: { id, move: 'e7e5' },
  });
  assert.strictEqual(wrongTurn.status, 400);
  assert.match(wrongTurn.data.error, /not your turn/);

  // --- play Fool's mate to a finish
  for (const m of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    const { data: view } = await alice.client.call(`/api/match/one?id=${id}`);
    const res = await players[view.toMove].client.call('/api/match/move', {
      method: 'POST', body: { id, move: m },
    });
    assert.strictEqual(res.status, 200, `move ${m}: ${JSON.stringify(res.data)}`);
  }

  const done = await alice.client.call(`/api/match/one?id=${id}`);
  assert.strictEqual(done.data.status, 'done');
  assert.strictEqual(done.data.reason, 'checkmate');
  assert.deepStrictEqual(done.data.view.san, ['f3', 'e5', 'g4', 'Qh4#']);

  // --- the pot moved, less the rake
  const rake = Math.floor(200 * TUG * cfg.match.rake);
  const after = await alice.client.call('/api/match');
  const loserPaid = cfg.token.welcomeGrant - 100 * TUG;
  const winnerPaid = cfg.token.welcomeGrant - 100 * TUG + (200 * TUG - rake);
  assert.ok([loserPaid, winnerPaid].includes(after.data.balance),
    `unexpected balance ${after.data.balance}`);
});

test('the routes that move money refuse a request without a CSRF token', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(async () => { await app.stop(); cleanup(cfg, app.db); });
  const alice = await player(base, 'alice');
  const spend = await stake(alice, 100 * TUG);

  const res = await fetch(`${base}/api/match/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'chess', stake: 100 * TUG, spend }),
  });
  assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
});

test('the routes that move money refuse a stranger', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(async () => { await app.stop(); cleanup(cfg, app.db); });

  const alice = await player(base, 'alice');
  const bob = await player(base, 'bob');
  const carol = await player(base, 'carol');

  const made = await alice.client.call('/api/match/create', {
    method: 'POST', body: { game: 'chess', stake: 100 * TUG, spend: await stake(alice, 100 * TUG) },
  });
  const id = made.data.id;
  await bob.client.call('/api/match/join', {
    method: 'POST', body: { id, spend: await stake(bob, 100 * TUG) },
  });

  for (const [path, body] of [
    ['/api/match/move', { id, move: 'e2e4' }],
    ['/api/match/resign', { id }],
    ['/api/match/timeout', { id }],
    ['/api/match/cancel', { id }],
  ]) {
    const res = await carol.client.call(path, { method: 'POST', body });
    assert.ok(res.status >= 400, `${path} let a stranger in with ${res.status}`);
  }

  // The game is still going, untouched.
  const view = await alice.client.call(`/api/match/one?id=${id}`);
  assert.strictEqual(view.data.status, 'playing');
});

test('resigning over HTTP settles the match', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(async () => { await app.stop(); cleanup(cfg, app.db); });

  const alice = await player(base, 'alice');
  const bob = await player(base, 'bob');
  const made = await alice.client.call('/api/match/create', {
    method: 'POST', body: { game: 'chess', stake: 200 * TUG, spend: await stake(alice, 200 * TUG) },
  });
  await bob.client.call('/api/match/join', {
    method: 'POST', body: { id: made.data.id, spend: await stake(bob, 200 * TUG) },
  });

  const out = await alice.client.call('/api/match/resign', {
    method: 'POST', body: { id: made.data.id },
  });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.data.winners, [1]);

  const prize = (400 * TUG) - Math.floor(400 * TUG * cfg.match.rake);
  const bobLobby = await bob.client.call('/api/match');
  assert.strictEqual(bobLobby.data.balance, cfg.token.welcomeGrant - 200 * TUG + prize);
});

test('withdrawing a challenge over HTTP returns the stake', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(async () => { await app.stop(); cleanup(cfg, app.db); });

  const alice = await player(base, 'alice');
  const made = await alice.client.call('/api/match/create', {
    method: 'POST', body: { game: 'chess', stake: 300 * TUG, spend: await stake(alice, 300 * TUG) },
  });
  const out = await alice.client.call('/api/match/cancel', {
    method: 'POST', body: { id: made.data.id },
  });
  assert.strictEqual(out.status, 200);
  const lobby = await alice.client.call('/api/match');
  assert.strictEqual(lobby.data.balance, cfg.token.welcomeGrant);
  assert.strictEqual(lobby.data.open.length, 0);
});

test('the operator view is reachable and closed to everyone else', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(async () => { await app.stop(); cleanup(cfg, app.db); });
  const alice = await player(base, 'alice');

  const denied = await alice.client.call('/api/admin/matches');
  assert.ok(denied.status >= 400, `a player read the operator view with ${denied.status}`);

  const res = await fetch(`${base}/api/admin/matches`, {
    headers: { 'x-admin-token': cfg.adminToken },
  });
  assert.strictEqual(res.status, 200);
  const stats = await res.json();
  assert.strictEqual(stats.played, 0);
  assert.strictEqual(stats.rake, 0);
});

test('a match nobody can see does not leak a board', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(async () => { await app.stop(); cleanup(cfg, app.db); });
  const alice = await player(base, 'alice');
  const missing = await alice.client.call('/api/match/one?id=9999');
  assert.strictEqual(missing.status, 404);
});

test('a Tron match over HTTP: two riders, a stream that nudges, one crash, the survivor paid', async (t) => {
  const { cfg, app, base } = await boot();
  // The race runs on src/tron.js's clock, which the test turns by hand; the server is in
  // this process, so the dial is shared.
  const tron = require('../src/tron');
  let fake = Date.now();
  tron.clock.now = () => fake;
  let reader = null;
  t.after(async () => {
    tron.clock.now = () => Date.now();
    if (reader) await reader.cancel().catch(() => {});
    await app.stop();
    cleanup(cfg, app.db);
  });

  const alice = await player(base, 'alice');
  const bob = await player(base, 'bob');

  const made = await alice.client.call('/api/match/create', {
    method: 'POST',
    body: { game: 'tron', stake: 100 * TUG, seats: 2, spend: await stake(alice, 100 * TUG) },
  });
  assert.strictEqual(made.status, 200, `create: ${JSON.stringify(made.data)}`);
  const id = made.data.id;

  // --- a watcher on the table's stream hears every change, with nothing in the nudge
  const stream = await fetch(`${base}/api/match/stream?id=${id}`);
  assert.strictEqual(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let heard = '';
  const hear = async (marker) => {
    for (let i = 0; i < 20 && !heard.includes(marker); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      heard += decoder.decode(value);
    }
    return heard.includes(marker);
  };
  assert.ok(await hear('retry:'), 'the stream opened');

  // --- the table fills and the race is on: nobody is "to move", everyone may act
  const joined = await bob.client.call('/api/match/join', {
    method: 'POST', body: { id, spend: await stake(bob, 100 * TUG) },
  });
  assert.strictEqual(joined.status, 200, `join: ${JSON.stringify(joined.data)}`);
  assert.ok(await hear('event: update'), 'joining nudged the watcher');
  assert.ok(!heard.includes('turns'), 'the nudge carries no state');

  const aView = await alice.client.call(`/api/match/one?id=${id}`);
  assert.strictEqual(aView.data.status, 'playing');
  assert.strictEqual(aView.data.seat, 0);
  assert.strictEqual(aView.data.toMove, null);
  assert.deepStrictEqual(aView.data.view.turns, []);
  assert.ok(aView.data.view.startMs > fake, 'a countdown before the first tick');
  assert.strictEqual(aView.data.view.nowMs, fake, 'the server clock travels with the view');

  // --- Alice turns east during the countdown: recorded for tick one, and pushed
  heard = '';
  const turned = await alice.client.call('/api/match/move', {
    method: 'POST', body: { id, turn: 'e' },
  });
  assert.strictEqual(turned.status, 200, `turn: ${JSON.stringify(turned.data)}`);
  assert.ok(await hear('event: update'), 'a turn nudged the watcher without a poll');
  const bView = await bob.client.call(`/api/match/one?id=${id}`);
  assert.deepStrictEqual(bView.data.view.turns, [{ t: 1, seat: 0, h: 'e' }]);

  // --- Bob turns east too: his trail leaves row 21 alone, and he meets the east edge
  // on tick 32 while Alice, on the longer line, rides on until tick 65
  const bobTurn = await bob.client.call('/api/match/move', {
    method: 'POST', body: { id, turn: 'e' },
  });
  assert.strictEqual(bobTurn.status, 200, `turn: ${JSON.stringify(bobTurn.data)}`);

  // --- a reverse is refused by the server, not merely discouraged by the board
  const rev = await bob.client.call('/api/match/move', {
    method: 'POST', body: { id, turn: 's' },
  });
  assert.strictEqual(rev.status, 400);
  assert.match(rev.data.error, /reverse/);

  // --- claiming a result before there is one is refused
  const early = await alice.client.call('/api/match/timeout', {
    method: 'POST', body: { id, claim: true },
  });
  assert.strictEqual(early.status, 400);

  // --- ten seconds on, Bob has met the edge and Alice is the last rider
  fake += 10000;
  const claim = await alice.client.call('/api/match/timeout', {
    method: 'POST', body: { id, claim: true },
  });
  assert.strictEqual(claim.status, 200, `claim: ${JSON.stringify(claim.data)}`);
  const done = await bob.client.call(`/api/match/one?id=${id}`);
  assert.strictEqual(done.data.status, 'done');
  assert.strictEqual(done.data.reason, 'last-rider');
  assert.deepStrictEqual(done.data.winners, [0]);
  assert.deepStrictEqual(done.data.view.result, { winners: [0], reason: 'last-rider' });

  // --- the pot moved to Alice, less the rake
  const rake = Math.floor(200 * TUG * cfg.match.rake);
  const aliceNow = await alice.client.call('/api/match');
  assert.strictEqual(aliceNow.data.balance, cfg.token.welcomeGrant - 100 * TUG + (200 * TUG - rake));
  const bobNow = await bob.client.call('/api/match');
  assert.strictEqual(bobNow.data.balance, cfg.token.welcomeGrant - 100 * TUG);
});

test('a match is on the record: the table as it filled, every move, the result', async (t) => {
  const { cfg, app, base } = await boot();
  t.after(async () => { await app.stop(); cleanup(cfg, app.db); });
  const events = require('../src/events');

  const alice = await player(base, 'alice');
  const bob = await player(base, 'bob');
  const made = await alice.client.call('/api/match/create', {
    method: 'POST', body: { game: 'chess', stake: 100 * TUG, spend: await stake(alice, 100 * TUG) },
  });
  const id = made.data.id;
  assert.deepStrictEqual(events.history(app.db, 'match', id), [], 'an open table is not yet a round');

  const joined = await bob.client.call('/api/match/join', {
    method: 'POST', body: { id, spend: await stake(bob, 100 * TUG) },
  });
  assert.strictEqual(joined.status, 200);
  const players = [alice, bob];
  for (const m of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    const { data: view } = await alice.client.call(`/api/match/one?id=${id}`);
    const res = await players[view.toMove].client.call('/api/match/move', {
      method: 'POST', body: { id, move: m },
    });
    assert.strictEqual(res.status, 200, `move ${m}: ${JSON.stringify(res.data)}`);
  }

  const log = events.history(app.db, 'match', id);
  assert.deepStrictEqual(log.map((e) => e.k), ['o', 'p', 'p', 'p', 'p', 'f']);
  assert.strictEqual(log[0].a[0], 'chess');
  assert.strictEqual(log[0].a[1], 100 * TUG);
  assert.strictEqual(log[0].a[2].length, 2, 'both seats, by key');
  assert.strictEqual(log[1].a[1], 0, 'the ply');
  assert.strictEqual(log[2].a[1], 1);
  assert.deepStrictEqual(log[4].a[2], { move: 'd8h4' });
  assert.strictEqual(log[5].a[1], 'checkmate');
  assert.ok(events.round(app.db, 'match', id).closed_at > 0);

  // On the chain, once flushed: the same story from the blocks alone.
  events.flush(app.db, cfg, { force: true });
  assert.deepStrictEqual(events.fromChain(app.db, 'match', id).map((e) => e.k), log.map((e) => e.k));
  assert.ok(tc.verifyChain(app.db).ok);
});
