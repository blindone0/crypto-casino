// The bits of WebGL every renderer here needs, and none of the bits that are a game.
//
// WHY THIS EXISTS
//
// `slot3d.js` and `dice3d.js` were written months apart and independently arrived at the
// same five helpers, character for character: compile a shader, link a program, build a
// perspective matrix, load a texture, size a canvas to its host. The third renderer —
// cards — was about to make it three copies, and three copies of a thing is the point at
// which the copies start to disagree.
//
// It is a flat file in `public/` rather than a `public/gl/` directory on purpose:
// `test/client.test.js` walks `public/` and `public/games/`, so a new directory would be
// invisible to the parse and translation checks. A hole in the tests is a worse cost than
// a slightly less tidy tree.
//
// WHAT IS NOT HERE
//
// Geometry, shaders, easing and camera framing all stayed with their games. The test for
// whether something belongs here is not "do two files have it" but "would a third
// renderer want it unchanged" — a cylinder is slots, a rounded box is dice, and a shared
// easing library is the kind of thing that grows to forty functions and gets used twice.

/**
 * A WebGL context, or null.
 *
 * Never throws. Every caller here treats "no WebGL" as a normal outcome and falls back to
 * a DOM version of the same game, because a game that does not draw is worse than a game
 * drawn plainly.
 */
export function context(canvas, opts = {}) {
  const want = {
    antialias: true, alpha: false, premultipliedAlpha: false, ...opts,
  };
  return canvas.getContext('webgl', want)
    || canvas.getContext('experimental-webgl', want)
    || null;
}

export function shader(gl, type, src) {
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

export function program(gl, vertSrc, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

/**
 * Attribute and uniform locations, looked up once.
 *
 * `dice3d.js` made TWENTY-FIVE location lookups per frame before this existed: thirteen
 * uniforms and six attributes in the dice pass, plus six more in the table pass. An
 * earlier version of this comment said fifteen, which was wrong when it was written —
 * it counted only the uniforms and only in one of the two programs.
 * The lookups are cheap individually and pointless collectively: they cannot change while
 * the program lives.
 */
export function locations(gl, prog, { attrs = [], uniforms = [] } = {}) {
  const a = {};
  const u = {};
  for (const name of attrs) a[name] = gl.getAttribLocation(prog, name);
  for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
  return { a, u };
}

export const isPOT = (n) => (n & (n - 1)) === 0 && n > 0;

/**
 * A texture from a URL, with a grey placeholder until it arrives.
 *
 * Two hazards are handled here, and both were learned the hard way in different files:
 *
 *   - WebGL 1 cannot REPEAT a non-power-of-two texture. It does not warn; it renders
 *     black. `slot3d.js` and `dice3d.js` each discovered this independently, which is a
 *     good argument for the helper existing at all.
 *   - A texture that arrives after the last draw leaves the placeholder on screen for
 *     good. On a game that only animates when you act, "something will trigger a frame"
 *     can mean never — so `onReady` exists and callers use it to repaint.
 */
export function loadTexture(gl, url, { repeat = true, onReady = null } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([160, 160, 160, 255]));

  const img = new Image();
  img.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    if (repeat && isPOT(img.width) && isPOT(img.height)) {
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
    if (onReady) onReady();
  };
  img.src = url;
  return tex;
}

/**
 * Keep a canvas the size of its host, in device pixels.
 *
 * The device-pixel ratio is capped at 2 in both existing renderers. Above that the cost
 * is real and the gain is not visible, and a phone reporting 3 or 4 will happily ask for
 * sixteen times the fill rate.
 */
export function sizer(canvas, gl, host, { height = null, aspect = 0.62 } = {}) {
  const resize = () => {
    const w = host.clientWidth || 640;
    const h = height || Math.round(w * aspect);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);

    // Only when it actually changed. Assigning `canvas.width` or `canvas.height`
    // reallocates and clears the drawing buffer even when the value is identical — it is
    // a setter with side effects, not a plain property. ResizeObserver fires once on
    // observe in every browser, so without this guard every renderer threw away a
    // freshly drawn buffer immediately after drawing it, on a size that had not moved.
    const changed = canvas.width !== cw || canvas.height !== ch;
    if (changed) {
      canvas.width = cw;
      canvas.height = ch;
      canvas.style.setProperty('width', `${w}px`);
      canvas.style.setProperty('height', `${h}px`);
      gl.viewport(0, 0, cw, ch);
    }
    return changed;
  };
  let ro = null;
  return {
    resize,
    observe(cb) {
      if (typeof ResizeObserver !== 'function') return;
      // `resize()` reports whether anything actually changed, so the guaranteed
      // first fire does not cost a redraw of a canvas that is already correct.
      ro = new ResizeObserver(() => { if (resize()) cb(); });
      ro.observe(host);
    },
    disconnect() { ro?.disconnect(); ro = null; },
  };
}

// ------------------------------------------------------------------- matrices
//
// Column major, which is what WebGL expects. Written out rather than imported: this is
// the whole of the linear algebra the site needs, and it is less code than a dependency's
// import statement would be worth.

export const perspective = (fovy, aspect, near, far) => {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
};

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function lookAt(eye, target, up) {
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

export function multiply(a, b) {
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

export const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function translation(x, y, z) {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function scaling(s) {
  const m = identity();
  m[0] = s; m[5] = s; m[10] = s;
  return m;
}

/** Euler angles, applied X then Y then Z. */
export function rotation(rx, ry, rz) {
  const cx = Math.cos(rx); const sx = Math.sin(rx);
  const cy = Math.cos(ry); const sy = Math.sin(ry);
  const cz = Math.cos(rz); const sz = Math.sin(rz);
  const x = identity(); x[5] = cx; x[6] = sx; x[9] = -sx; x[10] = cx;
  const y = identity(); y[0] = cy; y[2] = -sy; y[8] = sy; y[10] = cy;
  const z = identity(); z[0] = cz; z[1] = sz; z[4] = -sz; z[5] = cz;
  return multiply(z, multiply(y, x));
}

/** The upper-left 3x3, for transforming normals. Uniform scale only, so no inverse. */
export function normalMatrix(m) {
  return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
}

/**
 * The key light, as a unit vector pointing towards it.
 *
 * Shared so that every surface in a scene agrees about where the light is. Two shaders
 * disagreeing produces wrongness nobody can name but everybody can see — highlights on
 * one side of an object and its shadow on the same side.
 */
export const KEY_DIR = norm([-0.45, 1.0, 0.55]);

/**
 * ACES-ish filmic tonemap, as GLSL source to paste into a fragment shader.
 *
 * Both existing renderers had it inlined, `dice3d.js` twice in the same file. Without it
 * a bright specular clips to flat white and takes the material with it, which is exactly
 * what the slots shipped with once.
 */
export const ACES = `
vec3 tonemap(vec3 c) {
  return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
}`;
