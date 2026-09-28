'use strict';
// Poker played at the table framework, with real stakes in escrow.
//
// The engine is tested in poker.test.js and the evaluator in holdem-eval.test.js. What is
// left is the join between them and the money: that a seat cannot act out of turn, that
// nobody is sent anybody else's cards, and that when the tournament ends the winner is
// paid exactly the pot less the rake and not a tugrik more.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const tc = require('../src/tokenchain');
const match = require('../src/match');
const poker = require('../src/poker');

const TUG = 100000000;

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

function started(db, cfg, users, keys, names, seats, stake) {
  const sitting = names.slice(0, seats);
  const made = match.create(db, cfg, users[sitting[0]], {
    game: 'poker', stake, seats, spend: spend(db, keys[sitting[0]], stake),
  });
  for (const name of sitting.slice(1)) {
    match.join(db, cfg, users[name], { id: made.id, spend: spend(db, keys[name], stake) });
  }
  return made.id;
}

const userAt = (users, names, seat) => users[names[seat]];

test('a table deals everyone in with the same chips', (t) => {
  const { cfg, db, users, keys, names } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys, names, 3, 100 * TUG);
  const view = match.detail(db, cfg, users.alice, id);

  assert.strictEqual(view.status, 'playing');
  assert.strictEqual(view.seats, 3);
  assert.strictEqual(view.view.chips.length, 3);
  const total = view.view.chips.reduce((a, b) => a + b, 0) + view.view.pot;
  assert.strictEqual(total, 3 * poker.START_CHIPS, 'every chip is accounted for');
  assert.strictEqual(view.view.hole.length, 2, 'you are dealt two cards');
});

test('nobody is sent another seat’s hole cards', (t) => {
  const { cfg, db, users, keys, names } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys, names, 3, 100 * TUG);

  const holes = names.slice(0, 3).map(
    (name) => match.detail(db, cfg, users[name], id).view.hole,
  );
  // All three hands are different, and none appears in anybody else's view.
  for (let seat = 0; seat < 3; seat += 1) {
    for (let other = 0; other < 3; other += 1) {
      if (seat === other) continue;
      const theirs = JSON.stringify(match.detail(db, cfg, users[names[other]], id).view);
      for (const card of holes[seat]) {
        assert.ok(!theirs.includes(`"${card}"`),
          `${card} from seat ${seat} reached seat ${other}`);
      }
    }
  }
  // And a spectator gets no hand at all.
  assert.strictEqual(match.detail(db, cfg, null, id).view.hole, null);
});

test('a seat cannot act out of turn', (t) => {
  const { cfg, db, users, keys, names } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys, names, 3, 100 * TUG);
  const view = match.detail(db, cfg, users.alice, id);
  const waiting = userAt(users, names, (view.toMove + 1) % 3);
  assert.throws(() => match.act(db, cfg, waiting, { id, play: 'fold' }), /not your turn/);
});

test('an illegal raise is a client error, and the table is untouched', (t) => {
  const { cfg, db, users, keys, names } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys, names, 3, 100 * TUG);
  const view = match.detail(db, cfg, users.alice, id);
  const mover = userAt(users, names, view.toMove);
  const o = view.view.toAct === view.seat ? view.view.options : null;
  const opts = o || match.detail(db, cfg, mover, id).view.options;

  assert.throws(
    () => match.act(db, cfg, mover, { id, play: 'raise', amount: opts.maxRaiseTo + 1 }),
    /do not have that many/,
  );
  const after = match.detail(db, cfg, users.alice, id);
  assert.strictEqual(after.view.pot, view.view.pot, 'nothing moved');
});

test('the tournament pays the last player standing, less the rake', (t) => {
  const { cfg, db, users, keys, names } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 80 * TUG;
  const id = started(db, cfg, users, keys, names, 3, stake);
  // Read after the buy-in: everyone's stake is already sitting in escrow by now.
  const before = names.slice(0, 3).map((n) => tc.balanceOf(db, keys[n].pub));

  // Play it out with a simple player: call what it can, occasionally shove.
  let out = null;
  for (let step = 0; step < 6000 && !out; step += 1) {
    const board = match.detail(db, cfg, users.alice, id);
    if (board.status !== 'playing') break;
    const seat = board.toMove;
    assert.ok(seat !== null && seat >= 0, `nobody to act at step ${step}`);
    const me = match.detail(db, cfg, userAt(users, names, seat), id);
    const v = me.view;

    let move = { play: 'check' };
    if (v.street === 'showdown') move = { play: 'next' };
    else if (v.options.check) move = { play: 'check' };
    else if (v.options.call > 0) move = { play: 'call' };
    else move = { play: 'fold' };

    const res = match.act(db, cfg, userAt(users, names, seat), { id, ...move });
    if (res.winners) out = res;
  }

  assert.ok(out, 'the tournament finished');
  assert.strictEqual(out.winners.length, 1, 'exactly one player takes it');
  assert.strictEqual(out.reason, 'last-standing');

  const pot = stake * 3;
  const prize = pot - Math.floor(pot * cfg.match.rake);
  const seat = out.winners[0];
  assert.strictEqual(
    tc.balanceOf(db, keys[names[seat]].pub),
    before[seat] + prize,
    'the winner is paid the pot less the rake',
  );
  for (let s = 0; s < 3; s += 1) {
    if (s === seat) continue;
    assert.strictEqual(tc.balanceOf(db, keys[names[s]].pub), before[s],
      `seat ${s} is paid nothing and loses no more than its stake`);
  }
  assert.strictEqual(tc.verifyChain(db).ok, true, 'and the chain still verifies');
});

test('leaving surrenders your chips without ending everyone else’s game', (t) => {
  const { cfg, db, users, keys, names } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys, names, 3, 50 * TUG);

  const out = match.resign(db, cfg, users.carol, id);
  // Three-handed, one leaving still leaves a game, so this is not a result yet.
  assert.strictEqual(out.ok, true, 'the table carried on');
  const view = match.detail(db, cfg, users.alice, id);
  assert.strictEqual(view.status, 'playing');
  assert.strictEqual(view.view.chips[2], 0, 'the leaver has no chips left');
});

test('heads up, one player leaving ends it', (t) => {
  const { cfg, db, users, keys, names } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 50 * TUG;
  const id = started(db, cfg, users, keys, names, 2, stake);
  const before = tc.balanceOf(db, keys.alice.pub);

  const out = match.resign(db, cfg, users.bob, id);
  assert.deepStrictEqual(out.winners, [0]);
  const prize = (stake * 2) - Math.floor(stake * 2 * cfg.match.rake);
  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before + prize);
});

test('poker seats two to six', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  assert.strictEqual(match.GAMES.poker.seats.min, 2);
  assert.strictEqual(match.GAMES.poker.seats.max, 6);
  assert.throws(
    () => match.create(db, cfg, users.alice, {
      game: 'poker', stake: 50 * TUG, seats: 7, spend: spend(db, keys.alice, 50 * TUG),
    }),
    /is for 2 to 6/,
  );
});
