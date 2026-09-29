// Русская пирамида: the table, the physics and the rules, in millimetres.
//
// WHY MILLIMETRES
//
// A real Russian table is the reason the game feels the way it does: twelve feet of
// cloth, 3550 by 1775 between the cushions; balls of 68 mm; corner pockets of 73 mm and
// middle pockets of 83 mm — a pocket barely wider than the ball, so a shot that would
// drop on a pool table rattles in the jaws here. Everything below is in those units, and
// the two renderers scale them: billiards.js draws the cloth flat when there is no WebGL,
// billiards3d.js draws the table when there is. This file imports nothing and touches no
// canvas, so a test can hold every rule in it.
//
// THE POCKETS ARE JAWS, NOT CIRCLES
//
// The cushions stop short of each pocket, and the gap between two cushion ends is the
// mouth. A ball is pocketed when its centre passes the cushion line inside a gap, and
// nothing else: to get there it has to fit between the two noses, each of which is a
// point the ball bounces off. A corner mouth of 73 mm against a 68 mm ball leaves five
// millimetres, which is exactly why a Russian pocket takes a ball driven into it and
// spits out one that arrives at an angle.
//
// THE RULES (the classic pyramid)
//
//   - Sixteen balls: fifteen white object balls racked in a pyramid on the foot spot, and
//     the coloured cue ball, the биток, in the house. Only the cue ball may be struck.
//   - Any object ball pocketed counts one for the shooter. A свояк — the cue ball
//     pocketed after it touched an object ball — counts one too: the shooter takes an
//     object ball off the table, and the cue ball goes back to the house.
//   - A foul is the cue ball touching no ball, or dropping without touching one. For each
//     foul the opponent takes a ball off the table and counts it, and the turn passes.
//   - A shooter who counted a ball shoots again; one who did not hands the cue over.
//   - The first to eight of the fifteen wins.
//
// Seat 0 is the player and seat 1 the machine, whose shots come from botShot().

export const L = 3550;             // the playing field, cushion to cushion
export const W = 1775;
export const R = 34;               // a 68 mm ball
export const CORNER_MOUTH = 73;
export const MIDDLE_MOUTH = 83;
export const TARGET = 8;
export const MAX_POWER = 7000;     // mm/s off the cue at full power
export const SUBSTEPS = 8;         // 7000 mm/s at 60 fps is 117 mm a frame; a ball is 68
const FRICTION = 1.0;              // per second, exponential: full power runs two tables
const STOP_BELOW = 15;             // mm/s: below this a ball is simply stopped
const BALL_BOUNCE = 0.96;          // heavy phenolic balls lose little to each other
const CUSHION_BOUNCE = 0.82;
const NOSE_BOUNCE = 0.62;          // a nose is a lump of rubber at an angle

// The cushions stop this far short of a corner, measured along the rail, and this far
// either side of a middle pocket. The corner's two noses are then 79 mm apart across the
// diagonal, which is the 73 mm mouth plus the rounding a real nose has.
export const CORNER_JAW = 56;
export const MIDDLE_JAW = MIDDLE_MOUTH / 2;

/** The cushions as segments. `at` is the line, `from`/`to` the run along it. */
export const RAILS = [
  { axis: 'y', at: 0, from: CORNER_JAW, to: L / 2 - MIDDLE_JAW },
  { axis: 'y', at: 0, from: L / 2 + MIDDLE_JAW, to: L - CORNER_JAW },
  { axis: 'y', at: W, from: CORNER_JAW, to: L / 2 - MIDDLE_JAW },
  { axis: 'y', at: W, from: L / 2 + MIDDLE_JAW, to: L - CORNER_JAW },
  { axis: 'x', at: 0, from: CORNER_JAW, to: W - CORNER_JAW },
  { axis: 'x', at: L, from: CORNER_JAW, to: W - CORNER_JAW },
];

/** Every cushion end: the noses a ball has to get between. */
export const NOSES = RAILS.flatMap((s) => (s.axis === 'y'
  ? [{ x: s.from, y: s.at }, { x: s.to, y: s.at }]
  : [{ x: s.at, y: s.from }, { x: s.at, y: s.to }]));

/**
 * The six pockets: where the hole is drawn, and the point a ball is aimed at to drop —
 * just past the cushion line, where the centre has to cross.
 */
export const POCKETS = [
  { x: -12, y: -12, aim: { x: -14, y: -14 }, corner: true },
  { x: L + 12, y: -12, aim: { x: L + 14, y: -14 }, corner: true },
  { x: -12, y: W + 12, aim: { x: -14, y: W + 14 }, corner: true },
  { x: L + 12, y: W + 12, aim: { x: L + 14, y: W + 14 }, corner: true },
  { x: L / 2, y: -18, aim: { x: L / 2, y: -30 }, corner: false },
  { x: L / 2, y: W + 18, aim: { x: L / 2, y: W + 30 }, corner: false },
];

export const HOUSE_SPOT = { x: L * 0.25, y: W / 2 };   // the дом: where the cue ball starts
export const FOOT_SPOT = { x: L * 0.75, y: W / 2 };    // the apex of the pyramid

const len = (x, y) => Math.hypot(x, y);

/** xorshift32, the generator every cabinet uses. */
export function rng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

/** A fresh game: the rack, the cue ball in the house, the player to break. */
export function create() {
  const balls = [{ id: 0, x: HOUSE_SPOT.x, y: HOUSE_SPOT.y, vx: 0, vy: 0, cue: true, potted: false }];
  // The pyramid: five rows from the apex on the foot spot, pointing at the house, each
  // ball touching its neighbours with a hair between them.
  const gap = R * 2 + 0.4;
  let id = 1;
  for (let row = 0; row < 5; row += 1) {
    for (let i = 0; i <= row; i += 1) {
      balls.push({
        id, cue: false, potted: false, vx: 0, vy: 0,
        x: FOOT_SPOT.x + row * gap * 0.8660254,
        y: FOOT_SPOT.y + (i - row / 2) * gap,
      });
      id += 1;
    }
  }
  return {
    balls,
    turn: 0,
    scores: [0, 0],
    shots: 0,
    over: false,
    winner: null,
    shot: null,          // the shot in flight: what it touched, what it dropped
    last: null,          // how the last shot was resolved, for the cabinet to say
  };
}

export const cueBall = (state) => state.balls[0];
export const moving = (state) => state.balls.some((b) => !b.potted && (b.vx !== 0 || b.vy !== 0));
export const onTable = (state) => state.balls.filter((b) => !b.potted && !b.cue);
export const toGo = (state, seat) => Math.max(0, TARGET - state.scores[seat]);

/** Strike the cue ball. `power` is 0..1. False when nothing may be struck. */
export function shoot(state, angle, power) {
  if (state.over || moving(state) || cueBall(state).potted) return false;
  const p = Math.max(0.1, Math.min(1, power));
  const c = cueBall(state);
  c.vx = Math.cos(angle) * MAX_POWER * p;
  c.vy = Math.sin(angle) * MAX_POWER * p;
  state.shots += 1;
  state.shot = { seat: state.turn, struck: false, potted: [], cuePotted: false };
  state.last = null;
  return true;
}

// ------------------------------------------------------------------ physics
/** Equal masses, resolved along the line of centres. This is all of billiards. */
function hitBalls(state, a, b, hooks) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = len(dx, dy);
  if (dist === 0 || dist > R * 2) return false;
  const nx = dx / dist;
  const ny = dy / dist;
  // Separate first. A pair left overlapping re-collides every substep and buzzes.
  const overlap = (R * 2 - dist) / 2 + 0.01;
  a.x -= nx * overlap; a.y -= ny * overlap;
  b.x += nx * overlap; b.y += ny * overlap;
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rel > 0) return false;
  const impulse = rel * BALL_BOUNCE;
  a.vx += impulse * nx; a.vy += impulse * ny;
  b.vx -= impulse * nx; b.vy -= impulse * ny;
  if (state.shot && (a.cue || b.cue)) state.shot.struck = true;
  if (hooks && hooks.onContact && rel < -400) hooks.onContact(a, b, -rel);
  return true;
}

/** A cushion, where there is one: reflect. In a gap: nothing, the pocket decides. */
function cushions(b, hooks) {
  for (const s of RAILS) {
    if (s.axis === 'y') {
      if (b.x < s.from || b.x > s.to) continue;
      if (s.at === 0 && b.y - R < 0) { b.y = R; b.vy = Math.abs(b.vy) * CUSHION_BOUNCE; if (hooks?.onCushion) hooks.onCushion(b); }
      if (s.at === W && b.y + R > W) { b.y = W - R; b.vy = -Math.abs(b.vy) * CUSHION_BOUNCE; if (hooks?.onCushion) hooks.onCushion(b); }
    } else {
      if (b.y < s.from || b.y > s.to) continue;
      if (s.at === 0 && b.x - R < 0) { b.x = R; b.vx = Math.abs(b.vx) * CUSHION_BOUNCE; if (hooks?.onCushion) hooks.onCushion(b); }
      if (s.at === L && b.x + R > L) { b.x = L - R; b.vx = -Math.abs(b.vx) * CUSHION_BOUNCE; if (hooks?.onCushion) hooks.onCushion(b); }
    }
  }
}

/** The noses: a ball cannot overlap a cushion end, and bounces off it at the angle it hit. */
function noses(b, hooks) {
  for (const n of NOSES) {
    const dx = b.x - n.x;
    const dy = b.y - n.y;
    const d = len(dx, dy);
    if (d >= R || d === 0) continue;
    const nx = dx / d;
    const ny = dy / d;
    b.x = n.x + nx * (R + 0.01);
    b.y = n.y + ny * (R + 0.01);
    const along = b.vx * nx + b.vy * ny;
    if (along < 0) {
      b.vx -= (1 + NOSE_BOUNCE) * along * nx;
      b.vy -= (1 + NOSE_BOUNCE) * along * ny;
      if (hooks?.onCushion) hooks.onCushion(b);
    }
  }
}

/** A centre past a cushion line got there through a gap: it is in the pocket. */
function pockets(state, hooks) {
  for (const b of state.balls) {
    if (b.potted) continue;
    if (b.x < 0 || b.x > L || b.y < 0 || b.y > W) {
      b.potted = true;
      b.vx = 0; b.vy = 0;
      if (state.shot) {
        if (b.cue) state.shot.cuePotted = true;
        else state.shot.potted.push(b.id);
      }
      if (hooks?.onPocket) hooks.onPocket(b);
    }
  }
}

/**
 * Advance the table by `dt` seconds. Call it SUBSTEPS times a frame. When the balls have
 * come to rest after a shot, the shot is resolved and `state.last` says how.
 */
export function step(state, dt, hooks = null) {
  if (state.over) return;
  for (const b of state.balls) {
    if (b.potted) continue;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    const decay = Math.exp(-FRICTION * dt);
    b.vx *= decay;
    b.vy *= decay;
    if (len(b.vx, b.vy) < STOP_BELOW) { b.vx = 0; b.vy = 0; }
    cushions(b, hooks);
    noses(b, hooks);
  }
  for (let i = 0; i < state.balls.length; i += 1) {
    if (state.balls[i].potted) continue;
    for (let j = i + 1; j < state.balls.length; j += 1) {
      if (state.balls[j].potted) continue;
      hitBalls(state, state.balls[i], state.balls[j], hooks);
    }
  }
  pockets(state, hooks);
  if (state.shot && !moving(state)) resolve(state);
}

// -------------------------------------------------------------------- rules
/** The object ball nearest a pocket, which is the one taken off the table by a rule. */
function nearestToPocket(state) {
  let best = null;
  let bestD = Infinity;
  for (const b of onTable(state)) {
    for (const p of POCKETS) {
      const d = len(b.x - p.x, b.y - p.y);
      if (d < bestD) { bestD = d; best = b; }
    }
  }
  return best;
}

/** Put the cue ball back in the house, on the spot or the nearest free place behind it. */
export function respotCue(state) {
  const c = cueBall(state);
  c.potted = false;
  c.vx = 0; c.vy = 0;
  const free = (x, y) => onTable(state).every((b) => len(b.x - x, b.y - y) > R * 2 + 1);
  for (let k = 0; k < 40; k += 1) {
    const x = HOUSE_SPOT.x - k * R * 0.9;
    if (x < R) break;
    if (free(x, HOUSE_SPOT.y)) { c.x = x; c.y = HOUSE_SPOT.y; return; }
  }
  c.x = HOUSE_SPOT.x;
  c.y = HOUSE_SPOT.y;
}

function resolve(state) {
  const s = state.shot;
  state.shot = null;
  const seat = s.seat;
  const other = 1 - seat;
  const last = {
    seat, counted: 0, foul: false, svoyak: false, penalty: false, cuePotted: s.cuePotted, potted: s.potted.slice(),
  };

  if (!s.struck) {
    // Nothing touched: a foul, and the cue ball may be in a pocket on top of it.
    last.foul = true;
  } else {
    last.counted += s.potted.length;
    if (s.cuePotted) {
      // A свояк: the cue ball dropped after doing its work. One ball off the table for
      // the shooter, and the cue ball back to the house.
      const taken = nearestToPocket(state);
      if (taken) { taken.potted = true; last.counted += 1; last.svoyak = true; last.potted.push(taken.id); }
    }
  }
  state.scores[seat] += last.counted;

  if (last.foul) {
    const taken = nearestToPocket(state);
    if (taken) { taken.potted = true; state.scores[other] += 1; last.penalty = true; last.potted.push(taken.id); }
  }
  if (cueBall(state).potted) respotCue(state);

  if (state.scores[seat] >= TARGET) { state.over = true; state.winner = seat; }
  else if (state.scores[other] >= TARGET) { state.over = true; state.winner = other; }
  else if (onTable(state).length === 0) { state.over = true; state.winner = state.scores[0] === state.scores[1] ? null : (state.scores[0] > state.scores[1] ? 0 : 1); }
  else if (last.foul || last.counted === 0) state.turn = other;

  state.last = last;
  return last;
}

// ---------------------------------------------------------------- the aim
/** Where the cue ball going out at `angle` first meets a ball or a cushion, in mm. */
export function predict(state, angle) {
  const c = cueBall(state);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = Infinity;
  let hit = null;
  for (const b of onTable(state)) {
    // A ray from the cue against a circle of radius 2R around the object ball.
    const ox = b.x - c.x;
    const oy = b.y - c.y;
    const along = ox * dx + oy * dy;
    if (along <= 0) continue;
    const perp2 = ox * ox + oy * oy - along * along;
    const r2 = (2 * R) * (2 * R);
    if (perp2 > r2) continue;
    const t = along - Math.sqrt(r2 - perp2);
    if (t < best) { best = t; hit = b; }
  }
  const wall = Math.min(
    dx > 0 ? (L - R - c.x) / dx : (dx < 0 ? (R - c.x) / dx : Infinity),
    dy > 0 ? (W - R - c.y) / dy : (dy < 0 ? (R - c.y) / dy : Infinity),
  );
  if (wall < best) { best = wall; hit = null; }
  return { distance: best, ball: hit, x: c.x + dx * best, y: c.y + dy * best };
}

// ---------------------------------------------------------------- the bot
/** Whether the run from a to b is clear of every ball but the two named. */
function clear(state, a, b, ignore) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  for (const o of state.balls) {
    if (o.potted || ignore.includes(o)) continue;
    const t = d2 === 0 ? 0 : Math.max(0, Math.min(1, ((o.x - a.x) * dx + (o.y - a.y) * dy) / d2));
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    if (len(o.x - px, o.y - py) < R * 2) return false;
  }
  return true;
}

/**
 * The machine's shot: the ghost-ball method, which is how a person aims too. For every
 * object ball and every pocket, the point the cue ball has to reach is one ball's width
 * behind the object ball on the line from the pocket; the shot is worth taking when the
 * cue can get there, the object ball can get to the pocket, and the cut is not absurd.
 * With nothing on, it plays the nearest ball softly, which is never a foul.
 */
export function botShot(state, random = Math.random) {
  const c = cueBall(state);
  let best = null;
  for (const o of onTable(state)) {
    for (const p of POCKETS) {
      const tx = p.aim.x - o.x;
      const ty = p.aim.y - o.y;
      const td = len(tx, ty);
      if (td === 0) continue;
      const gx = o.x - (tx / td) * R * 2;
      const gy = o.y - (ty / td) * R * 2;
      const cx = gx - c.x;
      const cy = gy - c.y;
      const cd = len(cx, cy);
      if (cd < R) continue;
      const cut = Math.acos(Math.max(-1, Math.min(1, (cx * tx + cy * ty) / (cd * td))));
      if (cut > Math.PI * 0.42) continue;
      if (!clear(state, c, { x: gx, y: gy }, [c, o])) continue;
      if (!clear(state, o, p.aim, [o, c])) continue;
      // Middle pockets take only a straight ball; the score says so.
      const cost = cut * (p.corner ? 1 : 1.8) + td / 1600 + cd / 4000;
      if (!best || cost < best.cost) best = { cost, angle: Math.atan2(cy, cx), cd, td };
    }
  }
  if (best) {
    const power = Math.max(0.28, Math.min(1, 0.22 + best.cd / 3200 + best.td / 2400));
    return { angle: best.angle + (random() - 0.5) * 0.006, power };
  }
  // Nothing on: touch the nearest ball, which keeps the cue on the table and avoids a foul.
  let near = null;
  let nd = Infinity;
  for (const o of onTable(state)) {
    const d = len(o.x - c.x, o.y - c.y);
    if (d < nd) { nd = d; near = o; }
  }
  if (!near) return { angle: 0, power: 0.2 };
  return { angle: Math.atan2(near.y - c.y, near.x - c.x) + (random() - 0.5) * 0.01, power: Math.max(0.22, Math.min(0.5, nd / 4000)) };
}
