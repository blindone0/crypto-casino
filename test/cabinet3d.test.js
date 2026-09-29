'use strict';
// The GL cabinet: what can be held without a browser.
//
// The renderer itself needs a WebGL context, which Node has not got; what it draws is
// decided by buildGeometry, which is pure and is held here — every face has a unit
// normal, the bezel frames the window's rectangle to the pixel, the window itself is left
// open, and the materials the draw loop groups by are the ones the faces carry. The
// shader sources are walked by test/gl.test.js like every other renderer's. And with no
// document at all, createCabinet returns null, which is the whole fallback contract.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT } = require('./helpers');

const MODULE = pathToFileURL(path.join(ROOT, 'public', 'cabinet3d.js')).href;

const LAYOUT = {
  W: 660, H: 520,
  win: { x: 40, y: 90, w: 500, h: 300 },
  marqueeH: 70,
  base: { x: 20, y: 420, w: 620, h: 80 },
};

test('every face has a unit normal and a material the draw loop knows', async () => {
  const { buildGeometry } = await import(MODULE);
  const g = buildGeometry(LAYOUT);
  assert.strictEqual(g.stride, 9);
  assert.ok(g.count >= 6 * 20, `a cabinet is more than ${g.count / 6} quads`);
  assert.strictEqual(g.count % 3, 0, 'triangles');
  const ids = new Set(Object.values(g.materials));
  for (let i = 0; i < g.count; i += 1) {
    const v = g.vertices.subarray(i * 9, i * 9 + 9);
    assert.ok(ids.has(v[0]), `vertex ${i} carries material ${v[0]}`);
    const len = Math.hypot(v[4], v[5], v[6]);
    assert.ok(Math.abs(len - 1) < 1e-5, `vertex ${i} normal has length ${len}`);
    assert.ok(Number.isFinite(v[7]) && Number.isFinite(v[8]), 'uvs are numbers');
  }
});

test('the bezel frames the window to the pixel and stands proud of the face', async () => {
  const { buildGeometry } = await import(MODULE);
  const g = buildGeometry(LAYOUT);
  const brass = g.materials.brass;
  const xs = [];
  const zs = [];
  for (let i = 0; i < g.count; i += 1) {
    const v = g.vertices.subarray(i * 9, i * 9 + 9);
    if (v[0] !== brass) continue;
    xs.push(v[1]);
    zs.push(v[3]);
  }
  const { win } = LAYOUT;
  // The lip stands proud and is pulled towards the centre line by what the perspective
  // would push it out, so it lands on the window's edge on screen: within a few px here.
  const near = (a, b) => Math.abs(a - b) < 8;
  assert.ok(xs.some((x) => near(x, win.x)) && xs.some((x) => near(x, win.x + win.w)), 'the lip sits on the window edge');
  assert.ok(Math.max(...zs) > 0, 'the lip stands proud of the face');
  assert.ok(Math.min(...zs) >= -1e-6, 'and the frame never sinks behind it');
});

test('the window is left open: no front face covers it, and the well sits behind it', async () => {
  const { buildGeometry } = await import(MODULE);
  const g = buildGeometry(LAYOUT);
  const { win, H } = LAYOUT;
  const cx = win.x + win.w / 2;
  const cy = H - (win.y + win.h / 2);   // model y is up
  // Every face at z >= 0 must miss the window's centre.
  for (let t = 0; t < g.count; t += 3) {
    const p = [0, 1, 2].map((k) => g.vertices.subarray((t + k) * 9, (t + k) * 9 + 9));
    if (p.some((v) => v[3] < 0)) continue;
    const inside = p.every((v) => v[1] >= win.x - 1e-6 && v[1] <= win.x + win.w + 1e-6
      && v[2] >= H - win.y - win.h - 1e-6 && v[2] <= H - win.y + 1e-6);
    const coversCentre = inside && Math.min(...p.map((v) => v[1])) < cx && Math.max(...p.map((v) => v[1])) > cx
      && Math.min(...p.map((v) => v[2])) < cy && Math.max(...p.map((v) => v[2])) > cy;
    assert.ok(!coversCentre, 'a front face covers the drums');
  }
  const well = g.materials.well;
  let behind = 0;
  for (let i = 0; i < g.count; i += 1) {
    const v = g.vertices.subarray(i * 9, i * 9 + 9);
    if (v[0] === well && v[3] < 0) behind += 1;
  }
  assert.ok(behind >= 6, 'the well is drawn behind the drums');
});

test('with no document there is no cabinet, and nothing else happens', async () => {
  const { createCabinet } = await import(MODULE);
  assert.strictEqual(createCabinet(null, {}), null);
  assert.strictEqual(createCabinet({}, { window: {} }), null);
});
