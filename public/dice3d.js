// Two dice, as real geometry, thrown onto a felt table.
//
// Written against the WebGL API directly rather than through three.js, for the same
// reason `slot3d.js` is: WebGL is a browser feature, not a package, and the zero
// dependency rule was never about refusing to use the platform. The cost is that the
// lighting and the rounded cube are written out by hand below rather than imported.
//
// THE ONE THING THIS FILE MUST NOT DO
//
// Decide the result.
//
// A physics simulation that tumbled two dice and read whatever came up would be the
// obvious build, and it would be unverifiable: floating point differs between machines,
// nobody can replay it, and "trust my animation" is exactly the claim this whole site
// exists to avoid making. The server draws the faces from the round's seed and sends
// them. This file is told `[4, 3]` and its whole job is to put on a convincing throw that
// ends with 4 and 3 face up.
//
// So the tumble runs backwards from the answer. The final orientation of each die is
// computed first — the rotation that puts the required face against the sky — and the
// animation is an arc that arrives there. It is choreography, not simulation, and saying
// so plainly is better than implying a physics engine that is not there.
//
// WHAT MAKES A DIE LOOK LIKE AN OBJECT
//
// Three things, none of which is the cube itself:
//
//   - Rounded edges. A sharp cube reads as a box. Real dice are radiused, and the
//     highlight that runs along that radius is most of what says "solid".
//   - A material that is not flat. The bone and resin maps come off the RTX with grain
//     and wear in them; a die painted one colour reads as plastic in the bad sense.
//   - Pips that are drilled, not printed. The atlas has a soft dark rim around each pip
//     so it reads as a hole with depth rather than a dot stuck on the surface.

/**
 * Where the key light is, as a unit vector pointing towards it.
 *
 * Declared once and handed to BOTH shaders. The dice are lit by it and the table casts
 * its shadows along it, and two shaders disagreeing about where the light is produces
 * wrongness nobody can name but everybody can see: highlights on one side of a die and
 * its shadow on the same side.
 */
import {
  KEY_DIR, dot, cross, norm, identity, multiply, translation, scaling, rotation,
  normalMatrix, lookAt, perspective, shader, program, locations, loadTexture,
} from './gl.js';

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUV;
attribute float aFace;   // which sixth of the pip atlas this face shows
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUV;
varying float vFace;
void main() {
  vNormal = normalize(uNormalMat * aNormal);
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vUV = aUV;
  vFace = aFace;
  gl_Position = uProj * uView * world;
}`;

// The lighting.
//
// One key light high and to the left, one dim fill from the opposite side so the shadowed
// faces are not black, and a rim term that picks out the silhouette. The specular is
// Blinn-Phong against the key only — two specular highlights on a die look like a
// photograph of a die under studio lights, which is not the same as a die.
//
// `slot3d.js` records a bug worth not repeating here: its specular peaked at an angle
// that happened to fall between two rows of symbols, washing a stripe across every drum.
// The lesson is to check where a highlight actually lands rather than to trust that a
// plausible-looking exponent is fine. On a cube the normals are flat per face, so the
// highlight is per face and cannot smear — but the roughness map still modulates it, and
// that is checked by eye against a still frame.
const FRAG = `
precision highp float;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUV;
varying float vFace;

uniform sampler2D uBody;      // the material: bone or resin
uniform sampler2D uRough;     // roughness, derived from the material's own contrast
uniform sampler2D uPips;      // six faces in a row, transparent
uniform vec3 uEye;
uniform vec3 uTint;
uniform vec3 uKey;          // the key light, shared with the table so they agree
uniform float uWear;        // how used this particular die is, 0 new .. 1 old
uniform vec2 uGrain;        // this die's own offset into the material

void main() {
  // The pip atlas is six faces across, and vFace is already the slot to sample.
  //
  // It arrives as a per-vertex attribute rather than as a lookup into a uniform array,
  // and that is not a style choice: GLSL ES 1.0 permits only a constant or a loop index
  // inside [], so uPipShown[int(vFace)] is rejected by the compiler --
  // "Index expression can only contain const or loop symbols". The program then fails to
  // link, createDice returns null, and the whole game silently falls back to glyph
  // dice. Baking the slot into the geometry sidesteps the rule entirely, and costs one
  // float per vertex on a mesh that has a few thousand.
  vec2 pipUV = vec2((vUV.x + vFace) / 6.0, vUV.y);
  vec4 pip = texture2D(uPips, pipUV);

  // Each die reads a different part of the material.
  //
  // Two dice sharing one texture at one offset are the same object twice, and it shows:
  // the same scratch in the same corner of both. Offsetting the sample gives each its own
  // grain from the one map, at no cost.
  vec2 bodyUV = vUV * 0.82 + uGrain;
  vec3 body = texture2D(uBody, bodyUV).rgb * uTint;
  float rough = texture2D(uRough, bodyUV).r;

  // And an older die is duller and slightly darker at its edges, where a real one has
  // been handled most. vUV is per face, so the distance from the face centre is the
  // distance towards its edges.
  float edge = max(abs(vUV.x - 0.5), abs(vUV.y - 0.5)) * 2.0;
  body *= 1.0 - uWear * 0.16 * smoothstep(0.55, 1.0, edge);
  rough = min(1.0, rough + uWear * 0.22);

  // The pip is a hole: darken the body towards the pip's own colour by its alpha, rather
  // than pasting the pip over the top. A pasted pip sits on the surface; a darkened one
  // is in it.
  vec3 albedo = mix(body, pip.rgb * 0.35, pip.a);
  // And a hole is rougher than the polished face around it, which is what stops the pips
  // catching the same highlight as the surface and reading as flat discs.
  rough = mix(rough, 0.9, pip.a);

  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);

  vec3 keyDir = normalize(uKey);
  vec3 fillDir = normalize(vec3(0.6, 0.25, -0.5));

  float key = max(dot(n, keyDir), 0.0);
  float fill = max(dot(n, fillDir), 0.0) * 0.28;
  // A little ambient, warm, so the underside is not a void.
  vec3 ambient = vec3(0.16, 0.15, 0.14);

  // Blinn-Phong, with the exponent driven by the roughness map: a worn patch scatters,
  // a polished one does not.
  vec3 h = normalize(keyDir + v);
  float shine = mix(90.0, 8.0, rough);
  float spec = pow(max(dot(n, h), 0.0), shine) * (1.0 - rough) * 0.55;

  // Rim: the edge of the object against the background. This is the cheapest thing that
  // makes a rendered object stop looking pasted onto the picture.
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.18;

  vec3 lit = albedo * (ambient + key * vec3(1.0, 0.97, 0.92) + fill * vec3(0.55, 0.62, 0.75));
  lit += spec * vec3(1.0, 0.98, 0.94);
  lit += rim * vec3(0.8, 0.85, 1.0);

  // Filmic-ish tonemap, so a bright highlight rolls off instead of clipping to white.
  // The slots learned this the hard way: without it the specular blew out to flat white
  // and took the material with it.
  lit = (lit * (2.51 * lit + 0.03)) / (lit * (2.43 * lit + 0.59) + 0.14);
  gl_FragColor = vec4(clamp(lit, 0.0, 1.0), 1.0);
}`;

// The table: a single quad with the felt on it, lit far more simply than the dice.
const TABLE_VERT = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform mat4 uProj;
uniform mat4 uView;
varying vec2 vUV;
varying vec3 vWorld;
void main() {
  vUV = aUV;
  vWorld = aPos;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const TABLE_FRAG = `
precision highp float;
varying vec2 vUV;
varying vec3 vWorld;
uniform sampler2D uFelt;
uniform sampler2D uFeltRough;
uniform vec3 uEye;
uniform vec3 uDice[2];      // xyz of each die, so height and offset are both available
uniform vec3 uKey;          // the key light direction, shared with the dice shader

// The felt.
//
// The first pass was one texture multiplied by a brightness, and it read as green paper:
// a woven cloth is not a colour, it is a surface with a direction and a sheen, and a flat
// multiply throws both away. Three things are added here and each is doing a specific job.
void main() {
  // 1. Two samples at different scales. One tileable photo repeated across a big surface
  //    shows its period as a visible plaid; a second, larger, rotated sample breaks it up.
  //    The rotation matters — sampling the same texture twice on the same axes just makes
  //    the plaid darker.
  vec2 uvA = vWorld.xz * 0.42;
  vec2 uvB = vec2(vWorld.x * 0.11 - vWorld.z * 0.07, vWorld.x * 0.07 + vWorld.z * 0.11);
  vec3 fine = texture2D(uFelt, uvA).rgb;
  vec3 broad = texture2D(uFelt, uvB).rgb;
  vec3 felt = mix(fine, broad, 0.35);

  // 2. The nap. Real billiard cloth has a lie to it, and light coming across the weave
  //    catches differently from light going with it. The roughness map already encodes
  //    where the fibres are, so it drives a grazing sheen rather than a mirror highlight.
  float rough = texture2D(uFeltRough, uvA).r;
  vec3 v = normalize(uEye - vWorld);
  // The table is flat, so its normal is known and constant: straight up.
  float graze = pow(1.0 - max(v.y, 0.0), 3.0);
  // Kept small and tinted towards the cloth's own colour. A strong white sheen washes the
  // green straight out — measured at the table centre it turned a (30, 68, 50) felt into
  // a grey (48, 46, 43), which is the "does not look real" that a flat multiply also
  // gives, arrived at from the opposite direction.
  float sheen = graze * (1.0 - rough) * 0.16;

  // 3. The light pool, as before: without it the table is a flat rectangle and the dice
  //    look like they are floating over wallpaper.
  float d = length(vWorld.xz - vec2(1.2, 0.0)) / 6.0;
  float pool = 1.0 - smoothstep(0.1, 1.0, d);

  vec3 lit = felt * (0.30 + pool * 1.45);
  lit += sheen * vec3(0.16, 0.30, 0.22) * (0.3 + pool);

  // --- the shadows.
  //
  // Projected, not painted. The previous version put a round blob at each die's x/z
  // whatever the die was doing: it did not move with the light, did not fade as the die
  // rose, and was circular under an object that is a cube. All three are visible, and
  // together they are why it read as a sticker rather than a shadow.
  //
  // This traces from the surface point back along the key light to the die's height and
  // asks how far the hit lands from the die's centre. That gives a shadow offset in the
  // direction the light actually comes from, softening and weakening with height exactly
  // as a real contact shadow does.
  for (int i = 0; i < 2; i++) {
    vec3 p = uDice[i];
    float h = max(p.y, 0.0);

    // Where this point would be if pushed up to the die's height along the light.
    // uKey points TOWARDS the light, so walking up it by h/uKey.y lands at that plane.
    vec2 lift = uKey.xz * (h / max(uKey.y, 0.15));
    vec2 rel = vWorld.xz + lift - p.xz;

    // A cube's shadow is closer to a rounded square than to a circle. Chebyshev distance
    // gives the square; blending a little Euclidean back in rounds its corners, which is
    // what a radiused die actually casts.
    float square = max(abs(rel.x), abs(rel.y));
    float round_ = length(rel);
    float dist = mix(square, round_, 0.35);

    // A shadow spreads and fades as its caster rises. Both are what tells you a die is in
    // the air rather than resting, and neither existed before.
    float size = 0.52 + h * 0.42;
    float soft = 0.12 + h * 0.30;
    float strength = 0.62 / (1.0 + h * 1.5);

    lit *= 1.0 - strength * (1.0 - smoothstep(size - soft, size + soft, dist));
  }

  lit = (lit * (2.51 * lit + 0.03)) / (lit * (2.43 * lit + 0.59) + 0.14);
  gl_FragColor = vec4(clamp(lit, 0.0, 1.0), 1.0);
}`;

// ------------------------------------------------------------------ geometry
// The matrix and GL helpers that used to live here are in `gl.js` now — fourteen of them,
// character-for-character the same as the copies in `cards3d.js` and `slot3d.js`. What
// remains below is the one piece of geometry that is actually the dice's own.

function roundedBox(gl, radius = 0.18, seg = 10) {
  const pos = [];
  const nrm = [];
  const uv = [];
  const face = [];
  const idx = [];

  // The six faces, each as an origin plus two edge vectors, in the order the die's
  // numbering below expects: +X, -X, +Y, -Y, +Z, -Z.
  const FACES = [
    { o: [1, -1, -1], u: [0, 0, 2], v: [0, 2, 0] },    // +X
    { o: [-1, -1, 1], u: [0, 0, -2], v: [0, 2, 0] },   // -X
    { o: [-1, 1, -1], u: [2, 0, 0], v: [0, 0, 2] },    // +Y
    { o: [-1, -1, 1], u: [2, 0, 0], v: [0, 0, -2] },   // -Y
    { o: [-1, -1, 1], u: [2, 0, 0], v: [0, 2, 0] },    // +Z
    { o: [1, -1, -1], u: [-2, 0, 0], v: [0, 2, 0] },   // -Z
  ];

  const inner = 1 - radius;

  FACES.forEach((f, fi) => {
    const base = pos.length / 3;
    for (let j = 0; j <= seg; j += 1) {
      for (let i = 0; i <= seg; i += 1) {
        const s = i / seg;
        const t = j / seg;
        // The point on the flat face.
        const p = [
          f.o[0] + f.u[0] * s + f.v[0] * t,
          f.o[1] + f.u[1] * s + f.v[1] * t,
          f.o[2] + f.u[2] * s + f.v[2] * t,
        ];
        // Clamp into the inner cube, then push back out by the radius along the direction
        // from the clamped point. On a flat part of the face this is the identity; near
        // an edge or corner it bends the surface into a quarter-round.
        const c = [
          Math.max(-inner, Math.min(inner, p[0])),
          Math.max(-inner, Math.min(inner, p[1])),
          Math.max(-inner, Math.min(inner, p[2])),
        ];
        const d = norm([p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
        pos.push(c[0] + d[0] * radius, c[1] + d[1] * radius, c[2] + d[2] * radius);
        nrm.push(d[0], d[1], d[2]);
        uv.push(s, t);
        // The atlas slot, 0-indexed, baked in rather than looked up. See the note in the
        // fragment shader for why this cannot be a uniform array lookup.
        face.push(FACE_VALUES[fi] - 1);
      }
    }
    for (let j = 0; j < seg; j += 1) {
      for (let i = 0; i < seg; i += 1) {
        const a = base + j * (seg + 1) + i;
        const b = a + 1;
        const c = a + seg + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  });

  const buf = (data, Type, target = gl.ARRAY_BUFFER) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, new Type(data), gl.STATIC_DRAW);
    return b;
  };

  return {
    pos: buf(pos, Float32Array),
    nrm: buf(nrm, Float32Array),
    uv: buf(uv, Float32Array),
    face: buf(face, Float32Array),
    idx: buf(idx, Uint16Array, gl.ELEMENT_ARRAY_BUFFER),
    count: idx.length,
  };
}

/**
 * Which pip value sits on each of the six cube faces.
 *
 * Opposite faces of a real die sum to seven, and that is not decoration — a die that
 * breaks it is visibly wrong to anyone who has played anything. Face order matches
 * `FACES` above: +X, -X, +Y, -Y, +Z, -Z.
 *
 * The values are 1-indexed pip counts; the shader wants 0-indexed atlas slots.
 */
const FACE_VALUES = [3, 4, 1, 6, 2, 5];

/**
 * The rotation that brings a given pip value to face the sky.
 *
 * Worked out from FACE_VALUES rather than guessed: find which axis carries that value,
 * then turn that axis to +Y. These are the *resting* orientations the tumble must land
 * on, so getting them wrong means the animation ends showing the wrong number — the one
 * failure in this file that a player would actually catch.
 */
const RESTING = {
  1: [0, 0, 0],                        // +Y already up
  6: [Math.PI, 0, 0],                  // -Y up
  2: [-Math.PI / 2, 0, 0],             // +Z up
  5: [Math.PI / 2, 0, 0],              // -Z up
  3: [0, 0, Math.PI / 2],              // +X up
  4: [0, 0, -Math.PI / 2],             // -X up
};

/**
 * Every orientation that shows a given face, not just one.
 *
 * `RESTING` above gives ONE pose per face. But a cube sitting with face `v` upward has
 * FOUR — the same face stays up through any quarter turn about the vertical axis. With
 * only one target, a die that finished its tumble a quarter turn away had to rotate up to
 * 180 degrees to reach it, and that final swing is what read as the die teleporting onto
 * its answer rather than rolling to a stop.
 *
 * Generated rather than typed. All 24 orientations of a cube are combinations of quarter
 * turns, so this enumerates every triple of multiples of PI/2, throws away the ones that
 * are the same rotation written differently — Euler angles alias, and 64 triples collapse
 * to 24 rotations — keeps those that leave a face squarely up, and buckets them by which
 * face that is. Typing out 24 triples by hand would be 24 chances to put one wrong, and
 * a wrong one shows the player the wrong number.
 */
const RESTING_ALL = (() => {
  const Q = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const mul3 = (a, b) => {
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
  // The same Z-then-Y-then-X composition `rotation()` uses. If that ever changes, this
  // must change with it, and the test that checks every candidate shows the right face
  // will say so.
  const rot3 = (rx, ry, rz) => {
    const cx = Math.cos(rx); const sx = Math.sin(rx);
    const cy = Math.cos(ry); const sy = Math.sin(ry);
    const cz = Math.cos(rz); const sz = Math.sin(rz);
    const X = [1, 0, 0, 0, cx, sx, 0, -sx, cx];
    const Y = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
    const Z = [cz, sz, 0, -sz, cz, 0, 0, 0, 1];
    return mul3(Z, mul3(Y, X));
  };
  const apply3 = (m, v) => [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
  const NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  const seen = new Map();
  for (const rx of Q) {
    for (const ry of Q) {
      for (const rz of Q) {
        const m = rot3(rx, ry, rz);
        // Dedupe by the MATRIX, not the angles. Euler triples alias badly — (1, 2, 2) and
        // (-1, 0, 0) quarter turns are the SAME rotation — so 64 triples collapse to 24.
        const key = m.map((x) => Math.round(x)).join(',');
        if (!seen.has(key)) seen.set(key, [rx, ry, rz]);
      }
    }
  }

  const out = {};
  for (const euler of seen.values()) {
    const m = rot3(...euler);
    let best = 0;
    let bestY = -Infinity;
    NORMALS.forEach((n, i) => {
      const y = apply3(m, n)[1];
      if (y > bestY) { bestY = y; best = i; }
    });
    // Square to the table only: a cube balanced on an edge is not resting.
    if (bestY < 0.999) continue;
    const value = FACE_VALUES[best];
    (out[value] = out[value] || []).push(euler);
  }

  // Keep the canonical pose as each face's first candidate.
  //
  // The generator picks whichever alias it happened to meet first, which is not
  // necessarily the one `RESTING` names — face 2's canonical (-1, 0, 0) came out as
  // (1, 2, 2), the same rotation written differently. That is harmless for the physics
  // and confusing for everything else, so the canonical form is substituted back in.
  for (let v = 1; v <= 6; v += 1) {
    const canon = RESTING[v];
    const mc = rot3(...canon).map((x) => Math.round(x)).join(',');
    out[v] = out[v].map((e) => (rot3(...e).map((x) => Math.round(x)).join(',') === mc
      ? canon.slice()
      : e));
  }
  return out;
})();

/** Shortest signed angle, in (-PI, PI]. */
function wrapAngle(a) {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

/**
 * Of the four poses that show this die's face, the one it is already closest to.
 *
 * "Closest" is the real angle between two orientations, not the sum of their Euler
 * differences. Those are not the same thing and the difference matters here: Euler
 * angles alias, so two triples that look far apart on paper can be the identical
 * rotation, and the naive sum picks a pose that is further away in the only sense a
 * viewer cares about. The angle comes from the trace of R1 transpose times R2, which is
 * the standard way and needs no quaternions.
 *
 * Chosen when the tumble ends rather than at launch, because only then is the arrival
 * pose known. This is what bounds the final turn at a quarter turn instead of a half, and
 * it is the difference between a die tipping onto its face and a die spinning to its
 * answer.
 */
function nearestRest(value, rot) {
  const candidates = RESTING_ALL[value] || [RESTING[value] || [0, 0, 0]];
  const mul3 = (a, b) => {
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
  const rot3 = (rx, ry, rz) => {
    const cx = Math.cos(rx); const sx = Math.sin(rx);
    const cy = Math.cos(ry); const sy = Math.sin(ry);
    const cz = Math.cos(rz); const sz = Math.sin(rz);
    return mul3([cz, sz, 0, -sz, cz, 0, 0, 0, 1],
      mul3([cy, 0, -sy, 0, 1, 0, sy, 0, cy], [1, 0, 0, 0, cx, sx, 0, -sx, cx]));
  };
  const here = rot3(rot[0], rot[1], rot[2]);
  const transpose = [here[0], here[3], here[6], here[1], here[4], here[7],
    here[2], here[5], here[8]];

  let best = candidates[0];
  let bestAngle = Infinity;
  for (const c of candidates) {
    const rel = mul3(transpose, rot3(c[0], c[1], c[2]));
    const trace = rel[0] + rel[4] + rel[8];
    const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
    if (angle < bestAngle) { bestAngle = angle; best = c; }
  }

  // Return it in the turn frame the die is already in, so the servo walks the short way
  // rather than unwinding several turns of accumulated tumble.
  return best.map((a, i) => rot[i] + wrapAngle(a - rot[i]));
}


const easeOut = (t) => 1 - (1 - t) ** 3;

/**
 * Build the dice table.
 *
 * Returns null if WebGL cannot be had — old hardware, a blocked context, software
 * rendering off. The caller keeps whatever flat fallback it has: dice that do not draw
 * are worse than dice drawn plainly.
 */
export function createDice(host, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'dice-canvas';
  host.appendChild(canvas);

  const gl = canvas.getContext('webgl', {
    antialias: true, alpha: false, premultipliedAlpha: false,
  }) || canvas.getContext('experimental-webgl');
  if (!gl) {
    canvas.remove();
    return null;
  }

  let progDice;
  let progTable;
  try {
    progDice = program(gl, VERT, FRAG);
    progTable = program(gl, TABLE_VERT, TABLE_FRAG);
  } catch (e) {
    canvas.remove();
    return null;
  }

  /**
   * Every attribute and uniform location, looked up once.
   *
   * `draw()` used to call `getAttribLocation`/`getUniformLocation` twenty-five times per
   * frame — thirteen uniforms and six attributes for the dice, six more for the table.
   * They cannot change while the program lives, so at 60fps that was 1,500 lookups a
   * second for answers that were already known. In Chrome's multi-process model these can
   * force a synchronous hop to the GPU process, so they are not merely a hash lookup.
   */
  const D = locations(gl, progDice, {
    attrs: ['aPos', 'aNormal', 'aUV', 'aFace'],
    uniforms: ['uProj', 'uView', 'uEye', 'uKey', 'uBody', 'uRough', 'uPips',
      'uModel', 'uNormalMat', 'uTint', 'uWear', 'uGrain'],
  });
  const T = locations(gl, progTable, {
    attrs: ['aPos', 'aUV'],
    uniforms: ['uProj', 'uView', 'uFelt', 'uFeltRough', 'uEye', 'uKey', 'uDice'],
  });

  /**
   * Scratch buffers, filled in place rather than reallocated.
   *
   * `draw()` allocated about thirty Float32Arrays a frame — eighteen hundred a second —
   * including the camera position and the light direction, which are constants, boxed
   * fresh twice each per frame. Short-lived garbage on a 16ms budget does not lower the
   * average frame rate; it produces a hitch every few hundred frames, which is exactly
   * what reads as "the dice stutter".
   */
  const EYE = new Float32Array(3);
  const KEY = new Float32Array(KEY_DIR);
  const DICE_XZ = new Float32Array(6);
  const TINT = new Float32Array(3);
  const GRAIN = new Float32Array(2);

  const box = roundedBox(gl);
  const base = opts.textures || '/textures/';
  const material = opts.material === 'resin' ? 'dice-resin' : 'dice-bone';
  // A repaint when each texture lands. Cheap, and it is the difference between a table
  // that turns green a moment after opening and one that never does.
  // Guarded, because a cached image can fire `onload` synchronously — before `raf` is
  // even declared, which is a temporal-dead-zone throw rather than a quiet no-op.
  const repaint = () => {
    try { if (raf === null) draw(); } catch { /* not built yet; the next frame covers it */ }
  };
  const texBody = loadTexture(gl, `${base}${material}.jpg`, { onReady: repaint });
  const texRough = loadTexture(gl, `${base}${material}-rough.jpg`, { onReady: repaint });
  const texPips = loadTexture(gl, `${base}dice-pips.png`, { repeat: false, onReady: repaint });
  const texFelt = loadTexture(gl, `${base}felt-table.jpg`, { onReady: repaint });
  const texFeltRough = loadTexture(gl, `${base}felt-table-rough.jpg`, { onReady: repaint });

  // The table quad, big enough that its edges are never in frame.
  const tableBuf = (() => {
    const s = 9;
    const verts = new Float32Array([
      -s, 0, -s, 0, 0, s, 0, -s, 1, 0, s, 0, s, 1, 1,
      -s, 0, -s, 0, 0, s, 0, s, 1, 1, -s, 0, s, 0, 1,
    ]);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    return b;
  })();

  const baseTint = opts.material === 'resin'
    ? [1.0, 0.62, 0.58]
    : [1.0, 0.97, 0.92];

  /**
   * Give each die its own character.
   *
   * Two dice drawn from one mesh with one material are the same object twice, and the eye
   * catches it even when it cannot say why — the same scratch sits in the same corner of
   * both. None of this is randomised per throw: a die is a physical thing a player sees
   * repeatedly, so its character is fixed when the table is built and stays put.
   */
  const character = (i) => ({
    // A different corner of the same material, so each die has its own grain and wear.
    grain: [0.09 + i * 0.37, 0.23 + i * 0.29],
    // One a shade warmer than the other, the way two pieces of bone never match.
    tint: baseTint.map((c, k) => c * (1 + (i === 0 ? 0.015 : -0.02) * (k === 2 ? 2 : 1))),
    // And one more played-with than the other.
    wear: i === 0 ? 0.28 : 0.55,
  });

  // Where each die comes to rest. Apart, and slightly off-centre, so they read as two
  // objects that were thrown rather than two copies of one.
  const REST = [[-1.35, 0.5, 0.35], [1.35, 0.5, -0.3]];

  const dice = [0, 1].map((i) => ({
    ...character(i),
    value: 1,
    pos: REST[i].slice(),
    vel: [0, 0, 0],
    rot: [0, 0, 0],
    spin: [0, 0, 0],          // radians per second, per axis
    rest: [0, 0, 0],          // the pose that shows this die's face
    settling: false,
  }));

  // --------------------------------------------------------------- physics
  //
  // A real throw, not an interpolation.
  //
  // The first version tweened each die from off-screen to its resting place and spun it
  // by a decaying amount. It arrived correctly and looked wrong for two reasons: the dice
  // never touched anything, and the spin was a fixed number of turns crammed into the
  // duration, which at close range is a blur rather than a tumble.
  //
  // So this integrates instead. Velocity, gravity, a floor, four walls and a die-vs-die
  // test — enough that the dice bounce, ricochet off each other and scatter differently
  // every throw. Everything is in the board's own units; the numbers below were tuned by
  // watching, which is the honest way to say it.
  //
  // WHAT THE PHYSICS IS NOT ALLOWED TO DO
  //
  // Decide the result. The seed already did that. A simulation that read whichever face
  // happened to land up would be unverifiable — floating point differs between machines
  // and nobody could replay it. So the collisions are real, the scatter is real, and the
  // FINAL ORIENTATION is steered: once a die has spent its energy, its rotation is eased
  // onto the pose that shows the face the server sent. The die tumbles honestly and then
  // settles deliberately, and the seam between the two is hidden by the settle being
  // shortest-path from wherever the tumble left it.

  const GRAVITY = -26;         // board units per second squared
  const FLOOR = 0.5;           // the centre of a die at rest, i.e. its half-height
  const WALL_X = 3.9;          // the table's invisible edges, inside the felt
  const WALL_Z = 2.1;
  const RESTITUTION = 0.52;    // how much speed survives a bounce off the table
  const WALL_BOUNCE = 0.62;    // walls are harder than felt
  // Two kinds of loss, and separating them is what fixes the die that stopped dead.
  //
  // FRICTION and SPIN_DAMP are IMPULSIVE: the hit itself costs something, applied once
  // per bounce. They used to be 0.94 and 0.84, which took 16% of the tumble at every
  // contact — and because a die bounces several times in the first half second, most of
  // the spin was gone before it had rolled anywhere.
  //
  // ROLL_FRICTION and SPIN_FRICTION are CONTINUOUS, per second, while a die is on the
  // felt. That is the right shape: friction acts while something slides, not once when it
  // lands. Applied as an exponential decay so a 30Hz device loses the same energy per
  // second as a 60Hz one rather than twice as much.
  const FRICTION = 0.985;      // impulsive: what one bounce costs horizontally
  const SPIN_DAMP = 0.96;      // impulsive: what one bounce costs the tumble
  const ROLL_FRICTION = 2.2;   // per second on the felt: lateral speed halves every 0.32s
  const SPIN_FRICTION = 2.6;   // per second on the felt: about 1.5 more tumbles after landing
  const DIE_RADIUS = 0.58;     // for the die-vs-die test, a sphere is close enough

  /**
   * How slow is stopped.
   *
   * With continuous friction this is what actually ends a throw, rather than the frame
   * ceiling. It was 0.40, which cut the roll-out short; at 0.12 the die creeps to a halt
   * over about another half second, which is the part a player reads as "it rolled".
   */
  const ASLEEP = 0.12;

  /** Below this, a bounce is not a bounce. Was an unnamed 0.9, which ate most of them. */
  const BOUNCE_FLOOR = 0.25;

  /** How hard the die is turned onto its face once it has stopped, in 1/seconds. */
  const SETTLE_RATE = 7.0;

  /**
   * One die-vs-die collision, as two spheres.
   *
   * A box-box contact would be more correct and would cost far more code for a difference
   * nobody can see at this size and speed. What matters is that they visibly knock each
   * other off course rather than passing through, and that the pair conserves momentum so
   * neither gains energy from the exchange.
   */
  function collide(a, b) {
    const dx = b.pos[0] - a.pos[0];
    const dy = b.pos[1] - a.pos[1];
    const dz = b.pos[2] - a.pos[2];
    const dist = Math.hypot(dx, dy, dz);
    const min = DIE_RADIUS * 2;
    if (dist >= min || dist < 1e-6) return;

    const nx = dx / dist;
    const ny = dy / dist;
    const nz = dz / dist;

    // Push them apart first. Without this they can overlap on one frame and be resolved
    // twice on the next, which reads as the dice sticking together — the "collisions
    // should not persist" failure.
    const overlap = (min - dist) / 2;
    a.pos[0] -= nx * overlap; a.pos[1] -= ny * overlap; a.pos[2] -= nz * overlap;
    b.pos[0] += nx * overlap; b.pos[1] += ny * overlap; b.pos[2] += nz * overlap;

    // Relative speed along the normal. If they are already separating, leave them alone:
    // resolving a separating pair is what makes two objects vibrate against each other.
    const rvx = b.vel[0] - a.vel[0];
    const rvy = b.vel[1] - a.vel[1];
    const rvz = b.vel[2] - a.vel[2];
    const along = rvx * nx + rvy * ny + rvz * nz;
    if (along > 0) return;

    // Equal masses, so the impulse splits evenly.
    const j = -(1 + 0.55) * along / 2;
    a.vel[0] -= j * nx; a.vel[1] -= j * ny; a.vel[2] -= j * nz;
    b.vel[0] += j * nx; b.vel[1] += j * ny; b.vel[2] += j * nz;

    // A knock sets them spinning, which is most of what makes the hit read as a hit.
    for (let i = 0; i < 3; i += 1) {
      a.spin[i] -= j * 1.6 * (Math.random() - 0.5);
      b.spin[i] += j * 1.6 * (Math.random() - 0.5);
    }

    // And put them back inside the table.
    //
    // The separation above moves a die without asking where it is, and `step` has already
    // run for this frame — so a die shoved out of an overlap near the edge lands outside
    // the wall with nothing left to catch it, and from there it simply keeps going. Found
    // by simulating 500 throws headlessly, where it escaped on one of them.
    confine(a);
    confine(b);
  }

  /** Keep a die inside the table. Cheap, and safe to call as often as needed. */
  function confine(d) {
    if (d.pos[0] < -WALL_X) { d.pos[0] = -WALL_X; d.vel[0] = Math.abs(d.vel[0]) * WALL_BOUNCE; }
    if (d.pos[0] > WALL_X) { d.pos[0] = WALL_X; d.vel[0] = -Math.abs(d.vel[0]) * WALL_BOUNCE; }
    if (d.pos[2] < -WALL_Z) { d.pos[2] = -WALL_Z; d.vel[2] = Math.abs(d.vel[2]) * WALL_BOUNCE; }
    if (d.pos[2] > WALL_Z) { d.pos[2] = WALL_Z; d.vel[2] = -Math.abs(d.vel[2]) * WALL_BOUNCE; }
    if (d.pos[1] < FLOOR) d.pos[1] = FLOOR;
  }

  /** Advance one die by `dt` seconds against the table. */
  function step(d, dt) {
    d.vel[1] += GRAVITY * dt;
    d.pos[0] += d.vel[0] * dt;
    d.pos[1] += d.vel[1] * dt;
    d.pos[2] += d.vel[2] * dt;
    for (let i = 0; i < 3; i += 1) d.rot[i] += d.spin[i] * dt;

    // The floor.
    if (d.pos[1] < FLOOR) {
      d.pos[1] = FLOOR;
      if (d.vel[1] < 0) {
        d.vel[1] = -d.vel[1] * RESTITUTION;
        // Below a threshold a bounce is not a bounce, it is a die buzzing against the
        // felt forever. This used to be 0.9, which killed the bounce on the second or
        // third contact and took the rest of the throw with it.
        if (d.vel[1] < BOUNCE_FLOOR) d.vel[1] = 0;
        // What the impact itself costs. Small now: the sliding loss below does the work.
        d.vel[0] *= FRICTION;
        d.vel[2] *= FRICTION;
        for (let i = 0; i < 3; i += 1) d.spin[i] *= SPIN_DAMP;
      }
    }

    // Rolling and sliding, while the die is on the felt.
    //
    // This is the term that was missing, and its absence is the whole reported bug: with
    // friction applied only on impact, a die that had stopped bouncing had nothing slowing
    // it at all, so the only thing that could end a throw was a frame ceiling. Now it
    // slides, decelerates and comes to rest the way an object on cloth does.
    if (d.pos[1] <= FLOOR + 0.01) {
      const slide = Math.exp(-ROLL_FRICTION * dt);
      const turn = Math.exp(-SPIN_FRICTION * dt);
      d.vel[0] *= slide;
      d.vel[2] *= slide;
      for (let i = 0; i < 3; i += 1) d.spin[i] *= turn;
    }

    // The walls. Reflect and lose a little, so a die thrown hard ricochets back into
    // play instead of leaving the table.
    confine(d);
  }

  /** Is this die still worth simulating? */
  const moving = (d) => Math.hypot(...d.vel) > ASLEEP
    || Math.abs(d.spin[0]) + Math.abs(d.spin[1]) + Math.abs(d.spin[2]) > ASLEEP
    || d.pos[1] > FLOOR + 0.02;

  /**
   * Bring a rotation onto its resting pose by the shortest way round.
   *
   * The tumble leaves each axis at some arbitrary angle. Easing straight to the target
   * would often take the long way — up to a full turn of unnecessary rotation right at
   * the end, which is the most visible moment. Reducing the difference into (-PI, PI]
   * first makes every settle a short, plausible final quarter-turn.
   */
  function settleTowards(d) {
    for (let i = 0; i < 3; i += 1) {
      // Drive the SPIN towards closing the gap, and let `step` integrate it. Writing
      // `rot` directly — which is what this did — meant rotation ran on its own clock
      // while position ran on none at all, and the die stopped moving the instant it
      // started righting itself.
      d.spin[i] = wrapAngle(d.rest[i] - d.rot[i]) * SETTLE_RATE;
    }
  }

  let t0 = 0;
  let last = 0;
  let duration = 0;
  let raf = null;
  let onDone = null;
  let bail = null;

  function resize() {
    const w = host.clientWidth || 640;
    const h = opts.height || Math.round(w * 0.62);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.setProperty('width', `${w}px`);
    canvas.style.setProperty('height', `${h}px`);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // The camera.
  //
  // Far enough back that the whole playable area is in frame with room around it. The
  // first pass sat at 8.2 against a table 7.8 units across and the dice filled the canvas
  // and clipped its edge — the geometry was right and the framing was wrong, which looks
  // like a rendering fault. The walls are at +/-3.9 and +/-2.1, so the view has to cover
  // roughly 8 by 4.5 units plus a margin.
  const eye = [1.2, 10.5, 12.0];
  // Aimed at where the dice actually come to rest, not the table's centre: they are
  // thrown from the left and carry momentum, so measured over 300 throws they settle
  // around x = 1.2. Framing the geometric centre put them in the corner.
  const view = lookAt(eye, [1.2, 0.3, 0], [0, 1, 0]);

  function draw() {
    const aspect = canvas.width / Math.max(1, canvas.height);
    const proj = perspective(0.72, aspect, 0.1, 60);

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.043, 0.055, 0.047, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // --- the table first, so the dice draw over it.
    gl.useProgram(progTable);
    gl.bindBuffer(gl.ARRAY_BUFFER, tableBuf);
    const tPos = T.a.aPos;
    const tUV = T.a.aUV;
    gl.enableVertexAttribArray(tPos);
    gl.vertexAttribPointer(tPos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(tUV);
    gl.vertexAttribPointer(tUV, 2, gl.FLOAT, false, 20, 12);
    gl.uniformMatrix4fv(T.u.uProj, false, proj);
    gl.uniformMatrix4fv(T.u.uView, false, view);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texFelt);
    gl.uniform1i(T.u.uFelt, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texFeltRough);
    gl.uniform1i(T.u.uFeltRough, 1);
    EYE.set(eye);
    gl.uniform3fv(T.u.uEye, EYE);
    // The same key direction the dice are lit by, so the shadows fall the way the
    // highlights say they should. Two shaders disagreeing about where the light is is
    // the sort of thing nobody can name but everybody can see.
    gl.uniform3fv(T.u.uKey, KEY);
    DICE_XZ[0] = dice[0].pos[0]; DICE_XZ[1] = dice[0].pos[1] - FLOOR;
    DICE_XZ[2] = dice[0].pos[2];
    DICE_XZ[3] = dice[1].pos[0]; DICE_XZ[4] = dice[1].pos[1] - FLOOR;
    DICE_XZ[5] = dice[1].pos[2];
    gl.uniform3fv(T.u.uDice, DICE_XZ);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- the dice.
    gl.useProgram(progDice);
    const aPos = D.a.aPos;
    const aNormal = D.a.aNormal;
    const aUV = D.a.aUV;
    const aFace = D.a.aFace;

    gl.bindBuffer(gl.ARRAY_BUFFER, box.pos);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, box.nrm);
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, box.uv);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, box.face);
    gl.enableVertexAttribArray(aFace);
    gl.vertexAttribPointer(aFace, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, box.idx);

    gl.uniformMatrix4fv(D.u.uProj, false, proj);
    gl.uniformMatrix4fv(D.u.uView, false, view);
    gl.uniform3fv(D.u.uEye, EYE);
    gl.uniform3fv(D.u.uKey, KEY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texBody);
    gl.uniform1i(D.u.uBody, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texRough);
    gl.uniform1i(D.u.uRough, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texPips);
    gl.uniform1i(D.u.uPips, 2);

    const uModel = D.u.uModel;
    const uNormalMat = D.u.uNormalMat;

    const uTint = D.u.uTint;
    const uWear = D.u.uWear;
    const uGrain = D.u.uGrain;

    for (const d of dice) {
      // Each die is its own object, not two copies of one.
      //
      // A matched pair is what a factory ships; a pair that has been played with is not.
      // One reads a different corner of the material, one is slightly warmer, and one is
      // more worn — small enough that nobody would name any of it, large enough that the
      // two stop looking like the same mesh drawn twice.
      TINT.set(d.tint);
      gl.uniform3fv(uTint, TINT);
      gl.uniform1f(uWear, d.wear);
      GRAIN.set(d.grain);
      gl.uniform2fv(uGrain, GRAIN);

      const model = multiply(
        translation(d.pos[0], d.pos[1], d.pos[2]),
        multiply(rotation(d.rot[0], d.rot[1], d.rot[2]), scaling(0.5)),
      );
      gl.uniformMatrix4fv(uModel, false, model);
      gl.uniformMatrix3fv(uNormalMat, false, normalMatrix(model));
      gl.drawElements(gl.TRIANGLES, box.count, gl.UNSIGNED_SHORT, 0);
    }
  }

  function frame(now) {
    if (!t0) t0 = now;
    if (!last) last = now;
    // Clamped, because a tab that was backgrounded hands back a gap of seconds and an
    // unclamped step would teleport the dice through the table.
    const dt = Math.min((now - last) / 1000, 0.04);
    last = now;
    const elapsed = now - t0;

    // Every die is stepped, settling or not.
    //
    // The old loop ran `step` only while tumbling and replaced it with a lerp once the
    // die began righting itself — so gravity, friction, the walls and the other die all
    // stopped applying at the exact moment the player was watching most closely. The die
    // froze where it stood and rotated onto its answer. Now settling only changes WHO
    // OWNS THE SPIN: the servo writes it, `step` integrates it, and the die keeps
    // sliding to a halt while it tips onto its face.
    let busy = false;
    for (const d of dice) step(d, dt);
    collide(dice[0], dice[1]);

    for (const d of dice) {
      if (!d.settling && !moving(d)) {
        // The tumble is spent. Pick the target NOW, against the pose it actually
        // arrived in, so the last turn is the short way round.
        d.settling = true;
        d.rest = nearestRest(d.value, d.rot);
      }
      if (d.settling) {
        settleTowards(d);
        const off = Math.abs(wrapAngle(d.rest[0] - d.rot[0]))
          + Math.abs(wrapAngle(d.rest[1] - d.rot[1]))
          + Math.abs(wrapAngle(d.rest[2] - d.rot[2]));
        // Still turning, or still sliding: either one means the throw is not over.
        if (off > 0.01 || moving(d)) busy = true;
      } else {
        busy = true;
      }
    }

    draw();

    // A hard ceiling on the whole throw. Physics can always find a way to keep a die
    // twitching, and a round that will not end is worse than one that ends abruptly.
    const overrun = elapsed > duration;
    if (busy && !overrun) {
      raf = requestAnimationFrame(frame);
    } else {
      for (let i = 0; i < dice.length; i += 1) {
        dice[i].rot = dice[i].rest.slice();
        dice[i].pos[1] = FLOOR;
        dice[i].vel = [0, 0, 0];
        dice[i].spin = [0, 0, 0];
      }
      draw();
      raf = null;
      last = 0;
      clearTimeout(bail);
      const done = onDone;
      onDone = null;
      if (done) done();
    }
  }

  resize();
  draw();

  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { resize(); draw(); })
    : null;
  ro?.observe(host);

  return {
    canvas,

    /**
     * Throw the dice, landing on `faces`.
     *
     * The result is an input, not an output. `faces` came from the server, which drew it
     * from the round's seed — this stages the arrival and nothing more.
     *
     * The throw itself is simulated: each die is launched with a velocity and a spin, and
     * from there gravity, the table, the walls and the other die decide where it goes.
     * That part is genuinely unpredictable and different every time. Only the final
     * orientation is steered, once the die has stopped moving.
     *
     * `ms` is a CEILING, not a duration: a throw that settles sooner ends sooner. It has
     * to cover the roll-out — flight, bounces, slide and the final tip — or the ceiling
     * truncates the motion and the snap at the end becomes visible.
     */
    roll(faces, { ms = 3400 } = {}) {
      const values = Array.isArray(faces) && faces.length === 2 ? faces : [1, 1];
      return new Promise((resolve) => {
        values.forEach((v, i) => {
          const d = dice[i];
          d.value = v;
          d.rest = (RESTING[v] || [0, 0, 0]).slice();
          d.settling = false;

          // Thrown in from the left, across the table. The two dice start apart and with
          // different speeds, so they arrive out of step and have a chance to hit each
          // other on the way rather than travelling as one object.
          // Aimed slightly inward from opposite sides of the table, so their paths
          // cross and they have a real chance of hitting each other on the way. Thrown
          // apart they simply never met: measured over 400 throws, converging the launch
          // lines and loosening the damping took die-on-die contacts from 0.2 a throw to
          // 0.8 — from "almost never" to "most throws".
          const z = 1.3 - i * 2.6;
          const toward = z > 0 ? -1 : 1;
          d.pos = [-3.5 - i * 0.4, 2.7, z];
          d.vel = [
            7.4 + Math.random() * 2.6,
            1.5 + Math.random() * 1.4,
            toward * (3.2 + Math.random() * 2.0),
          ];

          // Angular speed in radians per second.
          //
          // This used to be a fixed number of whole turns crammed into the duration,
          // which at this distance was a blur rather than a tumble — you could not see
          // the faces go past. Now it is a rate, slow enough to read: about one and a
          // half turns a second, which is roughly what a real die does across a table.
          const rate = () => (Math.random() * 2 - 1) * 9 - Math.sign(Math.random() - 0.5) * 3;
          d.spin = [rate(), rate(), rate()];
          d.rot = [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28];
        });
        t0 = 0;
        last = 0;
        duration = ms;
        onDone = resolve;
        if (raf === null) raf = requestAnimationFrame(frame);

        // A throw must always finish, even when it is never drawn.
        //
        // A browser suspends `requestAnimationFrame` in a hidden tab, so a player who
        // switches apps mid-throw would otherwise wait on a promise that can never
        // settle: the bet is placed, the money has moved, and the result never appears.
        // The fallback puts the dice down at their final pose and resolves. It is the
        // same rule the rest of the site follows — the animation is decoration, and
        // decoration must never be load-bearing.
        clearTimeout(bail);
        bail = setTimeout(() => {
          if (!onDone) return;
          for (let i = 0; i < dice.length; i += 1) {
            dice[i].pos = REST[i].slice();
            dice[i].rot = (RESTING[dice[i].value] || [0, 0, 0]).slice();
            dice[i].vel = [0, 0, 0];
            dice[i].spin = [0, 0, 0];
          }
          if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
          draw();
          const done = onDone;
          onDone = null;
          done();
        }, ms + 600);
      });
    },

    /** Put the dice down showing these faces, with no animation. */
    show(faces) {
      const values = Array.isArray(faces) && faces.length === 2 ? faces : [1, 1];
      values.forEach((v, i) => {
        dice[i].value = v;
        dice[i].pos = REST[i].slice();
        dice[i].rot = (RESTING[v] || [0, 0, 0]).slice();
        dice[i].vel = [0, 0, 0];
        dice[i].spin = [0, 0, 0];
        dice[i].settling = false;
      });
      draw();
    },

    destroy() {
      clearTimeout(bail);
      if (raf !== null) cancelAnimationFrame(raf);
      ro?.disconnect();
      canvas.remove();
    },
  };
}

export { FACE_VALUES, RESTING, RESTING_ALL, nearestRest, wrapAngle };
