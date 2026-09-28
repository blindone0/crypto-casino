'use strict';
// Staked head-to-head matches.
//
// Two things are being checked here, and they are different things.
//
// The first is that the rules cannot be got around: you cannot move for your opponent, you
// cannot move out of turn, you cannot play an illegal move, and you cannot move in a match
// you are not in. The chess rules themselves are tested in chess.test.js; what matters here
// is that the match layer actually consults them.
//
// The second is that the money adds up. Every stake goes into escrow on the chain and every
// payout comes out of it, so after any sequence of matches the tokens in existence must be
// exactly the tokens that were minted, and the house must hold exactly the rake. That
// invariant is checked by replaying the whole chain, not by reading the balances the code
// under test wrote.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const tc = require('../src/tokenchain');
const match = require('../src/match');
const chess = require('../src/chess');

// A tugrik is divisible to eight places, like everything else here, so every stake below
// is written as whole tugriks times TUG. Bare numbers would be hundred-millionths of a
// coin and far under the table minimum.
const TUG = 100000000;

function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  const mk = (id, name) => db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(?,?,?,'x','s',?,0)`, id, name, name, `rc${id}`,
  );
  mk(1, 'alice');
  mk(2, 'bob');
  mk(3, 'carol');
  const users = {
    alice: { id: 1, username: 'alice' },
    bob: { id: 2, username: 'bob' },
    carol: { id: 3, username: 'carol' },
  };
  const keys = {};
  for (const name of Object.keys(users)) {
    const seed = crypto.randomBytes(32).toString('hex');
    const priv = tc.privateKeyFromSeed(seed);
    const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
    tc.registerKey(db, users[name].id, pub, cfg);
    keys[name] = { priv, pub };
  }
  return { cfg, db, users, keys };
}

/** Sign a stake transfer the way the browser would. */
function stakeSpend(db, key, amount) {
  const tx = {
    type: 'transfer',
    from: key.pub,
    to: match.houseKey(db).publicRaw,
    amount,
    nonce: tc.nextNonce(db, key.pub),
  };
  const sig = crypto.sign(
    null, Buffer.from(tc.canonical(tc.transferPayload(tx))), key.priv,
  ).toString('hex');
  return { from: key.pub, nonce: tx.nonce, sig };
}

const open = (db, cfg, users, keys, who, stake = 100 * TUG) => match.create(db, cfg, users[who], {
  game: 'chess', stake, spend: stakeSpend(db, keys[who], stake),
});
const take = (db, cfg, users, keys, who, id, stake = 100 * TUG) => match.join(db, cfg, users[who], {
  id, spend: stakeSpend(db, keys[who], stake),
});

/** Which user sits in which seat, and which of them has the move. */
function seats(db, cfg, users, id) {
  const view = match.detail(db, cfg, users.alice, id);
  return { toMove: view.toMove, white: view.view.white, fen: view.view.fen };
}
// Alice opens every table in these tests, so she is always seat 0.
const userInSeat = (users, seat) => (seat === 0 ? users.alice : users.bob);
const otherSeat = (seat) => (seat === 0 ? 1 : 0);

/** Total tokens in existence, replayed from the chain rather than read from balances. */
function chainTotals(db) {
  const balances = new Map();
  const add = (k, d) => balances.set(k, (balances.get(k) || 0) + d);
  for (const block of db.all('SELECT txs FROM token_blocks ORDER BY height')) {
    for (const tx of JSON.parse(block.txs)) {
      if (tx.type === 'mint') add(tx.to, tx.amount);
      else if (tx.type === 'burn') add(tx.from, -tx.amount);
      else { add(tx.from, -tx.amount); add(tx.to, tx.amount); }
    }
  }
  return balances;
}

test('a challenge escrows the stake and shows up in the lobby', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));

  const before = tc.balanceOf(db, keys.alice.pub);
  const made = open(db, cfg, users, keys, 'alice', 250 * TUG);

  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before - 250 * TUG);
  assert.strictEqual(tc.balanceOf(db, match.houseKey(db).publicRaw), 250 * TUG);

  const lobby = match.lobby(db, cfg, users.bob);
  assert.strictEqual(lobby.open.length, 1);
  assert.strictEqual(lobby.open[0].id, made.id);
  assert.strictEqual(lobby.open[0].stake, 250 * TUG);
  assert.strictEqual(lobby.open[0].host, 'alice');
  assert.strictEqual(lobby.open[0].players.length, 1, 'only the host is seated');
});

test('a stake signed by somebody else is refused', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  // Bob signs, Alice tries to use it. The key is not registered to her account.
  const spend = stakeSpend(db, keys.bob, 100 * TUG);
  assert.throws(
    () => match.create(db, cfg, users.alice, { game: 'chess', stake: 100 * TUG, spend }),
    /not registered to this account/,
  );
});

test('a tampered stake signature is refused', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const spend = stakeSpend(db, keys.alice, 100 * TUG);
  assert.throws(
    () => match.create(db, cfg, users.alice, { game: 'chess', stake: 500 * TUG, spend }),
    /signature does not match/,
    'a signature for 100 must not authorise 500',
  );
});

test('a stake signature cannot be replayed', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const spend = stakeSpend(db, keys.alice, 100 * TUG);
  match.create(db, cfg, users.alice, { game: 'chess', stake: 100 * TUG, spend });
  assert.throws(
    () => match.create(db, cfg, users.alice, { game: 'chess', stake: 100 * TUG, spend }),
    /already been used/,
  );
});

test('stakes outside the configured band are refused', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  for (const bad of [0, -100, cfg.match.minStake - 1, cfg.match.maxStake + 1, 1.5, NaN]) {
    assert.throws(
      () => match.create(db, cfg, users.alice, {
        game: 'chess', stake: bad, spend: stakeSpend(db, keys.alice, 100 * TUG),
      }),
      /stake/,
      `accepted a stake of ${bad}`,
    );
  }
});

test('you cannot join your own challenge, and cannot join twice', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice');
  assert.throws(() => take(db, cfg, users, keys, 'alice', made.id), /your own challenge/);
  take(db, cfg, users, keys, 'bob', made.id);
  assert.throws(() => take(db, cfg, users, keys, 'carol', made.id), /no longer open/);
});

test('cancelling an unanswered challenge returns the stake in full', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const before = tc.balanceOf(db, keys.alice.pub);
  const made = open(db, cfg, users, keys, 'alice', 300 * TUG);
  match.cancel(db, users.alice, made.id);
  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before, 'nothing was kept');
  assert.strictEqual(tc.balanceOf(db, match.houseKey(db).publicRaw), 0);
  assert.strictEqual(match.lobby(db, cfg, users.bob).open.length, 0);
});

test('only the host can cancel, and only before it starts', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice');
  assert.throws(() => match.cancel(db, users.bob, made.id), /not your challenge/);
  take(db, cfg, users, keys, 'bob', made.id);
  assert.throws(() => match.cancel(db, users.alice, made.id), /already started/);
});

test('one account cannot paper the lobby with challenges', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  for (let i = 0; i < cfg.match.maxOpenPerUser; i += 1) open(db, cfg, users, keys, 'alice', 10 * TUG);
  assert.throws(() => open(db, cfg, users, keys, 'alice', 10 * TUG), /too many open challenges/);
});

test('the board is dealt with one player as White and the clocks start', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice');
  take(db, cfg, users, keys, 'bob', made.id);

  const view = match.detail(db, cfg, users.alice, made.id);
  assert.strictEqual(view.status, 'playing');
  assert.strictEqual(view.seat, 0);
  assert.ok([0, 1].includes(view.view.white));
  assert.strictEqual(view.view.fen, chess.START_FEN);
  assert.strictEqual(view.toMove, view.view.white, 'White moves first');
  assert.ok(view.clock[0] > 0 && view.clock[1] > 0);
  assert.strictEqual(view.view.legal.length, 20);
});

test('you cannot move out of turn, for the other side, or from outside the match', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice');
  take(db, cfg, users, keys, 'bob', made.id);
  const { toMove } = seats(db, cfg, users, made.id);
  const mover = userInSeat(users, toMove);
  const waiter = userInSeat(users, otherSeat(toMove));

  assert.throws(() => match.act(db, cfg, waiter, { id: made.id, move: 'e2e4' }), /not your turn/);
  assert.throws(() => match.act(db, cfg, users.carol, { id: made.id, move: 'e2e4' }), /not in that match/);
  assert.throws(() => match.act(db, cfg, mover, { id: made.id, move: 'e2e5' }), /illegal move/);
  assert.throws(() => match.act(db, cfg, mover, { id: made.id, move: 'hello' }), /illegal move/);
  assert.doesNotThrow(() => match.act(db, cfg, mover, { id: made.id, move: 'e2e4' }));
});

test('moves alternate and are recorded in algebraic notation', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice');
  take(db, cfg, users, keys, 'bob', made.id);

  for (const m of ['e2e4', 'e7e5', 'g1f3']) {
    const { toMove } = seats(db, cfg, users, made.id);
    match.act(db, cfg, userInSeat(users, toMove), { id: made.id, move: m });
  }
  const view = match.detail(db, cfg, users.alice, made.id);
  assert.deepStrictEqual(view.view.san, ['e4', 'e5', 'Nf3']);
  assert.strictEqual(view.moves.length, 3);
  assert.notStrictEqual(view.moves[0].seat, view.moves[1].seat, 'the seats alternate');
});

test('checkmate ends the match and pays the winner the pot less the rake', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 100 * TUG;
  const start = {
    alice: tc.balanceOf(db, keys.alice.pub),
    bob: tc.balanceOf(db, keys.bob.pub),
  };
  const made = open(db, cfg, users, keys, 'alice', stake);
  take(db, cfg, users, keys, 'bob', made.id, stake);

  // Fool's mate: Black gives mate on the fourth ply.
  let last = null;
  for (const m of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    const { toMove } = seats(db, cfg, users, made.id);
    last = match.act(db, cfg, userInSeat(users, toMove), { id: made.id, move: m });
  }

  assert.strictEqual(last.reason, 'checkmate');
  const view = match.detail(db, cfg, users.alice, made.id);
  assert.strictEqual(view.status, 'done');

  const pot = stake * 2;
  const rake = Math.floor(pot * cfg.match.rake);
  const prize = pot - rake;
  // Black mated, so whoever was Black takes the prize.
  const winnerIsHost = view.view.white === 1;
  const winner = winnerIsHost ? 'alice' : 'bob';
  const loser = winnerIsHost ? 'bob' : 'alice';
  assert.deepStrictEqual(last.winners, [winnerIsHost ? 0 : 1]);
  assert.strictEqual(tc.balanceOf(db, keys[winner].pub), start[winner] - stake + prize);
  assert.strictEqual(tc.balanceOf(db, keys[loser].pub), start[loser] - stake);
  assert.strictEqual(tc.balanceOf(db, match.houseKey(db).publicRaw), rake);
});

test('resignation hands the pot to the other side', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice', 200 * TUG);
  take(db, cfg, users, keys, 'bob', made.id, 200 * TUG);
  const before = tc.balanceOf(db, keys.bob.pub);

  const out = match.resign(db, cfg, users.alice, made.id);
  assert.strictEqual(out.reason, 'resignation');
  assert.deepStrictEqual(out.winners, [1]);

  const prize = (400 * TUG) - Math.floor(400 * TUG * cfg.match.rake);
  assert.strictEqual(tc.balanceOf(db, keys.bob.pub), before + prize);
  assert.strictEqual(match.detail(db, cfg, users.bob, made.id).status, 'done');
});

test('a settled match is closed to further play', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice');
  take(db, cfg, users, keys, 'bob', made.id);
  match.resign(db, cfg, users.alice, made.id);

  assert.throws(() => match.act(db, cfg, users.bob, { id: made.id, move: 'e2e4' }), /not in play/);
  assert.throws(() => match.resign(db, cfg, users.bob, made.id), /not in play/);
  assert.throws(() => match.claimTimeout(db, cfg, users.bob, made.id), /not in play/);
});

test('a draw splits the pot and the odd unit stays with the house', (t) => {
  const { cfg, db, users, keys } = setup({ match: { rake: 0 } });
  t.after(() => cleanup(cfg, db));
  // An odd pot, so the halves cannot be equal: 2 x 101 = 202, each side gets 101.
  const made = open(db, cfg, users, keys, 'alice', 101 * TUG);
  take(db, cfg, users, keys, 'bob', made.id, 101 * TUG);
  const before = {
    alice: tc.balanceOf(db, keys.alice.pub),
    bob: tc.balanceOf(db, keys.bob.pub),
  };
  const row = db.get('SELECT * FROM matches WHERE id=?', made.id);
  match.settle(db, cfg, row, [0, 1], 'agreed');

  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before.alice + 101 * TUG);
  assert.strictEqual(tc.balanceOf(db, keys.bob.pub), before.bob + 101 * TUG);
  assert.strictEqual(tc.balanceOf(db, match.houseKey(db).publicRaw), 0);
});

test('a timeout cannot be claimed before the clock has actually run out', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice');
  take(db, cfg, users, keys, 'bob', made.id);
  assert.throws(() => match.claimTimeout(db, cfg, users.alice, made.id), /has not run out/);
  assert.throws(() => match.claimTimeout(db, cfg, users.carol, made.id), /not in that match/);
});

test('a flagged clock loses the match to the other side', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice', 100 * TUG);
  take(db, cfg, users, keys, 'bob', made.id, 100 * TUG);
  const { toMove } = seats(db, cfg, users, made.id);

  // Run the mover's clock to nothing by backdating the last move.
  db.run('UPDATE matches SET moved_at_ms=? WHERE id=?', Date.now() - 60 * 60 * 1000, made.id);

  const out = match.claimTimeout(db, cfg, users.alice, made.id);
  assert.strictEqual(out.reason, 'timeout');
  assert.deepStrictEqual(out.winners, [otherSeat(toMove)]);
});

test('moving after your flag has fallen does not save you', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice');
  take(db, cfg, users, keys, 'bob', made.id);
  const { toMove } = seats(db, cfg, users, made.id);
  db.run('UPDATE matches SET moved_at_ms=? WHERE id=?', Date.now() - 60 * 60 * 1000, made.id);

  const out = match.act(db, cfg, userInSeat(users, toMove), { id: made.id, move: 'e2e4' });
  assert.strictEqual(out.reason, 'timeout');
  assert.deepStrictEqual(out.winners, [otherSeat(toMove)]);
});

test('flagging against a bare king is a draw, not a win', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice');
  take(db, cfg, users, keys, 'bob', made.id);

  // Black is to move with a rook and pawns; White has nothing but a king, so White cannot
  // mate and Black running out of time is a draw rather than a loss.
  const row = db.get('SELECT * FROM matches WHERE id=?', made.id);
  const state = JSON.parse(row.state);
  state.fen = '4k3/8/8/8/8/8/5ppp/4K3 b - - 0 1';
  state.white = 0;
  db.run('UPDATE matches SET state=?, moved_at_ms=? WHERE id=?',
    JSON.stringify(state), Date.now() - 60 * 60 * 1000, made.id);

  const out = match.claimTimeout(db, cfg, users.alice, made.id);
  assert.deepStrictEqual(out.winners.sort(), [0, 1],
    'a player who cannot mate cannot win on time, so it is a draw');
});

test('tokens are conserved across a run of matches', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));

  // Every tugrik that exists was minted once, at genesis. Nothing a match does may
  // change that total: stakes move into escrow and out again, and the rake is a balance
  // like any other.
  const minted = cfg.token.maxSupply;
  let rakeTaken = 0;

  // A decisive game, a resignation, and a cancelled challenge.
  const a = open(db, cfg, users, keys, 'alice', 100 * TUG);
  take(db, cfg, users, keys, 'bob', a.id, 100 * TUG);
  for (const m of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    const { toMove } = seats(db, cfg, users, a.id);
    match.act(db, cfg, userInSeat(users, toMove), { id: a.id, move: m });
  }
  rakeTaken += Math.floor(200 * TUG * cfg.match.rake);

  const b = open(db, cfg, users, keys, 'alice', 340 * TUG);
  take(db, cfg, users, keys, 'bob', b.id, 340 * TUG);
  match.resign(db, cfg, users.bob, b.id);
  rakeTaken += Math.floor(680 * TUG * cfg.match.rake);

  const c = open(db, cfg, users, keys, 'alice', 50 * TUG);
  match.cancel(db, users.alice, c.id);

  // Replay the chain from genesis and check it against what the database believes.
  const replayed = chainTotals(db);
  let total = 0;
  for (const [pubkey, amount] of replayed) {
    assert.strictEqual(tc.balanceOf(db, pubkey), amount, `balance disagrees for ${pubkey}`);
    total += amount;
  }
  assert.strictEqual(total, minted, 'tokens were created or destroyed');
  assert.strictEqual(replayed.get(match.houseKey(db).publicRaw), rakeTaken,
    'the house holds exactly the rake and nothing else');
  assert.strictEqual(tc.verifyChain(db).ok, true, 'the chain still verifies');
});

test('the operator view reports what the matches earned', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const made = open(db, cfg, users, keys, 'alice', 200 * TUG);
  take(db, cfg, users, keys, 'bob', made.id, 200 * TUG);
  match.resign(db, cfg, users.alice, made.id);

  const stats = match.stats(db);
  assert.strictEqual(stats.played, 1);
  assert.strictEqual(stats.wagered, 400 * TUG);
  assert.strictEqual(stats.rake, Math.floor(400 * TUG * cfg.match.rake));
  assert.strictEqual(stats.perGame[0].game, 'chess');
});

test('matches are refused when the feature is switched off', (t) => {
  const { cfg, db, users, keys } = setup({ match: { enabled: false } });
  t.after(() => cleanup(cfg, db));
  assert.throws(
    () => match.create(db, cfg, users.alice, {
      game: 'chess', stake: 100 * TUG, spend: stakeSpend(db, keys.alice, 100 * TUG),
    }),
    /matches are closed/,
  );
});

test('an unknown game is refused before any money moves', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const before = tc.balanceOf(db, keys.alice.pub);
  assert.throws(
    () => match.create(db, cfg, users.alice, {
      game: 'backgammon', stake: 100 * TUG, spend: stakeSpend(db, keys.alice, 100 * TUG),
    }),
    /no such game/,
  );
  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before, 'nothing was taken');
});
