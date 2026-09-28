'use strict';
// Балда.
//
// A five by five grid with a five-letter noun across the middle. On your turn you add one
// letter to an empty square that touches a filled one, then claim a word that runs through
// the square you just filled. The word is a path of orthogonally adjacent squares that
// never reuses a square, it has to be in the dictionary, and it has to be one nobody has
// claimed yet in this game. You score its length. When the grid fills, or both players
// pass in a row, the higher score wins.
//
// The interesting part for a staked game is the path. A player sends a word; the server
// finds a path for it, or refuses. Asking the client to send the path instead would be
// easier here and worse there: the client would then be the thing deciding what counts as
// a word on the board, and it is not a thing that can be trusted with that.
//
// The search is a depth-first walk from every square holding the first letter. Twenty-five
// squares and words of a dozen letters make it small enough to do on every move without
// anyone noticing.

const U = require('./util');
const words = require('./words-ru');

const SIZE = 5;
const CELLS = SIZE * SIZE;

const idx = (x, y) => y * SIZE + x;
const xOf = (cell) => cell % SIZE;
const yOf = (cell) => Math.floor(cell / SIZE);

/** The four orthogonal neighbours of a square. Diagonals are not adjacency in Балда. */
function neighbours(cell) {
  const x = xOf(cell);
  const y = yOf(cell);
  const out = [];
  if (x > 0) out.push(idx(x - 1, y));
  if (x < SIZE - 1) out.push(idx(x + 1, y));
  if (y > 0) out.push(idx(x, y - 1));
  if (y < SIZE - 1) out.push(idx(x, y + 1));
  return out;
}

/** An empty grid with `word` laid across the middle row. */
function startGrid(word) {
  const letters = words.normalise(word);
  if (letters.length !== SIZE) throw new Error(`the opening word must be ${SIZE} letters`);
  const grid = new Array(CELLS).fill(null);
  const row = Math.floor(SIZE / 2);
  for (let x = 0; x < SIZE; x += 1) grid[idx(x, row)] = letters[x];
  return grid;
}

/** Squares that may be written to: empty, and touching something that is not. */
function playable(grid) {
  const out = [];
  for (let cell = 0; cell < CELLS; cell += 1) {
    if (grid[cell] !== null) continue;
    if (neighbours(cell).some((n) => grid[n] !== null)) out.push(cell);
  }
  return out;
}

/**
 * Find a path spelling `word` that passes through `mustInclude`.
 * Returns the path as a list of squares, or null. The first path found is as good as any:
 * the score depends on the word, not on the route.
 */
function findPath(grid, word, mustInclude) {
  const letters = words.normalise(word);
  if (!letters.length) return null;

  const seen = new Array(CELLS).fill(false);
  const path = [];

  const walk = (cell, at) => {
    if (grid[cell] !== letters[at] || seen[cell]) return false;
    seen[cell] = true;
    path.push(cell);
    if (at === letters.length - 1) {
      if (mustInclude === undefined || path.includes(mustInclude)) return true;
    } else {
      for (const next of neighbours(cell)) if (walk(next, at + 1)) return true;
    }
    seen[cell] = false;
    path.pop();
    return false;
  };

  for (let cell = 0; cell < CELLS; cell += 1) {
    if (walk(cell, 0)) return path.slice();
  }
  return null;
}

/** Is there any legal move left? Used to decide whether a pass is the only option. */
function gridFull(grid) {
  return grid.every((c) => c !== null);
}

/**
 * Play one move.
 *
 * `letter` goes into `cell`, then `word` must be findable through that square. Nothing is
 * changed unless the whole move is good, so a refused move leaves the board untouched.
 */
function play(state, dictionary, { cell, letter, word }) {
  const at = Number(cell);
  if (!Number.isInteger(at) || at < 0 || at >= CELLS) throw new U.BadRequest('not a square');
  if (state.grid[at] !== null) throw new U.BadRequest('that square is taken');
  if (!neighbours(at).some((n) => state.grid[n] !== null)) {
    throw new U.BadRequest('a letter must touch one already on the board');
  }

  const ch = words.normalise(letter);
  if (ch.length !== 1 || !/^[а-я]$/.test(ch)) throw new U.BadRequest('one Russian letter, please');

  const claimed = words.normalise(word);
  if (claimed.length < 2) throw new U.BadRequest('a word is at least two letters');
  if (!dictionary.has(claimed)) throw new U.BadRequest(`"${claimed}" is not in the dictionary`);
  if (state.used.includes(claimed)) throw new U.BadRequest('that word has already been played');

  const grid = state.grid.slice();
  grid[at] = ch;
  const path = findPath(grid, claimed, at);
  if (!path) throw new U.BadRequest(`"${claimed}" does not run through the letter you added`);

  return { grid, path, word: claimed, score: claimed.length };
}

/** Every word the dictionary holds that could be played right now, for a hint or a bot. */
function suggestions(grid, dictionary, limit = 5) {
  const out = [];
  const spots = playable(grid);
  for (const word of dictionary) {
    if (out.length >= limit) break;
    if (word.length < 3) continue;
    for (const cell of spots) {
      let found = null;
      for (const letter of new Set(word)) {
        const trial = grid.slice();
        trial[cell] = letter;
        const path = findPath(trial, word, cell);
        if (path) { found = { word, cell, letter, path }; break; }
      }
      if (found) { out.push(found); break; }
    }
  }
  return out;
}

module.exports = {
  SIZE, CELLS, idx, xOf, yOf, neighbours,
  startGrid, playable, findPath, gridFull, play, suggestions,
};
