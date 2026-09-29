'use strict';
// Русская пирамида: the rules, tested where they live.
//
// public/games/billiards-rules.js is an ES module with no imports, so this CommonJS test
// can require() it the way test/tron.test.js does. Everything here is in millimetres on a
// real table, and the pocket cases are the whole point of the size: a ball driven into a
// corner drops, a ball that arrives at an angle rattles out, the middle pocket takes a
// ball six millimetres off its line and refuses one twenty off. Then the rules: a foul
// hands a ball over, a свояк counts, the turn passes when nothing dropped, and two
// machines can play a whole game to eight without breaking a rule.

const test = require('node:test');
const assert = require('node:assert');
const B = require('../public/games/billiards-rules.js');

/** Run the table until it is still, in the cabinet's own steps. Returns frames used. */
function settle(state, hooks = null, limit = 4000) {
  let frames = 0;
  while (frames < limit && (state.shot || B.moving(state))) {
    for (let i = 0; i < B.SUBSTEPS; i += 1) B.step(state, 1 / 60 / B.SUBSTEPS, hooks);
    frames += 1;
  }
  return frames;
}

/** A shot played out, with what dropped recorded before resolve() tidies the table. */
function play(state, angle, power) {
  const dropped = [];
  assert.ok(B.shoot(state, angle, power), 'the shot was allowed');
  const frames = settle(state, { onPocket: (b) => dropped.push(b.cue ? 'cue' : b.id) });
  assert.ok(frames < 4000, 'the table settled');
  return { dropped, last: state.last, frames };
}

/** A near-empty table: the cue ball where it is put, and only the object balls named. */
function lone(cx, cy, objects = []) {
  const s = B.create();
  for (const b of B.onTable(s)) b.potted = true;
  objects.forEach((o, i) => { const b = s.balls[i + 1]; b.potted = false; b.x = o.x; b.y = o.y; });
  const c = B.cueBall(s);
  c.x = cx; c.y = cy;
  return s;
}

const towards = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);
// Two balls out of everyone's way: off both diagonals, off the middle line, near no pocket.
const FAR = [{ x: 300, y: 1200 }, { x: 700, y: 1500 }];

test('the table is a Russian table: twelve feet, 68 mm balls, pockets a few millimetres wider', () => {
  assert.strictEqual(B.L, 3550);
  assert.strictEqual(B.W, 1775);
  assert.strictEqual(B.R * 2, 68);
  assert.strictEqual(B.CORNER_MOUTH, 73);
  assert.strictEqual(B.MIDDLE_MOUTH, 83);
  assert.ok(B.CORNER_MOUTH - B.R * 2 <= 5, 'a corner takes the ball with five millimetres to spare');
  assert.strictEqual(B.TARGET, 8);
  assert.strictEqual(B.POCKETS.length, 6);
  assert.strictEqual(B.RAILS.length, 6, 'two long rails split by the middle pockets, and two short');
  assert.strictEqual(B.NOSES.length, 12, 'every cushion end is a nose');
});

test('the rack: fifteen whites in a pyramid on the foot spot, the cue ball in the house, nothing touching', () => {
  const s = B.create();
  assert.strictEqual(s.balls.length, 16);
  assert.strictEqual(B.onTable(s).length, 15);
  const c = B.cueBall(s);
  assert.ok(c.cue);
  assert.deepStrictEqual({ x: c.x, y: c.y }, B.HOUSE_SPOT);
  assert.deepStrictEqual({ x: s.balls[1].x, y: s.balls[1].y }, B.FOOT_SPOT, 'the apex is on the foot spot');
  for (let i = 0; i < s.balls.length; i += 1) {
    for (let j = i + 1; j < s.balls.length; j += 1) {
      const d = Math.hypot(s.balls[i].x - s.balls[j].x, s.balls[i].y - s.balls[j].y);
      assert.ok(d >= B.R * 2, `balls ${i} and ${j} overlap: ${d.toFixed(1)} mm apart`);
    }
  }
  for (const b of s.balls) {
    assert.ok(b.x >= B.R && b.x <= B.L - B.R && b.y >= B.R && b.y <= B.W - B.R, 'inside the cushions');
  }
  assert.strictEqual(s.turn, 0, 'the player breaks');
  assert.deepStrictEqual(s.scores, [0, 0]);
  assert.strictEqual(B.toGo(s, 0), 8);
  assert.strictEqual(s.over, false);
});

test('a corner pocket takes a ball driven down its diagonal', () => {
  const s = lone(600, 600, FAR);
  const { dropped } = play(s, towards({ x: 600, y: 600 }, B.POCKETS[0].aim), 0.5);
  assert.deepStrictEqual(dropped, ['cue']);
});

test('a corner pocket spits out a ball that arrives twenty-five degrees off the diagonal', () => {
  // Aimed at the pocket point exactly, but arriving steeply: it meets a jaw and rattles.
  const th = Math.PI / 4 + (25 * Math.PI) / 180;
  const from = { x: -14 + Math.cos(th) * 800, y: -14 + Math.sin(th) * 800 };
  const s = lone(from.x, from.y, FAR);
  const { dropped } = play(s, towards(from, B.POCKETS[0].aim), 0.5);
  assert.deepStrictEqual(dropped, [], 'the ball rattled out');
  const c = B.cueBall(s);
  assert.ok(!c.potted && c.x >= 0 && c.y >= 0, 'and is still on the cloth');
});

test('a ball rolled along the cushion drops in the corner off the far jaw', () => {
  const s = lone(900, B.R, FAR);
  const { dropped } = play(s, Math.PI, 0.45);
  assert.deepStrictEqual(dropped, ['cue']);
});

test('the middle pocket: straight in drops, six millimetres off drops, twenty off rattles', () => {
  const pocket = B.POCKETS[4];
  const straight = lone(B.L / 2, 900, FAR);
  assert.deepStrictEqual(play(straight, -Math.PI / 2, 0.4).dropped, ['cue'], 'straight');
  const six = lone(B.L / 2 + 6, 900, FAR);
  assert.deepStrictEqual(play(six, -Math.PI / 2, 0.4).dropped, ['cue'], 'six off');
  const twenty = lone(B.L / 2 + 20, 900, FAR);
  assert.deepStrictEqual(play(twenty, -Math.PI / 2, 0.4).dropped, [], 'twenty off');
  assert.ok(!B.cueBall(twenty).potted);
  assert.strictEqual(pocket.corner, false);
});

test('the break touches the rack and scatters it; nothing dropped means the turn passes', () => {
  const s = B.create();
  const { last } = play(s, 0, 1);
  assert.strictEqual(last.seat, 0);
  assert.strictEqual(last.foul, false, 'a straight break is not a foul');
  const apex = s.balls[1];
  assert.ok(apex.potted || apex.x !== B.FOOT_SPOT.x || apex.y !== B.FOOT_SPOT.y, 'the apex moved');
  assert.strictEqual(B.onTable(s).length + s.scores[0] + s.scores[1], 15, 'every ball accounted for');
  if (last.counted === 0) assert.strictEqual(s.turn, 1, 'nothing dropped: the machine shoots');
  else assert.strictEqual(s.turn, 0, 'something dropped: shoot again');
});

test('a foul — nothing touched — hands the other side a ball and the turn', () => {
  const s = B.create();
  // Softly away from the rack, into the head cushion and back: touches nothing.
  const { last, dropped } = play(s, Math.PI, 0.3);
  assert.deepStrictEqual(dropped, []);
  assert.strictEqual(last.foul, true);
  assert.strictEqual(last.penalty, true);
  assert.strictEqual(last.counted, 0);
  assert.deepStrictEqual(s.scores, [0, 1]);
  assert.strictEqual(s.turn, 1);
  assert.strictEqual(B.onTable(s).length, 14, 'the ball nearest a pocket came off the table');
  assert.strictEqual(B.toGo(s, 1), 7);
});

test('the cue ball dropped without touching anything is a foul, and it comes back to the house', () => {
  const s = lone(600, 600, FAR);
  const { last, dropped } = play(s, towards({ x: 600, y: 600 }, B.POCKETS[0].aim), 0.5);
  assert.deepStrictEqual(dropped, ['cue']);
  assert.strictEqual(last.foul, true);
  assert.strictEqual(last.cuePotted, true);
  assert.strictEqual(last.svoyak, false);
  assert.deepStrictEqual(s.scores, [0, 1]);
  assert.strictEqual(s.turn, 1);
  const c = B.cueBall(s);
  assert.ok(!c.potted, 'respotted');
  assert.strictEqual(c.y, B.W / 2);
  assert.ok(c.x <= B.HOUSE_SPOT.x && c.x > 0, 'in the house');
});

test('a свояк — the cue ball dropped after doing its work — counts, and the shooter keeps the cue', () => {
  // An object ball sitting in the jaws of the far corner, and the cue ball driven straight
  // down the diagonal into it: the object ball drops, and the cue ball, which keeps a few
  // percent of its speed off a full-ball contact, creeps in after it.
  const jaw = { x: B.L - 42.4, y: 42.4 };
  const from = { x: 2800, y: 750 };                       // on the same diagonal: x + y = L
  const s = lone(from.x, from.y, [jaw, ...FAR]);
  const { last, dropped } = play(s, towards(from, jaw), 0.9);
  assert.ok(dropped.includes(1), 'the object ball dropped');
  assert.ok(dropped.includes('cue'), 'and the cue ball followed it in');
  assert.strictEqual(last.foul, false);
  assert.strictEqual(last.svoyak, true);
  assert.strictEqual(last.cuePotted, true);
  assert.strictEqual(last.counted, 2, 'one for the ball, one for the свояк');
  assert.deepStrictEqual(s.scores, [2, 0]);
  assert.strictEqual(s.turn, 0, 'the shooter shoots again');
  assert.strictEqual(B.onTable(s).length, 1, 'the свояк took a second ball off the table');
  assert.ok(!B.cueBall(s).potted, 'the cue ball is back in the house');
  assert.strictEqual(B.onTable(s).length + s.scores[0] + s.scores[1], 3);
});

test('a shot cannot be taken while the balls roll, nor once the game is over', () => {
  const s = B.create();
  assert.ok(B.shoot(s, 0, 1));
  B.step(s, 1 / 480);
  assert.strictEqual(B.shoot(s, 0, 1), false, 'the second shot was refused');
  assert.strictEqual(s.shots, 1);
  s.over = true;
  settle(s);
  assert.strictEqual(B.shoot(s, 0, 1), false);
});

test('predict says what the cue ball will meet first', () => {
  const s = B.create();
  const up = B.predict(s, 0);
  assert.strictEqual(up.ball.id, 1, 'straight up the table is the apex');
  assert.ok(Math.abs(up.x - (B.FOOT_SPOT.x - 2 * B.R)) < 1e-6, "met a ball's width short of it");
  const back = B.predict(s, Math.PI);
  assert.strictEqual(back.ball, null);
  assert.ok(Math.abs(back.x - B.R) < 1e-6, 'the head cushion, one radius in');
});

test('the machine finds a shot on a fresh rack, and a soft touch when nothing is on', () => {
  const random = B.rng(3);
  const fresh = B.botShot(B.create(), random);
  assert.ok(Number.isFinite(fresh.angle));
  assert.ok(fresh.power >= 0.1 && fresh.power <= 1);
  // Nothing on: the only ball sits directly behind the cue ball, and every pocket would
  // need a cut past ninety degrees. The bot plays for contact instead, softly.
  const blocked = lone(500, 887, [{ x: 420, y: 887 }]);
  const soft = B.botShot(blocked, random);
  assert.ok(soft.power <= 0.5, `a touch, not a blast: ${soft.power}`);
  assert.ok(Math.abs(Math.abs(soft.angle) - Math.PI) < 0.02, 'straight at the ball behind');
  const empty = lone(500, 887, []);
  assert.deepStrictEqual(B.botShot(empty, random), { angle: 0, power: 0.2 });
});

test('two machines play a whole game, legally, to eight', () => {
  const s = B.create();
  const random = B.rng(7);
  let shots = 0;
  while (!s.over && shots < 400) {
    const shot = B.botShot(s, random);
    assert.ok(shot.power >= 0.1 && shot.power <= 1);
    const before = s.turn;
    const { last, frames } = play(s, shot.angle, shot.power);
    assert.ok(frames < 4000, `shot ${shots} never settled`);
    shots += 1;
    assert.strictEqual(last.seat, before, 'the shot belongs to whoever had the cue');
    // Every ball is on the table or in somebody's score, and never anywhere else.
    assert.strictEqual(B.onTable(s).length + s.scores[0] + s.scores[1], 15);
    assert.ok(!B.cueBall(s).potted, 'the cue ball is always back on the table between shots');
    if (!s.over) {
      if (last.foul || last.counted === 0) assert.strictEqual(s.turn, 1 - before, 'the cue passed');
      else assert.strictEqual(s.turn, before, 'a ball down keeps the cue');
    }
  }
  assert.ok(s.over, `no result in ${shots} shots`);
  assert.strictEqual(Math.max(...s.scores), 8);
  assert.strictEqual(s.winner, s.scores[0] === 8 ? 0 : 1);
  assert.strictEqual(B.shoot(s, 0, 1), false, 'nothing may be struck after the end');
});

test('the same seed plays the same game', () => {
  const run = (seed) => {
    const s = B.create();
    const random = B.rng(seed);
    for (let i = 0; i < 12 && !s.over; i += 1) {
      const shot = B.botShot(s, random);
      play(s, shot.angle, shot.power);
    }
    return JSON.stringify({ scores: s.scores, balls: s.balls.map((b) => [Math.round(b.x), Math.round(b.y), b.potted]) });
  };
  assert.strictEqual(run(11), run(11));
});
