'use strict';
// Балда.
//
// The rule that actually needs defending is the path. A player sends a word, and the
// server has to decide whether that word can be read off the board through the square
// they just filled, walking orthogonally and never stepping on a square twice. Getting
// that wrong in either direction ruins the game: too strict and legitimate words are
// refused, too loose and a player can claim anything whose letters happen to be lying
// around.
//
// The board used throughout is the opening word "полка" across the middle row, so every
// square is known:
//
//        0  1  2  3  4
//   0    .  .  .  .  .
//   1    .  .  .  .  .
//   2    п  о  л  к  а      squares 10 11 12 13 14
//   3    .  .  .  .  .
//   4    .  .  .  .  .

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const balda = require('../src/balda');
const words = require('../src/words-ru');
const tc = require('../src/tokenchain');
const match = require('../src/match');

// A tugrik is divisible to eight places, like everything else here, so every stake below
// is written as whole tugriks times TUG. Bare numbers would be hundred-millionths of a
// coin and far under the table minimum.
const TUG = 100000000;

const DICT = words.loadWords();
const cell = (x, y) => y * balda.SIZE + x;
const start = () => ({
  grid: balda.startGrid('полка'),
  used: ['полка'],
  scores: [0, 0],
});

// ------------------------------------------------------------- the dictionary
test('the dictionary is usable and only holds Russian words', () => {
  assert.ok(DICT.size > 1000, `only ${DICT.size} words`);
  for (const word of DICT) {
    assert.match(word, /^[а-я]{2,}$/, `"${word}" is not a plain Russian word`);
    assert.strictEqual(word, word.toLowerCase());
    assert.ok(!word.includes('ё'), `"${word}" still has a ё in it`);
  }
  // Enough five-letter words that the opening is not the same every game.
  assert.ok(words.wordsOfLength(DICT, 5).length > 100);
});

test('ё is folded to е, and rubbish is dropped rather than stored', () => {
  assert.strictEqual(words.normalise('  Ёлка '), 'елка');
  assert.strictEqual(words.normalise('ПОЛКА'), 'полка');
  const parsed = words.parseWords('дом  Hello  дом2  я  ёж  -  стол');
  assert.deepStrictEqual([...parsed].sort(), ['дом', 'еж', 'стол']);
});

test('an operator word list adds to the built-in one rather than replacing it', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balda-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); words.resetCache(); });

  fs.writeFileSync(path.join(dir, 'balda-ru.txt'), 'абракадабра\nвертолётик\n', 'utf8');
  words.resetCache();
  const merged = words.loadWords(dir);
  assert.ok(merged.has('абракадабра'), 'the extra word is there');
  assert.ok(merged.has('вертолетик'), 'and it was normalised on the way in');
  assert.ok(merged.has('полка'), 'the built-in list is still there');
  words.resetCache();
});

// -------------------------------------------------------------------- the board
test('the opening word goes across the middle row and nowhere else', () => {
  const grid = balda.startGrid('полка');
  assert.deepStrictEqual(grid.slice(10, 15), ['п', 'о', 'л', 'к', 'а']);
  assert.strictEqual(grid.filter((c) => c !== null).length, 5);
  assert.throws(() => balda.startGrid('дом'), /must be 5 letters/);
});

test('adjacency is orthogonal, and corners have only two neighbours', () => {
  assert.deepStrictEqual(balda.neighbours(cell(0, 0)).sort((a, b) => a - b),
    [cell(1, 0), cell(0, 1)].sort((a, b) => a - b));
  assert.strictEqual(balda.neighbours(cell(2, 2)).length, 4);
  assert.strictEqual(balda.neighbours(cell(0, 2)).length, 3);
  // The diagonal neighbour of the centre is not a neighbour.
  assert.ok(!balda.neighbours(cell(2, 2)).includes(cell(1, 1)));
});

test('only empty squares touching a letter can be written to', () => {
  const spots = balda.playable(balda.startGrid('полка'));
  for (const c of spots) assert.ok(balda.neighbours(c).some((n) => n >= 10 && n <= 14));
  assert.ok(spots.includes(cell(0, 1)), 'directly above the п');
  assert.ok(spots.includes(cell(4, 3)), 'directly below the а');
  assert.ok(!spots.includes(cell(0, 0)), 'the far corner touches nothing');
  assert.ok(!spots.includes(cell(2, 2)), 'and an occupied square is not empty');
  assert.strictEqual(spots.length, 10, 'five above and five below');
});

test('a path walks orthogonally and never reuses a square', () => {
  const grid = balda.startGrid('полка');
  assert.deepStrictEqual(balda.findPath(grid, 'полка'), [10, 11, 12, 13, 14]);
  assert.deepStrictEqual(balda.findPath(grid, 'пол'), [10, 11, 12]);
  assert.strictEqual(balda.findPath(grid, 'плк'), null, 'п to л skips a square');
  assert.strictEqual(balda.findPath(grid, 'полкаа'), null, 'there is only one а');
  assert.strictEqual(balda.findPath(grid, 'дом'), null, 'those letters are not there');
});

test('a path can be required to pass through a particular square', () => {
  const grid = balda.startGrid('полка');
  assert.ok(balda.findPath(grid, 'пол', 12), 'пол does run through the л');
  assert.strictEqual(balda.findPath(grid, 'пол', 14), null, 'but not through the а');
});

// --------------------------------------------------------------------- moves
test('a good move scores the length of the word', () => {
  // "п" below the о makes "пол" reading up and along: 16, 11, 12.
  const out = balda.play(start(), DICT, { cell: 16, letter: 'п', word: 'пол' });
  assert.strictEqual(out.word, 'пол');
  assert.strictEqual(out.score, 3);
  assert.strictEqual(out.grid[16], 'п');
  assert.ok(out.path.includes(16), 'the path runs through the new letter');
  assert.deepStrictEqual(out.path, [16, 11, 12]);
});

test('a word must run through the letter just placed', () => {
  // "е" makes "елка" at 7, 12, 13, 14, which is legal.
  assert.doesNotThrow(() => balda.play(start(), DICT, { cell: 7, letter: 'е', word: 'елка' }));
  // Placing a letter somewhere else and then claiming that same word is not.
  assert.throws(
    () => balda.play(start(), DICT, { cell: 19, letter: 'е', word: 'полка' }),
    /does not run through the letter you added|already been played/,
  );
});

test('a letter must touch one already on the board', () => {
  assert.throws(
    () => balda.play(start(), DICT, { cell: cell(0, 0), letter: 'а', word: 'пол' }),
    /must touch one already on the board/,
  );
});

test('an occupied square cannot be written to', () => {
  assert.throws(
    () => balda.play(start(), DICT, { cell: 12, letter: 'а', word: 'пол' }),
    /that square is taken/,
  );
});

test('the input is checked before anything else happens', () => {
  const state = start();
  for (const bad of [
    { cell: -1, letter: 'п', word: 'пол' },
    { cell: 25, letter: 'п', word: 'пол' },
    { cell: 'x', letter: 'п', word: 'пол' },
  ]) {
    assert.throws(() => balda.play(state, DICT, bad), /not a square/);
  }
  for (const letter of ['', 'аб', 'a', '1', ' ']) {
    assert.throws(
      () => balda.play(state, DICT, { cell: 16, letter, word: 'пол' }),
      /one Russian letter/,
      `accepted "${letter}"`,
    );
  }
  assert.throws(() => balda.play(state, DICT, { cell: 16, letter: 'п', word: 'о' }), /at least two/);
});

test('a word that is not in the dictionary is refused', () => {
  assert.throws(
    () => balda.play(start(), DICT, { cell: 16, letter: 'х', word: 'хол' }),
    /is not in the dictionary/,
  );
});

test('a word cannot be claimed twice in one game', () => {
  const state = start();
  assert.throws(
    () => balda.play(state, DICT, { cell: 6, letter: 'п', word: 'полка' }),
    /already been played/,
    'the opening word counts as played',
  );
  const first = balda.play(state, DICT, { cell: 16, letter: 'п', word: 'пол' });
  const next = { ...state, grid: first.grid, used: [...state.used, first.word] };
  assert.throws(
    () => balda.play(next, DICT, { cell: 6, letter: 'п', word: 'пол' }),
    /already been played/,
  );
});

test('a refused move leaves the board exactly as it was', () => {
  const state = start();
  const before = state.grid.slice();
  for (const bad of [
    { cell: 12, letter: 'а', word: 'пол' },
    { cell: 16, letter: 'х', word: 'хол' },
    { cell: cell(0, 0), letter: 'а', word: 'пол' },
  ]) {
    assert.throws(() => balda.play(state, DICT, bad));
  }
  assert.deepStrictEqual(state.grid, before);
});

test('the board is only full when every square has a letter', () => {
  assert.ok(!balda.gridFull(balda.startGrid('полка')));
  assert.ok(balda.gridFull(new Array(balda.CELLS).fill('а')));
});

test('suggestions are all legal moves', () => {
  const grid = balda.startGrid('полка');
  const found = balda.suggestions(grid, DICT, 6);
  assert.ok(found.length > 0, 'there is something to play on an opening board');
  for (const s of found) {
    assert.strictEqual(grid[s.cell], null, 'suggests an empty square');
    assert.ok(balda.playable(grid).includes(s.cell), 'and a reachable one');
    assert.ok(s.path.includes(s.cell), 'with a path through it');
    assert.ok(DICT.has(s.word));
  }
});

// -------------------------------------------------- played through the match layer
function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  const mk = (id, name) => db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(?,?,?,'x','s',?,0)`, id, name, name, `rc${id}`,
  );
  mk(1, 'alice');
  mk(2, 'bob');
  const users = { alice: { id: 1 }, bob: { id: 2 } };
  const keys = {};
  for (const name of ['alice', 'bob']) {
    const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
    const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
    tc.registerKey(db, users[name].id, pub, cfg);
    keys[name] = { priv, pub };
  }
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

function started(db, cfg, users, keys, stake = 100 * TUG) {
  const made = match.create(db, cfg, users.alice, {
    game: 'balda', stake, spend: spend(db, keys.alice, stake),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, stake) });
  // Force a known opening so the moves in these tests are the moves on this board.
  const row = db.get('SELECT * FROM matches WHERE id=?', made.id);
  const state = JSON.parse(row.state);
  state.grid = balda.startGrid('полка');
  state.opening = 'полка';
  state.used = ['полка'];
  db.run('UPDATE matches SET state=? WHERE id=?', JSON.stringify(state), made.id);
  return made.id;
}

const players = (users) => [users.alice, users.bob];

test('a game opens with a five-letter word and somebody to move', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);
  const view = match.detail(db, cfg, users.alice, id);

  assert.strictEqual(view.view.opening, 'полка');
  assert.strictEqual(view.view.grid.filter((c) => c !== null).length, 5);
  assert.deepStrictEqual(view.view.scores, [0, 0]);
  assert.ok([0, 1].includes(view.toMove));
  assert.ok(view.view.playable.length > 0);
});

test('a move scores, passes the turn, and spends the word', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);
  const first = match.detail(db, cfg, users.alice, id);
  const mover = first.toMove;

  match.act(db, cfg, players(users)[mover], { id, cell: 16, letter: 'п', word: 'пол' });

  const after = match.detail(db, cfg, users.alice, id);
  assert.strictEqual(after.view.scores[mover], 3);
  assert.strictEqual(after.view.scores[(1 - mover)], 0);
  assert.strictEqual(after.toMove, (1 - mover), 'the turn changes hands');
  assert.ok(after.view.used.includes('пол'));
  assert.strictEqual(after.view.grid[16], 'п');
});

test('you cannot move out of turn or from outside the game', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);
  const view = match.detail(db, cfg, users.alice, id);
  const waiting = players(users)[(1 - view.toMove)];

  assert.throws(
    () => match.act(db, cfg, waiting, { id, cell: 16, letter: 'п', word: 'пол' }),
    /not your turn/,
  );
});

test('two passes in a row end the game on the higher score', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 100 * TUG;
  const id = started(db, cfg, users, keys, stake);
  const first = match.detail(db, cfg, users.alice, id);
  const mover = first.toMove;
  const winnerKey = mover === 0 ? keys.alice : keys.bob;
  const before = tc.balanceOf(db, winnerKey.pub);

  // One player scores, then both pass.
  match.act(db, cfg, players(users)[mover], { id, cell: 16, letter: 'п', word: 'пол' });
  match.act(db, cfg, players(users)[(1 - mover)], { id, pass: true });
  const out = match.act(db, cfg, players(users)[mover], { id, pass: true });

  assert.strictEqual(out.reason, 'higher-score');
  assert.deepStrictEqual(out.winners, [mover]);
  const prize = (stake * 2) - Math.floor(stake * 2 * cfg.match.rake);
  assert.strictEqual(tc.balanceOf(db, winnerKey.pub), before + prize);
});

test('a single pass does not end anything, and scoring resets the count', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);
  const mover = match.detail(db, cfg, users.alice, id).toMove;

  match.act(db, cfg, players(users)[mover], { id, pass: true });
  assert.strictEqual(match.detail(db, cfg, users.alice, id).status, 'playing');

  // A real move clears the passes, so the next pass is the first one again.
  match.act(db, cfg, players(users)[(1 - mover)],
    { id, cell: 16, letter: 'п', word: 'пол' });
  match.act(db, cfg, players(users)[mover], { id, pass: true });
  assert.strictEqual(match.detail(db, cfg, users.alice, id).status, 'playing',
    'one pass after a move is not two in a row');
});

test('a tied game is a draw and both stakes come back', (t) => {
  const { cfg, db, users, keys } = setup({ match: { rake: 0 } });
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys, 120 * TUG);
  const before = {
    alice: tc.balanceOf(db, keys.alice.pub),
    bob: tc.balanceOf(db, keys.bob.pub),
  };
  const mover = match.detail(db, cfg, users.alice, id).toMove;

  // Nobody scores, so it is nil-nil.
  match.act(db, cfg, players(users)[mover], { id, pass: true });
  const out = match.act(db, cfg, players(users)[(1 - mover)], { id, pass: true });

  assert.deepStrictEqual(out.winners.slice().sort(), [0, 1]);
  assert.strictEqual(out.reason, 'tied');
  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before.alice + 120 * TUG);
  assert.strictEqual(tc.balanceOf(db, keys.bob.pub), before.bob + 120 * TUG);
});

test('an illegal move over the match layer is a client error, not a crash', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);
  const mover = players(users)[match.detail(db, cfg, users.alice, id).toMove];

  for (const [bad, pattern] of [
    [{ cell: 12, letter: 'а', word: 'пол' }, /square is taken/],
    [{ cell: 0, letter: 'а', word: 'пол' }, /must touch/],
    [{ cell: 16, letter: 'х', word: 'хол' }, /not in the dictionary/],
    [{ cell: 16, letter: 'п', word: 'полка' }, /already been played/],
  ]) {
    assert.throws(() => match.act(db, cfg, mover, { id, ...bad }), pattern);
  }
  // And the game is untouched.
  const view = match.detail(db, cfg, users.alice, id);
  assert.strictEqual(view.status, 'playing');
  assert.deepStrictEqual(view.view.scores, [0, 0]);
  assert.strictEqual(view.view.grid.filter((c) => c !== null).length, 5);
});

test('the board is public: both players and a spectator see the same grid', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);
  const a = match.detail(db, cfg, users.alice, id).view;
  const b = match.detail(db, cfg, users.bob, id).view;
  const nobody = match.detail(db, cfg, null, id).view;
  assert.deepStrictEqual(a.grid, b.grid);
  assert.deepStrictEqual(a.grid, nobody.grid);
  assert.deepStrictEqual(a.used, b.used);
});
