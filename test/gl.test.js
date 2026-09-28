'use strict';
// The shared WebGL helpers: the maths, and the two traps.
//
// `public/gl.js` exists because slot3d.js and dice3d.js independently grew the same five
// helpers, and the card renderer was about to make it three. Extracting them is a
// refactor of working, shipped code — the slots in particular are the game the site is
// built around and have no browser tests at all.
//
// So the numbers below were captured from the COMMITTED slot3d.js before anything moved,
// and they are the only thing standing between a tidy-up and a silently broken camera.
// If a future change to the matrix code alters any of them, that change is wrong until
// proven otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// An ES module in a CommonJS package: copy to .mjs and import, the same trick
// test/client.test.js uses for i18n.js. Nothing here touches `document` at import time.
const load = (async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'gl.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-'));
  const file = path.join(dir, 'gl.mjs');
  fs.writeFileSync(file, src);
  return import(`file://${file.replace(/\\/g, '/')}`);
})();

// Float32Array, not Float64: every matrix here is 32-bit, so equality is to about seven
// significant figures and no tighter. A test that demands 1e-9 of a float32 is testing
// the storage type, not the arithmetic.
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------

test('perspective produces exactly what the slots have always been drawn with', async () => {
  const { perspective } = await load;

  // Captured from the committed slot3d.js. The slots have no browser test, so this is
  // the guard: if the camera changes, the reels are in the wrong place and nothing else
  // would say so.
  const golden = [
    1.7560153002, 0, 0, 0,
    0, 3.1218049782, 0, 0,
    0, 0, -1.0050125313, -1,
    0, 0, -0.2005012531, 0,
  ];
  const got = perspective(0.62, 16 / 9, 0.1, 40);
  assert.strictEqual(got.length, 16);
  golden.forEach((want, i) => {
    assert.ok(near(got[i], want, 1e-7),
      `element ${i}: got ${got[i]}, the slots expect ${want}`);
  });
});

test('perspective produces what the dice are drawn with', async () => {
  const { perspective } = await load;
  const golden = [
    1.6480237939, 0, 0, 0,
    0, 2.6567280127, 0, 0,
    0, 0, -1.0033388982, -1,
    0, 0, -0.2003338898, 0,
  ];
  const got = perspective(0.72, 1496 / 928, 0.1, 60);
  golden.forEach((want, i) => {
    assert.ok(near(got[i], want, 1e-7), `element ${i}: got ${got[i]}, expected ${want}`);
  });
});

test('multiply is column major and leaves identity alone', async () => {
  const { multiply, identity, translation } = await load;

  const t = translation(1, 2, 3);
  const viaLeft = multiply(identity(), t);
  const viaRight = multiply(t, identity());
  for (let i = 0; i < 16; i += 1) {
    assert.ok(near(viaLeft[i], t[i]), `I * T differs at ${i}`);
    assert.ok(near(viaRight[i], t[i]), `T * I differs at ${i}`);
  }
  // Column major puts a translation in elements 12, 13, 14 — not 3, 7, 11. Getting this
  // backwards transposes every matrix in the renderer and is not obvious from one frame.
  assert.deepStrictEqual([t[12], t[13], t[14]], [1, 2, 3]);
  assert.deepStrictEqual([t[3], t[7], t[11]], [0, 0, 0]);
});

test('rotation composes X then Y then Z, as both renderers assume', async () => {
  const { rotation } = await load;

  // A rotation about X alone must match the plain X matrix. slot3d.js has its own
  // `rotationX` and dice3d.js relies on `rotation(a, 0, 0)` being the same thing; if the
  // composition order ever changes, they silently disagree.
  const a = 0.7;
  const r = rotation(a, 0, 0);
  const c = Math.cos(a); const s = Math.sin(a);
  const want = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  want.forEach((v, i) => assert.ok(near(r[i], v), `element ${i}: ${r[i]} vs ${v}`));

  // And a full turn on any axis is the identity again.
  const full = rotation(Math.PI * 2, Math.PI * 2, Math.PI * 2);
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  id.forEach((v, i) => assert.ok(near(full[i], v, 1e-6), `a full turn is not identity at ${i}`));
});

test('normalMatrix drops translation and keeps scale', async () => {
  const { normalMatrix, multiply, translation, scaling } = await load;
  const m = multiply(translation(5, -2, 7), scaling(2));
  const n = normalMatrix(m);
  assert.strictEqual(n.length, 9);
  // Uniform scale only, which the renderers rely on: a non-uniform scale would need the
  // inverse transpose, and shading would be subtly wrong rather than obviously broken.
  assert.deepStrictEqual([...n], [2, 0, 0, 0, 2, 0, 0, 0, 2]);
});

test('lookAt puts the target in front of the camera', async () => {
  const { lookAt } = await load;
  const view = lookAt([0, 10, 10], [0, 0, 0], [0, 1, 0]);
  // The camera looks down its own -Z, so the target must land at negative z in view space.
  const p = [0, 0, 0, 1];
  const z = view[2] * p[0] + view[6] * p[1] + view[10] * p[2] + view[14];
  assert.ok(z < 0, `the target is behind the camera (z = ${z})`);
  assert.ok(Math.abs(z) > 1, 'and it should be a real distance away');
});

test('the key light is a unit vector, above and to the left', async () => {
  const { KEY_DIR } = await load;
  assert.ok(near(Math.hypot(...KEY_DIR), 1, 1e-12), 'must be normalised');
  assert.ok(KEY_DIR[1] > 0.5, 'the key light is above the table');
  assert.ok(KEY_DIR[0] < 0, 'and to the left, which is what the shadows assume');
});

test('isPOT knows which textures may repeat', async () => {
  const { isPOT } = await load;
  // WebGL 1 renders an NPOT texture black if asked to REPEAT, with no warning at all.
  // Both renderers learned this independently, which is why the helper is shared.
  for (const n of [1, 2, 256, 512, 1024, 2048]) {
    assert.strictEqual(isPOT(n), true, `${n} is a power of two`);
  }
  for (const n of [0, 3, 100, 1432, 1536, 2047]) {
    assert.strictEqual(isPOT(n), false, `${n} is not`);
  }
  // The two atlases actually shipped are NPOT on at least one edge, so they must clamp.
  assert.strictEqual(isPOT(1536) && isPOT(256), false, 'the pip atlas must not repeat');
  assert.strictEqual(isPOT(2048) && isPOT(1432), false, 'the card atlas must not repeat');
});

test('the tonemap is a single GLSL function, and is not empty', async () => {
  const { ACES } = await load;
  assert.ok(ACES.includes('vec3 tonemap(vec3'), 'it must declare tonemap()');
  assert.ok(ACES.includes('clamp('), 'and clamp, or a highlight can still exceed 1');
  // It is pasted into shader sources, so a backtick in it would end the template literal
  // it lands in. That hazard has cost this project several round trips already.
  assert.ok(!ACES.includes('`'), 'no backticks: this is pasted into template literals');
});

// ---------------------------------------------------------------------------
// The resize guard.
//
// Assigning `canvas.width` or `canvas.height` is not a plain property write: it
// reallocates and CLEARS the drawing buffer, even when the value assigned is identical to
// the one already there. ResizeObserver fires once on observe in every browser, so the
// unguarded version threw away a freshly drawn frame immediately after drawing it, on a
// size that had not moved — once per renderer, every time a game opened.
//
// A fake canvas counts the writes, because that is the thing that costs: what matters is
// not what the size ends up being, but how many times it was set to get there.

function fakeCanvas() {
  let w = 0;
  let h = 0;
  const writes = { width: 0, height: 0 };
  const style = { setProperty() {}, };
  return {
    writes,
    style,
    get width() { return w; },
    set width(v) { writes.width += 1; w = v; },
    get height() { return h; },
    set height(v) { writes.height += 1; h = v; },
  };
}

test('resizing to the size it already is does not reallocate the buffer', async () => {
  const { sizer } = await load;

  const canvas = fakeCanvas();
  let viewports = 0;
  const gl = { viewport() { viewports += 1; } };
  const host = { clientWidth: 800 };

  // The browser globals sizer reads. Node has neither.
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };

  try {
    const { resize } = sizer(canvas, gl, host, { height: 400 });

    assert.strictEqual(resize(), true, 'the first call has to size it');
    assert.strictEqual(canvas.width, 800);
    assert.strictEqual(canvas.height, 400);
    assert.deepStrictEqual(canvas.writes, { width: 1, height: 1 });

    // Three more calls at the same size: the ResizeObserver's guaranteed first fire, and
    // whatever else asks. None may touch the buffer.
    assert.strictEqual(resize(), false);
    assert.strictEqual(resize(), false);
    assert.strictEqual(resize(), false);
    assert.deepStrictEqual(canvas.writes, { width: 1, height: 1 },
      'a no-op resize must not write the size back');
    assert.strictEqual(viewports, 1, 'nor reset the viewport');

    // A real change still goes through.
    host.clientWidth = 1000;
    assert.strictEqual(resize(), true, 'a genuine resize must report that it changed');
    assert.strictEqual(canvas.width, 1000);
    assert.deepStrictEqual(canvas.writes, { width: 2, height: 2 });
    assert.strictEqual(viewports, 2);
  } finally {
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});

test('a device pixel ratio above 2 is capped rather than honoured', async () => {
  const { sizer } = await load;

  // A phone reporting 3 or 4 would otherwise ask for nine or sixteen times the fill
  // rate for a difference nobody can see.
  const canvas = fakeCanvas();
  const host = { clientWidth: 400 };
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 4 };

  try {
    const { resize } = sizer(canvas, { viewport() {} }, host, { height: 200 });
    resize();
    assert.strictEqual(canvas.width, 800, '400 css px at a capped ratio of 2');
    assert.strictEqual(canvas.height, 400);
  } finally {
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// Pre-normalised lighting constants.
//
// Four shaders normalised a LITERAL vector once per fragment — an inverse square root,
// millions of times a second, for a value fixed when the shader was written. Two more
// normalised `uKey`, which is KEY_DIR and is already unit length because gl.js builds it
// with norm().
//
// Substituting the computed value is only safe while the substituted digits are right,
// and a wrong digit moves the lighting by an amount too small to notice in a screenshot
// and too large to be correct. So the literals are pinned here: if someone edits a
// direction in a shader without recomputing it, this fails.

const GLSL_CONSTANTS = [
  { file: 'slot3d.js', raw: [-0.25, 0.75, 0.62], text: 'vec3(-0.2488332, 0.7464997, 0.6171064)' },
  { file: 'slot3d.js', raw: [0.0, 0.45, 1.0], text: 'vec3(0.0, 0.4103647, 0.9119215)' },
  { file: 'dice3d.js', raw: [0.6, 0.25, -0.5], text: 'vec3(0.7316529, 0.3048554, -0.6097108)' },
  { file: 'cards3d.js', raw: [0.6, 0.35, -0.5], text: 'vec3(0.7010475, 0.4089444, -0.5842062)' },
];

test('the baked lighting directions are the normalised form of what they replaced', () => {
  for (const { raw, text } of GLSL_CONSTANTS) {
    const len = Math.hypot(raw[0], raw[1], raw[2]);
    const want = raw.map((n) => n / len);
    // Parse inside the parentheses only: `vec3` ends in a 3, which a bare number
    // regex happily reports as a fourth component.
    const got = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))
      .split(',').map((n) => Number(n.trim()));

    assert.strictEqual(got.length, 3, `${text} must have three components`);
    got.forEach((g, i) => {
      assert.ok(near(g, want[i], 5e-7),
        `${text} component ${i}: baked ${g}, but normalising gives ${want[i]}`);
    });

    // And the result must actually be unit length, which is the whole point.
    assert.ok(near(Math.hypot(...got), 1, 1e-6), `${text} is not unit length`);
  }
});

test('the shaders no longer normalise a constant or an already-unit uniform', () => {
  // The saving is only real if the calls are gone. A regression here is silent: the
  // picture is identical and only the frame time moves.
  for (const file of ['slot3d.js', 'dice3d.js', 'cards3d.js']) {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');

    // Comments are stripped first. slot3d.js quotes the old CSS-era lighting expression
    // in a comment, and prose describing what the code used to do is not a cost.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    assert.ok(!/normalize\(\s*vec3\(\s*-?\d/.test(src),
      `${file} still normalises a literal vec3 per fragment`);
    assert.ok(!/normalize\(\s*uKey\s*\)/.test(src),
      `${file} still normalises uKey, which gl.js already built with norm()`);
  }

  // The ones that remain must remain: an interpolated normal is not unit length, and
  // the view vector is a difference of two positions.
  const dice = fs.readFileSync(path.join(__dirname, '..', 'public', 'dice3d.js'), 'utf8');
  assert.ok(dice.includes('normalize(vNormal)'), 'an interpolated normal must be renormalised');
  assert.ok(dice.includes('normalize(uEye - vWorld)'), 'the view vector must be normalised');
});

// ---------------------------------------------------------------------------
// A stray backtick in any shader, not just the dice.
//
// test/dice3d.test.js has guarded this since it cost two round trips in two earlier
// sessions. It checks dice3d.js only — so when the same mistake was made in cards3d.js
// (a comment reading `uKey`, inside GLSL, inside a template literal) it cost a THIRD.
// The whole app failed to boot with "Unexpected identifier 'uKey'".
//
// The hazard belongs to every file that keeps GLSL in a template literal, so the guard
// does too. This walks the real files rather than a copy: a new renderer is covered the
// day it is added, without anyone remembering to extend a list.

const TICK = String.fromCharCode(96);

test('no shader in any renderer is cut short by a stray backtick', () => {
  const dir = path.join(__dirname, '..', 'public');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('3d.js') || f === 'gl.js');
  assert.ok(files.length >= 3, `expected the renderers, found ${files.join(', ')}`);

  let checked = 0;
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const re = /const\s+([A-Z_0-9]+)\s*=\s*`/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      const rest = src.slice(m.index + m[0].length);
      const body = rest.slice(0, rest.indexOf(TICK));

      // Only GLSL: gl.js also exports the ACES tonemap as a fragment of source, which is
      // a function body rather than a whole shader and has no main() of its own.
      const isShader = /void\s+main\s*\(/.test(body) || /attribute |uniform |varying /.test(body);
      if (!isShader) continue;
      checked += 1;

      assert.ok(body.includes('void main()') || name === 'ACES',
        `${file}:${name} is truncated before main() — look for a ${TICK} inside its source`);
      assert.ok(body.trimEnd().endsWith('}'),
        `${file}:${name} does not end with a closing brace`);
    }
  }
  assert.ok(checked >= 8, `only ${checked} shaders were checked; the walk is not finding them`);
});

test('no comment inside a shader contains a backtick', () => {
  // The failure above is the symptom; this is the cause, and it names the line.
  const dir = path.join(__dirname, '..', 'public');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('3d.js'))) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    let inShader = false;
    lines.forEach((line, i) => {
      if (/const\s+[A-Z_0-9]+\s*=\s*`/.test(line)) { inShader = true; return; }
      if (inShader && line.includes(TICK)) { inShader = false; return; }
      if (inShader && /^\s*\/\//.test(line) && line.includes(TICK)) {
        assert.fail(`${file}:${i + 1} has a ${TICK} in a comment inside GLSL: ${line.trim()}`);
      }
    });
  }
});
