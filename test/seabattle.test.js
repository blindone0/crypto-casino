'use strict';
// Морской бой.
//
// Two things decide whether this game is playable for money, and neither is the rules.
//
// The first is that a fleet cannot be cheated. Ships that overlap, touch, hang off the
// edge, or add up to the wrong set have to be refused when they arrive, because "the
// client would not send that" stops being true the moment there is a stake on the board.
//
// The second is that a board cannot be read. The opponent's view must contain the shots
// that have been fired and nothing else: no ship the other player has not found. That is
// checked here by searching the serialised view for the actual coordinates, rather than by
// trusting that the right fields were picked.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const sb = require('../src/seabattle');
const tc = require('../src/tokenchain');
const match = require('../src/match');

// A tugrik is divisible to eight places, like everything else here, so every stake below
// is written as whole tugriks times TUG. Bare numbers would be hundred-millionths of a
// coin and far under the table minimum.
const TUG = 100000000;

const cell = (x, y) => y * sb.SIZE + x;

/** A legal fleet, laid out by hand so the tests do not depend on the random placer. */
const GOOD_FLEET = [
  { x: 0, y: 0, len: 4, dir: 'h' },
  { x: 0, y: 2, len: 3, dir: 'h' },
  { x: 5, y: 2, len: 3, dir: 'h' },
  { x: 0, y: 4, len: 2, dir: 'h' },
  { x: 4, y: 4, len: 2, dir: 'h' },
  { x: 8, y: 4, len: 2, dir: 'v' },
  { x: 0, y: 6, len: 1, dir: 'h' },
  { x: 2, y: 6, len: 1, dir: 'h' },
  { x: 4, y: 6, len: 1, dir: 'h' },
  { x: 6, y: 6, len: 1, dir: 'h' },
];

test('a legal fleet is accepted and occupies the cells it says it does', () => {
  const fleet = sb.parseFleet(GOOD_FLEET);
  assert.strictEqual(fleet.ships.length, sb.FLEET.length);
  const occupiedCount = fleet.occupied.filter((v) => v >= 0).length;
  assert.strictEqual(occupiedCount, sb.FLEET.reduce((a, b) => a + b, 0), '20 cells of ship');
  assert.strictEqual(fleet.occupied[cell(0, 0)], 0);
  assert.strictEqual(fleet.occupied[cell(3, 0)], 0);
  assert.strictEqual(fleet.occupied[cell(4, 0)], -1, 'the four-cell ship stops at x=3');
});

test('a fleet with the wrong ships in it is refused', () => {
  const swap = (i, patch) => GOOD_FLEET.map((s, n) => (n === i ? { ...s, ...patch } : s));
  assert.throws(() => sb.parseFleet(swap(9, { len: 2 })), /right set of ships/,
    'an extra two-cell ship');
  assert.throws(() => sb.parseFleet(swap(0, { len: 3 })), /right set of ships/,
    'no four-cell ship at all');
  assert.throws(() => sb.parseFleet(GOOD_FLEET.slice(0, 9)), /is 10 ships/);
  assert.throws(() => sb.parseFleet([...GOOD_FLEET, { x: 9, y: 9, len: 1, dir: 'h' }]), /is 10 ships/);
  assert.throws(() => sb.parseFleet('not a fleet'), /is 10 ships/);
  assert.throws(() => sb.parseFleet(null), /is 10 ships/);
});

test('ships may not overlap, touch, or touch at a corner', () => {
  const at = (i, x, y) => GOOD_FLEET.map((s, n) => (n === i ? { ...s, x, y } : s));
  // Straight on top of the four-cell ship.
  assert.throws(() => sb.parseFleet(at(1, 0, 0)), /touch|off the grid/);
  // Directly beneath it: sharing an edge.
  assert.throws(() => sb.parseFleet(at(6, 0, 1)), /may not touch/);
  // Diagonally off its corner, which is the case people forget.
  assert.throws(() => sb.parseFleet(at(6, 4, 1)), /may not touch/);
  // Somewhere with a clear square on every side is fine. (5, 1) is not such a place:
  // it sits directly above the three-cell ship on row 2.
  assert.throws(() => sb.parseFleet(at(6, 5, 1)), /may not touch/);
  assert.doesNotThrow(() => sb.parseFleet(at(6, 9, 0)));
});

test('a ship hanging off the grid is refused', () => {
  const at = (i, patch) => GOOD_FLEET.map((s, n) => (n === i ? { ...s, ...patch } : s));
  assert.throws(() => sb.parseFleet(at(0, { x: 7, y: 0, dir: 'h' })), /off the grid/);
  assert.throws(() => sb.parseFleet(at(0, { x: 0, y: 8, dir: 'v' })), /off the grid/);
  assert.throws(() => sb.parseFleet(at(0, { x: -1, y: 0 })), /off the grid/);
  assert.throws(() => sb.parseFleet(at(0, { x: 0, y: -3 })), /off the grid/);
  assert.throws(() => sb.parseFleet(at(0, { x: 'a', y: 0 })), /not on the grid/);
});

test('the random placer only ever produces fleets the parser accepts', () => {
  for (let i = 0; i < 300; i += 1) {
    const fleet = sb.randomFleet();
    assert.doesNotThrow(() => sb.parseFleet(fleet), `attempt ${i} produced an illegal fleet`);
  }
});

test('firing reports a miss, a hit and a sinking, and refuses a repeat', () => {
  let board = sb.emptyBoard(sb.parseFleet(GOOD_FLEET));

  const miss = sb.fire(board, cell(9, 9));
  assert.strictEqual(miss.outcome, 'miss');
  board = miss.board;

  const hit = sb.fire(board, cell(0, 0));
  assert.strictEqual(hit.outcome, 'hit');
  assert.strictEqual(hit.sunk, null);
  board = hit.board;

  // The single-cell ship at (0, 6) goes down in one.
  const sunk = sb.fire(board, cell(0, 6));
  assert.strictEqual(sunk.outcome, 'sunk');
  assert.deepStrictEqual(sunk.sunk, [cell(0, 6)]);
  board = sunk.board;

  assert.throws(() => sb.fire(board, cell(9, 9)), /already fired/);
  assert.throws(() => sb.fire(board, cell(0, 0)), /already fired/);
  assert.throws(() => sb.fire(board, -1), /not a cell/);
  assert.throws(() => sb.fire(board, 100), /not a cell/);
  assert.throws(() => sb.fire(board, 'x'), /not a cell/);
});

test('the fleet count falls only when a whole ship goes down', () => {
  let board = sb.emptyBoard(sb.parseFleet(GOOD_FLEET));
  assert.strictEqual(sb.afloat(board), 10);

  board = sb.fire(board, cell(0, 0)).board;
  assert.strictEqual(sb.afloat(board), 10, 'a wounded ship is still afloat');
  for (const x of [1, 2, 3]) board = sb.fire(board, cell(x, 0)).board;
  assert.strictEqual(sb.afloat(board), 9);
});

test('the opponent view contains no ship the opponent has not found', () => {
  let board = sb.emptyBoard(sb.parseFleet(GOOD_FLEET));
  // Sink one single-cell ship and wound the big one, then look at what an enemy can see.
  board = sb.fire(board, cell(0, 6)).board;
  board = sb.fire(board, cell(0, 0)).board;

  const enemy = sb.boardView(board, false);
  const serialised = JSON.stringify(enemy);

  assert.strictEqual(enemy.ships, undefined, 'the fleet is not in an enemy view');
  assert.strictEqual(enemy.afloat, 9);
  assert.strictEqual(enemy.shots[cell(0, 0)], 'hit');
  assert.strictEqual(enemy.shots[cell(9, 9)], null);

  // The sunk ship is public knowledge; the rest must not be anywhere in the response.
  assert.strictEqual(enemy.sunk.length, 1);
  assert.deepStrictEqual(enemy.sunk[0], { x: 0, y: 6, len: 1, dir: 'h' });
  for (const ship of GOOD_FLEET) {
    if (ship.x === 0 && ship.y === 6) continue;
    assert.ok(
      !serialised.includes(JSON.stringify(ship)),
      `an unfound ship at ${ship.x},${ship.y} appears in the enemy view`,
    );
  }

  // The owner does see their own fleet, because it is theirs.
  assert.strictEqual(sb.boardView(board, true).ships.length, 10);
});

// ------------------------------------------------- played through the match layer
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

/** Start a seabattle match with both stakes escrowed. */
function started(db, cfg, users, keys, stake = 100 * TUG) {
  const made = match.create(db, cfg, users.alice, {
    game: 'seabattle', stake, spend: spend(db, keys.alice, stake),
  });
  match.join(db, cfg, users.bob, { id: made.id, spend: spend(db, keys.bob, stake) });
  return made.id;
}

/**
 * A second legal fleet, written out rather than derived from the first.
 * It must share no ship with GOOD_FLEET, or the test that searches a view for the
 * opponent's ships finds the player's own and reports a leak that is not there.
 */
const OTHER_FLEET = [
  { x: 0, y: 9, len: 4, dir: 'h' },
  { x: 5, y: 9, len: 3, dir: 'h' },
  { x: 0, y: 7, len: 3, dir: 'h' },
  { x: 4, y: 7, len: 2, dir: 'h' },
  { x: 7, y: 7, len: 2, dir: 'h' },
  { x: 0, y: 5, len: 2, dir: 'h' },
  { x: 3, y: 5, len: 1, dir: 'h' },
  { x: 5, y: 5, len: 1, dir: 'h' },
  { x: 7, y: 5, len: 1, dir: 'h' },
  { x: 9, y: 5, len: 1, dir: 'h' },
];

test('the two test fleets are legal and share no ship', () => {
  assert.doesNotThrow(() => sb.parseFleet(GOOD_FLEET));
  assert.doesNotThrow(() => sb.parseFleet(OTHER_FLEET));
  const first = new Set(GOOD_FLEET.map((s) => JSON.stringify(s)));
  for (const ship of OTHER_FLEET) {
    assert.ok(!first.has(JSON.stringify(ship)),
      'the fleets share a ship, which would make the leak test meaningless');
  }
});

test('both sides place their fleets before anyone shoots', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);

  const before = match.detail(db, cfg, users.alice, id);
  assert.strictEqual(before.view.phase, 'setup');
  assert.strictEqual(before.toMove, null, 'nobody has the move during setup');
  assert.deepStrictEqual(before.view.placed, { host: false, guest: false });

  // Shooting before the fleets are down is not a move anyone may make.
  assert.throws(() => match.act(db, cfg, users.alice, { id, cell: 0 }), /place your fleet/);

  match.act(db, cfg, users.alice, { id, fleet: GOOD_FLEET });
  const half = match.detail(db, cfg, users.alice, id);
  assert.strictEqual(half.view.phase, 'setup');
  assert.deepStrictEqual(half.view.placed, { host: true, guest: false });
  // And you cannot place twice to overwrite what you already committed to.
  assert.throws(() => match.act(db, cfg, users.alice, { id, fleet: OTHER_FLEET }), /not your turn/);

  match.act(db, cfg, users.bob, { id, fleet: OTHER_FLEET });
  const ready = match.detail(db, cfg, users.alice, id);
  assert.strictEqual(ready.view.phase, 'play');
  assert.ok(['host', 'guest'].includes(ready.toMove));
});

test('an illegal fleet is refused by the server, and the phase does not advance', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);

  const touching = GOOD_FLEET.map((s, n) => (n === 6 ? { ...s, x: 0, y: 1 } : s));
  assert.throws(() => match.act(db, cfg, users.alice, { id, fleet: touching }), /may not touch/);
  assert.throws(() => match.act(db, cfg, users.alice, { id, fleet: [] }), /is 10 ships/);
  assert.deepStrictEqual(
    match.detail(db, cfg, users.alice, id).view.placed, { host: false, guest: false },
  );
});

test('a hit keeps the turn and a miss gives it away', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);
  match.act(db, cfg, users.alice, { id, fleet: GOOD_FLEET });
  match.act(db, cfg, users.bob, { id, fleet: OTHER_FLEET });

  const players = { host: users.alice, guest: users.bob };
  const view = match.detail(db, cfg, users.alice, id);
  const shooter = players[view.toMove];
  const targetFleet = view.toMove === 'host' ? OTHER_FLEET : GOOD_FLEET;

  // Fire at a cell that is certainly empty for both layouts: the middle column is clear.
  const empty = cell(9, 0) === undefined ? 0 : cell(3, 9);
  const occupied = new Set();
  for (const ship of targetFleet) {
    for (const c of sb.shipCells(ship)) occupied.add(c);
  }
  let blank = 0;
  while (occupied.has(blank)) blank += 1;
  const hitCell = [...occupied][0];

  match.act(db, cfg, shooter, { id, cell: blank });
  assert.notStrictEqual(match.detail(db, cfg, users.alice, id).toMove, view.toMove,
    'a miss passes the turn');

  const back = match.detail(db, cfg, users.alice, id);
  const other = players[back.toMove];
  // Give the turn back by having the other side miss too, then land a hit.
  const theirTarget = back.toMove === 'host' ? OTHER_FLEET : GOOD_FLEET;
  const theirOccupied = new Set();
  for (const ship of theirTarget) for (const c of sb.shipCells(ship)) theirOccupied.add(c);
  let theirBlank = 0;
  while (theirOccupied.has(theirBlank)) theirBlank += 1;
  match.act(db, cfg, other, { id, cell: theirBlank });

  match.act(db, cfg, shooter, { id, cell: hitCell });
  assert.strictEqual(match.detail(db, cfg, users.alice, id).toMove, view.toMove,
    'a hit keeps the turn');
  assert.ok(empty >= 0);
});

test('sinking the last ship wins the match and pays out', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 100 * TUG;
  const id = started(db, cfg, users, keys, stake);
  match.act(db, cfg, users.alice, { id, fleet: GOOD_FLEET });
  match.act(db, cfg, users.bob, { id, fleet: OTHER_FLEET });

  const players = { host: users.alice, guest: users.bob };
  const view = match.detail(db, cfg, users.alice, id);
  const shooter = players[view.toMove];
  const winnerKey = view.toMove === 'host' ? keys.alice : keys.bob;
  const before = tc.balanceOf(db, winnerKey.pub);
  const targetFleet = view.toMove === 'host' ? OTHER_FLEET : GOOD_FLEET;

  // Every hit keeps the turn, so a perfect game never gives the other side a shot.
  let last = null;
  for (const ship of targetFleet) {
    for (const c of sb.shipCells(ship)) last = match.act(db, cfg, shooter, { id, cell: c });
  }

  assert.strictEqual(last.reason, 'fleet-sunk');
  const done = match.detail(db, cfg, users.alice, id);
  assert.strictEqual(done.status, 'done');

  const prize = (stake * 2) - Math.floor(stake * 2 * cfg.match.rake);
  assert.strictEqual(tc.balanceOf(db, winnerKey.pub), before + prize);
});

test('the clock does not run while the fleets are still being placed', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);

  // Backdate the match a long way. In a game that was already under way this would flag
  // somebody; during setup it must not, because nobody has been given a chance to act.
  db.run('UPDATE matches SET moved_at_ms=? WHERE id=?', Date.now() - 60 * 60 * 1000, id);
  const view = match.detail(db, cfg, users.alice, id);
  assert.strictEqual(view.clock.host, match.GAMES.seabattle.clockMs);
  assert.strictEqual(view.clock.guest, match.GAMES.seabattle.clockMs);

  assert.doesNotThrow(() => match.act(db, cfg, users.alice, { id, fleet: GOOD_FLEET }));
});

test('a player who never sets up loses to the one who did', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys, 100 * TUG);
  match.act(db, cfg, users.alice, { id, fleet: GOOD_FLEET });

  assert.throws(() => match.claimTimeout(db, cfg, users.alice, id), /time to set up/);

  db.run('UPDATE matches SET started_at=? WHERE id=?',
    Math.floor(Date.now() / 1000) - cfg.match.setupSeconds - 1, id);
  const before = tc.balanceOf(db, keys.alice.pub);
  const out = match.claimTimeout(db, cfg, users.alice, id);

  assert.strictEqual(out.reason, 'no-setup');
  assert.strictEqual(out.result, 'host');
  const prize = (200 * TUG) - Math.floor(200 * TUG * cfg.match.rake);
  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before + prize);
});

test('if neither player sets up, both stakes go back', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const before = {
    alice: tc.balanceOf(db, keys.alice.pub),
    bob: tc.balanceOf(db, keys.bob.pub),
  };
  const id = started(db, cfg, users, keys, 150 * TUG);
  db.run('UPDATE matches SET started_at=? WHERE id=?',
    Math.floor(Date.now() / 1000) - cfg.match.setupSeconds - 1, id);

  const out = match.claimTimeout(db, cfg, users.alice, id);
  assert.strictEqual(out.cancelled, true);
  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before.alice);
  assert.strictEqual(tc.balanceOf(db, keys.bob.pub), before.bob);
  assert.strictEqual(tc.balanceOf(db, match.houseKey(db).publicRaw), 0);
});

test('a player cannot read the other board through the match view', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys);
  match.act(db, cfg, users.alice, { id, fleet: GOOD_FLEET });
  match.act(db, cfg, users.bob, { id, fleet: OTHER_FLEET });

  const asAlice = JSON.stringify(match.detail(db, cfg, users.alice, id));
  for (const ship of OTHER_FLEET) {
    assert.ok(!asAlice.includes(JSON.stringify(ship)),
      `Bob's ship at ${ship.x},${ship.y} is visible to Alice`);
  }
  // And she does get her own.
  assert.ok(asAlice.includes(JSON.stringify(GOOD_FLEET[0])), 'Alice cannot see her own fleet');

  // A spectator sees neither.
  const asNobody = JSON.stringify(match.detail(db, cfg, null, id));
  for (const ship of [...GOOD_FLEET, ...OTHER_FLEET]) {
    assert.ok(!asNobody.includes(JSON.stringify(ship)), 'a fleet is visible to a spectator');
  }
});
