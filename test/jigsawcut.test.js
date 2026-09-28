'use strict';
// The cut geometry: the shape of a jigsaw piece.
//
// This shipped broken and nobody could see why from the code. Every piece rendered with
// roughly half of it missing — a black diagonal across each cell — and the obvious
// suspects were all wrong: the picture was fine (2% black), the clip paths matched their
// outlines exactly, the empty-bed slots underneath made no difference. The defect was two
// characters of sign in a basis vector, three files away from where it showed up.
//
// The cause, written down because it is genuinely counter-intuitive: the bottom and left
// edges are traced backwards so that a piece shares each edge with its neighbour exactly.
// `reverseSegments` flips the curve, and its local `t` then still runs 0 to 1 while
// walking that curve from the far end. The mapper was *also* flipping its basis vector, so
// the edge was reversed twice — it started in the middle of the cell and the path cut
// straight across the piece.
//
// The lesson is the test, not the fix. A path is a string, and a wrong string still
// renders; nothing throws. So these assert the two properties that actually define the
// shape, both checkable as arithmetic:
//
//   1. A piece's outline visits its four corners, in order, and closes.
//   2. Two neighbours trace the same curve along their shared edge.
//
// Either one failing produces exactly the bug that shipped.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// `public/jigsaw.js` is an ES module served to the browser, and this suite is CommonJS.
// Rather than add a loader, the module is read and evaluated — it imports nothing, so
// this is the whole of it.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'jigsaw.js'), 'utf8');
const { createCut } = (() => {
  const body = SRC.replace(/^export\s*\{[^}]*\};?\s*$/m, '')
    + '\nreturn { createCut, edgeSegments, lcg };';
  // eslint-disable-next-line no-new-func
  return new Function(body)();
})();

/** The end point of every cubic segment in a path, in order. */
function endpoints(d) {
  return d.split('C').slice(1).map((seg) => {
    const n = seg.match(/-?\d+(?:\.\d+)?/g).map(Number);
    return [n[4], n[5]];
  });
}

/** The `M` the path starts at. */
function startPoint(d) {
  const n = d.slice(1, d.indexOf('C')).match(/-?\d+(?:\.\d+)?/g).map(Number);
  return [n[0], n[1]];
}

const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const samePoint = (p, q) => near(p[0], q[0]) && near(p[1], q[1]);
const key = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;

// ---------------------------------------------------------------------------

test('a piece visits its four corners, in order, and closes', () => {
  const cols = 5;
  const rows = 4;
  const cw = 100;
  const ch = 100;
  const cut = createCut({ cols, rows, width: cols * cw, height: rows * ch, seed: 20260928 });

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const d = cut.path(col, row);
      const x = col * cw;
      const y = row * ch;
      const corners = [[x, y], [x + cw, y], [x + cw, y + ch], [x, y + ch]];
      const at = `piece (${col},${row})`;

      assert.ok(samePoint(startPoint(d), corners[0]), `${at} must start at its top-left`);

      // Every corner must appear as a segment endpoint, in order, walking clockwise from
      // the top-left and back to it. The broken version reached only two: the bottom and
      // left edges began part-way across the cell, so the outline was a triangle and the
      // other half of the piece was never drawn.
      const pts = endpoints(d);
      const wanted = [corners[1], corners[2], corners[3], corners[0]];
      let seen = 0;
      for (const p of pts) {
        if (seen < wanted.length && samePoint(p, wanted[seen])) seen += 1;
      }
      assert.strictEqual(seen, wanted.length,
        `${at} walked ${seen} of its ${wanted.length} corners in order`);
      assert.ok(samePoint(pts[pts.length - 1], corners[0]),
        `${at} must end where it started, not at ${pts[pts.length - 1]}`);
    }
  }
});

test('the outline stays inside the cell, apart from its tabs', () => {
  // A tab reaches out by roughly a third of a cell, and nothing should reach further.
  // Doubly-reversed edges threw control points a full cell away, which is what turned the
  // outline inside out.
  const cut = createCut({ cols: 4, rows: 4, width: 400, height: 400, seed: 7 });
  const overhang = 100 * 0.35;

  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const x = col * 100;
      const y = row * 100;
      for (const [px, py] of endpoints(cut.path(col, row))) {
        assert.ok(px >= x - overhang && px <= x + 100 + overhang,
          `piece (${col},${row}) has a point at x=${px}, outside [${x - overhang}, ${x + 100 + overhang}]`);
        assert.ok(py >= y - overhang && py <= y + 100 + overhang,
          `piece (${col},${row}) has a point at y=${py}, outside its row`);
      }
    }
  }
});

test('neighbours trace the same curve along the edge they share', () => {
  // This is what makes it a jigsaw rather than a grid of squares: where one piece has a
  // tab the other has the matching blank, to the pixel. Generating each piece
  // independently would leave hairline gaps, and a tab that did not fit its own socket.
  const cut = createCut({ cols: 5, rows: 5, width: 500, height: 500, seed: 4242 });

  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const mine = endpoints(cut.path(col, row));
      // The path is four edges; a tabbed edge is 4 segments and a flat border edge is 1,
      // so the edges are found by their corners rather than by a fixed index.
      const interior = (pts) => pts.map(key);

      if (row < 4) {
        // My bottom edge is the top edge of the piece below.
        const below = endpoints(cut.path(col, row + 1));
        const mineSet = new Set(interior(mine));
        const shared = interior(below).filter((p) => mineSet.has(p));
        assert.ok(shared.length >= 3,
          `piece (${col},${row}) and the one below it share only ${shared.length} points`);
      }
      if (col < 4) {
        // My right edge is the left edge of the piece beside me.
        const beside = endpoints(cut.path(col + 1, row));
        const mineSet = new Set(interior(mine));
        const shared = interior(beside).filter((p) => mineSet.has(p));
        assert.ok(shared.length >= 3,
          `piece (${col},${row}) and the one beside it share only ${shared.length} points`);
      }
    }
  }
});

test('the outer border is straight, because a jigsaw has a flat edge', () => {
  const cut = createCut({ cols: 4, rows: 4, width: 400, height: 400, seed: 31337 });

  // Top-left piece: nothing above it and nothing to its left, so those two edges are flat.
  const pts = endpoints(cut.path(0, 0));
  for (const [px, py] of pts) {
    assert.ok(py >= -0.01, `no point may sit above the board, got y=${py}`);
    assert.ok(px >= -0.01, `no point may sit left of the board, got x=${px}`);
  }
  // Bottom-right likewise.
  for (const [px, py] of endpoints(cut.path(3, 3))) {
    assert.ok(py <= 400.01, `no point may sit below the board, got y=${py}`);
    assert.ok(px <= 400.01, `no point may sit right of the board, got x=${px}`);
  }
});

test('the same seed cuts the same board, and a different seed does not', () => {
  // The cut travels with the round so a re-render does not reshuffle the shapes under the
  // player mid-drag.
  const opts = { cols: 4, rows: 4, width: 400, height: 400 };
  const a = createCut({ ...opts, seed: 555 });
  const b = createCut({ ...opts, seed: 555 });
  const c = createCut({ ...opts, seed: 556 });

  assert.strictEqual(a.path(2, 2), b.path(2, 2), 'one seed, one cut');
  assert.notStrictEqual(a.path(2, 2), c.path(2, 2), 'a different seed must cut differently');
});

test('every piece is a closed region with real area', () => {
  // The shoelace area over the segment endpoints. A triangle-shaped piece — the bug that
  // shipped — comes out at roughly half a cell, so this catches it by magnitude even
  // without knowing which corner went missing.
  const cut = createCut({ cols: 5, rows: 5, width: 500, height: 500, seed: 99 });
  const cell = 100 * 100;

  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const pts = [startPoint(cut.path(col, row)), ...endpoints(cut.path(col, row))];
      let area = 0;
      for (let i = 0; i < pts.length; i += 1) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        area += x1 * y2 - x2 * y1;
      }
      area = Math.abs(area) / 2;
      // Tabs add and blanks subtract, so a piece is near a cell but not exactly one.
      assert.ok(area > cell * 0.7,
        `piece (${col},${row}) covers ${Math.round(area)} of ${cell} — it is not a whole piece`);
      assert.ok(area < cell * 1.3,
        `piece (${col},${row}) covers ${Math.round(area)} of ${cell} — it is larger than a piece`);
    }
  }
});
