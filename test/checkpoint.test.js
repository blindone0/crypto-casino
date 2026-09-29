'use strict';
// Checkpoints: a cache of a verification, trusted only while its anchor still hashes.
//
// The doctor verifies from the latest checkpoint so it stays quick as the chain grows.
// The claim that makes that safe is narrow: a rewritten anchor block cannot inherit a
// checkpoint, because the checkpoint commits to a hash that commits to everything before
// it, so a verify that finds its anchor changed falls back to the full replay. The one
// case a checkpointed verify cannot see — a link broken BELOW an untouched anchor — is
// spelled out here too, because that is what the weekly full replay exists for.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const tc = require('../src/tokenchain');
const events = require('../src/events');
const doctor = require('../src/doctor');

function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  const keys = [];
  for (const [id, name] of [[1, 'alice'], [2, 'bob']]) {
    db.run(
      `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
       VALUES(?,?,?,'x','s',?,0)`, id, name, name, `rc${id}`,
    );
    const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
    const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
    db.tx(() => tc.registerKey(db, id, pub, cfg));
    keys.push({ priv, pub });
  }
  return { cfg, db, keys };
}

/** A few blocks of events, the way the flusher makes them. */
function grow(db, cfg, blocks, perBlock = 5) {
  for (let b = 0; b < blocks; b += 1) {
    const txs = [];
    for (let i = 0; i < perBlock; i += 1) txs.push({ type: 'ev', g: 'mines', r: b, s: i, k: 'r', a: [i] });
    db.tx(() => tc.appendBlock(db, txs));
  }
}

const tip = (db) => db.get('SELECT * FROM token_blocks ORDER BY height DESC LIMIT 1');

test('a checkpoint records the verified state, and a verify from it agrees with the full replay', (t) => {
  const { cfg, db, keys } = setup();
  t.after(() => cleanup(cfg, db));
  grow(db, cfg, 6);

  const full = tc.verifyChain(db);
  assert.ok(full.ok, full.reason);
  assert.strictEqual(full.from, null, 'from genesis');
  assert.strictEqual(full.replayed, full.blocks);

  const cp = db.tx(() => tc.writeCheckpoint(db));
  assert.ok(cp.written);
  assert.strictEqual(cp.height, tip(db).height);
  const row = tc.latestCheckpoint(db);
  assert.strictEqual(row.hash, tip(db).hash);
  assert.strictEqual(JSON.parse(row.balances)[keys[0].pub], cfg.token.welcomeGrant);
  assert.strictEqual(row.events, 30);

  grow(db, cfg, 3);
  const fast = tc.verifyChain(db, { checkpoint: true });
  assert.ok(fast.ok, fast.reason);
  assert.strictEqual(fast.from, cp.height, 'it says which checkpoint it started from');
  assert.strictEqual(fast.replayed, 3, 'and replayed only the blocks since');
  const again = tc.verifyChain(db);
  assert.strictEqual(fast.head, again.head);
  assert.strictEqual(fast.events, again.events);
  assert.deepStrictEqual([...fast.balances].sort(), [...again.balances].sort());
  assert.strictEqual(fast.blocks, again.blocks);

  assert.strictEqual(db.tx(() => tc.writeCheckpoint(db)).written, true);
  assert.strictEqual(db.tx(() => tc.writeCheckpoint(db)).written, false, 'one per height');
});

test('a checkpoint whose anchor block was altered is rejected and the verify falls back to full', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  grow(db, cfg, 4);
  const cp = db.tx(() => tc.writeCheckpoint(db));
  grow(db, cfg, 2);

  // Rewrite the anchor's contents. Its stored hash no longer matches what is in it.
  const anchor = db.get('SELECT * FROM token_blocks WHERE height=?', cp.height);
  const txs = JSON.parse(anchor.txs);
  txs[0].a = [999];
  db.run('UPDATE token_blocks SET txs=? WHERE height=?', JSON.stringify(txs), cp.height);

  const fast = tc.verifyChain(db, { checkpoint: true });
  assert.strictEqual(fast.ok, false);
  assert.strictEqual(fast.from, null, 'the checkpoint was not trusted: this was a full replay');
  assert.match(fast.reason, /hash does not match/);
  assert.strictEqual(tc.verifyChain(db).ok, false, 'and the full replay agrees');
  assert.strictEqual(db.tx(() => tc.writeCheckpoint(db)).written, false, 'no checkpoint over a broken chain');
});

test('an anchor re-signed over rewritten history is caught too: the checkpoint remembers the old hash', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  grow(db, cfg, 4);
  const cp = db.tx(() => tc.writeCheckpoint(db));

  // The operator rewrites the anchor AND re-hashes and re-signs it, the way a consistent
  // rewrite of history would. The chain from there links to the new hash; the checkpoint
  // still holds the old one.
  const key = tc.serverKey(db);
  const anchor = db.get('SELECT * FROM token_blocks WHERE height=?', cp.height);
  const txs = JSON.parse(anchor.txs);
  txs[0].a = [999];
  const hash = tc.blockHash({
    height: anchor.height, prevHash: anchor.prev_hash, timestamp: anchor.created_at, txs,
  });
  const signature = crypto.sign(null, Buffer.from(hash), key.private).toString('hex');
  db.run('UPDATE token_blocks SET txs=?, hash=?, signature=? WHERE height=?',
    JSON.stringify(txs), hash, signature, cp.height);

  const fast = tc.verifyChain(db, { checkpoint: true });
  assert.strictEqual(fast.from, null, 'the anchor no longer hashes to what the checkpoint recorded');
  assert.ok(fast.ok, 'a consistent rewrite of the tip itself verifies — which is what the pinned heads are for');
  assert.notStrictEqual(fast.head, cp.head, 'and the head has changed, which compareHeads catches');
});

test('the one thing a checkpointed verify cannot see, and the full replay can', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  grow(db, cfg, 4);
  const cp = db.tx(() => tc.writeCheckpoint(db));
  grow(db, cfg, 2);

  // A block below the anchor is altered without relinking anything: its own hash and
  // the anchor are untouched, so the fast path sees nothing wrong.
  const below = db.get('SELECT * FROM token_blocks WHERE height=?', cp.height - 1);
  const txs = JSON.parse(below.txs);
  txs[0].a = [999];
  db.run('UPDATE token_blocks SET txs=? WHERE height=?', JSON.stringify(txs), below.height);

  assert.strictEqual(tc.verifyChain(db, { checkpoint: true }).ok, true, 'the cached verify trusts below its anchor');
  const full = tc.verifyChain(db);
  assert.strictEqual(full.ok, false, 'the weekly replay from genesis does not');
  assert.match(full.reason, new RegExp(`block ${below.height} hash does not match`));
});

test('the flusher writes a checkpoint every so many blocks, in its own transaction', (t) => {
  const { cfg, db } = setup({ token: { events: { batchCount: 1, batchMs: 0, maxPerBlock: 1, checkpointEvery: 3 } } });
  t.after(() => cleanup(cfg, db));
  for (let i = 0; i < 7; i += 1) db.tx(() => events.emit(db, cfg, { g: 'mines', r: 1, k: 'r', a: [i] }));
  const before = db.get('SELECT COUNT(*) AS n FROM token_checkpoints').n;
  const out = events.flush(db, cfg);
  assert.strictEqual(out.blocks, 7, 'one event a block, for the test');
  const heights = db.all('SELECT height FROM token_checkpoints ORDER BY height').map((r) => r.height);
  assert.ok(heights.length > before);
  for (const h of heights) assert.strictEqual(h % 3, 0, `checkpoint at ${h} is on the cadence`);
  assert.ok(tc.verifyChain(db, { checkpoint: true }).from !== null);
});

test('the doctor reads from the checkpoint and reports when the full replay is overdue', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  grow(db, cfg, 3);
  const now = Math.floor(Date.now() / 1000);

  let line = doctor.chainVerifies(db, cfg);
  assert.ok(line.ok);
  assert.match(line.detail, /from genesis/);
  const cp = db.tx(() => tc.writeCheckpoint(db));
  grow(db, cfg, 1);
  line = doctor.chainVerifies(db, cfg);
  assert.match(line.detail, new RegExp(`from checkpoint at ${cp.height}`));

  let recent = doctor.fullVerifyRecent(db, cfg, now);
  assert.ok(recent.ok, 'reported, never failed');
  assert.match(recent.detail, /never run/);
  db.kvSet('chain.fullVerifiedAt', now - 3600);
  assert.match(doctor.fullVerifyRecent(db, cfg, now).detail, /today/);
  db.kvSet('chain.fullVerifiedAt', now - 9 * 86400);
  recent = doctor.fullVerifyRecent(db, cfg, now);
  assert.ok(recent.ok);
  assert.match(recent.detail, /9 days ago.*overdue/);
  assert.strictEqual(tc.lastFullVerify(db), now - 9 * 86400);
});
