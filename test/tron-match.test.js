'use strict';
// Tron's match plugin, on a clock the test turns by hand.
//
// The plugin has no timer: a read replays the race from its inputs up to "now", so a test
// that owns "now" can put the race at any tick it likes and ask what the server would say.
// The rules themselves are tested in tron.test.js; this is the plugin — the countdown,
// the recording of turns, the refusals, and the three ways a race ends.

const test = require('node:test');
const assert = require('node:assert');
const { TRON, clock, TICK_MS, COUNTDOWN_MS } = require('../src/tron');

const BASE = 1000000;

/** A clock at BASE that a test moves to the start of any tick it names. */
function fixed() {
  let ms = BASE;
  clock.now = () => ms;
  return {
    get ms() { return ms; },
    tick(k) { ms = BASE + COUNTDOWN_MS + k * TICK_MS + 1; },
  };
}

test.after(() => { clock.now = () => Date.now(); });

test('a race starts after a countdown, with everyone able to act and nobody "to move"', () => {
  const c = fixed();
  const state = TRON.create({}, 2);
  assert.strictEqual(state.n, 2);
  assert.strictEqual(state.startMs, c.ms + COUNTDOWN_MS);
  assert.deepStrictEqual(state.turns, []);
  assert.strictEqual(TRON.toMove(state), null);
  assert.strictEqual(TRON.clockRuns(state), false);
  assert.ok(TRON.canAct(state, 0) && TRON.canAct(state, 1), 'both may act at once');
  assert.strictEqual(TRON.canAct(state, 2), false, 'there is no seat 2');
  const v = TRON.view(state, 0, 2);
  assert.strictEqual(v.tick, 0, 'no tick has passed during the countdown');
  assert.strictEqual(v.result, null);
  assert.strictEqual(v.nowMs, c.ms, 'the server clock travels, for the board to sync to');
  assert.strictEqual(v.sim, null, 'the simulation itself never travels');
  assert.ok(Array.isArray(v.colours) && v.cols > 0 && v.rows > 0);
});

test('a turn is recorded at the next tick, replaces one already there, and cannot reverse', () => {
  const c = fixed();
  const state = TRON.create({}, 2);
  c.tick(20);
  const out = TRON.act(state, 0, { turn: 'e' });
  assert.deepStrictEqual(out.state.turns, [{ t: 21, seat: 0, h: 'e' }]);
  assert.strictEqual(out.note, 'e');
  assert.deepStrictEqual(state.turns, [], 'the state given is not written to');

  assert.throws(() => TRON.act(out.state, 0, { turn: 'n' }), /reverse/, 'seat 0 rides south');
  assert.throws(() => TRON.act(out.state, 0, { turn: 'x' }), /n, e, s or w/);

  const again = TRON.act(out.state, 0, { turn: 'w' });
  assert.deepStrictEqual(again.state.turns, [{ t: 21, seat: 0, h: 'w' }],
    'a second turn for the same tick replaces the first');

  const sync = TRON.act(again.state, 1, { turn: 'straight' });
  assert.strictEqual(sync.note, 'sync');
  assert.strictEqual(sync.state, again.state, 'a sync records nothing');
  const bare = TRON.act(again.state, 1, {});
  assert.strictEqual(bare.note, 'sync', 'and so does an empty act');
});

test('a fallen rider may still sync but not turn', () => {
  const c = fixed();
  const state = TRON.create({}, 3);
  // Seat 2 turns east at tick one and rides into the east edge well before the others
  // meet anything; the race goes on without it.
  c.tick(0);
  const turned = TRON.act(state, 2, { turn: 'e' }).state;
  c.tick(30);
  assert.strictEqual(TRON.resultNow(turned, 3), null, 'two are still riding');
  const v = TRON.view(turned, 2, 3);
  assert.strictEqual(v.result, null);
  assert.ok(TRON.canAct(turned, 2), 'the fallen may ask how the race is going');
  assert.strictEqual(TRON.act(turned, 2, { turn: 'straight' }).note, 'sync');
  assert.throws(() => TRON.act(turned, 2, { turn: 'n' }), /out of the race/);
  assert.strictEqual(TRON.act(turned, 0, { turn: 'e' }).note, 'e', 'the living still turn');
});

test('the race decides itself, and resultNow, canAct, a claim and the view all agree', () => {
  const c = fixed();
  const state = TRON.create({}, 2);
  // Nobody turns: seat 0 rides south into the bottom edge on tick 43, seat 1 north
  // into the top edge on tick 44. Seat 0 falls first, so seat 1 is the last rider.
  c.tick(42);
  assert.strictEqual(TRON.resultNow(state, 2), null);
  assert.ok(TRON.canAct(state, 0));
  c.tick(43);
  assert.deepStrictEqual(TRON.resultNow(state, 2), { winners: [1], reason: 'last-rider' });
  assert.strictEqual(TRON.canAct(state, 0), false);
  assert.strictEqual(TRON.canAct(state, 1), false);
  assert.throws(() => TRON.act(state, 1, { turn: 'e' }), /over/);
  const claim = TRON.act(state, 1, { claim: true });
  assert.deepStrictEqual(claim.winners, [1]);
  assert.strictEqual(claim.reason, 'last-rider');
  assert.deepStrictEqual(TRON.view(state, 1, 2).result, { winners: [1], reason: 'last-rider' });
  c.tick(500);
  assert.deepStrictEqual(TRON.resultNow(state, 2), { winners: [1], reason: 'last-rider' },
    'the result does not change once the race is over');
});

test('a head-on is a draw, and time running out is shared by the living', () => {
  const c = fixed();
  const state = TRON.create({}, 2);
  const short = { ...TRON.create({}, 2), roundMs: 10 * TICK_MS };
  // The head-on from the rules test: seat 0 east at tick 1, seat 1 west at tick 23.
  state.turns = [{ t: 1, seat: 0, h: 'e' }, { t: 23, seat: 1, h: 'w' }];
  c.tick(27);
  assert.deepStrictEqual(TRON.resultNow(state, 2), { winners: [0, 1], reason: 'head-on' });

  c.tick(9);
  assert.strictEqual(TRON.resultNow(short, 2), null);
  c.tick(10);
  assert.deepStrictEqual(TRON.resultNow(short, 2), { winners: [0, 1], reason: 'time' });
  c.tick(500);
  assert.deepStrictEqual(TRON.resultNow(short, 2), { winners: [0, 1], reason: 'time' },
    'the race is frozen where time ran out');
  assert.strictEqual(TRON.view(short, 0, 2).tick, 10, 'and so is the tick the board sees');
});

test('catchUp records the machines\' turns tick by tick and settles when the race ends', () => {
  const c = fixed();
  const state = TRON.create({}, 3);
  const asked = [];
  // A machine that turns east the first time it is asked and rides straight after.
  const decide = (view, seat) => {
    asked.push(seat);
    assert.ok(view.sim, 'the bots are handed the live race');
    return asked.filter((s) => s === seat).length === 1 ? { turn: 'e' } : { turn: 'straight' };
  };
  assert.strictEqual(TRON.catchUp(state, decide), null, 'nothing to ride during the countdown');

  c.tick(5);
  const out = TRON.catchUp(state, decide);
  assert.strictEqual(out.state.decided, 5);
  assert.deepStrictEqual(out.state.turns, [{ t: 1, seat: 1, h: 'e' }, { t: 1, seat: 2, h: 'e' }]);
  assert.strictEqual(out.winners, undefined);
  assert.strictEqual(asked.length, 10, 'two machines asked at each of five ticks');
  assert.strictEqual(TRON.catchUp(out.state, decide), null, 'asked again at the same tick: nothing new');

  c.tick(60);
  const end = TRON.catchUp(out.state, decide);
  assert.ok(end.winners, 'by tick sixty everyone but one has met an edge');
  assert.strictEqual(end.winners.length, 1);
  assert.strictEqual(end.reason, 'last-rider');
  assert.ok(end.state.decided <= 60);
  assert.deepStrictEqual(TRON.resultNow(end.state, 3), { winners: end.winners, reason: 'last-rider' },
    'a race with machines in it replays exactly like one without');
});
