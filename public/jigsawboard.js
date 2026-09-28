// The drag-to-assemble board, with a tray for the pieces that are not down yet.
//
// WHY THE BOARD STARTS EMPTY
//
// The first version dealt every piece onto the board in the wrong slot, so solving meant
// swapping pairs until the permutation came right. That is a sliding puzzle wearing a
// jigsaw's clothes. Nobody tips a box onto a table and then shuffles pieces between
// finished positions — the board starts bare and the pieces wait beside it.
//
// It also stopped being readable at four hundred pieces. A full board of wrong pieces is
// noise, and there is nowhere to put the piece you are currently thinking about. So: the
// board is a bed of empty cuts, every piece starts in a scrolling tray, and a piece
// dropped anywhere that is not a slot goes back to the tray.
//
// WHAT THIS HAS TO GET RIGHT
//
//   - One pointerId per gesture. `pointerdown`, `pointermove` and `pointerup` must agree
//     on it or the drag is three unrelated events. This is the single most load-bearing
//     fact in the file and it cost the most to learn.
//   - Capture attempted, never relied on. `setPointerCapture` *throws* when there is no
//     live pointer with that id, and `?.` guards a missing method rather than one that
//     raises — an unwrapped call aborted `pointerdown` before the drag was ever assigned.
//     Losing capture costs a dropped piece on a fast drag; an uncaught throw costs the
//     whole board.
//   - A captured pointer delivers its `up` twice, once retargeted and once bubbling, so
//     `endDrag` is guarded by pointerId or it runs, clears the drag, and runs again on
//     nothing — which looks exactly like a rejected drop.
//   - Offset, not centre: a board piece moves by the delta from where it was grabbed, so
//     it does not jump under the finger on the first frame.
//
// One picture, many references. The image arrives as a ~170KB data URI, and an `<image>`
// per piece would be four hundred copies of that string — roughly 68MB of markup. It is
// declared once in `<defs>` and each piece is a `<use>`.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not know the answer. A piece knows the slot it was *cut from*, which the picture
// requires anyway; nothing here could tell a modified client more than the geometry
// already says. The server recomputes the finished arrangement and checks it, and the
// clock is the server's.

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

/** How far a pointer must travel before a press counts as a drag rather than a tap. */
const DRAG_SLOP = 6;

/**
 * Build a playable jigsaw.
 *
 * `onSolve(arrangement)` fires once, the moment the last piece lands. `arrangement[slot]`
 * is the piece in that slot, which is what the server checks — unchanged by the tray.
 *
 * `scramble` decides the order pieces appear in the tray. It comes from the round seed, so
 * the tray is part of the provably-fair record rather than whatever order a loop ran in.
 */
export function board(host, {
  cols, rows, scramble, cutSeed = 1, picture = null,
  onSolve = () => {}, onMove = () => {},
}) {
  const pieces = cols * rows;
  const boardH = Math.round((BOARD * rows) / cols);
  const cellW = BOARD / cols;
  const cellH = boardH / rows;
  const cut = createCut({
    cols, rows, width: BOARD, height: boardH, seed: (cutSeed || 1) * 2654435761,
  });

  // `slotOf[piece]` is the slot a piece occupies, or null while it is still in the tray.
  // The inverse is derived rather than stored, so the two cannot drift apart — which is
  // the bug class that cost this file two rounds of browser debugging.
  const slotOf = new Array(pieces).fill(null);

  const wrap = document.createElement('div');
  wrap.className = 'jig-wrap';

  // ------------------------------------------------------------------ board
  const svg = svgEl('svg', {
    // Past roughly eighty pieces the outlines dominate the picture, so the stylesheet
    // thins them. Decided here because only this knows the piece count.
    class: `jig-board${pieces > 80 ? ' dense' : ''}`,
    viewBox: `0 0 ${BOARD} ${boardH}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  const defs = svgEl('defs');
  svg.appendChild(defs);

  const ART_ID = `jigart-${cutSeed}`;
  /** The picture, or a blank plate when a round has none. Declared once per SVG root. */
  const artNode = (id) => (picture
    ? svgEl('image', {
      id,
      href: picture,
      x: 0, y: 0, width: BOARD, height: boardH,
      preserveAspectRatio: 'xMidYMid slice',
    })
    : svgEl('rect', { id, x: 0, y: 0, width: BOARD, height: boardH, class: 'jig-blank' }));

  defs.appendChild(artNode(ART_ID));

  const pathOf = (piece) => cut.path(piece % cols, Math.floor(piece / cols));
  const slotXY = (slot) => ({ x: (slot % cols) * cellW, y: Math.floor(slot / cols) * cellH });

  // The empty bed, so an unfinished board still reads as a board waiting to be filled
  // rather than as a blank rectangle.
  for (let slot = 0; slot < pieces; slot += 1) {
    svg.appendChild(svgEl('path', { d: pathOf(slot), class: 'jig-slot', 'data-slot': String(slot) }));
  }

  /** One piece on the board: clipped to its own cut, with the seam drawn over it. */
  function makePiece(piece) {
    const clipId = `jigclip-${cutSeed}-${piece}`;
    const clip = svgEl('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
    clip.appendChild(svgEl('path', { d: pathOf(piece) }));
    defs.appendChild(clip);

    const g = svgEl('g', { class: 'jig-piece', 'data-piece': String(piece) });
    const art = svgEl('g', { 'clip-path': `url(#${clipId})` });
    art.appendChild(svgEl('use', { href: `#${ART_ID}` }));
    g.appendChild(art);
    g.appendChild(svgEl('path', { d: pathOf(piece), class: 'jig-edge' }));
    return g;
  }

  const nodes = Array.from({ length: pieces }, (_, piece) => makePiece(piece));

  // ------------------------------------------------------------------- tray
  //
  // Each tray piece is its own small SVG framing one cell of the picture, rather than a
  // scaled-down copy of the whole board — four hundred little viewBoxes instead of four
  // hundred full boards.
  //
  // A tray piece cannot `<use>` the board's declaration: a `use` only reaches definitions
  // inside its own document fragment, and each of these is a separate SVG root. So each
  // carries its own reference to the same data URI string, which the browser decodes once.
  const tray = document.createElement('div');
  tray.className = 'jig-tray';
  // How big a tray piece should be, which the stylesheet cannot work out for itself
  // because only this knows how many there are.
  //
  // A fixed size fails at both ends: 60px is right for thirty-six pieces and gives four
  // hundred a tray a hundred and thirty rows deep, which is not a tray, it is a corridor.
  // So it shrinks with the count, and stops at 26px — below that a piece is a coloured
  // speck you cannot recognise, let alone aim at, and the tap-to-place gesture is the
  // only sane way to play anyway.
  const trayPx = Math.max(26, Math.round(300 / Math.sqrt(pieces)));
  tray.style.setProperty('--jig-tray-px', `${trayPx}px`);

  // ONE SVG FOR THE WHOLE TRAY, and this is not a detail.
  //
  // The obvious build — a small `<svg>` per tray piece — was written first and measured at
  // **65MB of markup for a 400-piece board**. Each root carried its own `<image href=...>`
  // holding the same ~170KB data URI, so the picture was in the document four hundred
  // times. That is the exact bug the board already avoids with a single `<defs>`, quietly
  // reintroduced in the tray.
  //
  // A `<use>` cannot reach a definition in a different SVG root, so the tray cannot borrow
  // the board's. Instead the tray is *itself* one root: the picture is declared once more
  // (twice in the document, not four hundred and one times) and every piece is a `<use>`
  // inside it, laid out on a grid by a transform.
  //
  // The cost of that is layout: an SVG grid does not reflow like a CSS grid, so the number
  // of columns is computed here and the tray is re-laid out when its width changes.
  const TRAY_PAD = Math.min(cellW, cellH) * 0.34;   // room for the tabs, which overhang
  const TRAY_W = cellW + TRAY_PAD * 2;
  const TRAY_H = cellH + TRAY_PAD * 2;

  const traySvg = svgEl('svg', { class: 'jig-tray-art', preserveAspectRatio: 'xMinYMin meet' });
  const trayDefs = svgEl('defs');
  const TRAY_ART = `${ART_ID}-tray`;
  trayDefs.appendChild(artNode(TRAY_ART));
  traySvg.appendChild(trayDefs);
  tray.appendChild(traySvg);

  /**
   * One piece in the tray: a group holding a clipped `<use>` of the shared picture, moved
   * into its grid cell by a transform.
   *
   * Its clip path lives in this root's own `<defs>`, which is why the board's clips cannot
   * simply be reused — same reason, same rule.
   */
  function trayCell(piece) {
    const clipId = `jigtrayclip-${cutSeed}-${piece}`;
    const clip = svgEl('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
    clip.appendChild(svgEl('path', { d: pathOf(piece) }));
    trayDefs.appendChild(clip);

    const g = svgEl('g', { class: 'jig-tray-piece', 'data-piece': String(piece) });
    const art = svgEl('g', { 'clip-path': `url(#${clipId})` });
    art.appendChild(svgEl('use', { href: `#${TRAY_ART}` }));
    g.appendChild(art);
    g.appendChild(svgEl('path', { d: pathOf(piece), class: 'jig-edge' }));
    return g;
  }

  const trayNodes = new Map();
  /** Tray order: the scramble, so two players given the same seed see the same tray. */
  let trayOrder = [];

  /**
   * Put every tray piece on a grid and size the root to match.
   *
   * A piece sits at its own cut coordinates, so moving it into a grid cell is the
   * difference between the two — the same "translate by the delta" the board uses, which
   * is what keeps the clip path and the art in register.
   */
  function layoutTray() {
    // The column count has to be worked out in the units the SVG is finally sized in, or
    // it disagrees with itself by the padding. Measured across every plausible tray width,
    // the naive version overflowed by 2px at exactly one of them — which is the kind of
    // thing that is invisible until it is a horizontal scrollbar on somebody's tablet.
    const unit = trayPx / cellW;                 // screen px per board unit
    const frame = TRAY_PAD * 2 * unit;           // the tabs' overhang, in screen px
    const avail = Math.max(trayPx, tray.clientWidth - 18 - frame);
    const cols_ = Math.max(1, Math.floor(avail / trayPx));
    const rows_ = Math.ceil(trayOrder.length / cols_) || 1;

    // The grid pitch is the CELL, not the padded frame. Spacing by the frame instead was
    // the first attempt and it overlapped every piece by the pad on each side, because the
    // pad is overhang for the tabs — it is meant to be shared with the neighbour, exactly
    // as the tabs themselves are.
    traySvg.setAttribute('viewBox', `0 0 ${cols_ * cellW + TRAY_PAD * 2} ${rows_ * cellH + TRAY_PAD * 2}`);
    // One board unit is `trayPx / cellW` screen pixels, and the root is sized in screen
    // pixels so the browser scales the viewBox to exactly that. Mixing the two units is
    // what made a 1176-unit viewBox render 210px wide with everything on top of itself.
    traySvg.setAttribute('width', Math.round((cols_ * cellW + TRAY_PAD * 2) * unit));
    traySvg.setAttribute('height', Math.round((rows_ * cellH + TRAY_PAD * 2) * unit));

    trayOrder.forEach((piece, i) => {
      const node = trayNodes.get(piece);
      if (!node) return;
      const from = slotXY(piece);
      const x = (i % cols_) * cellW + TRAY_PAD - from.x;
      const y = Math.floor(i / cols_) * cellH + TRAY_PAD - from.y;
      node.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    });
  }

  function addToTray(piece) {
    let node = trayNodes.get(piece);
    if (!node) {
      node = trayCell(piece);
      trayNodes.set(piece, node);
    }
    traySvg.appendChild(node);
    if (!trayOrder.includes(piece)) trayOrder.push(piece);
    layoutTray();
  }

  function removeFromTray(piece) {
    trayNodes.get(piece)?.remove();
    trayOrder = trayOrder.filter((p) => p !== piece);
    layoutTray();
  }

  // Seeded in one pass: `addToTray` lays the grid out on every call, and doing that a
  // hundred times on startup is a hundred full re-layouts for one final answer.
  trayOrder = [...scramble];
  for (const piece of trayOrder) {
    const node = trayCell(piece);
    trayNodes.set(piece, node);
    traySvg.appendChild(node);
  }

  wrap.appendChild(svg);
  wrap.appendChild(tray);
  host.appendChild(wrap);

  // Laid out only once the tray is in the document: the number of columns comes from its
  // measured width, and an element that is not in the document has no width. Doing this
  // before the append put every piece at the origin, stacked in a heap.
  layoutTray();

  // An SVG grid does not reflow by itself, so a resized tray — a rotated phone, a dragged
  // window — has to be told. Observed rather than bound to `window.resize`, because the
  // tray also changes width when the layout breaks from two columns to one at 900px,
  // which fires no resize event of its own.
  const trayResize = new ResizeObserver(() => layoutTray());
  trayResize.observe(tray);

  // --------------------------------------------------------------- the model
  const isSolved = () => slotOf.every((slot, piece) => slot === piece);

  /** slotOf is piece -> slot; the server wants slot -> piece. */
  function arrangement() {
    const out = new Array(pieces).fill(null);
    slotOf.forEach((slot, piece) => { if (slot !== null) out[slot] = piece; });
    return out;
  }

  const placedCount = () => slotOf.reduce((n, slot) => n + (slot === null ? 0 : 1), 0);

  /** Draw a placed piece at its slot, as an offset from where it was cut. */
  function place(piece, animate = false) {
    const slot = slotOf[piece];
    if (slot === null) return;
    const g = nodes[piece];
    const from = slotXY(piece);
    const to = slotXY(slot);
    g.classList.toggle('jig-settling', animate);
    g.setAttribute('transform',
      `translate(${(to.x - from.x).toFixed(2)} ${(to.y - from.y).toFixed(2)})`);
    // A piece in its own slot is finished; anything else is merely somewhere.
    g.classList.toggle('jig-home', slot === piece);
    if (animate) setTimeout(() => g.classList.remove('jig-settling'), 180);
  }

  let done = false;

  function settled() {
    onMove(arrangement(), placedCount(), pieces);
    if (!done && isSolved()) {
      done = true;
      svg.classList.add('jig-solved');
      onSolve(arrangement());
    }
  }

  /** Send a piece back to the tray. Safe to call on a piece already there. */
  function returnToTray(piece) {
    if (slotOf[piece] === null) return;
    slotOf[piece] = null;
    nodes[piece].remove();
    nodes[piece].removeAttribute('transform');
    addToTray(piece);
  }

  /**
   * Put a piece into a slot. Whatever was there goes back to the tray rather than being
   * swapped — placing is the gesture, and a swap would silently move a piece the player
   * never touched.
   */
  function putOnBoard(piece, slot) {
    const evicted = slotOf.findIndex((s) => s === slot);
    if (evicted >= 0 && evicted !== piece) returnToTray(evicted);
    if (slotOf[piece] === null) {
      trayNodes.get(piece)?.remove();
      trayNodes.delete(piece);
    }
    slotOf[piece] = slot;
    svg.appendChild(nodes[piece]);   // topmost, so a just-placed piece is never buried
    place(piece, true);
  }

  // ------------------------------------------------------------------ drag
  let drag = null;

  /** Board coordinates for a pointer, through the SVG's own letterboxed transform. */
  function toBoard(e) {
    const r = svg.getBoundingClientRect();
    // xMidYMid meet: the scale is the smaller of the two and the drawing is centred in
    // whatever is left over.
    const scale = Math.min(r.width / BOARD, r.height / boardH);
    const ox = (r.width - BOARD * scale) / 2;
    const oy = (r.height - boardH * scale) / 2;
    return {
      x: (e.clientX - r.left - ox) / scale,
      y: (e.clientY - r.top - oy) / scale,
      over: e.clientX >= r.left && e.clientX <= r.right
        && e.clientY >= r.top && e.clientY <= r.bottom,
      scale,
    };
  }

  const slotAt = (x, y) => {
    const c = Math.floor(x / cellW);
    const r = Math.floor(y / cellH);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return null;
    return r * cols + c;
  };

  /**
   * The floating copy that follows the pointer while a tray piece is being dragged.
   *
   * It has to be its own SVG root — it lives on `document.body`, outside the tray's
   * overflow, and a `<g>` cannot be a document child. That means one more copy of the
   * picture, which is acceptable at exactly one: the ghost exists only while a finger is
   * down, and it is removed the moment the drag ends.
   */
  function makeGhost(piece, size) {
    const { x, y } = slotXY(piece);
    const root = svgEl('svg', {
      class: 'jig-ghost',
      viewBox: `${x - TRAY_PAD} ${y - TRAY_PAD} ${TRAY_W} ${TRAY_H}`,
      width: size,
      height: size,
      preserveAspectRatio: 'xMidYMid meet',
    });
    const gd = svgEl('defs');
    const artId = `${ART_ID}-ghost`;
    const clipId = `${ART_ID}-ghostclip`;
    const clip = svgEl('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
    clip.appendChild(svgEl('path', { d: pathOf(piece) }));
    gd.appendChild(clip);
    gd.appendChild(artNode(artId));
    root.appendChild(gd);

    const art = svgEl('g', { 'clip-path': `url(#${clipId})` });
    art.appendChild(svgEl('use', { href: `#${artId}` }));
    root.appendChild(art);
    root.appendChild(svgEl('path', { d: pathOf(piece), class: 'jig-edge' }));
    document.body.appendChild(root);
    return root;
  }

  function moveGhost(e) {
    const { ghost, ghostSize } = drag;
    if (!ghost) return;
    ghost.style.setProperty('left', `${e.clientX - ghostSize / 2}px`);
    ghost.style.setProperty('top', `${e.clientY - ghostSize / 2}px`);
  }

  function onDown(e) {
    if (done || drag) return;
    const fromTray = e.target.closest?.('.jig-tray-piece');
    const onBoard = fromTray ? null : e.target.closest?.('.jig-piece');
    const holder = fromTray || onBoard;
    if (!holder) return;

    const piece = Number(holder.dataset.piece);
    const at = toBoard(e);
    drag = {
      piece,
      pointerId: e.pointerId,
      fromTray: !!fromTray,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      ghost: null,
      // A tray piece is dragged as a floating copy sized to the board's cells, so it does
      // not change size the moment it crosses onto the board.
      ghostSize: Math.max(20, cellW * at.scale),
      // How far into the piece it was grabbed. Only meaningful for a board piece; for a
      // tray piece the pointer holds the centre of the ghost.
      dx: 0,
      dy: 0,
    };
    if (!fromTray) {
      const to = slotXY(slotOf[piece]);
      drag.dx = at.x - to.x;
      drag.dy = at.y - to.y;
      nodes[piece].classList.add('jig-held');
      svg.appendChild(nodes[piece]);
    }
    // Attempted, not required: this throws when there is no live pointer with that id.
    try { holder.setPointerCapture?.(e.pointerId); } catch { /* no live pointer */ }
    e.preventDefault();
  }

  function onMovePointer(e) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.moved) {
      const far = Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY);
      if (far < DRAG_SLOP) return;   // still a tap, as far as anyone knows
      drag.moved = true;
      if (drag.fromTray) {
        drag.ghost = makeGhost(drag.piece, drag.ghostSize);
        trayNodes.get(drag.piece)?.classList.add('jig-lifted');
      }
    }
    if (drag.fromTray) { moveGhost(e); return; }

    // Two origins meet here, and mixing them broke this twice. `drag.d` is an offset
    // *inside* the piece, so it comes off the pointer to give the corner; `from` is where
    // the piece's art was cut out of the picture, and comes off the corner to give the
    // translate.
    const at = toBoard(e);
    const from = slotXY(drag.piece);
    nodes[drag.piece].setAttribute('transform',
      `translate(${(at.x - drag.dx - from.x).toFixed(2)} ${(at.y - drag.dy - from.y).toFixed(2)})`);
  }

  function endDrag(e) {
    // One drag, one ending: a captured pointer's `up` arrives twice.
    if (!drag || drag.pointerId !== e.pointerId) return;
    const { piece, fromTray, moved, ghost, dx, dy } = drag;
    drag = null;

    ghost?.remove();
    trayNodes.get(piece)?.classList.remove('jig-lifted');
    nodes[piece].classList.remove('jig-held');
    try { e.target.releasePointerCapture?.(e.pointerId); } catch { /* never captured */ }

    if (!moved) {
      // A tap. From the tray it sends the piece straight to its own slot, which is the
      // whole game on a phone where a 400-piece board gives you 16px to aim at. From the
      // board it picks the piece back up into the tray, so a misplacement is undoable
      // without a drag.
      if (fromTray) putOnBoard(piece, piece);
      else returnToTray(piece);
      settled();
      return;
    }

    const at = toBoard(e);
    if (!at.over) {
      // Dropped off the board — back to the tray, which is also how you deliberately take
      // a piece out again.
      if (!fromTray) returnToTray(piece);
      settled();
      return;
    }

    // The centre decides the slot: a piece overlapping four of them should land in the one
    // it mostly covers. A tray ghost is held by its centre; a board piece carries the grab
    // offset, so its corner is `at - d` and its centre half a cell further.
    const cx = fromTray ? at.x : at.x - dx + cellW / 2;
    const cy = fromTray ? at.y : at.y - dy + cellH / 2;
    const target = slotAt(cx, cy);

    if (target === null) {
      if (!fromTray) returnToTray(piece);
    } else {
      putOnBoard(piece, target);
    }
    settled();
  }

  // Bound on the wrapper so the tray and the board share one gesture: a drag that starts
  // in the tray and ends on the board is one sequence of events, not two.
  wrap.addEventListener('pointerdown', onDown);
  wrap.addEventListener('pointermove', onMovePointer);
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);
  // A capture lost without an `up` — the tab going away mid-drag — still has to put the
  // piece down, or it stays stuck to the pointer forever.
  wrap.addEventListener('lostpointercapture', endDrag);
  // A drag released outside the wrapper never reaches the handlers above, and the piece
  // would hang. The window sees it regardless.
  window.addEventListener('pointerup', endDrag);

  settled();

  return {
    node: svg,
    tray,
    arrangement,
    placed: placedCount,
    remaining: () => pieces - placedCount(),
    solved: isSolved,
    /** Stop accepting drags — used when the round closes under us. */
    freeze() { done = true; svg.classList.add('jig-done'); },
    destroy() {
      window.removeEventListener('pointerup', endDrag);
      trayResize.disconnect();
      wrap.remove();
    },
  };
}
