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
