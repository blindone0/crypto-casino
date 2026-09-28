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

  vec3 body = texture2D(uBody, vUV).rgb * uTint;
  float rough = texture2D(uRough, vUV).r;

  // The pip is a hole: darken the body towards the pip's own colour by its alpha, rather
  // than pasting the pip over the top. A pasted pip sits on the surface; a darkened one
  // is in it.
  vec3 albedo = mix(body, pip.rgb * 0.35, pip.a);
  // And a hole is rougher than the polished face around it, which is what stops the pips
  // catching the same highlight as the surface and reading as flat discs.
  rough = mix(rough, 0.9, pip.a);

  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);

  vec3 keyDir = normalize(vec3(-0.45, 1.0, 0.55));
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
uniform vec2 uDiceXZ[2];
void main() {
  vec3 felt = texture2D(uFelt, vUV * 3.0).rgb;

  // A pool of light in the middle, falling off to the edges. Without it the table is a
  // flat rectangle of green and the dice look like they are floating over wallpaper.
  float d = length(vWorld.xz) / 7.0;
  float pool = 1.0 - smoothstep(0.1, 1.0, d);
  vec3 lit = felt * (0.22 + pool * 0.95);

  // Contact shadows. Each die darkens the felt under it, which is the single cue that
  // says the dice are ON the table rather than hovering above it.
  for (int i = 0; i < 2; i++) {
    float s = length(vWorld.xz - uDiceXZ[i]);
    lit *= 1.0 - 0.55 * (1.0 - smoothstep(0.0, 1.45, s));
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

function loadTexture(gl, url, { repeat = true } = {}) {
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
  const texBody = loadTexture(gl, `${base}${material}.jpg`);
  const texRough = loadTexture(gl, `${base}${material}-rough.jpg`);
  const texPips = loadTexture(gl, `${base}dice-pips.png`, { repeat: false });
  const texFelt = loadTexture(gl, `${base}felt-table.jpg`);

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

  const tint = opts.material === 'resin'
    ? [1.0, 0.62, 0.58]
    : [1.0, 0.97, 0.92];

  // Where each die comes to rest. Apart, and slightly off-centre, so they read as two
  // objects that were thrown rather than two copies of one.
  const REST = [[-1.35, 1.0, 0.35], [1.35, 1.0, -0.3]];

  const dice = [0, 1].map((i) => ({
    value: 1,
    // Position and rotation are interpolated from these towards the resting pose.
    from: { pos: [0, 0, 0], rot: [0, 0, 0] },
    to: { pos: REST[i], rot: [0, 0, 0] },
    spin: [0, 0, 0],
    pos: REST[i].slice(),
    rot: [0, 0, 0],
  }));

  let t0 = 0;
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

  const eye = [0, 7.4, 8.2];
  const view = lookAt(eye, [0, 0.6, 0], [0, 1, 0]);

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
    gl.uniform2fv(gl.getUniformLocation(progTable, 'uDiceXZ'), new Float32Array([
      dice[0].pos[0], dice[0].pos[2], dice[1].pos[0], dice[1].pos[2],
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
    gl.uniform3fv(gl.getUniformLocation(progDice, 'uTint'), new Float32Array(tint));
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

    for (const d of dice) {
      const model = multiply(
        translation(d.pos[0], d.pos[1], d.pos[2]),
        multiply(rotation(d.rot[0], d.rot[1], d.rot[2]), scaling(0.85)),
      );
      gl.uniformMatrix4fv(uModel, false, model);
      gl.uniformMatrix3fv(uNormalMat, false, normalMatrix(model));
      gl.drawElements(gl.TRIANGLES, box.count, gl.UNSIGNED_SHORT, 0);
    }
  }

  function frame(now) {
    if (!t0) t0 = now;
    const elapsed = now - t0;
    const t = duration ? Math.min(1, elapsed / duration) : 1;
    const e = easeOut(t);

    for (const d of dice) {
      // Position: an arc in from off-screen, with a bounce that decays. The vertical
      // term is what sells it — a die that slides to a stop has no weight.
      d.pos[0] = d.from.pos[0] + (d.to.pos[0] - d.from.pos[0]) * e;
      d.pos[2] = d.from.pos[2] + (d.to.pos[2] - d.from.pos[2]) * e;
      const bounce = Math.abs(Math.sin(t * Math.PI * 2.4)) * (1 - t) ** 1.6;
      d.pos[1] = d.to.pos[1] + bounce * 2.6;

      // Rotation: spin fast, then converge on the resting pose that shows the right
      // face. The spin term decays as (1-t)^2 so the last quarter of the throw is almost
      // entirely the settle, which is what stops it snapping.
      const decay = (1 - t) ** 2;
      for (let i = 0; i < 3; i += 1) {
        d.rot[i] = d.to.rot[i] + d.spin[i] * decay;
      }
    }

    draw();
    if (t < 1) {
      raf = requestAnimationFrame(frame);
    } else {
      raf = null;
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
     * from the round's seed — this only stages the arrival.
     */
    roll(faces, { ms = 1900 } = {}) {
      const values = Array.isArray(faces) && faces.length === 2 ? faces : [1, 1];
      return new Promise((resolve) => {
        values.forEach((v, i) => {
          const d = dice[i];
          d.value = v;
          d.to = { pos: REST[i], rot: RESTING[v] || [0, 0, 0] };
          // Come in from off to the left, at a height, so the throw has somewhere to
          // come from. Slightly different per die so they do not move as one object.
          d.from = {
            pos: [-7 - i * 1.6, 3.2, 4.5 + i * 1.1],
            rot: [0, 0, 0],
          };
          // Whole extra turns, so the die spins several times on the way rather than
          // rotating the short way to its answer. The multiples of 2*PI mean the resting
          // pose is still exactly right when the decay reaches zero.
          const turns = () => (2 + Math.floor(Math.random() * 3)) * Math.PI * 2;
          d.spin = [turns(), turns(), turns()];
          d.pos = d.from.pos.slice();
        });
        t0 = 0;
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
          }
          if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
          draw();
          const done = onDone;
          onDone = null;
          done();
        }, ms + 400);
      });
    },

    /** Put the dice down showing these faces, with no animation. */
    show(faces) {
      const values = Array.isArray(faces) && faces.length === 2 ? faces : [1, 1];
      values.forEach((v, i) => {
        dice[i].value = v;
        dice[i].pos = REST[i].slice();
        dice[i].rot = (RESTING[v] || [0, 0, 0]).slice();
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
