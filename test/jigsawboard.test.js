'use strict';
// The jigsaw board's swap logic, tested as arithmetic rather than through a browser.
//
// This file exists because of how long the drag took to get right. The bug was in a few
// lines of index arithmetic, but every symptom appeared in the DOM — a piece that snapped
// back, a board that looked solved but would not finish — so it kept being investigated
// through transforms and CSS classes, which are two inferences away from the actual state.
// Several wrong conclusions came out of that, each of which cost a round trip.
//
// The model underneath is small and pure: a permutation, and a function that swaps two
// entries. That can be checked directly and in a thousandth of the time, which is what
// the tests below do. The browser is then only needed for the things it alone can answer
// — does a pointer land where it looks like it lands — rather than for logic.

const test = require('node:test');
const assert = require('node:assert');

/**
 * The board's model, extracted exactly as `public/jigsawboard.js` implements it.
 *
 * `slotOf[piece]` is the slot a piece currently occupies; `arrangement()[slot]` is the
 * piece in that slot. Keeping one and deriving the other is deliberate — holding both
 * lets them disagree, which is a class of bug this avoids entirely.
 */
function model(scramble) {
  const pieces = scramble.length;
  const slotOf = new Array(pieces);
  scramble.forEach((piece, slot) => { slotOf[piece] = slot; });

  return {
    slotOf,
    arrangement() {
      const out = new Array(pieces);
      slotOf.forEach((slot, piece) => { out[slot] = piece; });
      return out;
    },
    solved() {
      return slotOf.every((slot, piece) => slot === piece);
    },
    /** Drop `piece` onto `target`, swapping with whatever is there. */
    drop(piece, target) {
      if (target === null || target === slotOf[piece]) return;
      const other = slotOf.findIndex((slot) => slot === target);
      const mine = slotOf[piece];
      slotOf[piece] = target;
      if (other >= 0 && other !== piece) slotOf[other] = mine;
    },
  };
}

const identity = (n) => Array.from({ length: n }, (_, i) => i);

test('a scramble round-trips through the model', () => {
  const scramble = [1, 0, 3, 2];
  const m = model(scramble);
  assert.deepStrictEqual(m.arrangement(), scramble,
    'arrangement must reproduce the scramble it was built from');
  assert.strictEqual(m.solved(), false);
});

test('a swap exchanges exactly two pieces and nothing else', () => {
  const m = model([8, 2, 1, 14, 9, 3, 5, 13, 4, 6, 15, 12, 10, 0, 7, 11]);
  const before = m.arrangement();

  // Piece 8 sits in slot 0; drop it on slot 1, which holds piece 2.
  m.drop(8, 1);
  const after = m.arrangement();

  assert.strictEqual(after[0], 2, 'the displaced piece took the vacated slot');
  assert.strictEqual(after[1], 8, 'the dragged piece is where it was dropped');
  for (let slot = 2; slot < before.length; slot += 1) {
    assert.strictEqual(after[slot], before[slot], `slot ${slot} must not have moved`);
  }
});

test('the board stays a permutation however many pieces are dragged', () => {
  // The failure this guards against is not cosmetic. A board that loses a piece, or holds
  // one twice, can never be finished — and it looks like the game is broken rather than
  // like a move was wrong.
  const n = 16;
  const m = model([3, 7, 1, 0, 12, 5, 9, 2, 15, 4, 11, 6, 13, 8, 14, 10]);
  let seed = 12345;
  const rand = (limit) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };

  for (let i = 0; i < 2000; i += 1) {
    m.drop(rand(n), rand(n));
    const a = m.arrangement();
    assert.strictEqual(a.length, n);
    assert.deepStrictEqual([...a].sort((x, y) => x - y), identity(n),
      `after ${i + 1} drops the board stopped being a permutation`);
  }
});

test('dropping a piece on the slot it already occupies changes nothing', () => {
  // This is the case that broke it. `findIndex` returns the piece itself, and an earlier
  // version guarded the whole swap on `other !== piece` — so the assignment that commits
  // `slotOf[piece]` was skipped while the piece had already been moved on screen. The
  // model and the display then disagreed, and the board could look complete while
  // reporting that it was not.
  const m = model([1, 0, 3, 2]);
  const before = m.arrangement();
  m.drop(1, 0);   // piece 1 is already in slot 0
  assert.deepStrictEqual(m.arrangement(), before);
  assert.strictEqual(m.solved(), false);
});

test('a board can always be solved by putting each piece in its own slot', () => {
  // Selection sort, which is what a person does: find the piece that belongs here, drag
  // it here. If this terminates the game is completable; if it does not, no player could
  // finish either.
  for (const scramble of [
    [1, 0, 3, 2],
    [3, 2, 1, 0],
    [8, 2, 1, 14, 9, 3, 5, 13, 4, 6, 15, 12, 10, 0, 7, 11],
    identity(25).reverse(),
  ]) {
    const m = model(scramble);
    for (let slot = 0; slot < scramble.length; slot += 1) {
      if (m.arrangement()[slot] !== slot) m.drop(slot, slot);
    }
    assert.ok(m.solved(), `could not solve ${scramble.join(',')}`);
    assert.deepStrictEqual(m.arrangement(), identity(scramble.length));
  }
});

test('solving is detected the moment the last piece lands', () => {
  const m = model([1, 0]);
  assert.strictEqual(m.solved(), false);
  m.drop(0, 0);
  assert.strictEqual(m.solved(), true, 'one swap completes a two-piece board');
});
