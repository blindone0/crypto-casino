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

function setup(overrides = {}) {
  const cfg = testConfig(overrides);
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

test('registering a key pays the welcome grant out of the treasury', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();

  const out = db.tx(() => tc.registerKey(db, 1, A.pub, cfg));
  assert.strictEqual(out.balance, cfg.token.welcomeGrant);
  // Two blocks: the genesis mint of the whole supply, and a transfer out of it. The grant
  // is a block rather than a database poke, so the chain explains where it came from.
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM token_blocks').n, 2);
  const grantBlock = JSON.parse(db.get('SELECT txs FROM token_blocks WHERE height=1').txs);
  assert.strictEqual(grantBlock[0].type, 'transfer', 'a grant is a transfer, never a mint');
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

// ------------------------------------------------------------- fixed supply
// The point of a capped token is that the cap is checkable, not promised. Every tugrik is
// minted once, into the treasury, in the genesis block; everything afterwards moves what
// already exists. These tests exist because the first version did not work that way: a
// new wallet minted its own grant, so unlimited accounts meant unlimited tugriks and the
// token was worth whatever it cost to register another one.

test('the whole supply is minted once, at genesis, into the treasury', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));

  assert.strictEqual(tc.ensureGenesis(db, cfg), true, 'the first call creates it');
  assert.strictEqual(tc.ensureGenesis(db, cfg), false, 'a second call does nothing');

  const treasury = tc.treasuryKey(db).publicRaw;
  assert.strictEqual(tc.balanceOf(db, treasury), cfg.token.maxSupply);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM token_blocks').n, 1);

  const info = tc.supply(db);
  assert.strictEqual(info.minted, cfg.token.maxSupply);
  assert.strictEqual(info.circulating, cfg.token.maxSupply);
  assert.strictEqual(info.treasury, cfg.token.maxSupply);
});

test('the supply does not grow however many wallets register', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  for (let i = 1; i <= 8; i += 1) {
    db.run(
      `INSERT OR IGNORE INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
       VALUES(?,?,?,'x','s',?,0)`, i, `u${i}`, `u${i}`, `r${i}`,
    );
    db.tx(() => tc.registerKey(db, i, makeKey().pub, cfg));
  }
  const info = tc.supply(db);
  assert.strictEqual(info.minted, cfg.token.maxSupply, 'nothing was created');
  assert.strictEqual(
    info.treasury, cfg.token.maxSupply - 8 * cfg.token.welcomeGrant,
    'the grants came out of the treasury',
  );
  assert.ok(tc.verifyChain(db).ok);
});

test('when the treasury runs dry the grants stop rather than inventing more', (t) => {
  // A supply of exactly two grants. The third wallet gets a key and nothing else.
  const { cfg, db } = setup({ token: { maxSupply: 2000 * 100000000, welcomeGrant: 1000 * 100000000 } });
  t.after(() => cleanup(cfg, db));
  for (let i = 1; i <= 3; i += 1) {
    db.run(
      `INSERT OR IGNORE INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
       VALUES(?,?,?,'x','s',?,0)`, i, `u${i}`, `u${i}`, `r${i}`,
    );
  }
  const first = db.tx(() => tc.registerKey(db, 1, makeKey().pub, cfg));
  const second = db.tx(() => tc.registerKey(db, 2, makeKey().pub, cfg));
  const third = db.tx(() => tc.registerKey(db, 3, makeKey().pub, cfg));

  assert.strictEqual(first.balance, 1000 * 100000000);
  assert.strictEqual(second.balance, 1000 * 100000000);
  assert.strictEqual(third.balance, 0, 'the faucet is empty, and stays empty');
  assert.strictEqual(third.granted, false);
  assert.strictEqual(tc.supply(db).minted, 2000 * 100000000);
  assert.ok(tc.verifyChain(db).ok);
});

test('a mint after the genesis block is refused by the verifier', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => tc.registerKey(db, 1, makeKey().pub, cfg));
  assert.ok(tc.verifyChain(db).ok, 'sound to begin with');

  // Forge a second mint the way a dishonest operator would: a properly signed, properly
  // linked block that simply creates tokens. The chain stays internally consistent; the
  // supply rule is what catches it.
  const victim = makeKey();
  db.tx(() => tc.appendBlock(db, [{ type: 'mint', to: victim.pub, amount: 5000, memo: 'oops' }]));

  const check = tc.verifyChain(db);
  assert.strictEqual(check.ok, false);
  assert.match(check.reason, /only the genesis block may/);
});

test('raising maxSupply later does not create anything', (t) => {
  const { cfg, db } = setup({ token: { maxSupply: 5000 * 100000000 } });
  t.after(() => cleanup(cfg, db));
  tc.ensureGenesis(db, cfg);
  assert.strictEqual(tc.supply(db).minted, 5000 * 100000000);

  // The operator edits the config and restarts. The chain already exists, so the genesis
  // block is settled and signed, and nothing about it changes.
  const greedy = { ...cfg, token: { ...cfg.token, maxSupply: 999999999 } };
  assert.strictEqual(tc.ensureGenesis(db, greedy), false);
  assert.strictEqual(tc.supply(db).minted, 5000 * 100000000);
  assert.ok(tc.verifyChain(db).ok);
});

test('an impossible supply is refused rather than quietly rounded', (t) => {
  for (const bad of [0, -1, 1.5, NaN, 'lots', null]) {
    const { cfg, db } = setup({ token: { maxSupply: bad } });
    assert.throws(() => tc.ensureGenesis(db, cfg), /positive whole number/, `accepted ${bad}`);
    cleanup(cfg, db);
  }
});

test('burning takes tokens out of circulation for good', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const A = makeKey();
  db.tx(() => tc.registerKey(db, 1, A.pub, cfg));

  const before = tc.supply(db);
  db.tx(() => tc.appendBlock(db, [{ type: 'burn', from: A.pub, amount: 250 * 100000000, memo: 'arcade' }]));
  const after = tc.supply(db);

  assert.strictEqual(after.minted, before.minted, 'burning does not change what was minted');
  assert.strictEqual(after.burned, 250 * 100000000);
  assert.strictEqual(after.circulating, before.circulating - 250 * 100000000);
  // And it is gone: nothing re-mints it.
  assert.ok(after.circulating < cfg.token.maxSupply);
  assert.ok(tc.verifyChain(db).ok);
});
