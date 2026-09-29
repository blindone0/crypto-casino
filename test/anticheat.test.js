'use strict';
// The anti-cheat: freeze first, ban on review, seize to the house — all on the chain.
//
// The claims this file holds to are as narrow as the ones in tokenchain.test.js:
//   a seize may go only to the house key, and only after a ban of the same key already on
//   the chain — refused by applyTx, by the server's verifier and by the browser's, from
//   one vector;
//   a flag, an unflag and a ban move nothing;
//   the supply is what it was after a seize;
//   a frozen account can log in and see why, and can bet and move nothing;
//   and the record's tells — a jigsaw under the human floor, scripted clicks, impossible
//   mines luck — are found by the scan with the blocks that hold them.
// The test that the operator cannot sign a transfer out of a player account is in
// tokenchain.test.js and is unmodified by any of this.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { testConfig, openTestDb, cleanup, ROOT } = require('./helpers');
const U = require('../src/util');
const tc = require('../src/tokenchain');
const events = require('../src/events');
const anticheat = require('../src/anticheat');
const auth = require('../src/auth');
const bankMod = require('../src/bank');
const matches = require('../src/match');
const jigsaw = require('../src/games/jigsaw');
const doctor = require('../src/doctor');

const TUG = 100000000;
const BROWSER = pathToFileURL(path.join(ROOT, 'public', 'chainverify.js')).href;
const ACTOR = 'admin:test';

function setup() {
  const cfg = testConfig();
  const db = openTestDb(cfg);
  const keys = {};
  for (const [id, name] of [[1, 'alice'], [2, 'bob']]) {
    db.run(
      `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
       VALUES(?,?,?,?,'seed',?,0)`, id, name, name, U.hashPassword('pw'), `rc${id}`,
    );
    const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
    const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
    db.tx(() => tc.registerKey(db, id, pub, cfg));
    keys[name] = { priv, pub };
  }
  // The house exists, and holds a float.
  db.tx(() => tc.appendBlock(db, [tc.treasuryTransfer(db, matches.houseKey(db).publicRaw, 500 * TUG)]));
  return { cfg, db, keys, house: matches.houseKey(db).publicRaw };
}

async function browserVerify(db) {
  const { verifyChain } = await import(BROWSER);
  return verifyChain({ fetchSlice: async (from) => tc.chainSlice(db, from, 500) });
}

/** Write a block past applyTx, the way only a rewrite of the database could. */
function smuggle(db, txs) {
  const key = tc.serverKey(db);
  const prev = tc.head(db);
  const block = { height: prev.height + 1, prevHash: prev.hash, timestamp: Math.floor(Date.now() / 1000), txs };
  const hash = tc.blockHash(block);
  const signature = crypto.sign(null, Buffer.from(hash), key.private).toString('hex');
  db.run(
    `INSERT INTO token_blocks(height, prev_hash, hash, txs, signature, created_at) VALUES(?,?,?,?,?,?)`,
    block.height, block.prevHash, hash, JSON.stringify(txs), signature, block.timestamp,
  );
  return block.height;
}

const user = (db, id) => db.get('SELECT * FROM users WHERE id=?', id);

test('flag, unflag, ban and seize go on the chain, move only what they say, and both verifiers accept them', async (t) => {
  const { cfg, db, keys, house } = setup();
  t.after(() => cleanup(cfg, db));
  const alice = keys.alice.pub;
  const supplyBefore = tc.supply(db).circulating;
  const houseBefore = tc.balanceOf(db, house);

  // --- flag: frozen, on the record, and the money is where it was
  const flagged = anticheat.flag(db, cfg, { userId: 1, why: 'jigsaw-too-fast: 2s for 24 pieces', blocks: [5, 7, 7], actor: ACTOR });
  assert.ok(flagged.height > 0);
  const flagTx = JSON.parse(db.get('SELECT txs FROM token_blocks WHERE height=?', flagged.height).txs)[0];
  assert.deepStrictEqual(flagTx, { type: 'flag', who: alice, why: 'jigsaw-too-fast: 2s for 24 pieces', blocks: [5, 7] });
  assert.strictEqual(user(db, 1).frozen, 1);
  assert.strictEqual(user(db, 1).frozen_why, 'jigsaw-too-fast: 2s for 24 pieces');
  assert.strictEqual(tc.balanceOf(db, alice), cfg.token.welcomeGrant, 'a flag moves nothing');

  // A frozen account: may log in and is told why; may bet nothing and move nothing.
  const session = auth.login(db, cfg, { username: 'alice', password: 'pw', ip: '127.0.0.1' });
  assert.ok(session.user || session.token, 'login is allowed while frozen');
  const shown = auth.publicUser(db, user(db, 1));
  assert.strictEqual(shown.frozen, true);
  assert.strictEqual(shown.frozenWhy, 'jigsaw-too-fast: 2s for 24 pieces');
  assert.deepStrictEqual(shown.frozenBlocks, [5, 7]);
  assert.throws(() => bankMod.bankFor(db, cfg).checkLimits(user(db, 1), 10 * TUG), /frozen/);
  assert.throws(() => matches.create(db, cfg, user(db, 1), { game: 'chess', stake: 10 * TUG, spend: { from: alice } }), /frozen/);

  // --- unflag: thawed, on the record
  const thawed = anticheat.unflag(db, cfg, { userId: 1, actor: ACTOR });
  assert.ok(thawed.height > flagged.height);
  assert.strictEqual(user(db, 1).frozen, 0);
  assert.strictEqual(user(db, 1).frozen_why, null);
  assert.strictEqual(auth.publicUser(db, user(db, 1)).frozen, false);

  // --- seize before a ban: refused by applyTx
  assert.throws(() => db.tx(() => tc.appendBlock(db, [{ type: 'seize', from: alice, to: house, amount: 1, ban: flagged.height }])), /ban/);

  // --- ban: on the record, sessions gone, no more logging in
  anticheat.flag(db, cfg, { userId: 1, why: 'confirmed on review', blocks: [flagged.height], actor: ACTOR });
  const banned = anticheat.ban(db, cfg, { userId: 1, why: 'confirmed on review', actor: ACTOR });
  assert.strictEqual(user(db, 1).banned, 1);
  assert.strictEqual(user(db, 1).ban_height, banned.height);
  assert.throws(() => auth.login(db, cfg, { username: 'alice', password: 'pw', ip: '127.0.0.1' }), /banned/);
  assert.throws(() => anticheat.unflag(db, cfg, { userId: 1, actor: ACTOR }), /banned/);

  // --- seize: to the house, citing the ban, and the supply is what it was
  const held = tc.balanceOf(db, alice);
  const seized = anticheat.seize(db, cfg, { userId: 1, actor: ACTOR });
  assert.strictEqual(seized.amount, held);
  const seizeTx = JSON.parse(db.get('SELECT txs FROM token_blocks WHERE height=?', seized.height).txs)[0];
  assert.deepStrictEqual(seizeTx, { type: 'seize', from: alice, to: house, amount: held, ban: banned.height });
  assert.strictEqual(tc.balanceOf(db, alice), 0);
  assert.strictEqual(tc.balanceOf(db, house), houseBefore + held, 'to the house, where lost bets already go');
  assert.strictEqual(tc.supply(db).circulating, supplyBefore, 'a seize is a move, not a mint');
  assert.deepStrictEqual(anticheat.seize(db, cfg, { userId: 1, actor: ACTOR }), { userId: 1, amount: 0, height: null }, 'nothing left, nothing written');

  // --- both verifiers, the whole chain
  const server = tc.verifyChain(db);
  assert.ok(server.ok, server.reason);
  assert.strictEqual(server.admin, 5, 'flag, unflag, flag, ban, seize');
  const browser = await browserVerify(db);
  assert.ok(browser.ok, browser.reason);
  assert.strictEqual(browser.admin, 5);
  assert.strictEqual(browser.balances.get(alice), 0);
  assert.strictEqual(browser.balances.get(house), houseBefore + held);
  assert.strictEqual(tc.chainSlice(db).houseKey, house, 'the verifier is told which key the house is');
  assert.deepStrictEqual(anticheat.flagged(db).map((u) => [u.id, u.banned, u.balance]), [[1, true, 0]]);
});

test('a seize to anyone but the house, or without a ban behind it, is refused by all three', async (t) => {
  const { cfg, db, keys, house } = setup();
  t.after(() => cleanup(cfg, db));
  const alice = keys.alice.pub;
  const bob = keys.bob.pub;
  const banned = anticheat.ban(db, cfg, { userId: 1, why: 'x', actor: ACTOR });

  // applyTx
  assert.throws(() => db.tx(() => tc.appendBlock(db, [{ type: 'seize', from: alice, to: bob, amount: 1, ban: banned.height }])), /house/);
  assert.throws(() => db.tx(() => tc.appendBlock(db, [{ type: 'seize', from: bob, to: house, amount: 1, ban: banned.height }])), /ban/, 'the ban is of alice, not bob');
  assert.throws(() => db.tx(() => tc.appendBlock(db, [{ type: 'seize', from: alice, to: house, amount: 1, ban: banned.height + 5 }])), /ban/, 'a ban in the future is no ban');
  assert.throws(() => db.tx(() => tc.appendBlock(db, [{ type: 'seize', from: alice, to: house, amount: 1, ban: banned.height, memo: 'x' }])), /unknown field/);
  assert.throws(() => db.tx(() => tc.appendBlock(db, [{ type: 'ban', who: alice }])), /says why/);
  assert.ok(tc.verifyChain(db).ok, 'nothing of that was written');

  // Smuggled past applyTx: both verifiers refuse, naming the block.
  const h1 = smuggle(db, [{ type: 'seize', from: alice, to: bob, amount: 1, ban: banned.height }]);
  let server = tc.verifyChain(db);
  assert.strictEqual(server.ok, false);
  assert.match(server.reason, new RegExp(`block ${h1} seizes to a key that is not the house`));
  let browser = await browserVerify(db);
  assert.strictEqual(browser.ok, false);
  assert.match(browser.reason, /other than the house/);
  assert.strictEqual(browser.height, h1);
  db.run('DELETE FROM token_blocks WHERE height=?', h1);

  const h2 = smuggle(db, [{ type: 'seize', from: bob, to: house, amount: 1, ban: banned.height }]);
  server = tc.verifyChain(db);
  assert.strictEqual(server.ok, false);
  assert.match(server.reason, /without a ban/);
  browser = await browserVerify(db);
  assert.strictEqual(browser.ok, false);
  assert.match(browser.reason, /cites a ban that is not on the chain/);
  db.run('DELETE FROM token_blocks WHERE height=?', h2);

  // The narrow case that IS allowed verifies in both.
  db.tx(() => tc.appendBlock(db, [{ type: 'seize', from: alice, to: house, amount: 1, ban: banned.height }]));
  assert.ok(tc.verifyChain(db).ok);
  assert.ok((await browserVerify(db)).ok);
});

test('the scan finds the record\'s tells and cites the blocks that hold them', async (t) => {
  const { cfg, db, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const alice = user(db, 1);
  const sign = (amount) => {
    const tx = { type: 'transfer', from: keys.alice.pub, to: matches.houseKey(db).publicRaw, amount, nonce: tc.nextNonce(db, keys.alice.pub) };
    const sig = crypto.sign(null, Buffer.from(tc.canonical(tc.transferPayload(tx))), keys.alice.priv).toString('hex');
    return { from: keys.alice.pub, nonce: tx.nonce, sig };
  };
  const ctx = (spend) => ({ db, cfg, user: alice, bank: bankMod.bankFor(db, cfg, spend), bankFor: (s) => bankMod.bankFor(db, cfg, s) });

  // A jigsaw solved at once: under the human floor, with every drop scripted in no time.
  const g = jigsaw.start(ctx(sign(1 * TUG)), { amount: '1', board: 'medium' });
  for (let i = 0; i < g.pieces; i += 1) jigsaw.place(ctx(), { slot: i, piece: i });
  const out = jigsaw.solve(ctx(), { arrangement: [...Array(g.pieces).keys()] });
  assert.strictEqual(out.tooFast, true);

  // A run of mines luck that a fair layout would not produce: twelve rounds of twenty
  // safe picks through three mines, cashed every time.
  for (let r = 100; r < 112; r += 1) {
    db.tx(() => {
      events.emit(db, cfg, { g: 'mines', r, k: 'o', a: [TUG, 3, 'h'], userId: 1, pubkey: keys.alice.pub });
      for (let i = 0; i < 20; i += 1) events.emit(db, cfg, { g: 'mines', r, k: 'r', a: [i] });
      events.emit(db, cfg, { g: 'mines', r, k: 'c', a: [5 * TUG, 5, []] });
      events.close(db, { g: 'mines', r });
    });
  }
  events.flush(db, cfg, { force: true });

  const { findings, rounds } = anticheat.scan(db);
  assert.ok(rounds >= 13);
  const kinds = findings.map((f) => f.kind).sort();
  assert.deepStrictEqual(kinds, ['jigsaw-scripted', 'jigsaw-too-fast', 'mines-improbable']);
  for (const f of findings) {
    assert.strictEqual(f.userId, 1);
    assert.strictEqual(f.pubkey, keys.alice.pub);
    assert.ok(f.blocks.length >= 1, `${f.kind} cites its blocks`);
    assert.ok(f.blocks.every((h) => Number.isInteger(h) && h > 0));
  }
  assert.ok(anticheat.survival(3, 20) < 0.01);

  const line = doctor.cheatsReported(db, cfg);
  assert.ok(line.ok, 'reported, never failed');
  assert.match(line.detail, /3 finding\(s\)/);
  assert.match(line.detail, /0 under review, 0 banned/);

  // Acting on a finding puts its evidence on the chain with the freeze.
  const f = findings.find((x) => x.kind === 'jigsaw-too-fast');
  const flagged = anticheat.flag(db, cfg, { userId: f.userId, why: `${f.kind}: ${f.detail}`, blocks: f.blocks, actor: ACTOR });
  const tx = JSON.parse(db.get('SELECT txs FROM token_blocks WHERE height=?', flagged.height).txs)[0];
  assert.deepStrictEqual(tx.blocks, f.blocks);
  assert.match(doctor.cheatsReported(db, cfg).detail, /1 under review/);
  assert.ok(tc.verifyChain(db).ok);
});

test('a clean record finds nothing, and the doctor says so', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  assert.deepStrictEqual(anticheat.scan(db).findings, []);
  assert.match(doctor.cheatsReported(db, cfg).detail, /nothing found/);
  assert.ok(doctor.checkAll(db, cfg).ok);
});
