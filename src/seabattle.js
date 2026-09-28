'use strict';
// Морской бой, on the Russian rules.
//
// A ten by ten grid each. One ship of four cells, two of three, three of two and four of
// one. Ships lie straight, along a row or a column, and no two ships may touch, diagonals
// included. A shot that hits gives another shot; a shot that misses passes the turn. The
// first player to sink everything wins.
//
// The hard part of Battleship online is not the rules, it is that the whole game rests on
// neither player being able to move a ship after seeing where the other is shooting. The
// board therefore lives on the server, is validated the moment it arrives, and is never
// sent to the opponent: the view each player gets contains their own fleet and only the
// shots that have actually been fired at the other. There is nothing to peek at on the
// client, because nothing is there.

const U = require('./util');

const SIZE = 10;
// Ship lengths, largest first. Four singles, three pairs, two triples, one four.
const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const CELLS = SIZE * SIZE;

const idx = (x, y) => y * SIZE + x;
const inside = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;

/**
 * Read a fleet as sent by a client.
 *
 * Each ship is { x, y, len, dir } with dir 'h' or 'v' and (x, y) the topmost or leftmost
 * cell. Everything about it is checked here, because "the client would not send a bad
 * one" stops being true the moment there is money on the board.
 */
function parseFleet(raw) {
  if (!Array.isArray(raw) || raw.length !== FLEET.length) {
    throw new U.BadRequest(`a fleet is ${FLEET.length} ships`);
  }
  const ships = raw.map((s, i) => {
    const ship = {
      x: Number(s?.x), y: Number(s?.y), len: Number(s?.len), dir: s?.dir === 'v' ? 'v' : 'h',
    };
    if (!Number.isInteger(ship.x) || !Number.isInteger(ship.y)) {
      throw new U.BadRequest(`ship ${i + 1} is not on the grid`);
    }
    if (!Number.isInteger(ship.len) || ship.len < 1 || ship.len > 4) {
      throw new U.BadRequest(`ship ${i + 1} has an impossible length`);
    }
    return ship;
  });

  // The fleet must be exactly the right ships, not merely the right number of them.
  const lengths = ships.map((s) => s.len).sort((a, b) => b - a);
  if (lengths.join(',') !== FLEET.join(',')) {
    throw new U.BadRequest('that is not the right set of ships');
  }

  // occupied holds ship cells; blocked holds those plus every cell touching one, which is
  // what makes "ships may not touch" a single lookup rather than a special case per pair.
  const occupied = new Array(CELLS).fill(-1);
  const blocked = new Array(CELLS).fill(false);

  ships.forEach((ship, shipNo) => {
    const dx = ship.dir === 'h' ? 1 : 0;
    const dy = ship.dir === 'v' ? 1 : 0;
    for (let n = 0; n < ship.len; n += 1) {
      const x = ship.x + dx * n;
      const y = ship.y + dy * n;
      if (!inside(x, y)) throw new U.BadRequest(`ship ${shipNo + 1} hangs off the grid`);
      if (blocked[idx(x, y)]) throw new U.BadRequest('ships may not touch, not even at a corner');
      occupied[idx(x, y)] = shipNo;
    }
    // Mark the ship and its whole surround only after the ship itself has been placed, or
    // a ship would collide with its own halo.
    for (let n = 0; n < ship.len; n += 1) {
      const x = ship.x + dx * n;
      const y = ship.y + dy * n;
      for (let ay = y - 1; ay <= y + 1; ay += 1) {
        for (let ax = x - 1; ax <= x + 1; ax += 1) {
          if (inside(ax, ay)) blocked[idx(ax, ay)] = true;
        }
      }
    }
  });

  return { ships, occupied };
}

/** Cells of one ship, used to report it sunk and to shade its surround. */
function shipCells(ship) {
  const cells = [];
  const dx = ship.dir === 'h' ? 1 : 0;
  const dy = ship.dir === 'v' ? 1 : 0;
  for (let n = 0; n < ship.len; n += 1) cells.push(idx(ship.x + dx * n, ship.y + dy * n));
  return cells;
}

/** A fleet laid out at random, for the "arrange them for me" button. */
function randomFleet(random = Math.random) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const ships = [];
    const blocked = new Array(CELLS).fill(false);
    let ok = true;

    for (const len of FLEET) {
      let placed = false;
      for (let tries = 0; tries < 300 && !placed; tries += 1) {
        const dir = random() < 0.5 ? 'h' : 'v';
        const x = Math.floor(random() * (dir === 'h' ? SIZE - len + 1 : SIZE));
        const y = Math.floor(random() * (dir === 'v' ? SIZE - len + 1 : SIZE));
        const cells = shipCells({ x, y, len, dir });
        if (cells.some((c) => blocked[c])) continue;
        for (const c of cells) {
          const cx = c % SIZE;
          const cy = Math.floor(c / SIZE);
          for (let ay = cy - 1; ay <= cy + 1; ay += 1) {
            for (let ax = cx - 1; ax <= cx + 1; ax += 1) {
              if (inside(ax, ay)) blocked[idx(ax, ay)] = true;
            }
          }
        }
        ships.push({ x, y, len, dir });
        placed = true;
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return ships;
  }
  // Unreachable in practice: a ten by ten grid has room for this fleet many times over.
  throw new Error('could not arrange a fleet');
}

/**
 * Fire at one cell.
 * Returns what happened and the updated board, without deciding whose turn it is next:
 * that belongs to the caller, along with the "a hit shoots again" rule.
 */
function fire(board, cell) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) throw new U.BadRequest('not a cell');
  if (board.shots[cell]) throw new U.BadRequest('you have already fired there');

  const shipNo = board.occupied[cell];
  const shots = board.shots.slice();
  shots[cell] = shipNo >= 0 ? 'hit' : 'miss';
  const next = { ...board, shots };

  if (shipNo < 0) return { board: next, outcome: 'miss', sunk: null };

  const cells = shipCells(board.ships[shipNo]);
  const sunk = cells.every((c) => shots[c] === 'hit');
  return { board: next, outcome: sunk ? 'sunk' : 'hit', sunk: sunk ? cells : null };
}

/** How many ships are still afloat. */
const afloat = (board) => board.ships
  .filter((ship) => !shipCells(ship).every((c) => board.shots[c] === 'hit')).length;

const emptyBoard = (fleet) => ({
  ships: fleet.ships,
  occupied: fleet.occupied,
  shots: new Array(CELLS).fill(null),
});

/**
 * What one player may see of a board.
 *
 * `own` shows the fleet, because it is theirs. The opponent's board shows only the shots
 * fired at it: hits, misses, and the outline of anything already sunk. The ships that have
 * not been found are simply not in the response, so there is nothing for a modified client
 * to read.
 */
function boardView(board, own) {
  const view = { shots: board.shots, afloat: afloat(board) };
  if (own) {
    view.ships = board.ships;
  } else {
    // A sunk ship is public knowledge, so its shape may be shown.
    view.sunk = board.ships
      .filter((ship) => shipCells(ship).every((c) => board.shots[c] === 'hit'))
      .map((ship) => ({ ...ship }));
  }
  return view;
}

module.exports = {
  SIZE, FLEET, CELLS, idx, inside,
  parseFleet, randomFleet, shipCells, fire, afloat, emptyBoard, boardView,
};
