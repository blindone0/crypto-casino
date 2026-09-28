'use strict';
// The arcade in practice mode.
//
// Every cabinet used to demand real tugriks and a wallet to sign with, whatever wallet
// the player had selected, so switching to Тренировка and clicking a machine got you a
// request to go and create a wallet instead of a game. Practice mode is the rest of the
// site's answer to "let me try this without money" and the arcade was the one room that
// ignored it.
//
// Letting it play free costs nothing, because the arcade never pays out. The prize is a
// place on the board, and that is the one thing these tests are really about: a score
// nobody paid for must not land on a board other people bought their way onto.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const arcade = require('../src/arcade');
const tc = require('../src/tokenchain');

function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  const users = {};
  ['alice', 'bob'].forEach((name, i) => {
    const id = i + 1;
    db.run(
      `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
       VALUES(?,?,?,'x','s',?,0)`, id, name, name, `rc${id}`,
    );
    users[name] = { id };
  });
  return { cfg, db, users };
}

/** A player with a funded token wallet, for the paid side of the comparison. */
function withWallet(db, cfg, user) {
  const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
  const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
  tc.registerKey(db, user.id, pub, cfg);
  return { priv, pub };
}

function payToPlay(db, cfg, user, key, game = 'pinball') {
  const spend = {
    from: key.pub, game, amount: cfg.arcade.tokenCost, nonce: tc.nextNonce(db, key.pub),
  };
  spend.sig = crypto.sign(
    null, Buffer.from(tc.canonical(arcade.spendPayload(spend))), key.priv,
  ).toString('hex');
  return arcade.insertToken(db, cfg, user, spend);
}

test('a practice play needs no wallet and no tokens', (t) => {
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  // No wallet at all: this is exactly the state the bug report came from.
  assert.strictEqual(tc.keyFor(db, users.alice.id), null);

  const play = arcade.practicePlay(db, cfg, users.alice, 'pinball');

  assert.ok(play.ticket, 'a ticket came back');
  assert.strictEqual(play.cost, 0);
  assert.strictEqual(play.mode, 'practice');
  assert.strictEqual(play.game, 'pinball');
});

test('a practice play burns nothing', (t) => {
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  const before = db.get('SELECT COUNT(*) AS n FROM token_blocks').n;
  const supply = tc.supply(db).circulating;

  arcade.practicePlay(db, cfg, users.alice, 'pinball');

  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM token_blocks').n, before,
    'no block was written');
  assert.strictEqual(tc.supply(db).circulating, supply, 'and nothing left circulation');
  assert.strictEqual(tc.verifyChain(db).ok, true);
});

test('a practice score does not reach the leaderboard', (t) => {
  // The whole point. Free plays must not take a place somebody paid for.
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  const play = arcade.practicePlay(db, cfg, users.alice, 'pinball');

  const out = arcade.submitScore(db, cfg, users.alice, { ticket: play.ticket, score: 999999 });

  assert.strictEqual(out.score, 999999);
  assert.strictEqual(out.mode, 'practice');
  assert.deepStrictEqual(arcade.leaderboard(db, 'pinball'), [], 'the board is still empty');
});

test('a practice score does not become a personal best', (t) => {
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  const key = withWallet(db, cfg, users.alice);

  const paid = payToPlay(db, cfg, users.alice, key);
  arcade.submitScore(db, cfg, users.alice, { ticket: paid.ticket, score: 100 });

  const free = arcade.practicePlay(db, cfg, users.alice, 'pinball');
  const out = arcade.submitScore(db, cfg, users.alice, { ticket: free.ticket, score: 50000 });

  assert.strictEqual(out.personalBest, 100, 'the paid score is still the best that counts');
  const overview = arcade.overview(db, cfg, users.alice);
  const pinball = overview.games.find((g) => g.key === 'pinball');
  assert.strictEqual(pinball.mine.best, 100, 'and the floor agrees');
  assert.strictEqual(pinball.mine.plays, 1, 'practice runs are not counted as plays');
});

test('a paid score still reaches the leaderboard', (t) => {
  // The other half: in fencing practice off, nothing real must have been fenced out.
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  const key = withWallet(db, cfg, users.bob);

  const paid = payToPlay(db, cfg, users.bob, key);
  arcade.submitScore(db, cfg, users.bob, { ticket: paid.ticket, score: 4242 });

  const board = arcade.leaderboard(db, 'pinball');
  assert.strictEqual(board.length, 1);
  assert.strictEqual(board[0].username, 'bob');
  assert.strictEqual(board[0].score, 4242);
});

test('a practice ticket is single use like any other', (t) => {
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  const play = arcade.practicePlay(db, cfg, users.alice, 'pinball');
  arcade.submitScore(db, cfg, users.alice, { ticket: play.ticket, score: 10 });

  assert.throws(
    () => arcade.submitScore(db, cfg, users.alice, { ticket: play.ticket, score: 20 }),
    /no open play with that ticket/,
  );
});

test('one player cannot submit a score for another player’s practice ticket', (t) => {
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  const play = arcade.practicePlay(db, cfg, users.alice, 'pinball');

  assert.throws(
    () => arcade.submitScore(db, cfg, users.bob, { ticket: play.ticket, score: 10 }),
    /no open play with that ticket/,
  );
});

test('a practice score is still capped at what the cabinet can produce', (t) => {
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  const play = arcade.practicePlay(db, cfg, users.alice, 'pinball');

  const out = arcade.submitScore(db, cfg, users.alice, {
    ticket: play.ticket, score: arcade.GAMES.pinball.maxScore * 10,
  });

  assert.strictEqual(out.score, arcade.GAMES.pinball.maxScore);
  assert.strictEqual(out.capped, true);
});

test('practice refuses a cabinet that does not exist', (t) => {
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  assert.throws(() => arcade.practicePlay(db, cfg, users.alice, 'roulette'), /no such cabinet/);
  assert.throws(() => arcade.practicePlay(db, cfg, users.alice, ''), /no such cabinet/);
});

// There used to be a test here asserting that a free play is refused when practice mode
// is switched off. Practice mode was a property of the play-money wallet, and that wallet
// is gone: a free go is now simply what the arcade offers when you are short of a tugrik.
// The arcade's own switch still closes the room, which the next test covers.

test('practice refuses when the arcade is closed', (t) => {
  const { cfg, db, users } = setup({ arcade: { enabled: false } });
  t.after(() => cleanup(cfg, db));
  assert.throws(() => arcade.practicePlay(db, cfg, users.alice, 'pinball'), /arcade is closed/);
});

test('every play records which kind it was', (t) => {
  // The column this rests on. Anything that predates it was paid for, which is what the
  // migration's default says, and nothing should be writing a blank.
  const { cfg, db, users } = setup();
  t.after(() => cleanup(cfg, db));
  const key = withWallet(db, cfg, users.alice);
  payToPlay(db, cfg, users.alice, key);
  arcade.practicePlay(db, cfg, users.alice, 'billiards');

  // Mapped to plain objects: node:sqlite hands back null-prototype rows, and
  // deepStrictEqual counts that as a difference.
  const modes = db.all('SELECT game, mode FROM arcade_plays ORDER BY id')
    .map((r) => ({ game: r.game, mode: r.mode }));
  assert.deepStrictEqual(modes, [
    { game: 'pinball', mode: 'real' },
    { game: 'billiards', mode: 'practice' },
  ]);
});
