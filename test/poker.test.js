'use strict';
// The Hold'em betting engine.
//
// The evaluator is tested separately; this is about the money. Three things here decide
// whether a hand of poker is honest, and each is a place real implementations go wrong:
//
//   Side pots. A player all in for less than the bets around them can only win what the
//   others also put in up to that amount. Paying a short all-in the whole pot takes chips
//   out of somebody else's stack.
//
//   Chip conservation. Nothing may create or destroy a chip, ever, including when a pot
//   splits unevenly. Every test below that plays a hand checks the total afterwards.
//
//   Hole cards. They live in the state and must never reach another seat's view.

const test = require('node:test');
const assert = require('node:assert');
const poker = require('../src/poker');

/** A pinned shuffle, so a dealt hand is the same hand every run. */
function seeded(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

const totalChips = (state) => state.chips.reduce((a, b) => a + b, 0)
  + state.bets.reduce((a, b) => a + b, 0) + state.pot;

/** Every chip that started the tournament is still somewhere. */
const conserved = (state, seats) => {
  assert.strictEqual(totalChips(state), seats * poker.START_CHIPS, 'chips were created or lost');
};

// -------------------------------------------------------------------- dealing
test('a tournament starts everyone equal, with blinds posted', () => {
  const s = poker.create(3, seeded(1));
  assert.strictEqual(s.chips.length, 3);
  conserved(s, 3);
  assert.strictEqual(s.street, 'preflop');
  for (const hole of s.hole) assert.strictEqual(hole.length, 2);
  // Two blinds are in front of somebody.
  assert.strictEqual(s.bets.filter((b) => b > 0).length, 2);
  assert.strictEqual(s.currentBet, s.blinds.big);
});

test('poker seats two to six', () => {
  for (const n of [2, 3, 4, 5, 6]) assert.doesNotThrow(() => poker.create(n, seeded(n)));
  assert.throws(() => poker.create(1), /two to six/);
  assert.throws(() => poker.create(7), /two to six/);
});

test('nobody is dealt the same card twice', () => {
  for (let i = 0; i < 50; i += 1) {
    const s = poker.create(6, seeded(i + 1));
    const dealt = s.hole.flat();
    assert.strictEqual(new Set(dealt).size, 12);
  }
});

test('heads up, the button posts the small blind and acts first', () => {
  const s = poker.create(2, seeded(5));
  // The button is small blind, so it owes less than the other seat, and it is on it.
  assert.strictEqual(s.toAct, s.button);
  assert.strictEqual(s.bets[s.button], s.blinds.small);
});

test('at three or more, the button posts no blind', () => {
  const s = poker.create(3, seeded(9));
  assert.strictEqual(s.bets[s.button], 0, 'the button posts no blind');
  // Three-handed the button is also first to act before the flop, because the action
  // starts to the left of the big blind and that is all the way round to the button.
  assert.strictEqual(s.toAct, s.button);

  const four = poker.create(4, seeded(10));
  assert.strictEqual(four.bets[four.button], 0);
  assert.notStrictEqual(four.toAct, four.button, 'with four, somebody else opens');
});

// -------------------------------------------------------------------- acting
test('a seat can only act when it is its turn', () => {
  const s = poker.create(3, seeded(2));
  const other = (s.toAct + 1) % 3;
  assert.throws(() => poker.act(s, other, 'fold'), /not your turn/);
  assert.doesNotThrow(() => poker.act(s, s.toAct, 'fold'));
});

test('checking is refused when you owe something', () => {
  const s = poker.create(3, seeded(3));
  assert.throws(() => poker.act(s, s.toAct, 'check'), /you owe/);
});

test('calling puts in exactly what is owed', () => {
  const s = poker.create(3, seeded(4));
  const seat = s.toAct;
  const owed = poker.options(s, seat).owed;
  const after = poker.act(s, seat, 'call');
  assert.strictEqual(after.chips[seat], s.chips[seat] - owed);
  assert.strictEqual(after.bets[seat], s.currentBet);
  conserved(after, 3);
});

test('a raise must be to at least the minimum, or be everything', () => {
  const s = poker.create(3, seeded(6));
  const seat = s.toAct;
  const o = poker.options(s, seat);
  assert.throws(() => poker.act(s, seat, 'raise', o.minRaiseTo - 1), /at least/);
  assert.throws(() => poker.act(s, seat, 'raise', s.currentBet), /at least|more than the bet/);
  assert.throws(() => poker.act(s, seat, 'raise', o.maxRaiseTo + 1), /do not have that many/);
  assert.doesNotThrow(() => poker.act(s, seat, 'raise', o.minRaiseTo));
});

test('a raise reopens the betting for everyone who had already acted', () => {
  let s = poker.create(3, seeded(7));
  const first = s.toAct;
  s = poker.act(s, first, 'call');
  const second = s.toAct;
  s = poker.act(s, second, 'raise', poker.options(s, second).minRaiseTo);
  // The first seat called and now owes again, so it is back on the clock.
  assert.strictEqual(s.acted[first], false, 'the call no longer counts as acted');
  conserved(s, 3);
});

test('folding takes a seat out of the hand but not the tournament', () => {
  const s = poker.create(3, seeded(8));
  const seat = s.toAct;
  const after = poker.act(s, seat, 'fold');
  assert.strictEqual(after.folded[seat], true);
  assert.ok(after.chips[seat] >= 0);
  conserved(after, 3);
});

test('everyone folding to one player ends the hand there', () => {
  let s = poker.create(3, seeded(11));
  const chipsBefore = s.chips.slice();
  s = poker.act(s, s.toAct, 'fold');
  s = poker.act(s, s.toAct, 'fold');
  assert.strictEqual(s.street, 'showdown');
  assert.strictEqual(s.showdown.shown.length, 0, 'nothing is shown when nobody called');
  // The blinds went to the one who was left.
  const winner = s.showdown.awards[0].winners[0];
  assert.ok(s.chips[winner] > chipsBefore[winner]);
  conserved(s, 3);
});

// ------------------------------------------------------------------- streets
test('the board comes out three, then one, then one', () => {
  let s = poker.create(3, seeded(12));
  /** Everyone calls or checks until the street changes. */
  const toNextStreet = () => {
    const from = s.street;
    for (let guard = 0; guard < 12 && s.street === from && s.toAct >= 0; guard += 1) {
      const o = poker.options(s, s.toAct);
      s = poker.act(s, s.toAct, o.check ? 'check' : 'call');
    }
  };
  toNextStreet();
  assert.strictEqual(s.street, 'flop');
  assert.strictEqual(s.board.length, 3);
  toNextStreet();
  assert.strictEqual(s.street, 'turn');
  assert.strictEqual(s.board.length, 4);
  toNextStreet();
  assert.strictEqual(s.street, 'river');
  assert.strictEqual(s.board.length, 5);
});

test('a card is burned before each community card', () => {
  let s = poker.create(2, seeded(13));
  const deckBefore = s.deck.length;
  // Call and check to the flop.
  s = poker.act(s, s.toAct, 'call');
  s = poker.act(s, s.toAct, 'check');
  assert.strictEqual(s.street, 'flop');
  assert.strictEqual(s.board.length, 3);
  // Three cards to the board and one burned.
  assert.strictEqual(s.deck.length, deckBefore - 4);
});

// ------------------------------------------------------------------ side pots
test('a side pot gives a short all-in only what it could match', () => {
  // Three players commit 100, 500 and 500. The short stack can win 300 at most.
  const pots = poker.buildPots([100, 500, 500], [true, true, true]);
  assert.strictEqual(pots.length, 2);
  assert.deepStrictEqual(pots[0], { amount: 300, eligible: [0, 1, 2] });
  assert.deepStrictEqual(pots[1], { amount: 800, eligible: [1, 2] });
  assert.strictEqual(pots[0].amount + pots[1].amount, 1100, 'every chip is in a pot');
});

test('a folded player contributes to the pot but cannot win it', () => {
  const pots = poker.buildPots([100, 500, 500], [false, true, true]);
  assert.strictEqual(pots.reduce((n, p) => n + p.amount, 0), 1100);
  for (const pot of pots) assert.ok(!pot.eligible.includes(0), 'the folder is never eligible');
});

test('layers with the same claimants are one pot, not several', () => {
  const pots = poker.buildPots([200, 200, 200], [true, true, true]);
  assert.strictEqual(pots.length, 1);
  assert.strictEqual(pots[0].amount, 600);
});

test('an all-in short stack that wins takes only the main pot', (t) => {
  // Built by hand so the outcome is certain rather than dealt.
  const state = {
    chips: [0, 400, 400],
    hole: [['As', 'Ah'], ['Kd', 'Kc'], ['Qd', 'Qc']],
    dealt: [true, true, true],
    folded: [false, false, false],
    allIn: [true, false, false],
    acted: [true, true, true],
    bets: [0, 0, 0],
    committed: [100, 500, 500],
    board: ['2d', '7h', '9c', 'Jd', '3s'],
    deck: [],
    pot: 1100,
    currentBet: 0,
    minRaise: 20,
    button: 0,
    toAct: -1,
    street: 'river',
    hand: 0,
    blinds: { small: 10, big: 20 },
    log: [],
  };
  const after = poker.settleHand(state);
  // Aces take the 300 main pot; kings take the 800 side pot the aces could not match.
  assert.strictEqual(after.chips[0], 300, 'the short all-in wins only what it matched');
  assert.strictEqual(after.chips[1], 400 + 800, 'the best of the rest takes the side pot');
  assert.strictEqual(after.chips[2], 400);
  assert.strictEqual(after.chips.reduce((a, b) => a + b, 0), 1900);
});

test('a tied pot splits, and the odd chip is not lost', () => {
  const state = {
    chips: [0, 0],
    hole: [['As', 'Kh'], ['Ad', 'Kc']],
    dealt: [true, true],
    folded: [false, false],
    allIn: [true, true],
    acted: [true, true],
    bets: [0, 0],
    // An odd total, so the halves cannot be equal.
    committed: [50, 51],
    board: ['2d', '7h', '9c', 'Jd', '3s'],
    deck: [],
    pot: 101,
    currentBet: 0,
    minRaise: 20,
    button: 0,
    toAct: -1,
    street: 'river',
    hand: 0,
    blinds: { small: 10, big: 20 },
    log: [],
  };
  const after = poker.settleHand(state);
  assert.strictEqual(after.chips[0] + after.chips[1], 101, 'the odd chip went somewhere');
  assert.ok(Math.abs(after.chips[0] - after.chips[1]) <= 1, 'and the split is even otherwise');
});

test('an uncalled bet comes back to whoever made it', () => {
  // Seat 1 is all in for 140. Seat 3 put in 300, so 160 of that was never matched by
  // anybody and is not part of any pot. Before this was handled those chips vanished:
  // they belonged to a pot with no eligible claimant, and the table quietly lost them.
  const state = {
    chips: [0, 0, 0, 7060, 0],
    hole: [null, ['As', 'Ah'], null, ['Kd', 'Kc'], null],
    dealt: [false, true, false, true, false],
    folded: [false, false, false, true, false],
    allIn: [false, true, false, false, false],
    acted: [false, true, false, true, false],
    bets: [0, 140, 0, 300, 0],
    committed: [0, 140, 0, 300, 0],
    board: ['2d', '7h', '9c', 'Jd', '3s'],
    deck: [],
    pot: 0,
    currentBet: 300,
    minRaise: 140,
    button: 0,
    toAct: -1,
    street: 'preflop',
    hand: 0,
    blinds: { small: 10, big: 20 },
    log: [],
  };
  const before = state.chips.reduce((a, b) => a + b, 0)
    + state.bets.reduce((a, b) => a + b, 0) + state.pot;

  const after = poker.settleHand(state);
  const total = after.chips.reduce((a, b) => a + b, 0)
    + after.bets.reduce((a, b) => a + b, 0) + after.pot;

  assert.strictEqual(total, before, 'not one chip went missing');
  assert.strictEqual(after.chips[3], 7060 + 160, 'the uncalled 160 came back');
  assert.strictEqual(after.chips[1], 280, 'and the matched 280 went to the hand that won it');
});

// ------------------------------------------------------------------ the view
test('you see your own cards and nobody sees yours', () => {
  const s = poker.create(3, seeded(21));
  for (let seat = 0; seat < 3; seat += 1) {
    const mine = poker.view(s, seat);
    assert.deepStrictEqual(mine.hole, s.hole[seat]);
    for (let other = 0; other < 3; other += 1) {
      if (other === seat) continue;
      const serialised = JSON.stringify(poker.view(s, other));
      for (const card of s.hole[seat]) {
        assert.ok(!serialised.includes(`"${card}"`),
          `${card} from seat ${seat} is visible to seat ${other}`);
      }
    }
  }
  // And a spectator sees no hand at all.
  assert.strictEqual(poker.view(s, null).hole, null);
});

test('the showdown reveals the hands that were called, and only then', () => {
  let s = poker.create(2, seeded(22));
  assert.strictEqual(poker.view(s, 0).showdown, null);
  // Both all in preflop, so it runs to the river.
  s = poker.act(s, s.toAct, 'allin');
  s = poker.act(s, s.toAct, 'call');
  // The hand is over. If it also busted somebody, the tournament is over with it.
  assert.ok(['showdown', 'over'].includes(s.street));
  const shown = poker.view(s, 0).showdown;
  assert.strictEqual(shown.shown.length, 2, 'both hands are shown');
  assert.strictEqual(shown.board.length, 5, 'and the whole board is out');
});

// ------------------------------------------------------- whole tournaments
test('tournaments play out, conserve every chip, and leave one winner', () => {
  for (let game = 0; game < 40; game += 1) {
    const seats = 2 + (game % 5);
    const rnd = seeded(game * 977 + 3);
    let s = poker.create(seats, rnd);

    for (let step = 0; step < 4000 && !s.finished; step += 1) {
      if (s.street === 'showdown') {
        s = poker.nextHand(s, rnd);
        continue;
      }
      const seat = s.toAct;
      assert.ok(seat >= 0, `nobody to act on step ${step} of game ${game}`);
      const o = poker.options(s, seat);
      // A simple player: call what it can, shove now and then, never fold to a check.
      const roll = rnd();
      // A raise has to fit in the stack. minRaiseTo is what the rules ask for; a shorter
      // stack can only get there by shoving, which is a different move.
      const raiseTo = Math.min(o.minRaiseTo, o.maxRaiseTo);
      const canRaise = o.raise > 0 && raiseTo > s.currentBet && raiseTo >= o.minRaiseTo;
      let move = 'check';
      if (o.check) move = roll < 0.12 && canRaise ? 'raise' : 'check';
      else if (roll < 0.18) move = 'fold';
      else if (roll > 0.94 && o.allIn) move = 'allin';
      else move = 'call';
      s = move === 'raise' ? poker.act(s, seat, 'raise', raiseTo) : poker.act(s, seat, move);

      assert.strictEqual(
        s.chips.reduce((a, b) => a + b, 0) + s.bets.reduce((a, b) => a + b, 0) + s.pot,
        seats * poker.START_CHIPS,
        `chips went missing in game ${game} at step ${step}`,
      );
    }

    assert.strictEqual(s.finished, true, `game ${game} never finished`);
    assert.ok(s.winner !== null, `game ${game} has no winner`);
    assert.strictEqual(s.chips[s.winner], seats * poker.START_CHIPS,
      `the winner of game ${game} does not hold every chip`);
  }
});

test('blinds rise as the tournament goes on', () => {
  const early = poker.blindsAt(0);
  const later = poker.blindsAt(poker.HANDS_PER_LEVEL * 3);
  assert.ok(later.big > early.big, 'the blinds went up');
  assert.strictEqual(early.big, early.small * 2, 'the big blind is twice the small');
  // And they stop climbing rather than overflowing.
  const far = poker.blindsAt(poker.HANDS_PER_LEVEL * 100);
  assert.ok(Number.isSafeInteger(far.big));
});

test('quitting surrenders a stack without breaking the table', () => {
  let s = poker.create(3, seeded(31));
  const seat = (s.toAct + 1) % 3;
  s = poker.quit(s, seat);
  assert.strictEqual(s.chips[seat], 0);
  assert.strictEqual(s.folded[seat], true);
  // The table either carries on or the hand resolves, but it is never left stuck.
  assert.ok(s.finished || s.toAct >= 0 || s.street === 'showdown');
});
