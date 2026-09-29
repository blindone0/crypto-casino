'use strict';
// The jigsaw placement rules, checked without a board.
//
// jigsawboard.js binds these to a live board and cannot be exercised here: there is no
// DOM, and inventing one would test the fake. The rules are pure functions in jigsaw.js
// for exactly this reason — the first version had them as closures inside the board,
// where the only way to check "a piece dropped where it cannot belong bounces back" was
// to dispatch pointer events in a browser.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// An ES module in a CommonJS package: copy to .mjs and import, as gl.test.js does.
// jigsaw.js imports nothing, so a lone copy resolves.
const load = (async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'jigsaw.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jigrules-'));
  const file = path.join(dir, 'jigsaw.mjs');
  fs.writeFileSync(file, src);
  // pathToFileURL rather than a hand-built file:// string: the string form needs a
  // backslash-to-slash replace whose backslash was eaten by a heredoc the first time.
  return import(require('node:url').pathToFileURL(file).href);
})();

/** A hundred-piece board with nothing placed. */
const empty = () => new Array(100).fill(null);

test('adjacent uses columns, not indices: 9 and 10 do not touch on a ten-wide board', async () => {
  const { adjacent } = await load;
  assert.strictEqual(adjacent(0, 1, 10), true, 'side by side');
  assert.strictEqual(adjacent(0, 10, 10), true, 'one above the other');
  assert.strictEqual(adjacent(9, 10, 10), false, 'end of one row, start of the next');
  assert.strictEqual(adjacent(0, 11, 10), false, 'diagonal');
  assert.strictEqual(adjacent(5, 5, 10), false, 'a slot is not adjacent to itself');
});

test('a piece may always go in its own slot', async () => {
  const { canPlace } = await load;
  assert.strictEqual(canPlace(42, 42, empty(), 10), true);
});

test('a piece cannot go where it touches nothing', async () => {
  const { canPlace } = await load;
  assert.strictEqual(canPlace(7, 2, empty(), 10), false);
});

test('a piece cannot evict another', async () => {
  const { canPlace } = await load;
  const slotOf = empty();
  slotOf[3] = 5;                                  // piece 3 sits in slot 5
  assert.strictEqual(canPlace(9, 5, slotOf, 10), false);
});

test('a piece may join its real neighbour, on the correct side only', async () => {
  const { canPlace } = await load;
  const slotOf = empty();
  slotOf[0] = 0;                                  // piece 0 is home
  assert.strictEqual(canPlace(1, 1, slotOf, 10), true, 'its right-hand neighbour, to its right');
  assert.strictEqual(canPlace(10, 10, slotOf, 10), true, 'its lower neighbour, below it');
  assert.strictEqual(canPlace(1, 10, slotOf, 10), false, 'its right-hand neighbour, placed below');
  assert.strictEqual(canPlace(5, 1, slotOf, 10), false, 'a piece from further along the row');
});

test('building by trial is allowed: a real join in the wrong place', async () => {
  const { canPlace } = await load;
  // Piece 0 sits in slot 4 — wrong, but it is down. Piece 1 belongs to its right in the
  // picture and slot 5 is to the right of slot 4, so that join is real and is allowed;
  // the player finds the error when the row runs off the edge. That is the rule igor
  // chose over "correct slot only".
  const slotOf = empty();
  slotOf[0] = 4;
  assert.strictEqual(canPlace(1, 5, slotOf, 10), true);
  assert.strictEqual(canPlace(1, 3, slotOf, 10), false, 'to its left is not where 1 goes');
});
