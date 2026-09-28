// Real jigsaw piece geometry.
//
// A grid of squares does not read as a puzzle. A jigsaw does, and the thing that makes it
// one is that neighbouring pieces share an edge exactly: where one has a tab, the other
// has the matching blank, and the curve between them is the *same* curve traced in
// opposite directions.
//
// So edges are generated once and shared. Each internal edge gets a direction, and each
// of the two pieces touching it traces that same absolute curve, one of them reversed.
// Generating each piece independently would leave hairline gaps and overlaps wherever two
// pieces disagreed about where the boundary was.
//
// The shapes here are cosmetic. Which pieces are broken comes from the server seed and is
// never decided in the browser.

/** Small deterministic PRNG so a round keeps the same cut across re-renders. */
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Knob shape in edge-local space: x runs 0..1 along the edge, y is perpendicular.
// The control points deliberately step backwards (0.30 < 0.36) to pinch the neck, which
// is what stops a jigsaw tab looking like a bump.
const NECK = 0.36;
const KNOB = 0.30;

/**
 * Cubic segments for one edge, in edge-local coordinates, from (0,0) to (1,0).
 * `dir` is +1 or -1 for which side the tab sticks out, or 0 for a flat border edge.
 * Returns a list of [c1, c2, end] triples.
 */
function edgeSegments(dir, wobble) {
  if (!dir) return [[[0.34, 0], [0.66, 0], [1, 0]]];
  const d = dir;
  const k = KNOB * d;
  const mid = 0.5 + wobble * 0.04;
  return [
    [[0.2, 0], [NECK - 0.04, 0], [NECK, 0]],
    [[NECK - 0.05, k * 0.42], [mid - 0.22, k], [mid, k]],
    [[mid + 0.22, k], [1 - NECK + 0.05, k * 0.42], [1 - NECK, 0]],
    [[1 - NECK + 0.04, 0], [0.8, 0], [1, 0]],
  ];
}

/** Reverse a segment list so the same curve can be traced from the other end. */
function reverseSegments(segs) {
  const pts = [[0, 0], ...segs.map((s) => s[2])];
  const out = [];
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    out.push([segs[i][1], segs[i][0], pts[i]]);
  }
  return out;
}

/**
 * Build the cut for a cols x rows jigsaw.
 * Returns { path(col,row) } producing an absolute SVG path string in a `width` x `height`
 * box. Neighbouring pieces share edges exactly.
 */
function createCut({ cols, rows, width, height, seed = 1, jitter = true }) {
  const rand = lcg(seed);
  const cw = width / cols;
  const ch = height / rows;

  // Internal edge directions. h[r][c] is the edge under piece (c, r-1); v[r][c] is the
  // edge to the right of piece (c-1, r).
  const h = [];
  const hw = [];
  for (let r = 0; r <= rows; r += 1) {
    h.push(Array.from({ length: cols }, () => (rand() < 0.5 ? -1 : 1)));
    hw.push(Array.from({ length: cols }, () => (jitter ? rand() * 2 - 1 : 0)));
  }
  const v = [];
  const vw = [];
  for (let r = 0; r < rows; r += 1) {
    v.push(Array.from({ length: cols + 1 }, () => (rand() < 0.5 ? -1 : 1)));
    vw.push(Array.from({ length: cols + 1 }, () => (jitter ? rand() * 2 - 1 : 0)));
  }

  /** Map an edge-local point onto the board, given an origin and two basis vectors. */
  const place = (ox, oy, ax, ay, bx, by) => ([t, u]) => [
    (ox + ax * t + bx * u).toFixed(2),
    (oy + ay * t + by * u).toFixed(2),
  ];

  function emit(segs, mapper) {
    return segs.map((s) => {
      const c1 = mapper(s[0]);
      const c2 = mapper(s[1]);
      const e = mapper(s[2]);
      return `C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${e[0]} ${e[1]}`;
    }).join(' ');
  }

  function path(col, row) {
    const x = col * cw;
    const y = row * ch;
    const parts = [`M${x.toFixed(2)} ${y.toFixed(2)}`];

    // --- top edge, traced left to right
    {
      const dir = row === 0 ? 0 : h[row][col];
      const segs = edgeSegments(dir, hw[row][col]);
      parts.push(emit(segs, place(x, y, cw, 0, 0, ch)));
    }
    // --- right edge, traced top to bottom
    {
      const dir = col === cols - 1 ? 0 : v[row][col + 1];
      const segs = edgeSegments(dir, vw[row][col + 1]);
      parts.push(emit(segs, place(x + cw, y, 0, ch, -cw, 0)));
    }
    // --- bottom edge, traced right to left: the same curve the piece below uses for its
    //     top, reversed, so the two agree to the pixel.
    //
    // The origin is the LEFT corner and `a` points right, even though the edge is traced
    // right to left. That looks backwards and is the whole point: `reverseSegments` has
    // already flipped the curve, so its local `t` still runs 0 to 1 while walking the
    // curve backwards. Flipping `a` as well reversed it twice, which put the start of the
    // edge in the middle of the cell and left the path cutting a diagonal across the
    // piece — the "half of every piece is black" that this shipped with.
    {
      const dir = row === rows - 1 ? 0 : h[row + 1][col];
      const segs = reverseSegments(edgeSegments(dir, hw[row + 1][col]));
      parts.push(emit(segs, place(x, y + ch, cw, 0, 0, ch)));
    }
    // --- left edge, traced bottom to top, likewise shared with the piece to the left.
    //     Same rule: origin at the TOP corner, `a` pointing down.
    {
      const dir = col === 0 ? 0 : v[row][col];
      const segs = reverseSegments(edgeSegments(dir, vw[row][col]));
      parts.push(emit(segs, place(x, y, 0, ch, -cw, 0)));
    }
    parts.push('Z');
    return parts.join(' ');
  }

  return { path, cellWidth: cw, cellHeight: ch };
}

export { createCut, edgeSegments, lcg };
