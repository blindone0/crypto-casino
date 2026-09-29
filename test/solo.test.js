'use strict';
// Playing the match games on your own.
//
// Two claims are worth defending here, and they are different in kind.
//
// The first is mechanical: every game must reach an end. A practice opponent that gets
// stuck is worse than none, because the player cannot tell whether they are waiting for
// something or whether it is broken. The дурак no-progress rule was found exactly this
// way, by driving games to completion in a loop and watching one that never arrived.
//
// The second is structural: **a bot cannot see what a player cannot.** That is not a
// promise in a comment, it is the shape of the code — `bots.choose` is handed
// `plugin.view(state, seat)` and has no reference to the state at all. The tests below
// prove it by taking the view away: strip the hidden fields and the bot still plays,
// because it was never reading them.

const test = require('node:test');
const assert = require('node:assert');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const solo = require('../src/solo');
const bots = require('../src/bots');
const { GAMES } = require('../src/matchgames');
const tronMatch = require('../src/tron');

/** Tron runs on a clock; the test turns it by hand so the race can happen in no time. */
const tronTime = { ms: 0 };

function setup() {
  const cfg = testConfig();
  const db = openTestDb(cfg);
  db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(1,'alice','alice','x','seed','rc1',0)`,
  );
  return { cfg, db, user: db.get('SELECT * FROM users WHERE id=1') };
}

/**
 * Play one game to the end, with the player's own seat driven by the same bot.
 *
 * If a game cannot finish this way it will not finish for a person either: the bots are
 * the only thing keeping the other seats moving, and a position they cannot answer is a
 * position the player would be left staring at.
 */
function playOut(db, cfg, user, game, limit = 600) {
  if (game === 'tron') {
    tronTime.ms = Date.now();
    tronMatch.clock.now = () => tronTime.ms;
  }
  let out = solo.start(db, cfg, user, game);
  let moves = 0;
  let lastError = null;

  while (out.status === 'playing' && moves < limit) {
    const tries = [];
    const chosen = bots.choose(game, out.view, solo.PLAYER, cfg);
    if (chosen) tries.push(chosen);
    // The same improvisation the driver uses for a stuck bot, so the player's seat is
    // never the reason a game stalls.
    if (game === 'chess') for (const m of (out.view.legal || [])) tries.push({ move: m });
    if (game === 'balda') tries.push({ pass: true });
    if (game === 'durak') tries.push({ play: 'take' }, { play: 'done' });
    if (game === 'poker') tries.push({ play: 'next' }, { play: 'check' }, { play: 'fold' });
    if (game === 'seabattle') {
      const shots = (out.view.theirs && out.view.theirs.shots) || [];
      for (let i = 0; i < shots.length; i += 1) {
        if (shots[i] === null || shots[i] === undefined) tries.push({ cell: i });
      }
    }
    if (game === 'tron') {
      // A third of a second a move, so the machines have ticks to ride between the
      // player's turns; a sync is always a legal move.
      tronTime.ms += 350;
      tries.push({ turn: 'straight' });
    }

    let moved = false;
    for (const payload of tries) {
      try {
        out = solo.move(db, cfg, user, game, payload);
        moved = true;
        break;
      } catch (e) {
        lastError = e.message;
      }
    }
    if (!moved) break;
    moves += 1;
  }
  return { out, moves, lastError };
}

for (const game of Object.keys(GAMES)) {
  test(`${game}: a solo game starts, plays and finishes`, (t) => {
    const { cfg, db, user } = setup();
    t.after(() => cleanup(cfg, db));

    const { out, moves, lastError } = playOut(db, cfg, user, game);
    assert.strictEqual(out.status, 'done',
      `${game} did not finish after ${moves} moves (last refusal: ${lastError})`);
    assert.ok(Array.isArray(out.winners) && out.winners.length >= 1,
      `${game} finished without naming a winner`);
    assert.ok(moves > 0, `${game} finished without anybody moving`);
  });
}

test('every game finishes repeatedly, not just once', (t) => {
  // Termination that holds on one deal is not termination. Дурак in particular ran for
  // about three quarters of its games before the no-progress rule existed.
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));

  for (const game of Object.keys(GAMES)) {
    for (let i = 0; i < 6; i += 1) {
      const { out, moves, lastError } = playOut(db, cfg, user, game);
      assert.strictEqual(out.status, 'done',
        `${game} stalled on run ${i + 1} after ${moves} moves (${lastError})`);
      solo.quit(db, user, game);
    }
  }
});

test('the player never sees another seat\'s secrets', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));

  // Дурак and poker both hide a hand; the response must carry the player's and no other.
  const durak = solo.start(db, cfg, user, 'durak');
  assert.ok(Array.isArray(durak.view.hand), 'the player can see their own hand');
  assert.strictEqual(durak.view.hands, undefined, 'and not the array of everyone\'s');

  const poker = solo.start(db, cfg, user, 'poker');
  assert.ok(poker.view.hole === null || Array.isArray(poker.view.hole));
  assert.strictEqual(poker.view.hole?.length ?? 2, 2, 'two cards, or none before the deal');
  // `showdown` is the only sanctioned way hole cards become public, and only after they
  // already are.
  const everyone = JSON.stringify(poker.view);
  assert.ok(!everyone.includes('"hands"'), 'no all-seats hand array reaches the client');

  const sea = solo.start(db, cfg, user, 'seabattle');
  assert.strictEqual(sea.view.boards, undefined, 'the raw boards never leave the server');
});

test('a bot plays from the view alone, with nothing else to read', () => {
  // The proof that the anti-cheat is structural rather than promised: strip everything a
  // cheating bot would want, and the bots still return a legal-looking move. They cannot
  // miss the hidden data because they never had a path to it.
  const cfg = testConfig();

  const chess = bots.choose('chess', {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    white: 0,
    legal: ['e2e4', 'd2d4', 'g1f3'],
  }, 0, cfg);
  assert.ok(chess && ['e2e4', 'd2d4', 'g1f3'].includes(chess.move));

  const sea = bots.choose('seabattle', {
    phase: 'play', size: 10, theirs: { shots: new Array(100).fill(null) },
  }, 1, cfg);
  assert.ok(sea && sea.cell >= 0 && sea.cell < 100);

  // A wounded ship pulls the next shot next to the hit rather than anywhere on the board.
  const shots = new Array(100).fill(null);
  shots[44] = 'hit';
  const target = bots.choose('seabattle', {
    phase: 'play', size: 10, theirs: { shots },
  }, 1, cfg);
  assert.ok([43, 45, 34, 54].includes(target.cell),
    `expected a shot beside the hit, got ${target.cell}`);
});

test('a second game of the same type joins the first rather than replacing it', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));

  const first = solo.start(db, cfg, user, 'chess');
  const again = solo.start(db, cfg, user, 'chess');
  assert.strictEqual(again.id, first.id, 'pressing start twice must not throw a game away');

  // Different games are independent, though.
  const balda = solo.start(db, cfg, user, 'balda');
  assert.notStrictEqual(balda.id, first.id);

  solo.quit(db, user, 'chess');
  assert.strictEqual(solo.current(db, user.id, 'chess'), null);
  assert.ok(solo.current(db, user.id, 'balda'), 'quitting one leaves the other alone');

  const fresh = solo.start(db, cfg, user, 'chess');
  assert.notStrictEqual(fresh.id, first.id, 'and a new one really is new');
});

test('an illegal move changes nothing', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));

  const before = solo.start(db, cfg, user, 'chess');
  assert.throws(() => solo.move(db, cfg, user, 'chess', { move: 'e2e9' }));
  const after = solo.current(db, user.id, 'chess');
  assert.strictEqual(after.view.fen, before.view.fen,
    'the position must be untouched, because the whole move runs in one transaction');
});

test('no money moves, and none is recorded', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));

  playOut(db, cfg, user, 'chess');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM bets').n, 0, 'no bet was written');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM token_blocks').n, 0,
    'and the chain was never touched');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM matches').n, 0,
    'nor did this go anywhere near the match framework');
});

test('a game that does not exist is refused', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  assert.throws(() => solo.start(db, cfg, user, 'roulette'), /no such game/);
  assert.throws(() => solo.move(db, cfg, user, 'chess', {}), /no game in progress/);
});
