'use strict';
// The site token ledger. The claims this file exists to enforce are narrow and specific,
// which is the only kind of security claim worth making:
//
//   the operator cannot move tokens it does not hold the key for,
//   the operator cannot rewrite history without it being detectable,
//   and a captured signature cannot be replayed.
//
// Anything broader ("unhackable") is marketing, and untestable.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const tc = require('../src/tokenchain');

function setup() {
  const cfg = testConfig();
  const db = openTestDb(cfg);
  const mk = (id, name) => db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(?,?,?,'x','s',?,0)`, id, name, name, `rc${id}`,
  );
  mk(1, 'alice');
  mk(2, 'bob');
  return { cfg, db };
}

/** A player keypair, derived the way the browser derives it: from 32 seed bytes. */
function makeKey() {
  const seed = crypto.randomBytes(32).toString('hex');
  const priv = tc.privateKeyFromSeed(seed);
  return { seed, priv, pub: tc.rawPublicKey(crypto.createPublicKey(priv)) };
}

const sign = (tx, priv) => crypto.sign(
  null, Buffer.from(tc.canonical(tc.transferPayload(tx))), priv,
).toString('hex');

test('canonical JSON is stable regardless of key order', () => {
  // Both sides must hash identical bytes or every signature check fails mysteriously.
  assert.strictEqual(tc.canonical({ b: 1, a: 2 }), tc.canonical({ a: 2, b: 1 }));
  assert.strictEqual(tc.canonical({ a: [1, { d: 4, c: 3 }] }), '{"a":[1,{"c":3,"d":4}]}');
  assert.strictEqual(tc.canonical('x'), '"x"');
  assert.strictEqual(tc.canonical(null), 'null');
});

test('a phrase seed always produces the same key', () => {
  const seed = 'ab'.repeat(32);
  const a = tc.rawPublicKey(crypto.createPublicKey(tc.privateKeyFromSeed(seed)));
  const b = tc.rawPublicKey(crypto.createPublicKey(tc.privateKeyFromSeed(seed)));
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  // A different seed gives a different key.
  const other = tc.rawPublicKey(crypto.createPublicKey(tc.privateKeyFromSeed('cd'.repeat(32))));
  assert.notStrictEqual(a, other);
});

test('registering a key mints the welcome grant on-chain', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();

  const out = db.tx(() => tc.registerKey(db, 1, A.pub, cfg));
  assert.strictEqual(out.balance, cfg.token.welcomeGrant);
  // The grant is a block, not a database poke: the chain explains where it came from.
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM token_blocks').n, 1);
  assert.ok(tc.verifyChain(db).ok);
});

test('the same account cannot register a second, different key', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => tc.registerKey(db, 1, makeKey().pub, cfg));
  assert.throws(() => db.tx(() => tc.registerKey(db, 1, makeKey().pub, cfg)), /already has a token key/);
});

test('one key cannot be claimed by two accounts', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();
  db.tx(() => tc.registerKey(db, 1, A.pub, cfg));
  assert.throws(() => db.tx(() => tc.registerKey(db, 2, A.pub, cfg)), /belongs to another account/);
});

test('a properly signed transfer moves the balance', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();
  const B = makeKey();
  db.tx(() => tc.registerKey(db, 1, A.pub, cfg));
  db.tx(() => tc.registerKey(db, 2, B.pub, cfg));

  const tx = { from: A.pub, to: B.pub, amount: 250, nonce: 0 };
  tc.submitTransfer(db, { ...tx, sig: sign(tx, A.priv) });

  assert.strictEqual(tc.balanceOf(db, A.pub), cfg.token.welcomeGrant - 250);
  assert.strictEqual(tc.balanceOf(db, B.pub), cfg.token.welcomeGrant + 250);
  assert.ok(tc.verifyChain(db).ok);
});

test('THE operator cannot sign a transfer out of a player account', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();
  const B = makeKey();
  db.tx(() => tc.registerKey(db, 1, A.pub, cfg));
  db.tx(() => tc.registerKey(db, 2, B.pub, cfg));

  // This is the central claim of the whole design. The server holds the block-signing
  // key and the entire database, and still cannot produce this signature.
  const server = tc.serverKey(db);
  const theft = { from: A.pub, to: B.pub, amount: 1000, nonce: 0 };
  assert.throws(
    () => tc.submitTransfer(db, { ...theft, sig: sign(theft, server.private) }),
    /signature does not match/,
  );
  assert.strictEqual(tc.balanceOf(db, A.pub), cfg.token.welcomeGrant);
});

test('a forged or altered transfer is refused', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();
  const B = makeKey();
  db.tx(() => tc.registerKey(db, 1, A.pub, cfg));
  db.tx(() => tc.registerKey(db, 2, B.pub, cfg));

  const tx = { from: A.pub, to: B.pub, amount: 100, nonce: 0 };
  const sig = sign(tx, A.priv);

  // Raising the amount after signing invalidates the signature.
  assert.throws(() => tc.submitTransfer(db, { ...tx, amount: 900, sig }), /signature does not match/);
  // So does redirecting it.
  assert.throws(() => tc.submitTransfer(db, { ...tx, to: makeKey().pub, sig }), /signature does not match/);
  // And random bytes are not a signature.
  assert.throws(() => tc.submitTransfer(db, { ...tx, sig: 'ab'.repeat(64) }), /signature does not match/);
});

test('a captured signature cannot be replayed', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();
  const B = makeKey();
  db.tx(() => tc.registerKey(db, 1, A.pub, cfg));
  db.tx(() => tc.registerKey(db, 2, B.pub, cfg));

  const tx = { from: A.pub, to: B.pub, amount: 100, nonce: 0 };
  const sig = sign(tx, A.priv);
  tc.submitTransfer(db, { ...tx, sig });
  assert.throws(() => tc.submitTransfer(db, { ...tx, sig }), /nonce has already been used/);
  assert.strictEqual(tc.balanceOf(db, B.pub), cfg.token.welcomeGrant + 100);
});

test('you cannot spend more than you hold', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();
  const B = makeKey();
  db.tx(() => tc.registerKey(db, 1, A.pub, cfg));
  db.tx(() => tc.registerKey(db, 2, B.pub, cfg));

  const tx = { from: A.pub, to: B.pub, amount: cfg.token.welcomeGrant + 1, nonce: 0 };
  assert.throws(() => tc.submitTransfer(db, { ...tx, sig: sign(tx, A.priv) }), /insufficient token/);
  assert.ok(tc.verifyChain(db).ok);
});

test('rewriting history breaks the chain and is detected', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();
  const B = makeKey();
  db.tx(() => tc.registerKey(db, 1, A.pub, cfg));
  db.tx(() => tc.registerKey(db, 2, B.pub, cfg));
  const tx = { from: A.pub, to: B.pub, amount: 100, nonce: 0 };
  tc.submitTransfer(db, { ...tx, sig: sign(tx, A.priv) });
  assert.ok(tc.verifyChain(db).ok);

  // Edit a past block directly in the database, the way a dishonest operator would.
  db.run('UPDATE token_blocks SET txs=? WHERE height=0',
    JSON.stringify([{ type: 'mint', to: B.pub, amount: 5000000, memo: 'stolen' }]));

  const after = tc.verifyChain(db);
  assert.strictEqual(after.ok, false);
  assert.match(after.reason, /hash does not match/);
});

test('breaking a block link is detected', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => tc.registerKey(db, 1, makeKey().pub, cfg));
  db.tx(() => tc.registerKey(db, 2, makeKey().pub, cfg));
  assert.ok(tc.verifyChain(db).ok);

  db.run('UPDATE token_blocks SET prev_hash=? WHERE height=1', 'ff'.repeat(32));
  const after = tc.verifyChain(db);
  assert.strictEqual(after.ok, false);
  assert.match(after.reason, /link/);
});

test('a block signed by the wrong key is detected', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => tc.registerKey(db, 1, makeKey().pub, cfg));

  // Re-sign block 0 with somebody else's key, keeping the hash intact.
  const impostor = crypto.generateKeyPairSync('ed25519').privateKey;
  const row = db.get('SELECT hash FROM token_blocks WHERE height=0');
  const bogus = crypto.sign(null, Buffer.from(row.hash), impostor).toString('hex');
  db.run('UPDATE token_blocks SET signature=? WHERE height=0', bogus);

  const after = tc.verifyChain(db);
  assert.strictEqual(after.ok, false);
  assert.match(after.reason, /not signed by the operator key/);
});

test('a doctored stored balance is caught against a replay of the chain', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();
  db.tx(() => tc.registerKey(db, 1, A.pub, cfg));
  assert.ok(tc.verifyChain(db).ok);

  db.run('UPDATE token_balances SET balance=? WHERE pubkey=?', 999999, A.pub);
  const after = tc.verifyChain(db);
  assert.strictEqual(after.ok, false);
  assert.match(after.reason, /disagrees with the chain/);
});

test('malformed submissions are rejected before any signature work', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();
  db.tx(() => tc.registerKey(db, 1, A.pub, cfg));

  const base = { from: A.pub, to: makeKey().pub, amount: 10, nonce: 0, sig: 'ab'.repeat(64) };
  assert.throws(() => tc.submitTransfer(db, { ...base, from: 'nope' }), /32-byte key/);
  assert.throws(() => tc.submitTransfer(db, { ...base, sig: 'short' }), /64 bytes of hex/);
  assert.throws(() => tc.submitTransfer(db, { ...base, amount: 0 }), /bad amount/);
  assert.throws(() => tc.submitTransfer(db, { ...base, amount: -5 }), /bad amount/);
  assert.throws(() => tc.submitTransfer(db, { ...base, nonce: -1 }), /bad nonce/);
  assert.throws(() => tc.submitTransfer(db, { ...base, to: A.pub }), /send to yourself/);
});

test('the chain slice exposes what a verifier needs and nothing secret', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => tc.registerKey(db, 1, makeKey().pub, cfg));

  const slice = tc.chainSlice(db, 0, 100);
  assert.strictEqual(slice.chain, tc.CHAIN_ID);
  assert.match(slice.serverKey, /^[0-9a-f]{64}$/);
  assert.ok(slice.blocks.length >= 1);
  for (const b of slice.blocks) {
    for (const field of ['height', 'prevHash', 'hash', 'signature', 'timestamp', 'txs']) {
      assert.ok(field in b, `block is missing ${field}`);
    }
  }
  // The operator private key must never appear anywhere in the response.
  const stored = db.kvGet('token.serverKey');
  assert.ok(!JSON.stringify(slice).includes(stored.privatePkcs8), 'the private key leaked');
});
