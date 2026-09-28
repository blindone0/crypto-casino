'use strict';
// Tables nobody is coming back to.
//
// A stake goes into escrow when a match is created and only comes out when the match
// reaches a result. Two situations never reach one: a challenge nobody accepts, and a
// game every player walked away from. Left alone the tokens sit at the house key for
// ever, which is the same failure дурак had inside the rules and this is the same failure
// one layer up.
//
// What matters here is the money. Every test ends by checking that the tokens came back
// to the right keys, that the house is not holding stakes it no longer owes, and that the
// chain still verifies after the sweeper has written to it.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const tc = require('../src/tokenchain');
const match = require('../src/match');

const TUG = 100000000;
const HOUR = 3600;

function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  const users = {};
  const keys = {};
  const names = ['alice', 'bob', 'carol'];
  names.forEach((name, i) => {
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
  return { cfg, db, users, keys, names };
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

const balance = (db, key) => tc.balanceOf(db, key.pub);
const status = (db, id) => db.get('SELECT * FROM matches WHERE id=?', id).status;

/** Backdate a match so the sweeper sees it as old, without waiting for real time. */
function age(db, id, seconds) {
  db.run('UPDATE matches SET created_at = created_at - ? WHERE id=?', seconds, id);
  db.run('UPDATE matches SET moved_at_ms = moved_at_ms - ? WHERE id=? AND moved_at_ms > 0',
    seconds * 1000, id);
}

// ------------------------------------------------------------- open tables

test('a challenge nobody accepts is refunded, not held for ever', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 50 * TUG;
  const before = balance(db, keys.alice);

  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  assert.strictEqual(balance(db, keys.alice), before - stake, 'the stake is in escrow');

  // Not yet: a challenge posted a minute ago is somebody waiting, not somebody gone.
  assert.deepStrictEqual(match.sweep(db, cfg), { expired: 0, resolved: 0, refunded: 0, failed: 0 });
  assert.strictEqual(status(db, made.id), 'open');

  age(db, made.id, cfg.match.openExpirySeconds + 60);
  const swept = match.sweep(db, cfg);

  assert.strictEqual(swept.expired, 1);
  assert.strictEqual(status(db, made.id), 'cancelled');
  assert.strictEqual(balance(db, keys.alice), before, 'the stake came back whole');
  assert.strictEqual(
    db.get('SELECT reason FROM matches WHERE id=?', made.id).reason, 'expired',
  );
  assert.strictEqual(tc.verifyChain(db).ok, true);
});

test('an expired challenge is refunded without a rake', (t) => {
  // Nothing was played, so there is nothing to take a cut of. Charging for a game that
  // never happened would be the house quietly earning on its own inactivity.
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 400 * TUG;
  const before = balance(db, keys.alice);
  const made = match.create(db, cfg, users.alice, {
    game: 'poker', stake, seats: 3, spend: spend(db, keys.alice, stake),
  });

  age(db, made.id, cfg.match.openExpirySeconds + 1);
  match.sweep(db, cfg);

  assert.strictEqual(balance(db, keys.alice), before, 'not a tugrik short');
  assert.strictEqual(db.get('SELECT rake FROM matches WHERE id=?', made.id).rake, 0);
});

test('a part-filled table gives everyone their stake back', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 30 * TUG;
  const before = [balance(db, keys.alice), balance(db, keys.bob)];

  // Three seats, two of them taken: still open, so both stakes are in escrow.
  const made = match.create(db, cfg, users.alice, {
    game: 'poker', stake, seats: 3, spend: spend(db, keys.alice, stake),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, stake) });
  assert.strictEqual(status(db, made.id), 'open', 'a seat is still empty');

  age(db, made.id, cfg.match.openExpirySeconds + 1);
  assert.strictEqual(match.sweep(db, cfg).expired, 1);

  assert.strictEqual(balance(db, keys.alice), before[0]);
  assert.strictEqual(balance(db, keys.bob), before[1]);
  assert.strictEqual(tc.verifyChain(db).ok, true);
});

// --------------------------------------------------------- abandoned games

test('a game both players walk away from is settled on the clock', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 100 * TUG;
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, stake) });
  const after = [balance(db, keys.alice), balance(db, keys.bob)];
  assert.strictEqual(status(db, made.id), 'playing');

  // Nobody has moved for hours. Nobody is left to claim the clock either, which is
  // exactly why the server has to do it.
  age(db, made.id, 6 * HOUR);
  const swept = match.sweep(db, cfg);

  assert.strictEqual(swept.resolved + swept.refunded, 1);
  assert.strictEqual(status(db, made.id), 'done');
  const row = db.get('SELECT result, reason FROM matches WHERE id=?', made.id);
  assert.strictEqual(row.reason, 'timeout', 'the clock decided it');

  const winners = JSON.parse(row.result);
  assert.strictEqual(winners.length, 1, 'the player who did not run out of time won');
  const pot = stake * 2;
  const prize = pot - Math.floor(pot * cfg.match.rake);
  const keyOf = [keys.alice, keys.bob][winners[0]];
  assert.strictEqual(balance(db, keyOf), after[winners[0]] + prize);
  assert.strictEqual(tc.verifyChain(db).ok, true);
});

test('the sweeper settles a game exactly as a player claiming it would', (t) => {
  // The result must not depend on who noticed. If a player could have claimed a win on
  // the clock, the server finding it later has to reach the same answer.
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 20 * TUG;

  // One match, asked both ways. Two matches would not compare: chess draws for colours,
  // so the player on the clock is not the same seat twice running.
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, stake) });
  age(db, made.id, 6 * HOUR);

  const row = db.get('SELECT * FROM matches WHERE id=?', made.id);
  const bySweep = match.timeoutOutcome(db, cfg, row);
  const byClaim = match.claimTimeout(db, cfg, users.alice, made.id);

  assert.strictEqual(bySweep.ready, true, 'the sweeper would have acted');
  assert.deepStrictEqual(bySweep.winners, byClaim.winners, 'same winner either way');
  assert.strictEqual(bySweep.reason, byClaim.reason, 'and the same reason');
});

test('a game nobody can win refunds instead of handing the house the pot', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 75 * TUG;
  const before = [balance(db, keys.alice), balance(db, keys.bob)];
  const made = match.create(db, cfg, users.alice, {
    game: 'seabattle', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, stake) });

  // Sea battle starts with both fleets unplaced. Neither player ever turns up, so
  // neither of them lost: there is nothing to award and nothing to charge for.
  age(db, made.id, 6 * HOUR);
  const swept = match.sweep(db, cfg);

  assert.strictEqual(swept.refunded, 1, 'refunded rather than settled');
  assert.strictEqual(status(db, made.id), 'cancelled');
  assert.strictEqual(balance(db, keys.alice), before[0], 'alice got her stake back');
  assert.strictEqual(balance(db, keys.bob), before[1], 'and so did bob');
  assert.strictEqual(db.get('SELECT rake FROM matches WHERE id=?', made.id).rake, 0);
});

test('a live game is never touched by the sweeper', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 40 * TUG;
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, stake) });

  // Somebody moved a minute ago: this is a game in progress, not an abandoned one.
  for (let i = 0; i < 3; i += 1) {
    assert.deepStrictEqual(match.sweep(db, cfg),
      { expired: 0, resolved: 0, refunded: 0, failed: 0 });
  }
  assert.strictEqual(status(db, made.id), 'playing');
});

// ------------------------------------------------------------------ escrow

test('the house holds at least every stake it owes', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 60 * TUG;

  assert.deepStrictEqual(match.escrowHealth(db), { held: 0, owed: 0, spare: 0, ok: true });

  const open = match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  let health = match.escrowHealth(db);
  assert.strictEqual(health.owed, stake, 'one seat taken, one stake owed');
  assert.strictEqual(health.held, stake);
  assert.ok(health.ok);

  match.join(db, cfg, users.bob, { id: open.id, spend: spend(db, keys.bob, stake) });
  health = match.escrowHealth(db);
  assert.strictEqual(health.owed, stake * 2, 'both stakes are owed while it is played');
  assert.ok(health.ok);

  // Once it is settled the house owes nothing and keeps the rake.
  match.resign(db, cfg, users.bob, open.id);
  health = match.escrowHealth(db);
  assert.strictEqual(health.owed, 0);
  assert.strictEqual(health.spare, Math.floor(stake * 2 * cfg.match.rake), 'the rake, exactly');
  assert.ok(health.ok);
});

test('escrow comes out level after a sweep', (t) => {
  const { cfg, db, users, keys, names } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 25 * TUG;
  const before = names.map((n) => balance(db, keys[n]));

  // One of each: a challenge nobody takes, a game nobody plays, and a game that ends
  // properly. After the sweep the house should owe nothing at all.
  const lonely = match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  const abandoned = match.create(db, cfg, users.bob, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.bob, stake),
  });
  match.join(db, cfg, users.carol, { id: abandoned.id, spend: spend(db, keys.carol, stake) });

  age(db, lonely.id, cfg.match.openExpirySeconds + 1);
  age(db, abandoned.id, 6 * HOUR);
  match.sweep(db, cfg);

  const health = match.escrowHealth(db);
  assert.strictEqual(health.owed, 0, 'nothing is still in escrow');
  assert.ok(health.ok);
  assert.strictEqual(balance(db, keys.alice), before[0], 'the unaccepted challenge came back');

  // The abandoned game was decided on the clock, so between those two the pot moved but
  // nothing left the system except the rake.
  const paid = balance(db, keys.bob) + balance(db, keys.carol);
  assert.strictEqual(paid, before[1] + before[2] - health.spare,
    'every tugrik is either with a player or is the rake');
  assert.strictEqual(tc.verifyChain(db).ok, true);
});

test('sweeping twice changes nothing the second time', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 15 * TUG;
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  age(db, made.id, cfg.match.openExpirySeconds + 1);

  assert.strictEqual(match.sweep(db, cfg).expired, 1);
  const settled = balance(db, keys.alice);
  assert.deepStrictEqual(match.sweep(db, cfg),
    { expired: 0, resolved: 0, refunded: 0, failed: 0 });
  assert.strictEqual(balance(db, keys.alice), settled, 'not refunded twice');
});

// ----------------------------------------------------------------- downtime

test('an outage is given back to the clocks', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 30 * TUG;
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, stake) });

  const at = Date.now();
  match.heartbeat(db, at);
  const before = db.get('SELECT moved_at_ms FROM matches WHERE id=?', made.id).moved_at_ms;

  // The server was off for two hours.
  const out = match.creditDowntime(db, cfg, at + 2 * HOUR * 1000);

  assert.strictEqual(out.down, 2 * HOUR * 1000);
  assert.strictEqual(out.matches, 1);
  const after = db.get('SELECT moved_at_ms FROM matches WHERE id=?', made.id).moved_at_ms;
  assert.strictEqual(after - before, 2 * HOUR * 1000, 'the clock mark moved with the outage');
});

test('an outage does not end every game in progress', (t) => {
  // The regression this exists for. abandonSeconds is measured from the last move, so
  // without crediting the downtime a server that was off for longer than that comes back,
  // finds every live table untouched, and settles the lot as abandoned.
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 30 * TUG;
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, stake) });

  const at = Date.now();
  match.heartbeat(db, at);
  const off = (cfg.match.abandonSeconds + 600) * 1000;

  match.creditDowntime(db, cfg, at + off);
  const swept = match.sweep(db, cfg, Math.floor((at + off) / 1000));

  assert.deepStrictEqual(swept, { expired: 0, resolved: 0, refunded: 0, failed: 0 },
    'the game survived the outage');
  assert.strictEqual(status(db, made.id), 'playing');
});

test('an outage does not expire the challenges posted before it', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 30 * TUG;
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake, seats: 2, spend: spend(db, keys.alice, stake),
  });
  // Posted well into its life, then the server goes down for long enough to finish it off.
  age(db, made.id, cfg.match.openExpirySeconds - 600);

  const at = Date.now();
  match.heartbeat(db, at);
  const off = 3600 * 1000;
  match.creditDowntime(db, cfg, at + off);
  const swept = match.sweep(db, cfg, Math.floor((at + off) / 1000));

  assert.strictEqual(swept.expired, 0, 'it still has the time it had left');
  assert.strictEqual(status(db, made.id), 'open');
});

test('the heartbeat interval is not treated as an outage', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake: 30 * TUG, seats: 2, spend: spend(db, keys.alice, 30 * TUG),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, 30 * TUG) });

  const at = Date.now();
  match.heartbeat(db, at);
  const before = db.get('SELECT moved_at_ms FROM matches WHERE id=?', made.id).moved_at_ms;

  // One beat late is a normal tick, not an outage.
  const out = match.creditDowntime(db, cfg, at + cfg.match.heartbeatSeconds * 1000);

  assert.strictEqual(out.matches, 0);
  assert.strictEqual(
    db.get('SELECT moved_at_ms FROM matches WHERE id=?', made.id).moved_at_ms, before,
  );
});

test('a first start has nothing to credit', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  // No heartbeat has ever been written, so there is no outage to infer.
  assert.deepStrictEqual(match.creditDowntime(db, cfg), { down: 0, matches: 0 });
  // And it leaves one behind for next time.
  assert.ok(Number.isFinite(db.kvGet('match.heartbeat')));
});

test('a clock that went backwards is not paid out on', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = match.create(db, cfg, users.alice, {
    game: 'chess', stake: 30 * TUG, seats: 2, spend: spend(db, keys.alice, 30 * TUG),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, 30 * TUG) });

  const at = Date.now();
  match.heartbeat(db, at);
  const before = db.get('SELECT moved_at_ms FROM matches WHERE id=?', made.id).moved_at_ms;

  const out = match.creditDowntime(db, cfg, at - 5 * HOUR * 1000);

  assert.strictEqual(out.matches, 0, 'a negative gap credits nothing');
  assert.strictEqual(
    db.get('SELECT moved_at_ms FROM matches WHERE id=?', made.id).moved_at_ms, before,
  );
});
