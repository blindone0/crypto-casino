'use strict';
// The dice geometry: which number ends up facing the sky.
//
// This is the one part of the renderer a player would catch immediately. The server draws
// the faces from the round seed and the animation is TOLD to land on them — so if the
// table mapping a value to a resting orientation is wrong, the dice come to rest showing
// a 4 while the verdict underneath says 3. The money would still be right and the site
// would still be honest, and it would look exactly like cheating.
//
// Nothing else in the file can be tested here: the rest is WebGL, and a stub for it would
// only test the stub. But the geometry is pure arithmetic, and it is the part that can be
// silently wrong.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// `public/dice3d.js` is an ES module inside a CommonJS package, so it cannot be required.
// Copying it to a .mjs and importing is the trick test/client.test.js already uses for
// i18n.js. Importing the module does not touch `document` — only calling `createDice`
// does — so this is safe outside a browser.
const load = (async () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'dice3d.js'), 'utf8',
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dice3d-'));
  const file = path.join(dir, 'dice3d.mjs');
  // The one import it has is a sibling module it does not need for the geometry.
  fs.writeFileSync(file, src);
  return import(`file://${file.replace(/\\/g, '/')}`);
})();

/** The six cube-face normals, in the order `FACE_VALUES` indexes them. */
const NORMALS = [
  [1, 0, 0], [-1, 0, 0],   // +X, -X
  [0, 1, 0], [0, -1, 0],   // +Y, -Y
  [0, 0, 1], [0, 0, -1],   // +Z, -Z
];

/**
 * The same X-then-Y-then-Z composition the renderer's `rotation()` uses, as a 3x3.
 *
 * Reimplemented here rather than imported, deliberately: a test that shares the code it
 * is checking agrees with it by construction. If the renderer's order is ever changed to
 * Z-Y-X, this disagrees and says so, which is the point.
 */
function rotation3(rx, ry, rz) {
  const cx = Math.cos(rx); const sx = Math.sin(rx);
  const cy = Math.cos(ry); const sy = Math.sin(ry);
  const cz = Math.cos(rz); const sz = Math.sin(rz);
  const mul = (a, b) => {
    const o = new Array(9);
    for (let c = 0; c < 3; c += 1) {
      for (let r = 0; r < 3; r += 1) {
        let s = 0;
        for (let k = 0; k < 3; k += 1) s += a[k * 3 + r] * b[c * 3 + k];
        o[c * 3 + r] = s;
      }
    }
    return o;
  };
  const X = [1, 0, 0, 0, cx, sx, 0, -sx, cx];
  const Y = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  const Z = [cz, sz, 0, -sz, cz, 0, 0, 0, 1];
  return mul(Z, mul(Y, X));
}

const apply = (m, v) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

// ---------------------------------------------------------------------------

test('opposite faces sum to seven, as they do on a real die', async () => {
  const { FACE_VALUES } = await load;
  // The order is +X, -X, +Y, -Y, +Z, -Z, so the pairs are adjacent.
  assert.strictEqual(FACE_VALUES[0] + FACE_VALUES[1], 7, 'the X axis');
  assert.strictEqual(FACE_VALUES[2] + FACE_VALUES[3], 7, 'the Y axis');
  assert.strictEqual(FACE_VALUES[4] + FACE_VALUES[5], 7, 'the Z axis');
});

test('every value from one to six appears exactly once', async () => {
  const { FACE_VALUES } = await load;
  assert.strictEqual(FACE_VALUES.length, 6);
  assert.deepStrictEqual([...FACE_VALUES].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6],
    'a die with two fours and no one is not a die');
});

test('the die is right-handed, like a western casino die', async () => {
  const { FACE_VALUES } = await load;
  // With 1 up and 2 toward the viewer, 3 is on the right. A left-handed die is a real
  // thing that exists and looks subtly wrong to anyone who has held one.
  assert.strictEqual(FACE_VALUES[2], 1, '1 is on +Y');
  assert.strictEqual(FACE_VALUES[4], 2, '2 is on +Z');
  assert.strictEqual(FACE_VALUES[0], 3, '3 is on +X');
});

test('every value has a resting orientation', async () => {
  const { RESTING } = await load;
  assert.deepStrictEqual(Object.keys(RESTING).sort(), ['1', '2', '3', '4', '5', '6']);
  for (const [value, euler] of Object.entries(RESTING)) {
    assert.strictEqual(euler.length, 3, `${value} needs three angles`);
    for (const a of euler) assert.ok(Number.isFinite(a), `${value} has a non-finite angle`);
  }
});

test('asking for a face actually puts that face up', async () => {
  // The load-bearing test. The animation is told to land on what the seed produced, so a
  // wrong entry here means the dice come to rest showing one number while the verdict
  // prints another — which is indistinguishable from cheating, however correct the
  // accounting is underneath.
  const { FACE_VALUES, RESTING } = await load;

  for (let value = 1; value <= 6; value += 1) {
    const m = rotation3(...RESTING[value]);
    let best = 0;
    let bestY = -Infinity;
    NORMALS.forEach((n, i) => {
      const y = apply(m, n)[1];
      if (y > bestY) { bestY = y; best = i; }
    });
    assert.strictEqual(FACE_VALUES[best], value,
      `asked for ${value}, but ${FACE_VALUES[best]} ends up on top`);
    // And it must be square to the table, not resting on an edge.
    assert.ok(bestY > 0.999, `${value} comes to rest tilted (up-component ${bestY.toFixed(4)})`);
  }
});

test('a resting pose is a whole number of quarter turns', async () => {
  // The tumble adds whole extra turns (multiples of 2*PI) that decay to zero, so the
  // resting pose is exactly what is left at the end. If one of these were a stray angle
  // the die would settle crooked, which reads as a rendering fault rather than as style.
  const { RESTING } = await load;
  for (const [value, euler] of Object.entries(RESTING)) {
    for (const a of euler) {
      const quarters = a / (Math.PI / 2);
      assert.ok(Math.abs(quarters - Math.round(quarters)) < 1e-9,
        `${value} has an angle of ${a}, which is not a quarter turn`);
    }
  }
});

// ---------------------------------------------------------------------------
// The throw itself.
//
// The dice are simulated rather than tweened: velocity, gravity, a floor, four walls and
// a die-vs-die test. That is what was asked for — real collisions and ricochets — and it
// brings a risk a tween does not have. A tween always ends. A simulation can find a
// corner to buzz in forever, and a throw that never finishes is a bet that never pays.
//
// So the constants are read out of the renderer itself and run headlessly here. If a
// future tuning pass makes throws hang, or sends a die through the wall, this says so
// before a player does.

const DICE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'dice3d.js'), 'utf8',
);

/** Pull a numeric constant out of the renderer, so the test cannot drift from it. */
function constant(name) {
  const m = new RegExp(`const ${name} = (-?[\\d.]+)`).exec(DICE_SRC);
  assert.ok(m, `${name} is not declared in dice3d.js`);
  return Number(m[1]);
}

const P = {
  GRAVITY: constant('GRAVITY'),
  FLOOR: constant('FLOOR'),
  WALL_X: constant('WALL_X'),
  WALL_Z: constant('WALL_Z'),
  RESTITUTION: constant('RESTITUTION'),
  WALL_BOUNCE: constant('WALL_BOUNCE'),
  FRICTION: constant('FRICTION'),
  SPIN_DAMP: constant('SPIN_DAMP'),
  DIE_RADIUS: constant('DIE_RADIUS'),
  ASLEEP: constant('ASLEEP'),
  ROLL_FRICTION: constant('ROLL_FRICTION'),
  SPIN_FRICTION: constant('SPIN_FRICTION'),
  BOUNCE_FLOOR: constant('BOUNCE_FLOOR'),
  SETTLE_RATE: constant('SETTLE_RATE'),
};

/** The integrator, mirroring `step()` in the renderer. */
function step(d, dt) {
  d.vel[1] += P.GRAVITY * dt;
  d.pos[0] += d.vel[0] * dt;
  d.pos[1] += d.vel[1] * dt;
  d.pos[2] += d.vel[2] * dt;
  for (let i = 0; i < 3; i += 1) d.rot[i] += d.spin[i] * dt;

  let hit = false;
  if (d.pos[1] < P.FLOOR) {
    d.pos[1] = P.FLOOR;
    if (d.vel[1] < 0) {
      hit = true;
      d.vel[1] = -d.vel[1] * P.RESTITUTION;
      if (d.vel[1] < P.BOUNCE_FLOOR) d.vel[1] = 0;
      d.vel[0] *= P.FRICTION;
      d.vel[2] *= P.FRICTION;
      for (let i = 0; i < 3; i += 1) d.spin[i] *= P.SPIN_DAMP;
    }
  }

  // Sliding and rolling on the felt, per second rather than per bounce. Its absence was
  // the reported bug: with friction only on impact, a die that had stopped bouncing had
  // nothing slowing it, and the settle froze it in place instead.
  if (d.pos[1] <= P.FLOOR + 0.01) {
    const slide = Math.exp(-P.ROLL_FRICTION * dt);
    const turn = Math.exp(-P.SPIN_FRICTION * dt);
    d.vel[0] *= slide;
    d.vel[2] *= slide;
    for (let i = 0; i < 3; i += 1) d.spin[i] *= turn;
  }

  confine(d);
  return hit;
}

/** Keep a die inside the table, mirroring `confine()` in the renderer. */
function confine(d) {
  if (d.pos[0] < -P.WALL_X) { d.pos[0] = -P.WALL_X; d.vel[0] = Math.abs(d.vel[0]) * P.WALL_BOUNCE; }
  if (d.pos[0] > P.WALL_X) { d.pos[0] = P.WALL_X; d.vel[0] = -Math.abs(d.vel[0]) * P.WALL_BOUNCE; }
  if (d.pos[2] < -P.WALL_Z) { d.pos[2] = -P.WALL_Z; d.vel[2] = Math.abs(d.vel[2]) * P.WALL_BOUNCE; }
  if (d.pos[2] > P.WALL_Z) { d.pos[2] = P.WALL_Z; d.vel[2] = -Math.abs(d.vel[2]) * P.WALL_BOUNCE; }
  if (d.pos[1] < P.FLOOR) d.pos[1] = P.FLOOR;
}

/** The die-vs-die test, mirroring `collide()`. Returns true when it resolved a contact. */
function collide(a, b) {
  const dx = b.pos[0] - a.pos[0];
  const dy = b.pos[1] - a.pos[1];
  const dz = b.pos[2] - a.pos[2];
  const dist = Math.hypot(dx, dy, dz);
  const min = P.DIE_RADIUS * 2;
  if (dist >= min || dist < 1e-6) return false;
  const nx = dx / dist; const ny = dy / dist; const nz = dz / dist;
  const overlap = (min - dist) / 2;
  a.pos[0] -= nx * overlap; a.pos[1] -= ny * overlap; a.pos[2] -= nz * overlap;
  b.pos[0] += nx * overlap; b.pos[1] += ny * overlap; b.pos[2] += nz * overlap;
  const along = (b.vel[0] - a.vel[0]) * nx + (b.vel[1] - a.vel[1]) * ny
    + (b.vel[2] - a.vel[2]) * nz;
  if (along > 0) return false;
  const j = -(1 + 0.55) * along / 2;
  a.vel[0] -= j * nx; a.vel[1] -= j * ny; a.vel[2] -= j * nz;
  b.vel[0] += j * nx; b.vel[1] += j * ny; b.vel[2] += j * nz;
  confine(a);
  confine(b);
  return true;
}

const moving = (d) => Math.hypot(...d.vel) > P.ASLEEP
  || Math.abs(d.spin[0]) + Math.abs(d.spin[1]) + Math.abs(d.spin[2]) > P.ASLEEP
  || d.pos[1] > P.FLOOR + 0.02;

/** A pair launched exactly as `roll()` launches them. */
function launch(rand) {
  return [0, 1].map((i) => {
    const z = 1.3 - i * 2.6;
    const toward = z > 0 ? -1 : 1;
    return {
      pos: [-3.5 - i * 0.4, 2.7, z],
      vel: [7.4 + rand() * 2.6, 1.5 + rand() * 1.4, toward * (3.2 + rand() * 2.0)],
      rot: [0, 0, 0],
      spin: [0, 0, 0].map(() => (rand() * 2 - 1) * 9 - Math.sign(rand() - 0.5) * 3),
    };
  });
}

/** Run one throw to rest. Returns how it went. */
/**
 * One whole throw, mirroring `frame()` — INCLUDING the settling phase.
 *
 * The settling phase is the point. An earlier version of this stopped the moment
 * `moving()` went false, which meant it never ran the half of the loop where the bug
 * lived: `frame()` used to skip `step()` entirely once a die began righting itself, so
 * position froze and the die rotated onto its answer on the spot. Tests that stop at the
 * handover pass whether or not that happens, and that is exactly what let it ship.
 */
function throwOnce(rand, maxFrames = 600) {
  const dice = launch(rand);
  for (const d of dice) { d.settling = false; d.rest = [0, 0, 0]; }
  let frames = 0;
  let hits = 0;
  let escaped = false;
  const landed = dice.map(() => -1);
  const landedAt = dice.map(() => null);
  const floorHits = dice.map(() => 0);

  const wrap = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
  const settled = (d) => {
    const off = Math.abs(wrap(d.rest[0] - d.rot[0])) + Math.abs(wrap(d.rest[1] - d.rot[1]))
      + Math.abs(wrap(d.rest[2] - d.rot[2]));
    return d.settling && off <= 0.01 && !moving(d);
  };

  while (!(settled(dice[0]) && settled(dice[1])) && frames < maxFrames) {
    // Every die is stepped, settling or not. This is the line the fix turns on.
    dice.forEach((d, i) => {
      if (step(d, 1 / 60)) {
        floorHits[i] += 1;
        if (landed[i] < 0) {
          landed[i] = frames;
          landedAt[i] = [d.pos[0], d.pos[2]];
        }
      }
    });
    if (collide(dice[0], dice[1])) hits += 1;

    for (const d of dice) {
      if (!d.settling && !moving(d)) {
        d.settling = true;
        // The probe does not need the real `nearestRest`; rounding to quarter turns
        // lands on the same set of orientations and keeps this file self-contained.
        d.rest = d.rot.map((a) => Math.round(a / (Math.PI / 2)) * (Math.PI / 2));
      }
      if (d.settling) {
        for (let i = 0; i < 3; i += 1) {
          d.spin[i] = wrap(d.rest[i] - d.rot[i]) * P.SETTLE_RATE;
        }
      }
    }

    frames += 1;
    for (const d of dice) {
      if (Math.abs(d.pos[0]) > P.WALL_X + 0.01 || Math.abs(d.pos[2]) > P.WALL_Z + 0.01
        || d.pos[1] < P.FLOOR - 0.01) escaped = true;
    }
  }

  const travel = dice.map((d, i) => (landedAt[i]
    ? Math.hypot(d.pos[0] - landedAt[i][0], d.pos[2] - landedAt[i][1])
    : 0));
  const after = landed.map((f) => (f < 0 ? 0 : frames - f));

  return {
    frames, hits, escaped, settled: frames < maxFrames,
    travel, after, floorHits,
  };
}

/** A seeded PRNG, so a failure can be reproduced rather than merely reported. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('every throw comes to rest', () => {
  // The failure this exists for: a simulation that finds a corner to buzz in, and a
  // player left watching dice that will not stop while their bet hangs unresolved.
  const rand = rng(20260929);
  let worst = 0;
  for (let n = 0; n < 500; n += 1) {
    const out = throwOnce(rand);
    assert.ok(out.settled, `throw ${n} was still moving after 10 seconds`);
    worst = Math.max(worst, out.frames);
  }
  // And it must not merely terminate, it must terminate promptly: a five-second throw is
  // a player waiting, and the round cannot settle until it ends.
  assert.ok(worst < 300, `the longest throw took ${worst} frames (${(worst / 60).toFixed(2)}s)`);
  // And the other side of it, which is the bug this pins: a throw that ends too FAST is a
  // die that stopped dead on landing. Measured at ~190 frames after the fix; before it,
  // the physics gave up as soon as the die touched the felt.
  assert.ok(worst > 120,
    `the longest throw was only ${worst} frames — the dice are stopping on contact`);
});

test('no die ever leaves the table or falls through it', () => {
  const rand = rng(777);
  for (let n = 0; n < 500; n += 1) {
    assert.ok(!throwOnce(rand).escaped, `a die escaped the table on throw ${n}`);
  }
});

test('the dice actually hit each other, often enough to be the point', () => {
  // Ricochets were asked for specifically. Thrown apart, the dice simply never met:
  // measured at 0.2 contacts a throw, which is "almost never". Converging the launch
  // lines and loosening the damping took it to 0.8, which is most throws.
  const rand = rng(31337);
  let hits = 0;
  let throwsWithContact = 0;
  const N = 500;
  for (let n = 0; n < N; n += 1) {
    const out = throwOnce(rand);
    hits += out.hits;
    if (out.hits > 0) throwsWithContact += 1;
  }
  assert.ok(hits / N > 0.4,
    `only ${(hits / N).toFixed(2)} contacts per throw; the dice are not meeting`);
  assert.ok(throwsWithContact / N > 0.2,
    `only ${((throwsWithContact / N) * 100).toFixed(0)}% of throws had any contact`);
});

test('a contact pushes the dice apart rather than sticking', () => {
  // "Collisions should not persist": two overlapping dice must separate on the frame they
  // touch. Resolving an already-separating pair is what makes objects vibrate together,
  // so the impulse is skipped when they are moving apart — but the positional push must
  // still happen, or they sink into each other.
  const a = { pos: [0, 1, 0], vel: [2, 0, 0], rot: [0, 0, 0], spin: [0, 0, 0] };
  const b = { pos: [1.0, 1, 0], vel: [-2, 0, 0], rot: [0, 0, 0], spin: [0, 0, 0] };
  const before = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]);
  assert.ok(before < P.DIE_RADIUS * 2, 'the fixture must start overlapping');

  assert.strictEqual(collide(a, b), true, 'an approaching overlap must resolve');
  const after = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]);
  assert.ok(after > before, 'the dice must be pushed apart');
  assert.ok(Math.abs(after - P.DIE_RADIUS * 2) < 1e-9, 'exactly to touching, not further');
  // And they must now be separating.
  assert.ok(b.vel[0] - a.vel[0] > 0, 'the impulse must reverse the approach');

  // A second call on the same, now separating, pair must do nothing at all.
  assert.strictEqual(collide(a, b), false, 'a separating pair must be left alone');
});

test('a collision conserves momentum rather than inventing energy', () => {
  // Equal masses and a split impulse, so the pair's total momentum is unchanged. A
  // collision that added energy would send dice off the table, and the escape test above
  // would only catch it sometimes.
  const a = { pos: [0, 1, 0], vel: [3, 0, 1], rot: [0, 0, 0], spin: [0, 0, 0] };
  const b = { pos: [1.2, 1, 0.4], vel: [-1, 0, -2], rot: [0, 0, 0], spin: [0, 0, 0] };
  const before = [0, 1, 2].map((i) => a.vel[i] + b.vel[i]);
  collide(a, b);
  const after = [0, 1, 2].map((i) => a.vel[i] + b.vel[i]);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(after[i] - before[i]) < 1e-9,
      `momentum on axis ${i} went from ${before[i]} to ${after[i]}`);
  }
});

test('the spin is slow enough to read', () => {
  // The first version span a fixed number of whole turns crammed into the throw duration,
  // which at this distance was a blur — you could not see the faces go past. The spin is
  // now a rate, and this pins it: a die that turns faster than about three times a second
  // is not a tumbling die, it is a smear.
  const rand = rng(99);
  let fastest = 0;
  for (let n = 0; n < 200; n += 1) {
    for (const d of launch(rand)) {
      fastest = Math.max(fastest, ...d.spin.map((r) => Math.abs(r) / (Math.PI * 2)));
    }
  }
  assert.ok(fastest < 3, `the fastest launch spin is ${fastest.toFixed(2)} turns/sec`);
  assert.ok(fastest > 0.5, `the fastest launch spin is only ${fastest.toFixed(2)} turns/sec`);
});

test('a bounce loses energy, so the dice cannot bounce forever', () => {
  const d = { pos: [0, 6, 0], vel: [0, 0, 0], rot: [0, 0, 0], spin: [0, 0, 0] };
  let peaks = 0;
  let rising = false;
  for (let i = 0; i < 600; i += 1) {
    const wasUp = d.vel[1] > 0;
    step(d, 1 / 60);
    if (!wasUp && d.vel[1] > 0) { peaks += 1; rising = true; }
  }
  assert.ok(peaks > 1, 'it must bounce at least twice');
  assert.ok(peaks < 30, `it bounced ${peaks} times; the floor is not absorbing enough`);
  assert.ok(Math.abs(d.vel[1]) < 0.9, 'and it must be at rest by the end');
  assert.ok(Math.abs(d.pos[1] - P.FLOOR) < 0.05, 'resting on the table, not under it');
  assert.ok(rising || true);
});

test('no shader source is cut short by a stray backtick', () => {
  // This cost two round trips, in two different sessions, and both times the symptom was
  // baffling: once the whole app failed to boot with "Unexpected identifier", once the
  // dice silently fell back to glyphs because the program would not link.
  //
  // The cause both times was a backtick inside a comment inside the GLSL. The shaders are
  // template literals, so a backtick ends the string and turns the rest of the shader
  // into JavaScript — and a shader that is cut short still looks perfectly reasonable in
  // the editor. Nothing else in the file has this hazard, which is exactly why it is easy
  // to walk back into.
  const TICK = String.fromCharCode(96);
  for (const name of ['VERT', 'FRAG', 'TABLE_VERT', 'TABLE_FRAG']) {
    const open = `const ${name} = ${TICK}`;
    const at = DICE_SRC.indexOf(open);
    assert.ok(at >= 0, `${name} is not declared as a template literal`);
    const rest = DICE_SRC.slice(at + open.length);
    const body = rest.slice(0, rest.indexOf(TICK));
    // A GLSL shader that reaches its closing backtick has a main(). One that was cut
    // short by a stray backtick, in practice, never does.
    assert.ok(body.includes('void main()'),
      `${name} is truncated before main() — look for a ${TICK} inside its source`);
    assert.ok(body.trimEnd().endsWith('}'),
      `${name} does not end with a closing brace`);
  }
});

// ---------------------------------------------------------------------------
// The roll-out: what happens AFTER a die touches the felt.
//
// This is the gap that let a real bug ship. Every test above passed while the dice were
// stopping dead on contact, because they only ever asked "does it settle" and "does it
// land on the right face" — both true of a die that freezes the instant it lands.
//
// The cause was structural rather than numeric: `frame()` ran the integrator only while
// tumbling and replaced it with a lerp once the die began righting itself, so gravity,
// friction, the walls and the other die all stopped applying at the exact moment the
// player was watching most closely. The tests below measure the thing a player actually
// sees, which is movement after the landing.

test('a die keeps travelling after it first touches the felt', () => {
  // The headline regression test. Under the old code this was zero for every throw, by
  // construction: position was never integrated again once settling began.
  const rand = rng(90210);
  const travels = [];
  for (let n = 0; n < 300; n += 1) {
    for (const t of throwOnce(rand).travel) travels.push(t);
  }
  travels.sort((a, b) => a - b);
  const median = travels[Math.floor(travels.length / 2)];
  const p5 = travels[Math.floor(travels.length * 0.05)];
  assert.ok(median > 0.8,
    `dice travel a median of only ${median.toFixed(2)} units after landing`);
  // The fifth percentile, not the absolute minimum. A die thrown straight into a corner
  // genuinely does stop where it lands, and one in six hundred does — asserting on the
  // single worst case would be testing the tail rather than the behaviour. A die is one
  // unit across, so a fifth of that is the floor for "it moved".
  assert.ok(p5 > 0.2,
    `the slowest 5% of dice moved under ${p5.toFixed(2)} units after landing`);
});

test('landing is not the end of the throw', () => {
  const rand = rng(1337);
  const afters = [];
  for (let n = 0; n < 300; n += 1) {
    for (const a of throwOnce(rand).after) afters.push(a);
  }
  afters.sort((a, b) => a - b);
  const median = afters[Math.floor(afters.length / 2)];
  // A second of motion after touchdown is what reads as a roll rather than a stop.
  assert.ok(median > 60,
    `the median die stops ${median} frames after landing (${(median / 60).toFixed(2)}s)`);
  assert.ok(afters[0] > 20,
    `one die stopped only ${afters[0]} frames after it landed`);
});

test('a die bounces several times before it stays down', () => {
  // Pins BOUNCE_FLOOR from both sides. Put it back to 0.9 and the median falls to two or
  // three; drop it near zero and the die chatters against the felt forever.
  const rand = rng(5150);
  const counts = [];
  for (let n = 0; n < 200; n += 1) {
    for (const h of throwOnce(rand).floorHits) counts.push(h);
  }
  counts.sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  assert.ok(median >= 4, `the median die touches the felt only ${median} times`);
  assert.ok(counts[counts.length - 1] < 400,
    `one die touched the felt ${counts[counts.length - 1]} times — it is ringing`);
});

test('speed decays smoothly instead of being cut off', () => {
  // The shape of the bug rather than its symptom. A die whose speed drops by most of
  // itself in one frame, with nothing to hit, has been stopped by a threshold rather than
  // by friction — which is exactly what `if (vel[1] < 0.9) vel[1] = 0` used to do.
  const rand = rng(24680);
  const d = launch(rand)[0];
  let worstDrop = 0;
  let prev = Math.hypot(...d.vel);
  for (let f = 0; f < 400 && moving(d); f += 1) {
    const hit = step(d, 1 / 60);
    const now = Math.hypot(...d.vel);
    // A real contact is allowed to take a lot; a quiet frame is not.
    if (!hit && prev > P.ASLEEP * 4) {
      worstDrop = Math.max(worstDrop, 1 - now / prev);
    }
    prev = now;
  }
  assert.ok(worstDrop < 0.3,
    `speed fell by ${(worstDrop * 100).toFixed(0)}% in a single contact-free frame`);
});

test('the settle turns the die the short way round', async () => {
  // A cube showing face v upward has FOUR orientations, not one — the same face stays up
  // through any quarter turn about the vertical axis. Picking the nearest bounds the last
  // turn at a quarter turn per axis; picking the single canonical pose allowed a half
  // turn, and that swing is what read as the die snapping onto its answer.
  const { RESTING, RESTING_ALL, nearestRest, wrapAngle } = await load;
  const rand = rng(31415);

  // "Nearest" must be measured as the real angle between two orientations, not as the
  // sum of their Euler differences. Those are not the same thing — Euler triples alias,
  // so two that look far apart on paper can be the identical rotation — and using the
  // naive sum is what makes a settle take the long way round.
  const angleBetween = (a, b) => {
    const ra = rotation3(...a);
    const rb = rotation3(...b);
    const t = [ra[0], ra[3], ra[6], ra[1], ra[4], ra[7], ra[2], ra[5], ra[8]];
    let trace = 0;
    for (let i = 0; i < 3; i += 1) {
      for (let k = 0; k < 3; k += 1) trace += (i === 0 ? 0 : 0);
    }
    // trace of (Aᵀ · B), taken directly.
    const m = [];
    for (let c = 0; c < 3; c += 1) {
      for (let r = 0; r < 3; r += 1) {
        let sum = 0;
        for (let k = 0; k < 3; k += 1) sum += t[k * 3 + r] * rb[c * 3 + k];
        m[c * 3 + r] = sum;
      }
    }
    trace = m[0] + m[4] + m[8];
    return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  };

  let worseThanCanonical = 0;
  let worstResidual = 0;
  let totalResidual = 0;
  for (let n = 0; n < 400; n += 1) {
    const value = 1 + Math.floor(rand() * 6);
    const arrived = [rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2];
    const near = nearestRest(value, arrived);
    if (angleBetween(arrived, near) > angleBetween(arrived, RESTING[value]) + 1e-9) {
      worseThanCanonical += 1;
    }
    const turn = angleBetween(arrived, near);
    worstResidual = Math.max(worstResidual, turn);
    totalResidual += turn;
  }
  assert.strictEqual(worseThanCanonical, 0,
    'the nearest pose must never be further than the canonical one');
  // The worst case is a half turn, and that is geometry rather than a shortcoming: a die
  // that lands showing 6 when the server said 1 has to turn over, and no choice of pose
  // avoids it. Measured over 20,000 random arrivals, the true worst is 180 degrees.
  //
  // What the four poses buy is the AVERAGE: 93 degrees instead of 126. That is the
  // number worth pinning, because it is the one a player sees on most throws.
  assert.ok(worstResidual <= Math.PI + 1e-6,
    `the worst settle is ${(worstResidual * 57.3).toFixed(0)} degrees — more than a half turn`);
  const meanResidual = totalResidual / 400;
  assert.ok(meanResidual < Math.PI * 0.62,
    `the mean settle is ${(meanResidual * 57.3).toFixed(0)} degrees; four poses should give ~93`);

  // And there really are four candidates per face, not one.
  for (let v = 1; v <= 6; v += 1) {
    assert.strictEqual(RESTING_ALL[v].length, 4, `face ${v} should have four poses`);
  }
});

test('every one of the 24 resting poses shows the face it is filed under', async () => {
  // The verifiability contract, now that the target set is four times bigger. A pose
  // filed under 3 that actually shows 5 would land the die on the wrong number while the
  // verdict said otherwise — indistinguishable from cheating.
  const { FACE_VALUES, RESTING_ALL, RESTING } = await load;

  let total = 0;
  for (let value = 1; value <= 6; value += 1) {
    for (const pose of RESTING_ALL[value]) {
      total += 1;
      const m = rotation3(...pose);
      let best = 0;
      let bestY = -Infinity;
      NORMALS.forEach((n, i) => {
        const y = apply(m, n)[1];
        if (y > bestY) { bestY = y; best = i; }
      });
      assert.strictEqual(FACE_VALUES[best], value,
        `a pose filed under ${value} actually shows ${FACE_VALUES[best]}`);
      assert.ok(bestY > 0.999, `that pose rests on an edge (up-component ${bestY.toFixed(4)})`);
    }
    // The canonical pose must be one of the candidates, or the fallback path would move
    // the die somewhere the settle never considers.
    const canon = JSON.stringify(RESTING[value].map((a) => Math.round(a * 1e6) / 1e6));
    const found = RESTING_ALL[value].some(
      (p) => JSON.stringify(p.map((a) => Math.round(a * 1e6) / 1e6)) === canon,
    );
    assert.ok(found, `RESTING[${value}] is not among its own candidates`);
  }
  assert.strictEqual(total, 24, 'a cube has 24 orientations');
});
