// The drag-to-assemble board.
//
// WHAT THIS HAS TO GET RIGHT
//
// A jigsaw lives or dies on whether dragging feels direct. Two things decide that, and
// neither is obvious:
//
//   - Pointer Events, captured. `setPointerCapture` means the piece keeps receiving moves
//     even when the pointer leaves it, which is what happens constantly when you drag
//     quickly. Without it a fast drag drops the piece the moment the cursor outruns it.
//   - Offset, not centre. The piece moves by the delta from where it was *grabbed*, so it
//     does not jump under the finger on the first frame. Snapping to centre is the single
//     most common way a drag implementation feels wrong.
//
// Touch needs `touch-action: none` on the pieces or the browser claims the gesture for
// scrolling and the drag never starts — that is in buttons.css alongside the rest.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not know the answer. The server sends a scramble and checks the arrangement;
// this file only tracks which piece is sitting in which slot. Nothing here could tell a
// modified client where a piece belongs, because nothing here knows.
//
// It also does not time anything. There is a clock on screen, but it is read from the
// server's `elapsed` and ticked locally for display only — the payout uses the server's
// own measurement, so a tampered display changes nothing but itself.

import { createCut } from './jigsaw.js';

const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  return n;
};

/** The board is drawn in its own coordinate space and scaled by the viewBox. */
const BOARD = 1000;

/**
 * Build a playable jigsaw.
 *
 * `onSolve(arrangement)` fires once, the moment every piece is home. `arrangement[slot]`
 * is the piece in that slot, which is exactly what the server expects.
 */
export function board(host, {
  cols, rows, scramble, cutSeed = 1, picture = null, onSolve = () => {}, onMove = () => {},
}) {
  const pieces = cols * rows;
  const boardH = Math.round((BOARD * rows) / cols);
  const cut = createCut({
    cols, rows, width: BOARD, height: boardH, seed: (cutSeed || 1) * 2654435761,
  });

  // slotOf[piece] = which slot it currently occupies. The inverse is what the server
  // wants, so it is derived at the end rather than maintained twice and allowed to drift.
  const slotOf = new Array(pieces);
  scramble.forEach((piece, slot) => { slotOf[piece] = slot; });

  const svg = svgEl('svg', {
    // Past roughly a hundred pieces the outlines start to dominate the picture, so the
    // stylesheet thins them. Decided here because only this knows the piece count.
    class: `jig-board${pieces > 80 ? ' dense' : ''}`,
    viewBox: `0 0 ${BOARD} ${boardH}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  // Every piece is clipped to its own cut shape and shows the whole picture through it.
  // That is what makes the picture continuous once assembled: each piece is a window onto
  // the same image, at the same place, rather than a separately cropped tile.
  const defs = svgEl('defs');
  svg.appendChild(defs);

  const slotXY = (slot) => ({
    x: (slot % cols) * (BOARD / cols),
    y: Math.floor(slot / cols) * (boardH / rows),
  });

  // The empty bed, so a half-finished board still reads as a board.
  for (let slot = 0; slot < pieces; slot += 1) {
    svg.appendChild(svgEl('path', {
      d: cut.path(slot % cols, Math.floor(slot / cols)),
      class: 'jig-slot',
    }));
  }

  // The picture is declared ONCE and every piece references it.
  //
  // This matters more than it looks. The picture arrives as a data URI of roughly 170KB,
  // and the obvious implementation — an <image> inside each piece — puts a copy of that
  // string in the document per piece. At sixteen pieces that is careless; at four hundred
  // it is 68MB of markup and the tab stops responding. A <defs> declaration plus a <use>
  // per piece is one copy and four hundred references.
  const ART_ID = `jigart-${cutSeed}`;
  if (picture) {
    defs.appendChild(svgEl('image', {
      id: ART_ID,
      href: picture,
      x: 0, y: 0, width: BOARD, height: boardH,
      preserveAspectRatio: 'xMidYMid slice',
    }));
  } else {
    // No picture for this round: the cut shapes are the puzzle either way.
    defs.appendChild(svgEl('rect', {
      id: ART_ID, x: 0, y: 0, width: BOARD, height: boardH, class: 'jig-blank',
    }));
  }

  const nodes = [];
  for (let piece = 0; piece < pieces; piece += 1) {
    const col = piece % cols;
    const row = Math.floor(piece / cols);
    const clipId = `jigclip-${cutSeed}-${piece}`;

    const clip = svgEl('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
    clip.appendChild(svgEl('path', { d: cut.path(col, row) }));
    defs.appendChild(clip);

    // A group per piece: the clip holds the shape, the transform holds where it sits, and
    // the outline is drawn on top so an assembled picture still shows its seams.
    const g = svgEl('g', { class: 'jig-piece', 'data-piece': String(piece) });
    const art = svgEl('g', { 'clip-path': `url(#${clipId})` });
    art.appendChild(svgEl('use', { href: `#${ART_ID}` }));
    g.appendChild(art);
    g.appendChild(svgEl('path', { d: cut.path(col, row), class: 'jig-edge' }));
    svg.appendChild(g);
    nodes.push(g);
  }

  /** Put a piece where its slot says, as an offset from where the piece was cut. */
  function place(piece, animate = false) {
    const from = slotXY(piece);           // where this piece's art lives in the image
    const to = slotXY(slotOf[piece]);     // where it is currently sitting
    const g = nodes[piece];
    g.classList.toggle('jig-settling', animate);
    g.setAttribute('transform', `translate(${(to.x - from.x).toFixed(2)} ${(to.y - from.y).toFixed(2)})`);
    g.classList.toggle('jig-home', slotOf[piece] === piece);
    if (animate) setTimeout(() => g.classList.remove('jig-settling'), 180);
  }

  for (let piece = 0; piece < pieces; piece += 1) place(piece);

  const isSolved = () => slotOf.every((slot, piece) => slot === piece);

  /** slotOf is piece -> slot; the server wants slot -> piece. */
  function arrangement() {
    const out = new Array(pieces);
    slotOf.forEach((slot, piece) => { out[slot] = piece; });
    return out;
  }

  // ------------------------------------------------------------------ drag
  let drag = null;
  let done = false;

  /** Board coordinates for a pointer, through the SVG's own transform. */
  function toBoard(e) {
    const r = svg.getBoundingClientRect();
    // The viewBox is letterboxed by xMidYMid meet, so the scale is the smaller of the two
    // and the drawing is centred in whatever is left over.
    const scale = Math.min(r.width / BOARD, r.height / boardH);
    const ox = (r.width - BOARD * scale) / 2;
    const oy = (r.height - boardH * scale) / 2;
    return {
      x: (e.clientX - r.left - ox) / scale,
      y: (e.clientY - r.top - oy) / scale,
    };
  }

  const slotAt = (x, y) => {
    const c = Math.floor(x / (BOARD / cols));
    const r = Math.floor(y / (boardH / rows));
    if (c < 0 || c >= cols || r < 0 || r >= rows) return null;
    return r * cols + c;
  };

  svg.addEventListener('pointerdown', (e) => {
    if (done) return;
    const g = e.target.closest('.jig-piece');
    if (!g) return;
    const piece = Number(g.dataset.piece);
    const at = toBoard(e);
    const from = slotXY(piece);
    const to = slotXY(slotOf[piece]);

    drag = {
      piece,
      pointerId: e.pointerId,
      // How far into the piece it was grabbed: 0..cellWidth, measured against where the
      // piece is *sitting*. This is the number that keeps the piece from jumping under
      // the finger, and it is a within-the-piece offset, never a displacement.
      dx: at.x - to.x,
      dy: at.y - to.y,
      moved: false,
    };
    // Keep receiving moves even when the pointer outruns the piece, which it will.
    //
    // Wrapped, and not merely optional-chained: this *throws* when there is no live
    // pointer with that id — a synthetic event, or a pointer the browser has already
    // released. `?.` guards a missing method, not a method that raises, so an
    // unwrapped call aborted `pointerdown` before `drag` was ever assigned and every
    // subsequent move and drop quietly did nothing. Capture is an optimisation; losing
    // it costs a dropped piece on a fast drag, not a broken board.
    try { g.setPointerCapture?.(e.pointerId); } catch { /* no live pointer to capture */ }
    g.classList.add('jig-held');
    // Lift it above its neighbours while it is in the air.
    svg.appendChild(g);
    e.preventDefault();
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const at = toBoard(e);
    const g = nodes[drag.piece];
    // Two different origins meet here, and mixing them is what broke this twice.
    //
    //   `corner`  where the piece's top-left should now be on the board.
    //   `from`    where this piece's art was cut out of the picture.
    //
    // A transform is the difference between them. `drag.d` is an offset *inside* the
    // piece, so it comes off the pointer to give the corner; `from` comes off the corner
    // to give the translate. Subtracting `from` from the pointer instead — which is what
    // it did — folded the piece's own displacement into the offset and sent it flying two
    // cells for a one-cell drag.
    const cornerX = at.x - drag.dx;
    const cornerY = at.y - drag.dy;
    const from = slotXY(drag.piece);
    g.setAttribute('transform',
      `translate(${(cornerX - from.x).toFixed(2)} ${(cornerY - from.y).toFixed(2)})`);
    drag.moved = true;
  });

  function endDrag(e) {
    // One drag, one ending. See the note by the listeners: a captured pointer's `up`
    // arrives twice.
    if (!drag || (drag.pointerId !== undefined && drag.pointerId !== e.pointerId)) return;
    const { piece } = drag;
    const g = nodes[piece];
    g.classList.remove('jig-held');
    try { g.releasePointerCapture?.(e.pointerId); } catch { /* never captured */ }

    if (drag.moved) {
      // Where the piece was dropped.
      //
      // `drag.d` is how far into the piece it was grabbed, so `at - drag.d` is the
      // piece's top-left corner and adding half a cell gives its centre. The centre is
      // what decides the slot, because a piece overlapping four of them should land in
      // the one it mostly covers.
      const at = toBoard(e);
      const target = slotAt(
        at.x - drag.dx + (BOARD / cols) / 2,
        at.y - drag.dy + (boardH / rows) / 2,
      );

      if (target !== null && target !== slotOf[piece]) {
        // Swap, rather than displace. The board is then always a permutation — every
        // slot filled, every piece somewhere — so it can never reach a state with two
        // pieces stacked in one slot and a hole elsewhere, which is unfinishable and
        // looks like the game is broken rather than like a mistake was made.
        const other = slotOf.findIndex((slot) => slot === target);
        const mine = slotOf[piece];
        slotOf[piece] = target;
        if (other >= 0 && other !== piece) {
          slotOf[other] = mine;
          place(other, true);
        }
      }
    }
    place(piece, true);
    drag = null;
    onMove(arrangement());

    if (isSolved()) {
      done = true;
      svg.classList.add('jig-solved');
      onSolve(arrangement());
    }
  }

  // Bound on the SVG, and guarded inside, because a captured pointer delivers its `up` to
  // the captured element *and* it then bubbles here. Without the `pointerId` check the
  // handler ran twice: the first pass did the work and cleared `drag`, the second found
  // nothing and did nothing — and the visible result was a piece that snapped back to
  // where it started, as though the drop had been rejected.
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  // A capture that is lost without an `up` — the tab going away mid-drag, say — has to
  // put the piece down too, or it stays stuck to the pointer forever.
  svg.addEventListener('lostpointercapture', endDrag);

  host.appendChild(svg);

  return {
    node: svg,
    arrangement,
    solved: isSolved,
    /** Stop accepting drags — used when the round closes under us. */
    freeze() { done = true; svg.classList.add('jig-done'); },
    destroy() { svg.remove(); },
  };
}
