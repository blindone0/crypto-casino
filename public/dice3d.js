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
const KEY_DIR = (() => {
  const v = [-0.45, 1.0, 0.55];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

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

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`shader: ${log}`);
  }
  return s;
}

function program(gl, vertSrc, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

// --------------------------------------------------------------------- maths
//
// Written out rather than imported, which is the trade this file exists to make. Column
// major, matching what WebGL expects, and the same convention slot3d.js uses.

const perspective = (fovy, aspect, near, far) => {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
};

/** A camera looking at a point, built the usual way from three basis vectors. */
function lookAt(eye, target, up) {
  const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function translation(x, y, z) {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

function scaling(s) {
  const m = identity();
  m[0] = s; m[5] = s; m[10] = s;
  return m;
}

/** Rotation from Euler angles, applied X then Y then Z. */
function rotation(rx, ry, rz) {
  const cx = Math.cos(rx); const sx = Math.sin(rx);
  const cy = Math.cos(ry); const sy = Math.sin(ry);
  const cz = Math.cos(rz); const sz = Math.sin(rz);
  const x = identity(); x[5] = cx; x[6] = sx; x[9] = -sx; x[10] = cx;
  const y = identity(); y[0] = cy; y[2] = -sy; y[8] = sy; y[10] = cy;
  const z = identity(); z[0] = cz; z[1] = sz; z[4] = -sz; z[5] = cz;
  return multiply(z, multiply(y, x));
}

/** The upper-left 3x3, for transforming normals. Uniform scale only, so no inverse. */
function normalMatrix(m) {
  return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
}

// ------------------------------------------------------------------ geometry

/**
 * A cube with rounded edges and corners.
 *
 * Built by subdividing each face into a grid and pushing every vertex out onto a
 * "squircle" — the point is moved towards the surface of a rounded box by clamping its
 * position to the inner cube and adding a radius along the direction to it. That gives
 * real curvature at the edges with correct normals, which is what the highlight needs;
 * a bevelled cube with flat chamfers reads as a machined part rather than a die.
 *
 * `aFace` carries which of the six faces a vertex belongs to, so the fragment shader can
 * pick the right pips out of the atlas. The UVs are per face, 0..1, so a face's material
 * and its pips line up.
 */
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

function loadTexture(gl, url, { repeat = true, onReady = null } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // One grey pixel until the real image arrives, so the first frames are not black.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([160, 160, 160, 255]));

  const img = new Image();
  img.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    // WebGL 1 cannot REPEAT a non-power-of-two texture, and silently renders black if
    // asked to. The materials are all 512 and the pip atlas is 1536x256 — that one is
    // NPOT on its long edge, so it must clamp and must not be mipmapped.
    const pot = (n) => (n & (n - 1)) === 0;
    const canRepeat = repeat && pot(img.width) && pot(img.height);
    if (canRepeat) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Repaint, or a still frame drawn before this arrived keeps the grey placeholder for
    // good. `show()` draws exactly once, so a table opened and left alone would stay grey
    // until something else happened to trigger a frame — which, on a game that only
    // animates when you throw, could be never.
    if (onReady) onReady();
  };
  img.src = url;
  return tex;
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
  const FRICTION = 0.94;       // horizontal damping on each floor contact
  const SPIN_DAMP = 0.84;      // a bounce costs angular speed too
  const DIE_RADIUS = 0.58;     // for the die-vs-die test, a sphere is close enough

  /** How fast a die must be moving to still count as tumbling. */
  const ASLEEP = 0.40;

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
        // felt forever. Kill it rather than let it ring.
        if (d.vel[1] < 0.9) d.vel[1] = 0;
        d.vel[0] *= FRICTION;
        d.vel[2] *= FRICTION;
        for (let i = 0; i < 3; i += 1) d.spin[i] *= SPIN_DAMP;
      }
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
  function settleTowards(d, k) {
    for (let i = 0; i < 3; i += 1) {
      let diff = d.rest[i] - d.rot[i];
      diff -= Math.PI * 2 * Math.round(diff / (Math.PI * 2));
      d.rot[i] += diff * k;
      d.spin[i] *= 0.6;
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
    const tPos = gl.getAttribLocation(progTable, 'aPos');
    const tUV = gl.getAttribLocation(progTable, 'aUV');
    gl.enableVertexAttribArray(tPos);
    gl.vertexAttribPointer(tPos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(tUV);
    gl.vertexAttribPointer(tUV, 2, gl.FLOAT, false, 20, 12);
    gl.uniformMatrix4fv(gl.getUniformLocation(progTable, 'uProj'), false, proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(progTable, 'uView'), false, view);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texFelt);
    gl.uniform1i(gl.getUniformLocation(progTable, 'uFelt'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texFeltRough);
    gl.uniform1i(gl.getUniformLocation(progTable, 'uFeltRough'), 1);
    gl.uniform3fv(gl.getUniformLocation(progTable, 'uEye'), new Float32Array(eye));
    // The same key direction the dice are lit by, so the shadows fall the way the
    // highlights say they should. Two shaders disagreeing about where the light is is
    // the sort of thing nobody can name but everybody can see.
    gl.uniform3fv(gl.getUniformLocation(progTable, 'uKey'), new Float32Array(KEY_DIR));
    gl.uniform3fv(gl.getUniformLocation(progTable, 'uDice'), new Float32Array([
      dice[0].pos[0], dice[0].pos[1] - FLOOR, dice[0].pos[2],
      dice[1].pos[0], dice[1].pos[1] - FLOOR, dice[1].pos[2],
    ]));
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- the dice.
    gl.useProgram(progDice);
    const aPos = gl.getAttribLocation(progDice, 'aPos');
    const aNormal = gl.getAttribLocation(progDice, 'aNormal');
    const aUV = gl.getAttribLocation(progDice, 'aUV');
    const aFace = gl.getAttribLocation(progDice, 'aFace');

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

    gl.uniformMatrix4fv(gl.getUniformLocation(progDice, 'uProj'), false, proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(progDice, 'uView'), false, view);
    gl.uniform3fv(gl.getUniformLocation(progDice, 'uEye'), new Float32Array(eye));
    gl.uniform3fv(gl.getUniformLocation(progDice, 'uKey'), new Float32Array(KEY_DIR));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texBody);
    gl.uniform1i(gl.getUniformLocation(progDice, 'uBody'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texRough);
    gl.uniform1i(gl.getUniformLocation(progDice, 'uRough'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texPips);
    gl.uniform1i(gl.getUniformLocation(progDice, 'uPips'), 2);

    const uModel = gl.getUniformLocation(progDice, 'uModel');
    const uNormalMat = gl.getUniformLocation(progDice, 'uNormalMat');

    const uTint = gl.getUniformLocation(progDice, 'uTint');
    const uWear = gl.getUniformLocation(progDice, 'uWear');
    const uGrain = gl.getUniformLocation(progDice, 'uGrain');

    for (const d of dice) {
      // Each die is its own object, not two copies of one.
      //
      // A matched pair is what a factory ships; a pair that has been played with is not.
      // One reads a different corner of the material, one is slightly warmer, and one is
      // more worn — small enough that nobody would name any of it, large enough that the
      // two stop looking like the same mesh drawn twice.
      gl.uniform3fv(uTint, new Float32Array(d.tint));
      gl.uniform1f(uWear, d.wear);
      gl.uniform2fv(uGrain, new Float32Array(d.grain));

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

    let busy = false;
    for (const d of dice) {
      if (d.settling) {
        // Energy spent: ease onto the face the server asked for. `k` rises with time so
        // the last moments converge rather than crawling asymptotically.
        settleTowards(d, Math.min(1, 0.12 + elapsed / 2600));
        d.pos[1] += (FLOOR - d.pos[1]) * 0.35;
        const off = Math.abs(d.rest[0] - d.rot[0]) + Math.abs(d.rest[1] - d.rot[1])
          + Math.abs(d.rest[2] - d.rot[2]);
        if (off > 0.004) busy = true;
      } else {
        step(d, dt);
        if (moving(d)) busy = true;
        else {
          // It has come to rest wherever the tumble left it. Hand it to the settle,
          // which turns it onto the face the seed chose.
          d.settling = true;
          busy = true;
        }
      }
    }
    collide(dice[0], dice[1]);

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
     */
    roll(faces, { ms = 2600 } = {}) {
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

export { FACE_VALUES, RESTING };
