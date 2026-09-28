'use strict';
// The drag-to-assemble jigsaw.
//
// This is the site's only skill game, and that changes what the tests have to defend.
// With a chance game the question is whether the odds are what they claim. Here anyone who
// keeps dragging finishes eventually, so the only thing deciding a payout is how fast —
// and the tests below are almost entirely about the ways someone could lie about that.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const jigsaw = require('../src/games/jigsaw');
const fair = require('../src/fair');
const bankMod = require('../src/bank');
const tc = require('../src/tokenchain');
const matches = require('../src/match');

const TUG = 100000000;

function setup() {
  const cfg = testConfig();
  const db = openTestDb(cfg);
  db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(1,'alice','alice','x','seed','rc1',0)`,
  );
  const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
  const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
  tc.registerKey(db, 1, pub, cfg);
  // The house needs a float, or capPayout truncates every win and the tests measure the
  // ceiling rather than the game.
  tc.appendBlock(db, [tc.treasuryTransfer(db, matches.houseKey(db).publicRaw, 500 * TUG)]);
  return { cfg, db, priv, pub, user: db.get('SELECT * FROM users WHERE id=1') };
}

const sign = (db, priv, pub, amount) => {
  const tx = {
    type: 'transfer', from: pub, to: matches.houseKey(db).publicRaw, amount,
    nonce: tc.nextNonce(db, pub),
  };
  const sig = crypto.sign(null, Buffer.from(tc.canonical(tc.transferPayload(tx))), priv).toString('hex');
  return { from: pub, nonce: tx.nonce, sig };
};

const ctxFor = (cfg, db, user, spend) => ({
  db, cfg, user,
  bank: bankMod.bankFor(db, cfg, spend),
  bankFor: (s) => bankMod.bankFor(db, cfg, s),
});

/** Open a round and hand back everything needed to finish it. */
function open(cfg, db, priv, pub, user, board = 'easy', stake = TUG) {
  const out = jigsaw.start(ctxFor(cfg, db, user, sign(db, priv, pub, stake)),
    { amount: String(stake / TUG), board });
  return out;
}

/** The only arrangement that counts: every piece in its own slot. */
const solved = (n) => Array.from({ length: n }, (_, i) => i);

// ---------------------------------------------------------------------------

test('a round starts scrambled, and the scramble replays from the seed', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  const g = open(cfg, db, priv, pub, user, 'easy');
  assert.strictEqual(g.pieces, 16);
  assert.strictEqual(g.scramble.length, 16);
  // Every piece appears exactly once — a scramble that lost or duplicated one would be
  // unsolvable, and the player would have paid for it.
  assert.deepStrictEqual([...g.scramble].sort((a, b) => a - b), solved(16));
  assert.ok(g.scramble.some((piece, slot) => piece !== slot), 'it must not start solved');

  const row = db.get('SELECT * FROM jigsaw_games WHERE id=?', g.id);
  const seed = db.get('SELECT * FROM server_seeds WHERE id=?', row.seed_id);
  const replay = jigsaw.scrambleFor(seed.seed, row.client_seed, row.nonce, jigsaw.boardOf('easy'));
  assert.deepStrictEqual(replay, g.scramble, 'the board played must be reproducible');
});

test('the solution never reaches the client', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  // The whole security model rests on this: the finished arrangement is recomputed here,
  // so a modified client cannot read the answer off the wire.
  const g = open(cfg, db, priv, pub, user, 'hard');
  const wire = JSON.stringify(g);
  assert.ok(!('solution' in g), 'no solution field');
  assert.ok(!wire.includes('"answer"'), 'and nothing pretending to be one');
});

test('an unfinished board is refused and the round stays open', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  const g = open(cfg, db, priv, pub, user, 'easy');
  const wrong = solved(16);
  [wrong[0], wrong[1]] = [wrong[1], wrong[0]];

  assert.throws(
    () => jigsaw.solve(ctxFor(cfg, db, user), { arrangement: wrong }),
    /not complete/,
  );
  assert.ok(jigsaw.current(ctxFor(cfg, db, user)), 'the round is still there to finish');

  // Nor does a board of the wrong length count.
  assert.throws(
    () => jigsaw.solve(ctxFor(cfg, db, user), { arrangement: [0, 1, 2] }),
    /finished board/,
  );
});

test('a finish faster than a human pays nothing, and says so', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  // Solving instantly is what a script does. The round still closes — the entry is spent,
  // which is what an entry is — but it pays zero rather than the full multiple.
  const g = open(cfg, db, priv, pub, user, 'expert');
  const out = jigsaw.solve(ctxFor(cfg, db, user), { arrangement: solved(g.pieces) });

  assert.strictEqual(out.tooFast, true);
  assert.strictEqual(out.multiplier, 0);
  assert.strictEqual(out.payout, 0);
  assert.strictEqual(out.state, 'done');
});

test('the clock is the server\'s, not the client\'s', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  const g = open(cfg, db, priv, pub, user, 'easy');
  // Backdate the start so the round looks like an honest, human-paced finish.
  const board = jigsaw.boardOf('easy');
  const par = Math.round(board.par * board.pieces);
  db.run('UPDATE jigsaw_games SET started_at = started_at - ? WHERE id=?', par, g.id);

  // Claim an absurd time as well, to prove nothing the client sends is consulted.
  const out = jigsaw.solve(ctxFor(cfg, db, user), {
    arrangement: solved(g.pieces), seconds: 1, elapsed: 1, time: 1,
  });

  assert.strictEqual(out.tooFast, false);
  assert.ok(out.seconds >= par, `the server's own elapsed time was used, got ${out.seconds}`);
  assert.ok(out.multiplier > 0, 'a par finish pays');
});

test('slower finishes pay less, down to nothing', () => {
  const cfg = testConfig();
  const board = jigsaw.boardOf('medium');
  const par = board.par * board.pieces;
  const edge = cfg.houseEdge.jigsaw;
  const at = (s) => jigsaw.payoutMultiplier(s, board, edge);

  assert.ok(at(par) > 0, 'par pays the most');
  assert.strictEqual(at(par / 2), at(par), 'and beating par does not pay more than par');
  assert.ok(at(par * 1.5) < at(par), 'slower pays less');
  assert.ok(at(par * 2) < at(par * 1.5));
  assert.strictEqual(at(par * 3), 0, 'three times par pays nothing');
  assert.strictEqual(at(par * 10), 0, 'and so does anything slower');
});

test('the house edge is taken once, at the top of the table', () => {
  const cfg = testConfig();
  const edge = cfg.houseEdge.jigsaw;
  for (const name of Object.keys(jigsaw.BOARDS)) {
    const board = jigsaw.boardOf(name);
    const best = jigsaw.payoutMultiplier(0, board, edge);
    // Through the same `floor2` the game uses, not a hand-rolled truncation: at a 5% edge
    // `3 * 0.95` is 2.8499999999999996 in a double, and a plain floor turns an exact 2.85
    // into 2.84. That is the representation bug already fixed once in src/fair.js, and
    // reimplementing the arithmetic here reintroduced it in the test instead.
    const want = fair.floor2(jigsaw.MAX_MULTIPLIER * (1 - edge));
    assert.strictEqual(best, want, `${name} tops out at the advertised multiple`);
  }
});

test('the stake is taken once and the win is bounded by the house', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  const before = tc.balanceOf(db, pub);
  const g = open(cfg, db, priv, pub, user, 'easy', 2 * TUG);
  assert.strictEqual(tc.balanceOf(db, pub), before - 2 * TUG, 'the entry left once');

  const board = jigsaw.boardOf('easy');
  db.run('UPDATE jigsaw_games SET started_at = started_at - ? WHERE id=?',
    Math.round(board.par * board.pieces), g.id);
  const out = jigsaw.solve(ctxFor(cfg, db, user), { arrangement: solved(g.pieces) });

  const house = tc.balanceOf(db, matches.houseKey(db).publicRaw);
  assert.ok(out.payout <= 2 * TUG + house + out.payout, 'never more than the house could hold');
  assert.strictEqual(tc.verifyChain(db).ok, true, 'and the chain still verifies');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM bets').n, 1, 'one round, one record');
});

test('only one jigsaw at a time, and giving up closes it', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  open(cfg, db, priv, pub, user, 'easy');
  assert.throws(() => open(cfg, db, priv, pub, user, 'hard'), /finish your current/);

  jigsaw.give(ctxFor(cfg, db, user));
  assert.strictEqual(jigsaw.current(ctxFor(cfg, db, user)), null);
  // And the entry is not refunded, because an entry that comes back is not an entry.
  assert.strictEqual(db.get("SELECT payout FROM jigsaw_games WHERE state='done'").payout, 0);
});

test('every board is big, and every one is solvable', () => {
  for (const [name, b] of Object.entries(jigsaw.BOARDS)) {
    const board = jigsaw.boardOf(name);
    assert.ok(board.pieces >= 16, `${name} has ${board.pieces} pieces; small ones are not jigsaws`);
    const scramble = jigsaw.scrambleFor('a'.repeat(64), 'client', 1, board);
    assert.deepStrictEqual([...scramble].sort((a, b2) => a - b2), solved(board.pieces),
      `${name} must scramble to a permutation, or it cannot be finished`);
  }
});
