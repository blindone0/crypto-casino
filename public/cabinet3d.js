// The slot cabinet, as geometry.
//
// TWO CANVASES, NOT ONE
//
// slot3d.js solves its camera so that exactly `rows` symbols fill the canvas height.
// Stretching that canvas to cover the cabinet would silently redefine every number that
// took several sessions to get right, so slot3d.js is not touched. The housing is drawn
// here on a transparent canvas of its own BEHIND the reel canvas, and the glass on
// another one IN FRONT of it: the reel canvas is already transparent, which is what this
// design was built for. Stacking, all in style.css: cabinet 1, reels 3, glass 4, sparks 8.
//
// NO STRAIGHT EDGES
//
// igor: "все должно быть обтекаемое и выпуклое полукруглое. без прямых углов вообще".
// So the case is a pillow, not a box: its silhouette is a rounded shape with wide radii,
// its edge is a bullnose all the way round, and its front comes forward at the centre and
// falls away towards the sides, so the room slides across it. The bezel round the drums
// is a rounded moulding with rounded corners, a ring of light runs round it, the
// marquee's lamp is a domed pillow behind a brass rim, the coin slot is a capsule and
// the button a dome. Every one of them is an outline of a rounded rectangle, sampled
// into the same number of points, and a band of quads between two such outlines - that
// one helper is the whole cabinet.
//
// The reels are flat in the page (a canvas in the DOM), so the bezel's inner lip has to
// land on the window's DOM rectangle to the pixel however far forward it stands; each
// lip point is pulled towards the camera's centre line by exactly the amount the
// perspective would push it out. The theme reaches all of it through the palette in
// slotthemes.js. Lit by the same key direction the drums use (gl.js), textured with the
// materials the RTX drew (tools/generate-materials.js) and their roughness, and
// tonemapped the same way. When this returns null - no context, no shaders - the app
// shows a notice; there is no flat version.

import {
  context, program, locations, loadTexture, perspective, lookAt, KEY_DIR, ACES, onLost, release,
} from './gl.js';

const FOVY = 0.62;             // the drums' field of view, so the two perspectives agree
const BULGE_X = 36;            // how far the front comes forward at its centre, across
const BULGE_Y = 18;            // and down
const EDGE_R = 28;             // the bullnose round the case
const CORNER_TOP = 140;        // the silhouette's radii, top and bottom
const CORNER_BOTTOM = 70;
const BEZEL = 18;              // the moulding round the window, and how far it stands proud
const WIN_R = 30;              // the window's corner radius - generous rounded curve
const WELL = 44;               // the drums sit in a recess this deep behind the lip
const TEX_PX = 220;            // one texture repeat every so many px
const LED_W = 5;               // the ring of light's width
const BUTTON_R = 27;           // the spin button's radius, at most
const K = 8;                   // points per corner arc of every outline
const E = 12;                  // points per straight edge of every outline
const PROFILE = 6;             // steps round a bullnose or a moulding

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUV;
uniform mat4 uProj;
uniform mat4 uView;
varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vWorld;
void main() {
  vNormal = aNormal;
  vUV = aUV;
  vWorld = aPos;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

// One shader, six ways of using it, picked by uMode per material: 0 a lit, textured
// surface; 1 the marquee's lamp; 2 the ring of LEDs; 3 the lamp in the button; 4 and 5
// the cast shadows, a strip and a disc.
const FRAG = `
precision highp float;
varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vWorld;
uniform sampler2D uTex;
uniform sampler2D uRough;     // roughness, derived from the material's own contrast
uniform vec3 uKey;            // the key light, unit length, shared with the drums
uniform vec3 uEye;
uniform vec3 uTint;
uniform float uSpec;
uniform float uShade;
uniform int uMode;
uniform vec3 uGlow;           // the colour of a light, modes 1 to 3
uniform vec4 uGlowBox;        // the marquee panel: left, bottom, right, top
uniform float uPhase;         // seconds, for the LEDs and the lamp
${ACES}
void main() {
  if (uMode == 1) {
    // Backlit acrylic: the lamp is behind the middle of the panel, so the light pools
    // there, behind the title, and the panel darkens towards its ends and edges, with a
    // little of the diffuser's grain in it.
    float tx = clamp((vWorld.x - uGlowBox.x) / max(uGlowBox.z - uGlowBox.x, 1.0), 0.0, 1.0);
    float ty = clamp((vWorld.y - uGlowBox.y) / max(uGlowBox.w - uGlowBox.y, 1.0), 0.0, 1.0);
    float ax = 1.0 - abs(tx * 2.0 - 1.0);
    float ay = 1.0 - abs(ty * 2.0 - 1.0);
    float pool = pow(ax, 1.6) * (0.35 + 0.65 * ay);
    float grain = texture2D(uRough, vUV * 0.5).r * 0.05;
    gl_FragColor = vec4(tonemap(uGlow * (0.05 + 0.62 * pool + grain)), 1.0);
    return;
  }
  if (uMode == 2) {
    // A ring of LEDs: the diodes are the peaks, and a pulse runs round them.
    float along = vWorld.x + vWorld.y;
    float pulse = 0.55 + 0.45 * sin(along * 0.05 - uPhase * 2.2);
    float diode = pow(0.5 + 0.5 * sin(along * 0.9), 6.0) * 0.6;
    gl_FragColor = vec4(tonemap(uGlow * (0.40 + pulse * 0.9 + diode)), 1.0);
    return;
  }
  if (uMode == 3) {
    // The lamp in the button: bright at its centre, breathing slowly.
    float r = length(vUV - 0.5) * 2.0;
    float breathe = 0.78 + 0.22 * sin(uPhase * 2.0);
    float core = 1.0 - smoothstep(0.15, 1.0, r);
    gl_FragColor = vec4(tonemap(uGlow * (0.30 + 0.75 * core) * breathe), 1.0);
    return;
  }
  if (uMode == 4) {
    // A cast shadow under a lip: dark at the edge it hangs from, gone a little below.
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.55 * vUV.y * vUV.y);
    return;
  }
  if (uMode == 5) {
    // A cast shadow under something round, soft at its rim.
    float r = length(vUV - 0.5) * 2.0;
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.6 * (1.0 - smoothstep(0.45, 1.0, r)));
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 base = texture2D(uTex, vUV).rgb * uTint;
  float rough = texture2D(uRough, vUV).r;
  float diff = max(dot(n, uKey), 0.0);
  // A soft fill from below and in front, so a face turned from the key is dark, not black.
  float fill = max(dot(n, vec3(0.0, -0.4, 0.9)), 0.0) * 0.16;
  vec3 v = normalize(uEye - vWorld);
  vec3 h = normalize(uKey + v);
  float gloss = 1.0 - rough;
  float spec = pow(max(dot(n, h), 0.0), mix(14.0, 96.0, gloss)) * gloss * uSpec;
  // What the surface reflects: the room, in the mirror direction - a lit ceiling above,
  // dark below. A black lacquer panel with nothing in it is a black rectangle; the same
  // panel with the room sliding across its curve is a glossy solid, and every bullnose,
  // moulding and dome shows its shape by what it catches. A little of it even face-on,
  // as real lacquer does, and nearly all of it at a graze.
  vec3 R = reflect(-v, n);
  float sky = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 env = mix(vec3(0.012, 0.012, 0.018), vec3(0.34, 0.31, 0.27), pow(sky, 2.4));
  float fres = 0.12 + 0.88 * pow(1.0 - max(dot(n, v), 0.0), 4.0);
  vec3 lit = base * (0.22 + diff * 0.92 + fill) * uShade + vec3(spec) + env * fres * gloss * uSpec;
  gl_FragColor = vec4(tonemap(lit), 1.0);
}`;

const GLASS_VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// The glass adds light and never takes it: this canvas is composited with plus-lighter,
// so black is nothing and a symbol can never be hidden by it. Barely there: a thread of
// light that bows with the pane - the pane is convex like everything else - and moves
// with the viewer, and a little brightening where the glass meets the frame.
const GLASS_FRAG = `
precision highp float;
varying vec2 vUV;
uniform vec2 uTilt;
uniform float uAspect;
void main() {
  vec2 uv = vUV;
  float bow = (uv.x - 0.5) * (uv.x - 0.5) * 0.9;
  float d = uv.y - 0.74 + bow - uTilt.x * 0.02 + uTilt.y * 0.01;
  float band = exp(-d * d * 900.0) * 0.05;
  float ex = pow(abs(uv.x * 2.0 - 1.0), 8.0);
  float ey = pow(abs(uv.y * 2.0 - 1.0), 10.0);
  float fres = (ex + ey) * 0.06;
  vec3 c = vec3(0.90, 0.95, 1.0) * (band + fres);
  float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
  gl_FragColor = vec4(c, a);
}`;

/** The look of a machine when no palette was given: the classic one. */
const DEFAULT_THEME = {
  case: [0.085, 0.078, 0.085],
  bezel: 'brass',
  accent: [1.0, 0.78, 0.32],
  lamp: [1.0, 0.26, 0.14],
  marquee: { glow: [1.0, 0.78, 0.40] },
};

/** The material ids the geometry carries; the draw loop groups faces by them. */
const IDS = { lacquer: 0, brass: 1, steel: 2, well: 3, glow: 4, led: 5, lamp: 6, shade: 7, disc: 8 };

/**
 * The materials for a palette, and how each is drawn. A lit material names its texture
 * and a tint on top of the photo; a light names its mode and colour.
 */
export function materialsFor(theme) {
  const t = theme || DEFAULT_THEME;
  const steel = t.bezel === 'steel';
  return {
    lacquer: { file: 'cab-vinyl', tint: t.case || DEFAULT_THEME.case, spec: 1.1, shade: 1.0 },
    brass: steel
      ? { file: 'cab-steel', tint: [0.96, 0.98, 1.03], spec: 1.0, shade: 1.05 }
      : { file: 'cab-brass', tint: [1.05, 0.98, 0.80], spec: 0.95, shade: 1.05 },
    steel: { file: 'cab-steel', tint: [0.92, 0.94, 0.98], spec: 0.8, shade: 0.95 },
    well: { file: 'cab-vinyl', tint: [0.05, 0.05, 0.06], spec: 0.05, shade: 0.6 },
    glow: { file: 'cab-vinyl', mode: 1, colour: (t.marquee && t.marquee.glow) || DEFAULT_THEME.marquee.glow },
    led: { file: 'cab-vinyl', mode: 2, colour: t.accent || DEFAULT_THEME.accent },
    lamp: { file: 'cab-vinyl', mode: 3, colour: t.lamp || t.accent || DEFAULT_THEME.lamp },
    // The cast shadows, blended over everything above them: last, so they are.
    shade: { file: 'cab-vinyl', mode: 4, blend: true },
    disc: { file: 'cab-vinyl', mode: 5, blend: true },
  };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const sq = (x) => x * x;

/** One vertex, with the normal and UVs given (UVs default to the world's, for textures). */
function pushV(out, mat, p, n, uv) {
  out.push(mat, p[0], p[1], p[2], n[0], n[1], n[2], uv ? uv[0] : p[0] / TEX_PX, uv ? uv[1] : p[1] / TEX_PX);
}

/**
 * One quad, four corners in order round the face, with a flat normal from the winding
 * and UVs from world position, so a texture repeats at the same scale on every face.
 */
function quad(out, mat, a, b, c, d) {
  const raw = crossV(sub(b, a), sub(d, a));
  // A rectangle the layout squeezed to nothing has no face to light: skipped, not drawn.
  if (Math.hypot(raw[0], raw[1], raw[2]) < 1e-6) return;
  const n = unit(raw);
  pushV(out, mat, a, n); pushV(out, mat, b, n); pushV(out, mat, c, n);
  pushV(out, mat, a, n); pushV(out, mat, c, n); pushV(out, mat, d, n);
}

/** One triangle with its own UVs, for the faces whose texture is not the world's. */
function tri(out, mat, a, b, c, uvs) {
  const raw = crossV(sub(b, a), sub(c, a));
  if (Math.hypot(raw[0], raw[1], raw[2]) < 1e-6) return;
  const n = unit(raw);
  pushV(out, mat, a, n, uvs[0]); pushV(out, mat, b, n, uvs[1]); pushV(out, mat, c, n, uvs[2]);
}

/**
 * A rounded rectangle, sampled counter-clockwise from the bottom edge with an outward
 * normal at every point: E points per edge and K per corner arc, so every outline has
 * the same count and a band can be laid between any two. Radii in the order bottom-left,
 * bottom-right, top-right, top-left; model coordinates, y up.
 */
function outline({ x0, y0, x1, y1, r, bow = [0, 0, 0, 0] }) {
  const pts = [];
  const nrm = [];
  const cap = Math.max(0, Math.min((x1 - x0) / 2, (y1 - y0) / 2));
  const [rBL, rBR, rTR, rTL] = r.map((v) => Math.max(0, Math.min(v, cap)));
  const edge = (ax, ay, bx, by, nx, ny, b = 0) => {
    const dx = bx - ax;
    const dy = by - ay;
    for (let i = 0; i < E; i += 1) {
      const t = i / E;
      if (b === 0) {
        pts.push([ax + dx * t, ay + dy * t]);
        nrm.push([nx, ny]);
      } else {
        const offset = b * Math.sin(t * Math.PI);
        pts.push([ax + dx * t + nx * offset, ay + dy * t + ny * offset]);
        const tx = dx + nx * b * Math.PI * Math.cos(t * Math.PI);
        const ty = dy + ny * b * Math.PI * Math.cos(t * Math.PI);
        const l = Math.hypot(ty, -tx) || 1;
        nrm.push([ty / l, -tx / l]);
      }
    }
  };
  const arc = (cx, cy, rr, a0, a1) => {
    for (let i = 0; i < K; i += 1) {
      const a = a0 + (a1 - a0) * (i / (K - 1));
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
      nrm.push([Math.cos(a), Math.sin(a)]);
    }
  };
  edge(x0 + rBL, y0, x1 - rBR, y0, 0, -1, bow[0]);
  arc(x1 - rBR, y0 + rBR, rBR, -Math.PI / 2, 0);
  edge(x1, y0 + rBR, x1, y1 - rTR, 1, 0, bow[1]);
  arc(x1 - rTR, y1 - rTR, rTR, 0, Math.PI / 2);
  edge(x1 - rTR, y1, x0 + rTL, y1, 0, 1, bow[2]);
  arc(x0 + rTL, y1 - rTL, rTL, Math.PI / 2, Math.PI);
  edge(x0, y1 - rTL, x0, y0 + rBL, -1, 0, bow[3]);
  arc(x0 + rBL, y0 + rBL, rBL, Math.PI, Math.PI * 1.5);
  return { pts, nrm };
}

/** The same rounded rectangle, `d` further in (or out, for a negative d): a parallel curve. */
const inset = (s, d) => ({
  x0: s.x0 + d,
  y0: s.y0 + d,
  x1: s.x1 - d,
  y1: s.y1 - d,
  r: s.r.map((v) => Math.max(0, v - d)),
  bow: s.bow ? s.bow.map((b) => Math.max(0, b - d * 0.15)) : [0, 0, 0, 0],
});

/** A band of quads between two outlines: `va(i)` and `vb(i)` give { p, n, uv? } for point i. */
function band(out, mat, N, va, vb) {
  for (let i = 0; i < N; i += 1) {
    const j = (i + 1) % N;
    const a = va(i); const b = va(j); const c = vb(j); const d = vb(i);
    pushV(out, mat, a.p, a.n, a.uv); pushV(out, mat, b.p, b.n, b.uv); pushV(out, mat, c.p, c.n, c.uv);
    pushV(out, mat, a.p, a.n, a.uv); pushV(out, mat, c.p, c.n, c.uv); pushV(out, mat, d.p, d.n, d.uv);
  }
}

/** A fan of triangles from one centre vertex out to an outline. */
function fan(out, mat, N, centre, v) {
  for (let i = 0; i < N; i += 1) {
    const j = (i + 1) % N;
    const b = v(i); const c = v(j);
    pushV(out, mat, centre.p, centre.n, centre.uv); pushV(out, mat, b.p, b.n, b.uv); pushV(out, mat, c.p, c.n, c.uv);
  }
}

/** A shadow strip hanging from its top edge: v runs 1 at the edge to 0 at the bottom. */
function shadeStrip(out, x0, yTop, x1, yBottom, zAt) {
  tri(out, IDS.shade, [x0, yBottom, zAt(x0, yBottom)], [x1, yBottom, zAt(x1, yBottom)], [x1, yTop, zAt(x1, yTop)], [[0, 0], [1, 0], [1, 1]]);
  tri(out, IDS.shade, [x0, yBottom, zAt(x0, yBottom)], [x1, yTop, zAt(x1, yTop)], [x0, yTop, zAt(x0, yTop)], [[0, 0], [1, 1], [0, 1]]);
}

/** A round shadow, centred UVs so the shader can fade its rim. */
function disc(out, cx, cy, r, z, segments = 24) {
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    tri(out, IDS.disc, [cx, cy, z], [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z], [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z],
      [[0.5, 0.5], [0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5], [0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5]]);
  }
}

/**
 * The spin button: a rounded brass bevel rising from the deck to a domed lamp. `cx`, `cy`
 * in model units, y up, `z0` the deck's surface there. The lamp's UVs are centred on
 * it, so the shader can light it from the middle.
 */
function button(out, cx, cy, r, z0, segments = 28) {
  const top = 9;
  const dome = 7;
  const ri = r * 0.78;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0); const s0 = Math.sin(a0);
    const c1 = Math.cos(a1); const s1 = Math.sin(a1);
    // The bevel: a quarter round from the deck up to the rim.
    for (let s = 0; s < 3; s += 1) {
      const f0 = (s / 3) * Math.PI / 2; const f1 = ((s + 1) / 3) * Math.PI / 2;
      const at = (c, sn, f) => ({
        p: [cx + c * (r - (r - ri) * (1 - Math.cos(f))), cy + sn * (r - (r - ri) * (1 - Math.cos(f))), z0 + top * Math.sin(f)],
        n: [c * Math.cos(f), sn * Math.cos(f), Math.sin(f)],
      });
      const a = at(c0, s0, f0); const b = at(c1, s1, f0); const c = at(c1, s1, f1); const d = at(c0, s0, f1);
      pushV(out, IDS.brass, a.p, a.n); pushV(out, IDS.brass, b.p, b.n); pushV(out, IDS.brass, c.p, c.n);
      pushV(out, IDS.brass, a.p, a.n); pushV(out, IDS.brass, c.p, c.n); pushV(out, IDS.brass, d.p, d.n);
    }
    // The lamp: a dome, in rings.
    for (let s = 0; s < 3; s += 1) {
      const f0 = (s / 3) * Math.PI / 2; const f1 = ((s + 1) / 3) * Math.PI / 2;
      const at = (c, sn, f) => ({
        p: [cx + c * ri * Math.cos(f), cy + sn * ri * Math.cos(f), z0 + top + dome * Math.sin(f)],
        n: [c * Math.cos(f) * 0.6, sn * Math.cos(f) * 0.6, Math.sqrt(1 - 0.36 * Math.cos(f) * Math.cos(f))],
        uv: [0.5 + c * 0.5 * Math.cos(f), 0.5 + sn * 0.5 * Math.cos(f)],
      });
      const a = at(c0, s0, f0); const b = at(c1, s1, f0); const c = at(c1, s1, f1); const d = at(c0, s0, f1);
      pushV(out, IDS.lamp, a.p, a.n, a.uv); pushV(out, IDS.lamp, b.p, b.n, b.uv); pushV(out, IDS.lamp, c.p, c.n, c.uv);
      pushV(out, IDS.lamp, a.p, a.n, a.uv); pushV(out, IDS.lamp, c.p, c.n, c.uv); pushV(out, IDS.lamp, d.p, d.n, d.uv);
    }
  }
}

/**
 * The cabinet, as quads, from the rectangles the DOM measured.
 *
 * `W`, `H` are the cabinet's size; `win` is the window's rectangle within it; `base` the
 * deck strip; all in CSS px with y down, as the DOM reports them. `dist` is the camera's
 * distance, so the lip can be placed to land on the window; left out, it is the one
 * createCabinet uses. Returns a flat list of vertices tagged with their material, and is
 * pure so a test can hold it.
 */
export function buildGeometry({ W, H, win, marqueeH = 0, base = null, dist = null }) {
  const Y = (y) => H - y;              // DOM y down to model y up
  const D = dist || (H / 2) / Math.tan(FOVY / 2);
  const v = [];
  const M = IDS;
  const cx = W / 2;
  const cy = H / 2;
  const rect = (m, x0, y0, x1, y1, z) => quad(v, m,
    [x0, Y(y1), z], [x1, Y(y1), z], [x1, Y(y0), z], [x0, Y(y0), z]);

  // The front is a pillow: forward at the centre, back at the sides and, less, at the top
  // and bottom. Everything that sits on the front sits on this.
  const bulge = (x, y) => BULGE_X * (1 - sq((x - cx) / cx)) + BULGE_Y * (1 - sq((y - cy) / cy));
  const bulgeN = (x, y) => unit([2 * BULGE_X * (x - cx) / (cx * cx), 2 * BULGE_Y * (y - cy) / (cy * cy), 1]);
  const onFront = (p, lift = 0) => ({ p: [p[0], p[1], bulge(p[0], p[1]) + lift], n: bulgeN(p[0], p[1]) });
  // Where a point at depth z has to be to land on the screen where a DOM point is.
  const toward = (p, z) => { const k = (D - z) / D; return [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]; };

  // --- the case: silhouette, bullnose, front
  // The case has vaulted top and bottom, and bowed convex barrel sides: no straight edges.
  const body = {
    x0: 0, y0: 0, x1: W, y1: H,
    r: [CORNER_BOTTOM, CORNER_BOTTOM, CORNER_TOP, CORNER_TOP],
    bow: [8, 14, 26, 14],
  };
  const bodyIn = inset(body, EDGE_R);
  const oOut = outline(body);
  const oIn = outline(bodyIn);
  const N = oIn.pts.length;
  for (let s = 0; s < PROFILE; s += 1) {
    const f0 = (s / PROFILE) * Math.PI / 2;
    const f1 = ((s + 1) / PROFILE) * Math.PI / 2;
    const at = (i, f) => {
      const a = oIn.pts[i]; const o = oOut.pts[i]; const n2 = oOut.nrm[i];
      const zf = bulge(a[0], a[1]);
      return {
        p: [a[0] + (o[0] - a[0]) * Math.sin(f), a[1] + (o[1] - a[1]) * Math.sin(f), zf - EDGE_R * (1 - Math.cos(f))],
        n: [n2[0] * Math.sin(f), n2[1] * Math.sin(f), Math.cos(f)],
      };
    };
    band(v, M.lacquer, N, (i) => at(i, f0), (i) => at(i, f1));
  }

  // --- the window: its outline, the bezel's, the ring of light's
  // The window is generously rounded with subtle vaulted arches on top and bottom: no right angles.
  const wr = {
    x0: win.x, y0: Y(win.y + win.h), x1: win.x + win.w, y1: Y(win.y),
    r: [WIN_R, WIN_R, WIN_R, WIN_R],
    bow: [6, 0, 8, 0],
  };
  const oWin = outline(wr);
  const oBez = outline(inset(wr, -BEZEL));
  const oLedIn = outline(inset(wr, -(BEZEL + 6)));
  const oLedOut = outline(inset(wr, -(BEZEL + 6 + LED_W)));

  // The front itself: from the bezel's outer edge out to the bullnose, on the pillow.
  band(v, M.lacquer, N, (i) => onFront(oBez.pts[i]), (i) => onFront(oIn.pts[i]));
  // A brass piping just inside the bullnose, all the way round.
  const oPipeA = outline(inset(bodyIn, 2));
  const oPipeB = outline(inset(bodyIn, 5));
  band(v, M.brass, N, (i) => onFront(oPipeA.pts[i], 0.4), (i) => onFront(oPipeB.pts[i], 0.4));
  // The ring of light round the bezel.
  band(v, M.led, N, (i) => onFront(oLedIn.pts[i], 0.6), (i) => onFront(oLedOut.pts[i], 0.6));

  // The bezel: a rounded moulding from its outer edge on the front up and in to the lip,
  // which is put exactly where it lands on the window's DOM rectangle.
  const lipZ = (i) => bulge(oWin.pts[i][0], oWin.pts[i][1]) + BEZEL;
  const lip = (i) => { const q = toward(oWin.pts[i], lipZ(i)); return [q[0], q[1], lipZ(i)]; };
  for (let s = 0; s < PROFILE; s += 1) {
    const f0 = (s / PROFILE) * Math.PI / 2;
    const f1 = ((s + 1) / PROFILE) * Math.PI / 2;
    const at = (i, f) => {
      const o = oBez.pts[i]; const zo = bulge(o[0], o[1]); const l = lip(i); const nn = oWin.nrm[i];
      const dh = Math.hypot(l[0] - o[0], l[1] - o[1]); const dz = l[2] - zo;
      const n = unit([nn[0] * dz * Math.cos(f), nn[1] * dz * Math.cos(f), dh * Math.sin(f)]);
      return { p: [o[0] + (l[0] - o[0]) * (1 - Math.cos(f)), o[1] + (l[1] - o[1]) * (1 - Math.cos(f)), zo + dz * Math.sin(f)], n };
    };
    band(v, M.brass, N, (i) => at(i, f0), (i) => at(i, f1));
  }
  // The recess the drums sit in: walls from the lip back to the well, in lacquer, so they
  // catch the room like the rest of the case. The well itself is black.
  band(v, M.lacquer, N,
    (i) => { const l = lip(i); const nn = oWin.nrm[i]; return { p: l, n: [-nn[0], -nn[1], 0] }; },
    (i) => { const l = lip(i); const nn = oWin.nrm[i]; return { p: [l[0], l[1], -WELL], n: [-nn[0], -nn[1], 0] }; });
  const cWin = [(win.x + win.x + win.w) / 2, Y((win.y + win.y + win.h) / 2)];
  fan(v, M.well, N, { p: [cWin[0], cWin[1], -WELL], n: [0, 0, 1] },
    (i) => { const l = lip(i); return { p: [l[0], l[1], -WELL], n: [0, 0, 1] }; });
  // What the lip casts: a soft dark strip on the front under the bezel.
  const by1 = win.y + win.h + BEZEL;
  shadeStrip(v, win.x + 10, Y(by1), win.x + win.w - 10, Y(by1 + 16), (x, y) => bulge(x, y) + 0.3);

  // --- the marquee: a domed lamp behind a brass rim, on the band above the window
  let marqueeLight = null;
  if (marqueeH > 40) {
    const pm = {
      x0: EDGE_R + 16, y0: Y(marqueeH - 10), x1: W - EDGE_R - 16, y1: Y(16),
      r: [24, 24, 44, 44],
      bow: [4, 6, 14, 6],
    };
    const oP = outline(pm);
    const oPin = outline(inset(pm, 9));
    const oPrim = outline(inset(pm, -3));
    const at = (o, lift) => (i) => onFront(o.pts[i], lift);
    band(v, M.brass, N, at(oPrim, 1.2), at(oP, 1.6));
    band(v, M.glow, N, at(oP, 1.8), at(oPin, 5.5));
    const c = [(pm.x0 + pm.x1) / 2, (pm.y0 + pm.y1) / 2];
    fan(v, M.glow, N, { p: [c[0], c[1], bulge(c[0], c[1]) + 7], n: [0, 0, 1] }, at(oPin, 5.5));
    marqueeLight = [pm.x0, pm.y0, pm.x1, pm.y1];
    shadeStrip(v, pm.x0 + 14, Y(marqueeH - 7), pm.x1 - 14, Y(marqueeH + 6), (x, y) => bulge(x, y) + 0.5);
  }

  // --- the deck: the coin slot, a capsule; the button, a dome
  if (base) {
    const th = Math.min(base.h * 0.62, 34);
    const tx0 = base.x + base.w * 0.06; const tx1 = base.x + base.w * 0.42;
    const ty0 = base.y + (base.h - th) / 2; const ty1 = ty0 + th;
    const pill = { x0: tx0, y0: Y(ty1), x1: tx1, y1: Y(ty0), r: [th / 2, th / 2, th / 2, th / 2] };
    const oT = outline(pill);
    const oTr = outline(inset(pill, -2.5));
    band(v, M.steel, N, (i) => onFront(oTr.pts[i], 0.5), (i) => onFront(oT.pts[i], 0.5));
    const c = [(tx0 + tx1) / 2, Y((ty0 + ty1) / 2)];
    fan(v, M.well, N, { p: [c[0], c[1], bulge(c[0], c[1]) + 0.3], n: [0, 0, 1] }, (i) => onFront(oT.pts[i], 0.3));
    shadeStrip(v, tx0 + th / 2, Y(ty0), tx1 - th / 2, Y(ty0 + th * 0.55), (x, y) => bulge(x, y) + 0.6);
    const r = Math.min(BUTTON_R, base.h * 0.42);
    if (r > 8) {
      const bx = base.x + base.w * 0.74;
      const byy = Y(base.y + base.h / 2);
      const z0 = bulge(bx, byy);
      disc(v, bx + r * 0.25, byy - r * 0.3, r * 1.3, z0 + 0.4);
      button(v, bx, byy, r, z0);
    }
  }

  return { vertices: new Float32Array(v), stride: 9, count: v.length / 9, materials: M, marqueeLight };
}

/** Where a child sits within the cabinet, in the cabinet's own CSS px. */
function rectIn(host, node) {
  const a = host.getBoundingClientRect();
  const b = node.getBoundingClientRect();
  // The cabinet is CSS-rotated for the parallax; measuring through that transform gives
  // the projected size, not the layout size. offsetWidth and offsetLeft are the layout.
  const sx = host.offsetWidth / (a.width || host.offsetWidth || 1);
  const sy = host.offsetHeight / (a.height || host.offsetHeight || 1);
  return { x: (b.left - a.left) * sx, y: (b.top - a.top) * sy, w: b.width * sx, h: b.height * sy };
}

const tiltOf = (stage) => {
  if (!stage) return [0, 0];
  const cs = getComputedStyle(stage);
  return [parseFloat(cs.getPropertyValue('--tilt-x')) || 0, parseFloat(cs.getPropertyValue('--tilt-y')) || 0];
};

/**
 * Build the cabinet around the reels.
 *
 * `host` is the .slot-cabinet element; `opts.window` its .slot-window, `opts.reels` the
 * #reels box the glass covers, and `opts.theme` the palette from slotthemes.js. Returns
 * null, exactly like createReels, when there is no context or the shaders will not
 * compile, and then nothing on the page has changed.
 */
export function createCabinet(host, opts = {}) {
  if (typeof document === 'undefined' || !host || !opts.window) return null;
  const back = document.createElement('canvas');
  back.className = 'cab-gl';
  const glass = document.createElement('canvas');
  glass.className = 'cab-glass';

  const gl = context(back, { alpha: true });
  // Premultiplied, with the light it adds as its alpha: under plain compositing that is a
  // highlight over the drums, and under plus-lighter, where the browser honours it, a sum.
  const gg = context(glass, { alpha: true, premultipliedAlpha: true });
  if (!gl || !gg) return null;
  let prog;
  let gprog;
  try {
    prog = program(gl, VERT, FRAG);
    gprog = program(gg, GLASS_VERT, GLASS_FRAG);
  } catch {
    return null;
  }
  host.appendChild(back);
  (opts.reels || opts.window).appendChild(glass);
  let lostCb = null;
  const unlistenBack = onLost(back, () => { if (lostCb) lostCb(); });
  const unlistenGlass = onLost(glass, () => { if (lostCb) lostCb(); });

  const L = locations(gl, prog, {
    attrs: ['aPos', 'aNormal', 'aUV'],
    uniforms: ['uProj', 'uView', 'uTex', 'uRough', 'uKey', 'uEye', 'uTint', 'uSpec', 'uShade',
      'uMode', 'uGlow', 'uGlowBox', 'uPhase'],
  });
  const G = locations(gg, gprog, { attrs: ['aPos'], uniforms: ['uTilt', 'uAspect'] });

  // The drums light from above and to the left; so does the cabinet. gl.js keeps y up.
  const key = [KEY_DIR[0], KEY_DIR[1], KEY_DIR[2]];

  let materials = materialsFor(opts.theme);

  // Textures: the colour and the roughness of every material file, drawn again as each
  // lands. Every file any theme can ask for is loaded once, so a re-theme is instant.
  const tex = {};
  for (const file of ['cab-vinyl', 'cab-brass', 'cab-steel']) {
    tex[file] = {
      colour: loadTexture(gl, `/textures/${file}.jpg`, { onReady: () => draw() }),
      rough: loadTexture(gl, `/textures/${file}-rough.jpg`, { onReady: () => draw() }),
    };
  }

  const buf = gl.createBuffer();
  const gbuf = gg.createBuffer();
  gg.bindBuffer(gg.ARRAY_BUFFER, gbuf);
  gg.bufferData(gg.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gg.STATIC_DRAW);

  let geometry = null;
  let runs = null;             // material id -> [start, count] pairs, from the vertex tags
  let W = 1;
  let H = 1;
  let eye = [0, 0, 1];
  let proj = null;
  let view = null;
  const t0 = performance.now();

  function layout() {
    W = host.offsetWidth || 660;
    H = host.offsetHeight || 500;
    // The camera on the centre line, at the distance that maps the front plane 1:1.
    const dist = (H / 2) / Math.tan(FOVY / 2);
    // The bezel frames the drums themselves, a few px out, not the padded window box
    // round them: framed at the box, the well showed as a black band inside the lip.
    const framed = rectIn(host, opts.reels || opts.window);
    const gap = opts.reels ? 4 : 0;
    const win = { x: framed.x - gap, y: framed.y - gap, w: framed.w + gap * 2, h: framed.h + gap * 2 };
    const marquee = host.querySelector('.slot-marquee');
    const base = host.querySelector('.slot-base');
    geometry = buildGeometry({
      W, H, win, dist,
      marqueeH: marquee ? marquee.offsetHeight : 0,
      base: base ? rectIn(host, base) : null,
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.STATIC_DRAW);
    // Runs of each material, found once here rather than on every frame.
    runs = new Map();
    const verts = geometry.vertices;
    let start = 0;
    for (let i = 1; i <= geometry.count; i += 1) {
      const mat = i < geometry.count ? verts[i * geometry.stride] : -1;
      if (mat !== verts[start * geometry.stride]) {
        const id = verts[start * geometry.stride];
        if (!runs.has(id)) runs.set(id, []);
        runs.get(id).push([start, i - start]);
        start = i;
      }
    }
    eye = [W / 2, H / 2, dist];
    proj = perspective(FOVY, W / H, 1, dist + 400);
    view = lookAt(eye, [W / 2, H / 2, 0], [0, 1, 0]);
  }

  function draw() {
    if (!geometry) return;
    gl.viewport(0, 0, back.width, back.height);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(L.u.uProj, false, proj);
    gl.uniformMatrix4fv(L.u.uView, false, view);
    gl.uniform3fv(L.u.uKey, key);
    gl.uniform3fv(L.u.uEye, eye);
    gl.uniform1i(L.u.uTex, 0);
    gl.uniform1i(L.u.uRough, 1);
    gl.uniform1f(L.u.uPhase, (performance.now() - t0) / 1000);
    const light = geometry.marqueeLight || [0, 0, 1, 1];
    gl.uniform4f(L.u.uGlowBox, light[0], light[1], light[2], light[3]);

    const stride = geometry.stride * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(L.a.aPos);
    gl.vertexAttribPointer(L.a.aPos, 3, gl.FLOAT, false, stride, 4);
    gl.enableVertexAttribArray(L.a.aNormal);
    gl.vertexAttribPointer(L.a.aNormal, 3, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(L.a.aUV);
    gl.vertexAttribPointer(L.a.aUV, 2, gl.FLOAT, false, stride, 28);

    // One material per draw, picked by a uniform, never by indexing a uniform array with
    // a varying: the vertices are grouped by material at build time.
    for (const [name, m] of Object.entries(materials)) {
      const id = geometry.materials[name];
      const spans = runs.get(id);
      if (!spans) continue;
      // The shadows are blended over the faces already drawn, and do not write depth.
      if (m.blend) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      } else {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
      const t = tex[m.file] || tex['cab-vinyl'];
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.colour);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.rough);
      gl.uniform1i(L.u.uMode, m.mode || 0);
      gl.uniform3fv(L.u.uGlow, m.colour || [0, 0, 0]);
      gl.uniform3fv(L.u.uTint, m.tint || [1, 1, 1]);
      gl.uniform1f(L.u.uSpec, m.spec ?? 0);
      gl.uniform1f(L.u.uShade, m.shade ?? 1);
      for (const [start, count] of spans) gl.drawArrays(gl.TRIANGLES, start, count);
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }

  const stage = host.closest('.slot-stage');
  let lastTilt = [NaN, NaN];
  function drawGlass(force = false) {
    const [tx, ty] = tiltOf(stage);
    if (!force && Math.abs(tx - lastTilt[0]) < 0.01 && Math.abs(ty - lastTilt[1]) < 0.01) return;
    lastTilt = [tx, ty];
    gg.viewport(0, 0, glass.width, glass.height);
    gg.clearColor(0, 0, 0, 0);
    gg.clear(gg.COLOR_BUFFER_BIT);
    gg.useProgram(gprog);
    gg.uniform2f(G.u.uTilt, tx, ty);
    gg.uniform1f(G.u.uAspect, glass.width / Math.max(1, glass.height));
    gg.bindBuffer(gg.ARRAY_BUFFER, gbuf);
    gg.enableVertexAttribArray(G.a.aPos);
    gg.vertexAttribPointer(G.a.aPos, 2, gg.FLOAT, false, 0, 0);
    gg.drawArrays(gg.TRIANGLES, 0, 6);
  }

  // Both canvases follow the DOM box they cover, in device pixels capped at 2x like every
  // other renderer here. Only reallocated when the size actually moved: assigning
  // canvas.width clears the buffer even for the same value.
  const fit = (canvas, box, fallbackW, fallbackH) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = box.offsetWidth || fallbackW;
    const h = box.offsetHeight || fallbackH;
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      canvas.style.setProperty('width', `${w}px`);
      canvas.style.setProperty('height', `${h}px`);
    }
  };
  const resize = () => {
    fit(back, host, 660, 500);
    fit(glass, opts.reels || opts.window, 400, 300);
    layout();
    draw();
    drawGlass(true);
  };
  resize();
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => resize());
    ro.observe(host);
  }

  // The glass follows the viewer: a frame when the tilt moved, nothing when it did not.
  // The lights are alive, so the housing is drawn again every other frame for them.
  let raf = null;
  let frames = 0;
  const tick = () => {
    frames += 1;
    if (frames % 2 === 0) draw();
    drawGlass();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    get element() { return back; },
    get glass() { return glass; },
    resize,
    /** Repaint in another palette, without rebuilding: the geometry does not change. */
    setTheme(theme) {
      materials = materialsFor(theme);
      draw();
    },
    /** Who to tell when either context is lost; they build a new cabinet. */
    onLost(cb) { lostCb = cb; },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      unlistenBack();
      unlistenGlass();
      release(gl);
      release(gg);
      back.remove();
      glass.remove();
    },
  };
}
