// Tron: the rules, and only the rules.
//
// Three things ride on this file: the arcade cabinet (games/tron.js), the staked match on
// the server (src/tron.js, which loads it with require — Node takes an ES module that way
// as long as it has no top-level await), and the match board in the browser, which
// predicts the race between server updates. That is why there is exactly one copy of the
// collision rule and why this module imports nothing: a rule that lives in two places is
// two rules on the day one of them is fixed.
//
// The grid is integer. Every rider advances one cell per tick, all of them at once, and a
// heading change applies at the *next* tick, never mid-cell. So a race is a pure function
// of (seed, riders, the list of turns and the ticks they took effect) — which is what lets
// the server replay a race it never ran a timer for, and what lets a board rebuild the
// same race from the same inputs and agree with it to the cell.

export const COLS = 96;
export const ROWS = 64;

/** Headings, clockwise, so a left turn is index minus one. */
export const HEADINGS = ['n', 'e', 's', 'w'];
const DX = { n: 0, e: 1, s: 0, w: -1 };
const DY = { n: -1, e: 0, s: 1, w: 0 };
export const OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e' };

/** The Legacy palette: cyan first, because the player is seat 0. */
export const COLOURS = ['#4fd8ff', '#ff9a3c', '#c07bff', '#7dff8e'];

export const MIN_RIDERS = 2;
export const MAX_RIDERS = 4;

/** xorshift32, the generator every cabinet uses: one seed is one race. */
export function rng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

export const turnLeft = (h) => HEADINGS[(HEADINGS.indexOf(h) + 3) % 4];
export const turnRight = (h) => HEADINGS[(HEADINGS.indexOf(h) + 1) % 4];

/**
 * Where riders start: spread along the middle, facing in, with room on every side. Two
 * ride at each other from the left and right thirds; three and four take the quarters.
 */
function starts(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const x = Math.round(COLS * (i + 1) / (n + 1));
    const y = Math.round(ROWS / 2 + (i % 2 === 0 ? -ROWS / 6 : ROWS / 6));
    out.push({ x, y, h: i % 2 === 0 ? 's' : 'n' });
  }
  return out;
}

/** A fresh race. `grid` holds 0 for empty and seat + 1 for a wall. */
export function create(n = 2) {
  const riders = Math.max(MIN_RIDERS, Math.min(MAX_RIDERS, n | 0));
  const grid = new Uint8Array(COLS * ROWS);
  const list = starts(riders).map((s, seat) => {
    grid[s.y * COLS + s.x] = seat + 1;
    return { seat, x: s.x, y: s.y, h: s.h, next: s.h, alive: true, path: [[s.x, s.y]], crashedAt: null };
  });
  return { n: riders, grid, riders: list, tick: 0, alive: riders, over: false, winners: null };
}

const inside = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS;
const at = (sim, x, y) => (inside(x, y) ? sim.grid[y * COLS + x] : 255);

/**
 * Ask for a heading. Refused — and false returned — when the rider is out, when the
 * heading is not one of the four, or when it is straight back into the rider's own trail,
 * which is not a turn but a way of ending the race. Takes effect at the next tick.
 */
export function setHeading(sim, seat, h) {
  const r = sim.riders[seat];
  if (!r || !r.alive || !HEADINGS.includes(h)) return false;
  if (h === OPPOSITE[r.h]) return false;
  r.next = h;
  return true;
}

/**
 * One tick: every live rider moves one cell at once. A rider whose cell is a wall, the
 * edge, or the cell another rider is entering this same tick crashes; two riders entering
 * one cell crash together, which is the head-on draw. Returns the seats that crashed.
 */
export function step(sim) {
  if (sim.over) return [];
  const moving = sim.riders.filter((r) => r.alive);
  const targets = new Map();
  for (const r of moving) {
    r.h = r.next;
    const x = r.x + DX[r.h];
    const y = r.y + DY[r.h];
    r.to = { x, y };
    const key = inside(x, y) ? y * COLS + x : -1 - r.seat;
    targets.set(key, (targets.get(key) || 0) + 1);
  }
  const crashed = [];
  for (const r of moving) {
    const { x, y } = r.to;
    const key = y * COLS + x;
    if (at(sim, x, y) !== 0 || targets.get(key) > 1) {
      r.alive = false;
      r.crashedAt = sim.tick + 1;
      crashed.push(r.seat);
    }
  }
  for (const r of moving) {
    if (!r.alive) continue;
    r.x = r.to.x;
    r.y = r.to.y;
    sim.grid[r.y * COLS + r.x] = r.seat + 1;
    // The path is the list of corners plus the head, which is what the board strokes.
    const last = r.path[r.path.length - 1];
    const prev = r.path[r.path.length - 2];
    if (prev && ((prev[0] === last[0] && last[0] === r.x) || (prev[1] === last[1] && last[1] === r.y))) {
      last[0] = r.x; last[1] = r.y;
    } else {
      r.path.push([r.x, r.y]);
    }
  }
  for (const r of moving) delete r.to;
  sim.tick += 1;
  sim.alive -= crashed.length;
  if (sim.alive <= 1) {
    sim.over = true;
    // One left is a win. None left is a draw between those who went down together.
    sim.winners = sim.alive === 1
      ? sim.riders.filter((r) => r.alive).map((r) => r.seat)
      : crashed.slice();
  }
  return crashed;
}

/** Whether a cell is free to ride into. */
export const free = (sim, x, y) => at(sim, x, y) === 0;

/**
 * How much room lies beyond a cell: a flood fill over empty cells, capped, because the
 * bot only needs to tell a pocket from the open field and not measure either exactly.
 */
export function room(sim, x, y, cap = 400) {
  if (!free(sim, x, y)) return 0;
  const seen = new Set([y * COLS + x]);
  const queue = [[x, y]];
  let count = 0;
  while (queue.length && count < cap) {
    const [cx, cy] = queue.shift();
    count += 1;
    for (const h of HEADINGS) {
      const nx = cx + DX[h];
      const ny = cy + DY[h];
      const key = ny * COLS + nx;
      if (!free(sim, nx, ny) || seen.has(key)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return count;
}

/**
 * The classic bot. It rides straight until a wall is within `lookahead` cells, then
 * turns toward whichever side has more room. A small random turn, only ever into a free
 * cell, stops two bots mirroring each other into a stalemate; the depth of the lookahead
 * is the whole difficulty setting.
 */
export function botHeading(sim, seat, random, lookahead = 6) {
  const r = sim.riders[seat];
  if (!r || !r.alive) return null;
  const ahead = (h, k) => ({ x: r.x + DX[h] * k, y: r.y + DY[h] * k });
  let clear = 0;
  for (let k = 1; k <= lookahead; k += 1) {
    const c = ahead(r.h, k);
    if (!free(sim, c.x, c.y)) break;
    clear += 1;
  }
  const left = turnLeft(r.h);
  const right = turnRight(r.h);
  const l = ahead(left, 1);
  const rt = ahead(right, 1);
  const leftRoom = room(sim, l.x, l.y);
  const rightRoom = room(sim, rt.x, rt.y);

  if (clear < lookahead) {
    if (leftRoom === 0 && rightRoom === 0) return r.h;         // nowhere: ride it out
    if (leftRoom === rightRoom) return random() < 0.5 ? left : right;
    return leftRoom > rightRoom ? left : right;
  }
  // The field is open. Now and then, turn anyway, but only where a turn is safe.
  if (random() < 0.03) {
    const options = [];
    if (leftRoom > lookahead) options.push(left);
    if (rightRoom > lookahead) options.push(right);
    if (options.length) return options[Math.floor(random() * options.length)];
  }
  return r.h;
}

/**
 * The server's way in: rebuild a race from its inputs. `turns` is a list of
 * { t, seat, h } — the tick at which the heading takes effect. Runs to `upto` ticks or to
 * the end of the race, whichever comes first, and returns the sim at that point.
 */
export function replay(n, turns, upto) {
  const sim = create(n);
  const sorted = turns.slice().sort((a, b) => a.t - b.t);
  let i = 0;
  while (sim.tick < upto && !sim.over) {
    // Everything scheduled for the tick about to be stepped is applied first.
    while (i < sorted.length && sorted[i].t <= sim.tick + 1) {
      setHeading(sim, sorted[i].seat, sorted[i].h);
      i += 1;
    }
    step(sim);
  }
  return sim;
}
