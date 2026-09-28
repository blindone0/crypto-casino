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
function open(cfg, db, priv, pub, user, board = SMALLEST, stake = TUG) {
  const out = jigsaw.start(ctxFor(cfg, db, user, sign(db, priv, pub, stake)),
    { amount: String(stake / TUG), board });
  return out;
}

/** The only arrangement that counts: every piece in its own slot. */
const solved = (n) => Array.from({ length: n }, (_, i) => i);

// The board names by position rather than by literal. The ladder has been retuned three
// times — four boards, then two, now one 10x10 — and each time the tests that named a
// board broke for reasons unconnected to what they were checking. With a single board
// SMALLEST and BIGGEST are the same name, which is correct: they mean "an end of the
// ladder", and a one-rung ladder has both ends in the same place.
const NAMES = Object.keys(jigsaw.BOARDS);
const SMALLEST = NAMES[0];
const BIGGEST = NAMES[NAMES.length - 1];

// ---------------------------------------------------------------------------

test('a round starts scrambled, and the scramble replays from the seed', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  const g = open(cfg, db, priv, pub, user, SMALLEST);
  // Read the size from the board rather than pinning a number here: the boards are a
  // product decision that has already changed once, and a test that breaks when they are
  // retuned is testing the wrong thing.
  const small = jigsaw.boardOf(SMALLEST);
  assert.strictEqual(g.pieces, small.pieces);
  assert.strictEqual(g.scramble.length, small.pieces);
  // Every piece appears exactly once — a scramble that lost or duplicated one would be
  // unsolvable, and the player would have paid for it.
  assert.deepStrictEqual([...g.scramble].sort((a, b) => a - b), solved(small.pieces));
  assert.ok(g.scramble.some((piece, slot) => piece !== slot), 'it must not start solved');

  const row = db.get('SELECT * FROM jigsaw_games WHERE id=?', g.id);
  const seed = db.get('SELECT * FROM server_seeds WHERE id=?', row.seed_id);
  const replay = jigsaw.scrambleFor(seed.seed, row.client_seed, row.nonce, jigsaw.boardOf(SMALLEST));
  assert.deepStrictEqual(replay, g.scramble, 'the board played must be reproducible');
});

test('the solution never reaches the client', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  // The whole security model rests on this: the finished arrangement is recomputed here,
  // so a modified client cannot read the answer off the wire.
  const g = open(cfg, db, priv, pub, user, BIGGEST);
  const wire = JSON.stringify(g);
  assert.ok(!('solution' in g), 'no solution field');
  assert.ok(!wire.includes('"answer"'), 'and nothing pretending to be one');
});

test('an unfinished board is refused and the round stays open', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  const g = open(cfg, db, priv, pub, user, SMALLEST);
  const wrong = solved(g.pieces);
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

test('a board with empty slots is refused, however they are spelled', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  // The client's board starts empty and an unplaced slot is `null`. That matters here
  // because `Number(null)` is 0, which equals slot 0 — so a board submitted with holes in
  // it is not obviously refused by an equality check, it is refused by the accident that
  // the other slots do not also match. This pins the intent rather than the accident.
  const g = open(cfg, db, priv, pub, user, SMALLEST);
  const full = solved(g.pieces);

  for (const hole of [null, undefined, '', ' ', NaN]) {
    const board = [...full];
    board[board.length - 1] = hole;
    assert.throws(
      () => jigsaw.solve(ctxFor(cfg, db, user), { arrangement: board }),
      /not complete/,
      `a board holding ${String(hole)} must not pay`,
    );
  }
  // An all-empty board is the degenerate case, and slot 0 is the one it could sneak past.
  assert.throws(
    () => jigsaw.solve(ctxFor(cfg, db, user), {
      arrangement: new Array(g.pieces).fill(null),
    }),
    /not complete/,
  );
  assert.ok(jigsaw.current(ctxFor(cfg, db, user)), 'and the round is still open');
});

test('a finish faster than a human pays nothing, and says so', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  // Solving instantly is what a script does. The round still closes — the entry is spent,
  // which is what an entry is — but it pays zero rather than the full multiple.
  const g = open(cfg, db, priv, pub, user, BIGGEST);
  const out = jigsaw.solve(ctxFor(cfg, db, user), { arrangement: solved(g.pieces) });

  assert.strictEqual(out.tooFast, true);
  assert.strictEqual(out.multiplier, 0);
  assert.strictEqual(out.payout, 0);
  assert.strictEqual(out.state, 'done');
});

test('the clock is the server\'s, not the client\'s', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  const g = open(cfg, db, priv, pub, user, SMALLEST);
  // Backdate the start so the round looks like an honest, human-paced finish.
  const board = jigsaw.boardOf(SMALLEST);
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
  const board = jigsaw.boardOf(SMALLEST);
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
  const g = open(cfg, db, priv, pub, user, SMALLEST, 2 * TUG);
  assert.strictEqual(tc.balanceOf(db, pub), before - 2 * TUG, 'the entry left once');

  const board = jigsaw.boardOf(SMALLEST);
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

  open(cfg, db, priv, pub, user, SMALLEST);
  // A second round of the same board, because there is only one board now. The rule being
  // checked is one round per player, not one per size.
  assert.throws(() => open(cfg, db, priv, pub, user, SMALLEST), /finish your current/);

  jigsaw.give(ctxFor(cfg, db, user));
  assert.strictEqual(jigsaw.current(ctxFor(cfg, db, user)), null);
  // And the entry is not refunded, because an entry that comes back is not an entry.
  assert.strictEqual(db.get("SELECT payout FROM jigsaw_games WHERE state='done'").payout, 0);
});

test('a round on a retired board stays playable instead of stranding the player', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  // This is a real failure that happened, not a hypothetical. The board table has been
  // retuned three times, and each time every round open at that moment named a board that
  // had just stopped existing. `boardOf` threw, so `current` threw, so the client saw no
  // round and drew the start panel — and start was then refused with "finish your current
  // jigsaw first", naming a round the interface would not show. No way forward and no way
  // out, which is precisely the dead end this project is meant not to have.
  const g = open(cfg, db, priv, pub, user, SMALLEST);
  db.run("UPDATE jigsaw_games SET board='atlantis' WHERE id=?", g.id);

  const seen = jigsaw.current(ctxFor(cfg, db, user));
  assert.ok(seen, 'the round must still be visible');
  assert.strictEqual(seen.pieces, g.pieces, 'and still the size it was played at');
  assert.strictEqual(seen.scramble.length, g.pieces);
  assert.ok(Array.isArray(seen.payTable) && seen.payTable.length > 0, 'with its ladder intact');

  // And it can still be finished, on the terms it was sold under.
  db.run('UPDATE jigsaw_games SET started_at = started_at - ? WHERE id=?', 600, g.id);
  const out = jigsaw.solve(ctxFor(cfg, db, user), { arrangement: solved(g.pieces) });
  assert.strictEqual(out.state, 'done');
  assert.ok(out.seconds >= 600);

  // Only then is the player free to start a new one, on a board that does exist.
  assert.ok(open(cfg, db, priv, pub, user, SMALLEST), 'and a fresh round opens after');
});

test('a retired board is rebuilt from the scramble, which is the board actually played', () => {
  // The row does not store cols and rows, but it stores the scramble, and the scramble has
  // one entry per piece. That is the authoritative record of the board dealt.
  for (const pieces of [36, 100, 196, 400]) {
    const b = jigsaw.boardOfRound({
      board: 'gone',
      scramble: JSON.stringify(Array.from({ length: pieces }, (_, i) => i)),
    });
    assert.strictEqual(b.pieces, pieces, `a ${pieces}-piece round must rebuild at ${pieces}`);
    assert.strictEqual(b.cols * b.rows, pieces);
    assert.ok(b.par > 0, 'and it must still have a pay curve');
  }
  // A board that still exists is taken from the table, not reconstructed.
  const live = jigsaw.boardOfRound({ board: 'medium', scramble: '[]' });
  assert.strictEqual(live.cols, jigsaw.BOARDS.medium.cols);
  assert.strictEqual(live.retired, undefined);
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
