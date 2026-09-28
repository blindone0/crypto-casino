'use strict';
// The jigsaw board's placement logic, tested as arithmetic rather than through a browser.
//
// This file exists because of how long the drag took to get right. The bug was in a few
// lines of index arithmetic, but every symptom appeared in the DOM — a piece that snapped
// back, a board that looked solved but would not finish — so it kept being investigated
// through transforms and CSS classes, which are two inferences away from the actual state.
// Several wrong conclusions came out of that, each of which cost a round trip.
//
// The model underneath is small and pure: a partial map from piece to slot. That can be
// checked directly and in a thousandth of the time, which is what the tests below do. The
// browser is then only needed for the thing it alone can answer — does a pointer land
// where it looks like it lands — rather than for logic.
//
// The model changed shape when the tray arrived. It used to be a permutation, because
// every piece was always on the board somewhere and a drop swapped two of them. Now a
// piece is either in a slot or in the tray, a drop *places* rather than swaps, and
// whatever was in the target slot is evicted back to the tray. That is a different
// invariant, and it is the one tested here: pieces are never lost or duplicated, and no
// two pieces ever occupy one slot.

const test = require('node:test');
const assert = require('node:assert');

/**
 * The board's model, extracted exactly as `public/jigsawboard.js` implements it.
 *
 * `slotOf[piece]` is the slot a piece occupies, or null while it is in the tray.
 * `arrangement()[slot]` is the piece in that slot, or null. Keeping one and deriving the
 * other is deliberate — holding both lets them disagree, which is a class of bug this
 * avoids entirely.
 */
function model(pieces) {
  const slotOf = new Array(pieces).fill(null);

  return {
    slotOf,
    arrangement() {
      const out = new Array(pieces).fill(null);
      slotOf.forEach((slot, piece) => { if (slot !== null) out[slot] = piece; });
      return out;
    },
    placed() {
      return slotOf.reduce((n, slot) => n + (slot === null ? 0 : 1), 0);
    },
    solved() {
      return slotOf.every((slot, piece) => slot === piece);
    },
    /** Take a piece off the board. */
    toTray(piece) {
      slotOf[piece] = null;
    },
    /** Drop `piece` into `slot`; whatever was there goes back to the tray. */
    place(piece, slot) {
      if (slot === null) return;
      const evicted = slotOf.findIndex((s) => s === slot);
      if (evicted >= 0 && evicted !== piece) slotOf[evicted] = null;
      slotOf[piece] = slot;
    },
  };
}

const identity = (n) => Array.from({ length: n }, (_, i) => i);

/** Nobody is lost, nobody is doubled, and no slot holds two pieces. */
function intact(m, pieces, note) {
  const a = m.arrangement();
  assert.strictEqual(a.length, pieces, note);
  const on = a.filter((p) => p !== null);
  assert.strictEqual(new Set(on).size, on.length, `${note}: a piece is in two slots`);
  assert.strictEqual(on.length, m.placed(), `${note}: the count disagrees with the board`);
  for (const p of on) assert.ok(p >= 0 && p < pieces, `${note}: piece ${p} is not a piece`);
}

// ---------------------------------------------------------------------------

test('a fresh board is empty and everything is in the tray', () => {
  const m = model(16);
  assert.strictEqual(m.placed(), 0);
  assert.strictEqual(m.solved(), false);
  assert.deepStrictEqual(m.arrangement(), new Array(16).fill(null));
});

test('placing a piece fills exactly one slot and nothing else', () => {
  const m = model(16);
  m.place(7, 3);
  const a = m.arrangement();
  assert.strictEqual(a[3], 7, 'the piece is where it was dropped');
  assert.strictEqual(m.placed(), 1);
  for (let slot = 0; slot < 16; slot += 1) {
    if (slot !== 3) assert.strictEqual(a[slot], null, `slot ${slot} must still be empty`);
  }
});

test('dropping onto an occupied slot evicts the tenant rather than swapping', () => {
  // This is the behaviour the tray changed, and it is deliberate. A swap would silently
  // move a piece the player never touched — possibly out of a slot they had got right —
  // to somewhere else on the board. Eviction sends it back to the tray, where they will
  // see it and deal with it.
  const m = model(16);
  m.place(7, 3);
  m.place(9, 3);

  assert.strictEqual(m.arrangement()[3], 9, 'the newcomer holds the slot');
  assert.strictEqual(m.slotOf[7], null, 'and the tenant went back to the tray');
  assert.strictEqual(m.placed(), 1, 'so the board did not gain a piece');
  intact(m, 16, 'after an eviction');
});

test('dropping a piece on the slot it already occupies changes nothing', () => {
  // This is the case that broke the old board. `findIndex` returns the piece itself, and
  // an earlier version guarded the whole placement on `evicted !== piece` — so the
  // assignment that commits `slotOf[piece]` was skipped while the piece had already moved
  // on screen. The model and the display then disagreed, and the board could look
  // complete while reporting that it was not.
  const m = model(9);
  m.place(4, 4);
  const before = m.arrangement();
  m.place(4, 4);
  assert.deepStrictEqual(m.arrangement(), before);
  assert.strictEqual(m.placed(), 1, 'it must not have evicted itself');
  assert.strictEqual(m.slotOf[4], 4);
});

test('the board survives any sequence of drops and lifts', () => {
  // The failure this guards against is not cosmetic. A board that loses a piece, or holds
  // one twice, can never be finished — and it looks like the game is broken rather than
  // like a move was wrong.
  const n = 25;
  const m = model(n);
  let seed = 12345;
  const rand = (limit) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };

  for (let i = 0; i < 4000; i += 1) {
    if (rand(4) === 0) m.toTray(rand(n));
    else m.place(rand(n), rand(n));
    intact(m, n, `after ${i + 1} moves`);
  }
});

test('a board can always be solved by putting each piece in its own slot', () => {
  // Which is what the tap gesture does in one touch, and what a person does by hand: take
  // the piece, put it where it goes. If this terminates, the game is completable.
  for (const n of [4, 9, 16, 400]) {
    const m = model(n);
    for (let piece = 0; piece < n; piece += 1) m.place(piece, piece);
    assert.ok(m.solved(), `${n} pieces did not solve`);
    assert.deepStrictEqual(m.arrangement(), identity(n));
  }
});

test('solving is detected only when the last piece lands, and in any order', () => {
  const m = model(4);
  // Backwards, to prove nothing depends on the order they arrive in.
  for (const piece of [3, 1, 2]) {
    m.place(piece, piece);
    assert.strictEqual(m.solved(), false, 'an incomplete board is not solved');
  }
  m.place(0, 0);
  assert.strictEqual(m.solved(), true, 'the last piece finishes it');
});

test('a full board in the wrong order is not solved', () => {
  // Every slot filled is not the same as every piece home. The server checks exactly this
  // — `arrangement.every((piece, slot) => Number(piece) === slot)` — so a client that
  // called this solved would be refused with the round still open and the clock running.
  const m = model(4);
  m.place(1, 0); m.place(0, 1); m.place(3, 2); m.place(2, 3);
  assert.strictEqual(m.placed(), 4, 'the board is full');
  assert.strictEqual(m.solved(), false, 'but it is not finished');
  assert.ok(m.arrangement().every((p) => p !== null));
});

test('taking a piece back out un-solves the board', () => {
  const m = model(4);
  for (let piece = 0; piece < 4; piece += 1) m.place(piece, piece);
  assert.strictEqual(m.solved(), true);
  m.toTray(2);
  assert.strictEqual(m.solved(), false, 'a hole is a hole');
  assert.strictEqual(m.arrangement()[2], null);
});

test('the arrangement it hands the server is slot -> piece', () => {
  // The direction is the whole contract with `src/games/jigsaw.js`, and getting it
  // backwards would be silently wrong on any placement symmetric enough to look
  // plausible. Pinned here with one that is not its own inverse.
  const m = model(4);
  m.place(0, 1);
  m.place(1, 2);
  m.place(2, 0);
  assert.deepStrictEqual(m.arrangement(), [2, 0, 1, null]);
});
