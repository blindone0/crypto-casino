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
// WHAT THE MACHINE IS MADE OF
//
// A lacquered case with a chamfered edge and brass trim, in the theme's colour; a marquee
// band with a backlit panel in it, framed in brass, that the CSS title sits on; a bezel
// round the window that stands proud, brass or steel by theme; a strip of LEDs down each
// side of the window in the theme's accent, with a pulse running along them; the dark
// well behind the drums; and a deck along the bottom with the coin tray sunk into it and
// the spin button rising out of it, lit. Every theme reaches all of it through the
// palette in slotthemes.js — before that, every machine was walnut and brass whatever
// the selector said. Lit by the same key direction the drums use (gl.js), textured with
// the materials the RTX drew (tools/generate-materials.js) and their roughness, and
// tonemapped the same way.
//
// CSS: the marquee text, the lever, the payline, the sparks and the room. The CSS cabinet
// stays whole underneath as the fallback: when this returns null - no context, no
// shaders - not one rule changes, because everything here is gated on a class the app
// only adds when this succeeded.
//
// THE CAMERA MAPS THE FRONT PLANE 1:1
//
// Model units are CSS pixels of the cabinet box, x right, y up, z towards the viewer, and
// the camera sits on the centre line at the distance that makes the z = 0 plane fill the
// canvas exactly. So a quad drawn at the window's DOM rectangle lands on the window's DOM
// rectangle, and the bezel frames the drums to the pixel. Depth is real: the bezel's
// inner lip is closer than the case, the chamfers slope away, the tray sinks and the
// button rises, and the perspective is the same perspective the reel canvas was solved
// for. The parallax tilt is CSS on the whole cabinet, so every layer turns together.

import {
  context, program, locations, loadTexture, perspective, lookAt, KEY_DIR, ACES,
} from './gl.js';

const FOVY = 0.62;             // the drums' field of view, so the two perspectives agree
const CHAMFER = 16;            // the case edge, in px
const CASE_DEPTH = 22;
const BEZEL = 18;              // the frame around the window, and how far it stands proud
const WELL = 6;                // the drums sit this far behind the frame's outer face
const TEX_PX = 220;            // one texture repeat every so many px
const LED_W = 5;               // an LED strip's width
const BUTTON_R = 27;           // the spin button's radius, at most

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

// One shader, four ways of using it, picked by uMode per material: 0 a lit, textured
// surface; 1 the marquee's backlit panel; 2 a strip of LEDs; 3 the lamp in the button.
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
    // A strip of LEDs: the diodes are the peaks, and a pulse runs along them.
    float pulse = 0.55 + 0.45 * sin(vWorld.y * 0.055 - uPhase * 2.2);
    float diode = pow(0.5 + 0.5 * sin(vWorld.y * 0.9), 6.0) * 0.6;
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
  // Lacquer reads as lacquer by what it reflects: a broad sheen where the surface turns
  // away from the eye, warmer on faces that look up towards the marquee's light.
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0) * gloss * 0.45;
  vec3 room = mix(vec3(0.10, 0.11, 0.15), vec3(0.34, 0.30, 0.24), clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 lit = base * (0.22 + diff * 0.92 + fill) * uShade + vec3(spec) + room * fres;
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
// so black is nothing and a symbol can never be hidden by it. A specular sweep slides
// with the viewer - the tell a fixed gradient cannot fake - the edges brighten where the
// pane is seen at a graze, and a faint room sits in it the other way round.
const GLASS_FRAG = `
precision highp float;
varying vec2 vUV;
uniform vec2 uTilt;
uniform float uAspect;
void main() {
  vec2 uv = vUV;
  float d = uv.x * 0.9 + uv.y * 0.45 - 0.58 - uTilt.y * 0.03 + uTilt.x * 0.01;
  float band = exp(-d * d * 70.0) * 0.20;
  float ex = pow(abs(uv.x * 2.0 - 1.0), 6.0);
  float ey = pow(abs(uv.y * 2.0 - 1.0), 8.0);
  float fres = (ex + ey) * 0.24;
  vec2 p = vec2((uv.x - 0.24 + uTilt.y * 0.004) * uAspect, uv.y - 0.78 - uTilt.x * 0.004);
  float room = exp(-dot(p, p) * 18.0) * 0.07;
  vec3 c = vec3(0.90, 0.95, 1.0) * (band + fres) + vec3(1.0, 0.95, 0.85) * room;
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
const IDS = { lacquer: 0, brass: 1, steel: 2, well: 3, glow: 4, led: 5, lamp: 6 };

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
  };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/**
 * One quad, four corners in order round the face, with a flat normal from the winding
 * and UVs from world position, so a texture repeats at the same scale on every face.
 */
function quad(out, mat, a, b, c, d) {
  const raw = crossV(sub(b, a), sub(d, a));
  // A rectangle the layout squeezed to nothing has no face to light: skipped, not drawn.
  if (Math.hypot(raw[0], raw[1], raw[2]) < 1e-6) return;
  const n = unit(raw);
  const push = (p) => out.push(mat, p[0], p[1], p[2], n[0], n[1], n[2], p[0] / TEX_PX, p[1] / TEX_PX);
  push(a); push(b); push(c);
  push(a); push(c); push(d);
}

/** One triangle with its own UVs, for the faces whose texture is not the world's. */
function tri(out, mat, a, b, c, uvs) {
  const raw = crossV(sub(b, a), sub(c, a));
  if (Math.hypot(raw[0], raw[1], raw[2]) < 1e-6) return;
  const n = unit(raw);
  const push = (p, uv) => out.push(mat, p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1]);
  push(a, uvs[0]); push(b, uvs[1]); push(c, uvs[2]);
}

/**
 * The spin button: a bevel rising from the deck to a lamp. `cx`, `cy` in model units,
 * y up. The lamp's UVs are centred on it, so the shader can light it from the middle.
 */
function button(out, cx, cy, r, segments = 28) {
  const top = 9;
  const ri = r * 0.78;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0); const s0 = Math.sin(a0);
    const c1 = Math.cos(a1); const s1 = Math.sin(a1);
    // The bevel, outward and up.
    quad(out, IDS.brass,
      [cx + c0 * r, cy + s0 * r, 0], [cx + c1 * r, cy + s1 * r, 0],
      [cx + c1 * ri, cy + s1 * ri, top], [cx + c0 * ri, cy + s0 * ri, top]);
    // The lamp.
    tri(out, IDS.lamp,
      [cx, cy, top], [cx + c0 * ri, cy + s0 * ri, top], [cx + c1 * ri, cy + s1 * ri, top],
      [[0.5, 0.5], [0.5 + c0 * 0.5, 0.5 + s0 * 0.5], [0.5 + c1 * 0.5, 0.5 + s1 * 0.5]]);
  }
}

/**
 * The cabinet, as quads, from the rectangles the DOM measured.
 *
 * `W`, `H` are the cabinet's size; `win` is the window's rectangle within it; `base` the
 * deck strip; all in CSS px with y down, as the DOM reports them. Returns a flat list of
 * vertices tagged with their material, and is pure so a test can hold it.
 */
export function buildGeometry({ W, H, win, marqueeH = 0, base = null }) {
  const Y = (y) => H - y;              // DOM y down to model y up
  const v = [];
  const M = IDS;
  const rect = (m, x0, y0, x1, y1, z) => quad(v, m,
    [x0, Y(y1), z], [x1, Y(y1), z], [x1, Y(y0), z], [x0, Y(y0), z]);

  // The case edge: a chamfer all round, sloping back from the face to the outside.
  const inX0 = CHAMFER; const inY0 = CHAMFER; const inX1 = W - CHAMFER; const inY1 = H - CHAMFER;
  const zb = -CASE_DEPTH;
  quad(v, M.lacquer, [0, Y(0), zb], [W, Y(0), zb], [inX1, Y(inY0), 0], [inX0, Y(inY0), 0]);        // top
  quad(v, M.lacquer, [inX0, Y(inY1), 0], [inX1, Y(inY1), 0], [W, Y(H), zb], [0, Y(H), zb]);        // bottom
  quad(v, M.lacquer, [0, Y(H), zb], [inX0, Y(inY1), 0], [inX0, Y(inY0), 0], [0, Y(0), zb]);        // left
  quad(v, M.lacquer, [inX1, Y(inY1), 0], [W, Y(H), zb], [W, Y(0), zb], [inX1, Y(inY0), 0]);        // right
  // Brass trim where the chamfer meets the face.
  rect(M.brass, inX0, inY0, inX1, inY0 + 2, 0.4);
  rect(M.brass, inX0, inY1 - 2, inX1, inY1, 0.4);
  rect(M.brass, inX0, inY0, inX0 + 2, inY1, 0.4);
  rect(M.brass, inX1 - 2, inY0, inX1, inY1, 0.4);

  // The front: lacquer everywhere the window is not, with the marquee band at the top
  // and the deck at the bottom.
  const bx0 = win.x - BEZEL; const by0 = win.y - BEZEL; const bx1 = win.x + win.w + BEZEL; const by1 = win.y + win.h + BEZEL;
  const baseTop = base ? base.y : inY1;
  const mqBottom = Math.max(inY0, Math.min(by0, inY0 + marqueeH));
  rect(M.lacquer, inX0, inY0, inX1, mqBottom, 0);                                                // the marquee band
  // The marquee light: a backlit panel inset in the band, in a brass frame.
  let marqueeLight = null;
  if (mqBottom - inY0 > 26) {
    const mx0 = inX0 + 14; const mx1 = inX1 - 14; const my0 = inY0 + 10; const my1 = mqBottom - 8;
    rect(M.brass, mx0 - 3, my0 - 3, mx1 + 3, my1 + 3, 0.5);
    rect(M.glow, mx0, my0, mx1, my1, 1.0);
    marqueeLight = [mx0, Y(my1), mx1, Y(my0)];
  }
  rect(M.brass, inX0, mqBottom, inX1, mqBottom + 3, 1);                                          // a brass rule under it
  rect(M.lacquer, inX0, mqBottom, inX1, by0, 0);                                                  // above the window
  rect(M.lacquer, inX0, by0, bx0, by1, 0);                                                        // left of it
  rect(M.lacquer, bx1, by0, inX1, by1, 0);                                                        // right of it
  rect(M.lacquer, inX0, by1, inX1, baseTop, 0);                                                   // below it
  // The LEDs: a strip down each side of the window, where the lacquer leaves room.
  if (bx0 - inX0 > LED_W + 14 && inX1 - bx1 > LED_W + 14) {
    rect(M.led, inX0 + 8, by0 + 6, inX0 + 8 + LED_W, by1 - 6, 0.6);
    rect(M.led, inX1 - 8 - LED_W, by0 + 6, inX1 - 8, by1 - 6, 0.6);
  }

  if (base) {
    // The deck: lacquer with a brass edge, the tray sunk into its left, the button
    // rising from its right.
    const th = Math.min(base.h * 0.62, 34);
    const tx0 = base.x + base.w * 0.06; const tx1 = base.x + base.w * 0.42;
    const ty0 = base.y + (base.h - th) / 2; const ty1 = ty0 + th;
    // The deck face, with the tray's mouth left open in it: a face drawn across the
    // recess would hide the recess, and did.
    rect(M.lacquer, inX0, base.y, inX1, ty0, 0);
    rect(M.lacquer, inX0, ty1, inX1, inY1, 0);
    rect(M.lacquer, inX0, ty0, tx0, ty1, 0);
    rect(M.lacquer, tx1, ty0, inX1, ty1, 0);
    rect(M.brass, inX0, base.y, inX1, base.y + 2, 0.5);
    const lip = 7;
    const zt = -12;
    rect(M.well, tx0 + lip, ty0 + lip, tx1 - lip, ty1 - lip, zt);
    quad(v, M.steel, [tx0, Y(ty0), 0], [tx1, Y(ty0), 0], [tx1 - lip, Y(ty0 + lip), zt], [tx0 + lip, Y(ty0 + lip), zt]);
    quad(v, M.steel, [tx0 + lip, Y(ty1 - lip), zt], [tx1 - lip, Y(ty1 - lip), zt], [tx1, Y(ty1), 0], [tx0, Y(ty1), 0]);
    quad(v, M.steel, [tx0, Y(ty1), 0], [tx0 + lip, Y(ty1 - lip), zt], [tx0 + lip, Y(ty0 + lip), zt], [tx0, Y(ty0), 0]);
    quad(v, M.steel, [tx1 - lip, Y(ty1 - lip), zt], [tx1, Y(ty1), 0], [tx1, Y(ty0), 0], [tx1 - lip, Y(ty0 + lip), zt]);
    const r = Math.min(BUTTON_R, base.h * 0.42);
    if (r > 8) button(v, base.x + base.w * 0.74, Y(base.y + base.h / 2), r);
  }

  // The bezel: four chamfered strips from the face (z = 0) to a lip that stands proud.
  const wx0 = win.x; const wy0 = win.y; const wx1 = win.x + win.w; const wy1 = win.y + win.h;
  const zl = BEZEL;
  quad(v, M.brass, [bx0, Y(by0), 0], [bx1, Y(by0), 0], [wx1, Y(wy0), zl], [wx0, Y(wy0), zl]);    // top
  quad(v, M.brass, [wx0, Y(wy1), zl], [wx1, Y(wy1), zl], [bx1, Y(by1), 0], [bx0, Y(by1), 0]);    // bottom
  quad(v, M.brass, [bx0, Y(by1), 0], [wx0, Y(wy1), zl], [wx0, Y(wy0), zl], [bx0, Y(by0), 0]);    // left
  quad(v, M.brass, [wx1, Y(wy1), zl], [bx1, Y(by1), 0], [bx1, Y(by0), 0], [wx1, Y(wy0), zl]);    // right
  // The lip's inner face, back to the well: what you see past the drums' edges.
  const zw = -WELL;
  quad(v, M.well, [wx0, Y(wy0), zl], [wx1, Y(wy0), zl], [wx1, Y(wy0), zw], [wx0, Y(wy0), zw]);
  quad(v, M.well, [wx0, Y(wy1), zw], [wx1, Y(wy1), zw], [wx1, Y(wy1), zl], [wx0, Y(wy1), zl]);
  quad(v, M.well, [wx0, Y(wy1), zw], [wx0, Y(wy1), zl], [wx0, Y(wy0), zl], [wx0, Y(wy0), zw]);
  quad(v, M.well, [wx1, Y(wy1), zl], [wx1, Y(wy1), zw], [wx1, Y(wy0), zw], [wx1, Y(wy0), zl]);
  // The well itself, behind the drums.
  rect(M.well, wx0, wy0, wx1, wy1, zw);

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
    // The bezel frames the drums themselves, a few px out, not the padded window box
    // round them: framed at the box, the well showed as a black band inside the lip.
    const framed = rectIn(host, opts.reels || opts.window);
    const gap = opts.reels ? 4 : 0;
    const win = { x: framed.x - gap, y: framed.y - gap, w: framed.w + gap * 2, h: framed.h + gap * 2 };
    const marquee = host.querySelector('.slot-marquee');
    const base = host.querySelector('.slot-base');
    geometry = buildGeometry({
      W, H, win,
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
    // The camera on the centre line, at the distance that maps the front plane 1:1.
    const dist = (H / 2) / Math.tan(FOVY / 2);
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
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      back.remove();
      glass.remove();
    },
  };
}
