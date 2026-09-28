// A chess board.
//
// It draws a position and collects an intention. It does not know the rules: the legal
// move list arrives from the server with every position, and this file will not offer a
// move that is not on that list. Teaching the board the rules would mean two rules engines
// that have to agree, and when a stake rides on the game, the one that matters is the one
// on the server.
//
// Pieces are Unicode glyphs rather than images, for the same reason everything else here
// is drawn rather than downloaded: the page runs under a Content-Security-Policy that
// forbids remote media.

const GLYPHS = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

const FILES = 'abcdefgh';
const squareName = (file, rank) => `${FILES[file]}${8 - rank}`;

/** Just the piece placement: the board never needs the rest of a FEN. */
function readBoard(fen) {
  const rows = String(fen).split(' ')[0].split('/');
  const board = new Array(64).fill(null);
  for (let rank = 0; rank < 8 && rank < rows.length; rank += 1) {
    let file = 0;
    for (const ch of rows[rank]) {
      if (ch >= '1' && ch <= '8') file += Number(ch);
      else if (file < 8) { board[rank * 8 + file] = ch; file += 1; }
    }
  }
  return board;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * Draw a position into `host` and return a handle.
 *
 * Every board in the match room takes the same four things: the view the server sent, the
 * seat the viewer occupies, whether it is their turn, and a callback that sends one action
 * back. Keeping the shape identical is what lets the match screen treat chess and Морской
 * бой as the same thing.
 *
 * `view.legal` is the list of moves the server will accept, and this board will not offer
 * anything outside it.
 */
export function board(host, opts = {}) {
  const read = (o) => ({
    fen: o.view?.fen || '',
    legal: o.myTurn ? (o.view?.legal || []) : [],
    orientation: o.seat && o.view?.white === o.seat ? 'w' : (o.seat ? 'b' : 'w'),
    interactive: !!o.myTurn,
  });

  const state = {
    ...read(opts),
    lastMove: null,
    onMove: (move) => (opts.onAct || (() => {}))({ move }),
    selected: null,
    pending: null, // a promotion waiting for the player to choose a piece
  };

  const grid = el('div', 'chessboard');
  host.replaceChildren(grid);

  /** Moves from a square, as [target, promotion] pairs. */
  const movesFrom = (from) => state.legal
    .filter((m) => m.slice(0, 2) === from)
    .map((m) => [m.slice(2, 4), m.slice(4) || null]);

  function choosePromotion(from, to) {
    state.pending = { from, to };
    draw();
  }

  function pick(square) {
    if (!state.interactive) return;

    if (state.selected) {
      const options = movesFrom(state.selected).filter(([target]) => target === square);
      if (options.length > 1) {
        // Every promotion shares a from and a to, so the piece has to be asked for.
        const from = state.selected;
        state.selected = null;
        choosePromotion(from, square);
        return;
      }
      if (options.length === 1) {
        const move = state.selected + square + (options[0][1] || '');
        state.selected = null;
        draw();
        state.onMove(move);
        return;
      }
    }
    // Selecting a square with no move from it clears rather than sticks.
    state.selected = movesFrom(square).length ? square : null;
    draw();
  }

  function draw() {
    const pieces = readBoard(state.fen);
    const targets = new Set(state.selected ? movesFrom(state.selected).map(([t]) => t) : []);
    const flipped = state.orientation === 'b';
    grid.replaceChildren();
    grid.classList.toggle('flipped', flipped);

    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const rank = flipped ? 7 - row : row;
        const file = flipped ? 7 - col : col;
        const name = squareName(file, rank);
        const piece = pieces[rank * 8 + file];

        const cell = el('div', `sq ${(file + rank) % 2 ? 'dark' : 'light'}`);
        cell.dataset.square = name;
        if (state.selected === name) cell.classList.add('selected');
        if (targets.has(name)) cell.classList.add(piece ? 'capture' : 'target');
        if (state.lastMove && (state.lastMove.slice(0, 2) === name
          || state.lastMove.slice(2, 4) === name)) cell.classList.add('last');

        if (piece) {
          const glyph = el('span', `pc ${piece === piece.toUpperCase() ? 'white' : 'black'}`, GLYPHS[piece]);
          cell.append(glyph);
        }
        // Coordinates on the outer edges only, the way a printed diagram does it.
        if (col === 0) cell.append(el('i', 'rank', String(8 - rank)));
        if (row === 7) cell.append(el('i', 'file', FILES[file]));

        if (state.interactive) cell.onclick = () => pick(name);
        grid.append(cell);
      }
    }

    if (state.pending) {
      const white = state.orientation === 'w';
      const picker = el('div', 'promo');
      for (const p of ['q', 'r', 'b', 'n']) {
        const btn = el('button', 'pc', GLYPHS[white ? p.toUpperCase() : p]);
        btn.onclick = () => {
          const move = state.pending.from + state.pending.to + p;
          state.pending = null;
          draw();
          state.onMove(move);
        };
        picker.append(btn);
      }
      const cancel = el('button', 'promo-cancel', '×');
      cancel.onclick = () => { state.pending = null; draw(); };
      picker.append(cancel);
      grid.append(picker);
    }
  }

  draw();

  return {
    /** Show a new position. Clears any half-made move, which is no longer meaningful. */
    update(next) {
      Object.assign(state, read({ ...opts, ...next }));
      state.selected = null;
      state.pending = null;
      draw();
    },
    get element() { return grid; },
  };
}

export const meta = { key: 'chess' };
