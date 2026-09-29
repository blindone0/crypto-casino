'use strict';
// Game events on the chain: the one property that matters, held by both verifiers.
//
// An event (type 'ev') is a game's record of a step — a round opened, a tile picked, a
// piece placed — written into the same blocks as the money so that the two share one
// order. The property this file exists to enforce: an event is not money and cannot be
// made into money. It never moves a balance, it cannot be appended with a money field
// in it, and a block carrying one that smuggles `to`, `from` or `amount` is refused by
// the server's verifier AND by the browser's, from the same vector. Two verifiers that
// agree is what makes the ledger independently auditable; two that drift is a chain the
// browser rejects the day the first event lands.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { testConfig, openTestDb, cleanup, ROOT } = require('./helpers');
const tc = require('../src/tokenchain');

const BROWSER = pathToFileURL(path.join(ROOT, 'public', 'chainverify.js')).href;

function setup() {
  const cfg = testConfig();
  const db = openTestDb(cfg);
  db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(1,'alice','alice','x','s','rc1',0)`,
  );
  const seed = crypto.randomBytes(32).toString('hex');
  const priv = tc.privateKeyFromSeed(seed);
  const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
  db.tx(() => tc.registerKey(db, 1, pub, cfg));
  return { cfg, db, pub, priv };
}

/** The browser's verifier, fed straight from the database the way /api/token/chain would. */
async function browserVerify(db) {
  const { verifyChain } = await import(BROWSER);
  return verifyChain({ fetchSlice: async (from) => tc.chainSlice(db, from, 500) });
}

const EVENT = { type: 'ev', g: 'mines', r: 41207, s: 7, k: 'p', a: [3, 42, 1731], u: 'a91c0f2e' };

/**
 * Write a block the way appendBlock does but without applyTx in the way: the only route
 * by which a malformed event could ever reach the chain, which is the route a verifier
 * has to be ready for.
 */
function smuggle(db, txs) {
  const key = tc.serverKey(db);
  const prev = tc.head(db);
  const block = {
    height: prev.height + 1, prevHash: prev.hash, timestamp: Math.floor(Date.now() / 1000), txs,
  };
  const hash = tc.blockHash(block);
  const signature = crypto.sign(null, Buffer.from(hash), key.private).toString('hex');
  db.run(
    `INSERT INTO token_blocks(height, prev_hash, hash, txs, signature, created_at)
     VALUES(?,?,?,?,?,?)`,
    block.height, block.prevHash, hash, JSON.stringify(txs), signature, block.timestamp,
  );
}

test('an event goes into a block and moves nobody\'s balance, and both verifiers accept it', async (t) => {
  const { cfg, db, pub } = setup();
  t.after(() => cleanup(cfg, db));
  const before = db.all('SELECT pubkey, balance FROM token_balances ORDER BY pubkey');

  db.tx(() => tc.appendBlock(db, [EVENT, { ...EVENT, s: 8, k: 'f', a: [12, 1.5, 0] }]));

  assert.deepStrictEqual(db.all('SELECT pubkey, balance FROM token_balances ORDER BY pubkey'), before);
  assert.strictEqual(tc.balanceOf(db, pub), cfg.token.welcomeGrant);

  const server = tc.verifyChain(db);
  assert.ok(server.ok, server.reason);
  assert.strictEqual(server.events, 2);
  assert.strictEqual(server.blocks, 3, 'genesis, the grant, the events');

  const browser = await browserVerify(db);
  assert.ok(browser.ok, browser.reason);
  assert.strictEqual(browser.events, 2);
  assert.strictEqual(browser.head, server.head);
  assert.strictEqual(browser.balances.get(pub), cfg.token.welcomeGrant);
});

test('an event with a money field in it cannot be appended', (t) => {
  const { cfg, db, pub } = setup();
  t.after(() => cleanup(cfg, db));
  for (const bad of [
    { ...EVENT, amount: 5 },
    { ...EVENT, to: pub },
    { ...EVENT, from: pub },
    { ...EVENT, nonce: 3 },
    { ...EVENT, extra: true },
    { ...EVENT, g: 'Mines!' },
    { ...EVENT, k: 'pp' },
    { ...EVENT, a: 'not a list' },
    { ...EVENT, r: -1 },
    { ...EVENT, a: ['x'.repeat(5000)] },
  ]) {
    assert.throws(() => db.tx(() => tc.appendBlock(db, [bad])), /event/, JSON.stringify(bad).slice(0, 60));
  }
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM token_blocks').n, 2, 'nothing was written');
  assert.ok(tc.verifyChain(db).ok);
});

test('a smuggled event carrying money is refused by both verifiers, from the same vector', async (t) => {
  const { cfg, db, pub } = setup();
  t.after(() => cleanup(cfg, db));

  smuggle(db, [{ ...EVENT, amount: 1000, to: pub }]);

  const server = tc.verifyChain(db);
  assert.strictEqual(server.ok, false);
  assert.match(server.reason, /money field/);

  const browser = await browserVerify(db);
  assert.strictEqual(browser.ok, false);
  assert.match(browser.reason, /money field/);
  assert.strictEqual(browser.height, 2, 'and it names the block');
});

test('the two verifiers agree on every malformed event, not just the money ones', async (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const { checkEvent } = await import(BROWSER);
  const vectors = [
    EVENT,
    { ...EVENT, u: undefined },
    { ...EVENT, sig: 'ab'.repeat(64) },
    { ...EVENT, sig: 'zz' },
    { ...EVENT, amount: 1 },
    { ...EVENT, from: 'x' },
    { ...EVENT, k: 'P' },
    { ...EVENT, g: '' },
    { ...EVENT, s: 1.5 },
    { ...EVENT, a: null },
    { ...EVENT, u: 'nothex!!' },
    { type: 'ev' },
  ];
  for (const v of vectors) {
    const cleaned = JSON.parse(JSON.stringify(v));
    assert.strictEqual(checkEvent(cleaned), tc.checkEvent(cleaned), JSON.stringify(cleaned));
  }
});

test('the chain a real game left behind still verifies with events in it', async (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  // A few hundred events across a handful of blocks, the way the flusher batches them.
  let seq = 0;
  for (let b = 0; b < 8; b += 1) {
    const txs = [];
    for (let i = 0; i < 25; i += 1) {
      txs.push({ type: 'ev', g: 'jigsaw', r: 12, s: seq, k: 'p', a: [i, i + 1, 1731 + seq] });
      seq += 1;
    }
    db.tx(() => tc.appendBlock(db, txs));
  }
  const server = tc.verifyChain(db);
  assert.ok(server.ok, server.reason);
  assert.strictEqual(server.events, 200);
  const browser = await browserVerify(db);
  assert.ok(browser.ok, browser.reason);
  assert.strictEqual(browser.events, 200);
  assert.strictEqual(browser.checked, 10);
});
