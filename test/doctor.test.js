'use strict';
// The health check, checked.
//
// A check that cannot fail is decoration. So every one of these breaks the thing the
// check is meant to notice — writing a balance the ledger does not know about, minting a
// block after genesis, spending escrow out from under a live table — and asserts the
// doctor says so, by name, rather than quietly passing.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const doctor = require('../src/doctor');
const tc = require('../src/tokenchain');
const match = require('../src/match');

const TUG = 100000000;

function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  const users = {};
  const keys = {};
  ['alice', 'bob'].forEach((name, i) => {
    const id = i + 1;
    db.run(
      `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
       VALUES(?,?,?,'x','s',?,0)`, id, name, name, `rc${id}`,
    );
    users[name] = { id };
    const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
    const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
    tc.registerKey(db, id, pub, cfg);
    keys[name] = { priv, pub };
  });
  return { cfg, db, users, keys };
}

function spend(db, key, amount) {
  const tx = {
    type: 'transfer', from: key.pub, to: match.houseKey(db).publicRaw, amount,
    nonce: tc.nextNonce(db, key.pub),
  };
  const sig = crypto.sign(
    null, Buffer.from(tc.canonical(tc.transferPayload(tx))), key.priv,
  ).toString('hex');
  return { from: key.pub, nonce: tx.nonce, sig };
}

const named = (out, name) => out.checks.find((c) => c.name === name);

test('a healthy site passes every check', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));

  const out = doctor.checkAll(db, cfg);

  assert.strictEqual(out.ok, true, out.checks.filter((c) => !c.ok).map((c) => c.detail).join('; '));
  assert.ok(out.checks.length >= 7, 'all the checks ran');
  for (const check of out.checks) {
    assert.ok(check.name && check.detail, `${check.name} says nothing useful`);
  }
});

test('a balance written behind the ledger is caught', (t) => {
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  const ledger = require('../src/ledger');
  const account = db.tx(() => ledger.userAccount(db, users.alice.id));

  // The one thing the double-entry rule forbids: money appearing in an account with no
  // row saying where it came from.
  db.run('UPDATE accounts SET balance = balance + 500 WHERE id=?', account.id);

  const out = doctor.checkAll(db, cfg);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(named(out, 'ledger').ok, false);
  assert.match(named(out, 'ledger').detail, /but the ledger says/);
});

test('a broken chain is caught', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  assert.strictEqual(named(doctor.checkAll(db, cfg), 'token chain').ok, true);

  // Relink a block to nothing. Every later block's hash no longer follows.
  db.run("UPDATE token_blocks SET prev_hash='00' WHERE height=(SELECT MAX(height) FROM token_blocks)");

  const out = doctor.checkAll(db, cfg);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(named(out, 'token chain').ok, false);
  assert.match(named(out, 'token chain').detail, /broken/);
});

test('a mint after genesis is caught even if the chain is otherwise sound', (t) => {
  // The supply cap's whole point. verifyChain has its own rule about this, so the check
  // here is that the doctor reports it as a supply problem and names the block.
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const top = db.get('SELECT height, txs FROM token_blocks ORDER BY height DESC LIMIT 1');
  const txs = JSON.parse(top.txs);
  txs.push({ type: 'mint', to: 'ff'.repeat(32), amount: 1000 * TUG });
  db.run('UPDATE token_blocks SET txs=? WHERE height=?', JSON.stringify(txs), top.height);

  const supply = doctor.supplyHolds(db, cfg);
  assert.strictEqual(supply.ok, false);
  assert.match(supply.detail, /minted after genesis/);
  assert.match(supply.detail, new RegExp(`block ${top.height}`));
});

test('escrow short of what it owes is caught', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 100 * TUG;
  match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  assert.strictEqual(named(doctor.checkAll(db, cfg), 'escrow').ok, true);

  // Pay the stake away while the table is still live: the house now owes a table it
  // cannot cover.
  db.tx(() => {
    tc.appendBlock(db, [match.houseTransfer(db, keys.bob.pub, stake)]);
  });

  const out = doctor.checkAll(db, cfg);
  assert.strictEqual(out.ok, false);
  const escrow = named(out, 'escrow');
  assert.strictEqual(escrow.ok, false);
  assert.match(escrow.detail, /holds only/);
});

test('a table the sweeper should have taken is caught', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake: 20 * TUG, seats: 2, spend: spend(db, keys.alice, 20 * TUG),
  });
  assert.strictEqual(named(doctor.checkAll(db, cfg), 'stranded tables').ok, true);

  // Far past its expiry and still open, so the sweeper is not running.
  db.run('UPDATE matches SET created_at = created_at - ? WHERE id=?',
    cfg.match.openExpirySeconds * 5, made.id);

  const out = doctor.checkAll(db, cfg);
  assert.strictEqual(named(out, 'stranded tables').ok, false);
  assert.match(named(out, 'stranded tables').detail, /expired challenges/);

  // And sweeping it makes the complaint go away, which is the point of the check.
  match.sweep(db, cfg);
  assert.strictEqual(named(doctor.checkAll(db, cfg), 'stranded tables').ok, true);
});

test('rows left behind by a deleted user are caught', (t) => {
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  db.run(
    'INSERT INTO sessions(token_hash,user_id,csrf,ip,created_at,expires_at) VALUES(?,?,?,?,?,?)',
    'hash', users.alice.id, 'csrf', null, 0, 9999999999,
  );
  assert.strictEqual(named(doctor.checkAll(db, cfg), 'orphans').ok, true);

  // Delete the user around the foreign key, the way a connection with foreign_keys off
  // would have done.
  db.exec('PRAGMA foreign_keys = OFF');
  db.run('DELETE FROM users WHERE id=?', users.alice.id);
  db.exec('PRAGMA foreign_keys = ON');

  const out = doctor.checkAll(db, cfg);
  assert.strictEqual(named(out, 'orphans').ok, false);
  assert.match(named(out, 'orphans').detail, /sessions/);
});

test('a database behind the code is caught', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const migrate = require('../src/migrate');
  assert.strictEqual(doctor.schemaCurrent(db).ok, true);

  migrate.setVersion(db.raw, 0);

  const check = doctor.schemaCurrent(db);
  assert.strictEqual(check.ok, false);
  assert.match(check.detail, /code expects/);
  migrate.setVersion(db.raw, migrate.latest());
});

test('the doctor writes nothing', (t) => {
  // It is meant to be safe against production at any hour, including from cron while
  // people are playing. A check that tidied up as it went would be a different tool.
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake: 20 * TUG, seats: 2, spend: spend(db, keys.alice, 20 * TUG),
  });
  db.run('UPDATE matches SET created_at = created_at - ? WHERE id=?',
    cfg.match.openExpirySeconds * 5, made.id);

  const snapshot = () => JSON.stringify({
    matches: db.all('SELECT * FROM matches'),
    seats: db.all('SELECT * FROM match_seats'),
    blocks: db.get('SELECT COUNT(*) AS n FROM token_blocks').n,
    accounts: db.all('SELECT * FROM accounts'),
  });
  const before = snapshot();

  const out = doctor.checkAll(db, cfg);

  assert.strictEqual(out.ok, false, 'it did find the stranded table');
  assert.strictEqual(snapshot(), before, 'and changed nothing while finding it');
});

test('with the token off the token checks pass rather than crash', (t) => {
  // Someone running the casino without the tugrik should still be able to use this.
  const { cfg, db } = setup({ token: { enabled: false } });
  t.after(() => cleanup(cfg, db));

  const out = doctor.checkAll(db, cfg);

  assert.strictEqual(out.ok, true);
  assert.strictEqual(named(out, 'token chain').detail, 'token is off');
  assert.strictEqual(named(out, 'supply').detail, 'token is off');
});
