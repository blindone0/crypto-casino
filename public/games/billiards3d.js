// The Russian table, in three dimensions.
//
// billiards-rules.js decides everything in millimetres on a flat cloth; this draws that
// cloth as a table. World units are those millimetres: x down the length, y across, z up,
// the cloth at z = 0 and every ball's centre at z = R. The camera hangs high over the
// head of the table looking down its length, the way a player sees it standing at the
// дом, which is also what makes a portrait canvas the right shape for it.
//
// What is drawn: the cloth, from the felt the dice table uses; the cushions and the frame
// in walnut; the six pockets as holes cut into the frame; the balls as spheres — ivory
// bone for the fifteen, deep red resin for the биток — rolling with their velocity, each
// with a contact shadow; the cue, along the aim while a shot is being made; and the aim
// line to the first thing the cue ball will meet. One lamp over the table lights all of
// it, so the far end is dimmer than the near, and the specular on a ball tells you where
// the lamp is.
//
// Same rule as every renderer here: createView returns null when there is no context or
// the shaders will not compile, and the cabinet draws the cloth flat instead. Nothing in
// the rules changes either way.

import {
  context, program, locations, loadTexture, perspective, lookAt, multiply, identity, ACES, onLost, release,
} from '../gl.js';
import { L, W, R, RAILS, POCKETS, CORNER_MOUTH, MIDDLE_MOUTH, cueBall, predict } from './billiards-rules.js';

const RAIL_W = 92;              // the cushion and the wood behind it, together
const RAIL_H = 42;
// The camera stands behind the head of the table, high, and looks a little short of the
// middle: with a 42-degree lens on a portrait canvas that puts the near rail and the far
// rail both inside the picture with a few degrees to spare.
const FOVY = 0.74;
const EYE = [-1000, W / 2, 4400];
const TARGET = [L / 2 - 250, W / 2, 0];
const UP = [0, 0, 1];
const LAMP = [L / 2, W / 2, 1900];

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUV;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vWorld;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUV = aUV;
  gl_Position = uProj * uView * world;
}`;

// One shader, four ways of using it, picked by uMode per draw: 0 a lit textured surface,
// 1 the cloth, 2 a flat colour, 3 a contact shadow that fades from its centre.
const FRAG = `
precision highp float;
varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vWorld;
uniform sampler2D uTex;
uniform sampler2D uRough;
uniform vec3 uLamp;
uniform vec3 uEye;
uniform vec3 uTint;
uniform vec4 uColour;
uniform float uGloss;
uniform int uMode;
${ACES}
void main() {
  if (uMode == 2) { gl_FragColor = uColour; return; }
  if (uMode == 3) {
    float r = length(vUV - 0.5) * 2.0;
    gl_FragColor = vec4(uColour.rgb, uColour.a * (1.0 - smoothstep(0.45, 1.0, r)));
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 toLamp = uLamp - vWorld;
  float dist = length(toLamp);
  vec3 l = toLamp / dist;
  // A lamp over the middle of the table: the far end is dimmer than the near.
  float fall = 1.0 / (1.0 + dist * dist / 9000000.0);
  vec3 v = normalize(uEye - vWorld);
  vec3 h = normalize(l + v);
  float diff = max(dot(n, l), 0.0);
  vec3 lit;
  if (uMode == 1) {
    // The cloth: two samples at different scales so the weave shows no period, and a
    // grazing sheen from the roughness, the way the dice table does it.
    vec2 uvA = vWorld.xy / 300.0;
    vec2 uvB = vec2(vWorld.x * 0.0011 - vWorld.y * 0.0007, vWorld.x * 0.0007 + vWorld.y * 0.0011);
    vec3 felt = mix(texture2D(uTex, uvA).rgb, texture2D(uTex, uvB).rgb, 0.35) * uTint;
    float rough = texture2D(uRough, uvA).r;
    float graze = pow(1.0 - max(v.z, 0.0), 3.0);
    float sheen = graze * (1.0 - rough) * 0.14;
    lit = felt * (0.28 + diff * fall * 2.2) + sheen * vec3(0.16, 0.30, 0.22) * fall;
  } else {
    vec3 base = texture2D(uTex, vUV).rgb * uTint;
    float spec = pow(max(dot(n, h), 0.0), mix(8.0, 140.0, uGloss)) * uGloss * 1.6 * fall;
    // A touch of rim, so a ball's edge separates from the cloth behind it.
    float rim = pow(1.0 - max(dot(n, v), 0.0), 4.0) * 0.08 * uGloss;
    lit = base * (0.26 + diff * fall * 1.9) + vec3(spec) + vec3(rim);
  }
  gl_FragColor = vec4(tonemap(lit), 1.0);
}`;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** Rodrigues: a rotation about a unit axis, column major, as gl.js builds its matrices. */
function axisRotation(axis, angle) {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return new Float32Array([
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ]);
}

const translate = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

// ---------------------------------------------------------------- meshes
/** A flat array of pos(3) normal(3) uv(2) per vertex. */
class Mesh {
  constructor() { this.v = []; }
  quad(a, b, c, d, uvScale = 1 / 300) {
    const n = unit(crossV(sub(b, a), sub(d, a)));
    const push = (p) => this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], p[0] * uvScale, p[1] * uvScale);
    push(a); push(b); push(c); push(a); push(c); push(d);
  }
  disc(cx, cy, z, r, segments = 28) {
    for (let i = 0; i < segments; i += 1) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p0 = [cx, cy, z];
      const p1 = [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z];
      const p2 = [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z];
      const push = (p, u, w) => this.v.push(p[0], p[1], p[2], 0, 0, 1, u, w);
      push(p0, 0.5, 0.5);
      push(p1, 0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5);
      push(p2, 0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5);
    }
  }
  get count() { return this.v.length / 8; }
}

/** A unit sphere, lat-long, with the seam on the far side of nobody in particular. */
function sphere(segments = 20, rings = 14) {
  const m = new Mesh();
  const at = (i, j) => {
    const th = (j / rings) * Math.PI;
    const ph = (i / segments) * Math.PI * 2;
    return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
  };
  for (let j = 0; j < rings; j += 1) {
    for (let i = 0; i < segments; i += 1) {
      const a = at(i, j); const b = at(i + 1, j); const c = at(i + 1, j + 1); const d = at(i, j + 1);
      const uv = (p, ii, jj) => m.v.push(p[0], p[1], p[2], p[0], p[1], p[2], ii / segments, jj / rings);
      uv(a, i, j); uv(b, i + 1, j); uv(c, i + 1, j + 1);
      uv(a, i, j); uv(c, i + 1, j + 1); uv(d, i, j + 1);
    }
  }
  return m;
}

/** A tapered cylinder along +x from 0 to `length`, radius r0 at the start, r1 at the end. */
function taper(length, r0, r1, segments = 12) {
  const m = new Mesh();
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const ring = (x, r, a) => [x, Math.cos(a) * r, Math.sin(a) * r];
    const p = [ring(0, r0, a0), ring(length, r1, a0), ring(length, r1, a1), ring(0, r0, a1)];
    const push = (q, u, w) => m.v.push(q[0], q[1], q[2], 0, q[1] / (r0 + r1), q[2] / (r0 + r1), u, w);
    push(p[0], 0, i / segments); push(p[1], 1, i / segments); push(p[2], 1, (i + 1) / segments);
    push(p[0], 0, i / segments); push(p[2], 1, (i + 1) / segments); push(p[3], 0, (i + 1) / segments);
  }
  return m;
}

/** The table that never moves: the cloth, the cushions, the frame, the pockets. */
function tableMeshes() {
  const cloth = new Mesh();
  cloth.quad([-RAIL_W, -RAIL_W, 0], [L + RAIL_W, -RAIL_W, 0], [L + RAIL_W, W + RAIL_W, 0], [-RAIL_W, W + RAIL_W, 0]);

  const wood = new Mesh();
  const z = RAIL_H;
  // The frame: a ring at cushion height all round, on which the pockets are cut.
  wood.quad([-RAIL_W, -RAIL_W, z], [L + RAIL_W, -RAIL_W, z], [L + RAIL_W, 0, z], [-RAIL_W, 0, z]);
  wood.quad([-RAIL_W, W, z], [L + RAIL_W, W, z], [L + RAIL_W, W + RAIL_W, z], [-RAIL_W, W + RAIL_W, z]);
  wood.quad([-RAIL_W, 0, z], [0, 0, z], [0, W, z], [-RAIL_W, W, z]);
  wood.quad([L, 0, z], [L + RAIL_W, 0, z], [L + RAIL_W, W, z], [L, W, z]);
  // The outer face of the frame, down to the floor of the picture.
  const drop = 90;
  wood.quad([-RAIL_W, -RAIL_W, z - drop], [L + RAIL_W, -RAIL_W, z - drop], [L + RAIL_W, -RAIL_W, z], [-RAIL_W, -RAIL_W, z]);
  wood.quad([L + RAIL_W, W + RAIL_W, z - drop], [-RAIL_W, W + RAIL_W, z - drop], [-RAIL_W, W + RAIL_W, z], [L + RAIL_W, W + RAIL_W, z]);
  wood.quad([-RAIL_W, W + RAIL_W, z - drop], [-RAIL_W, -RAIL_W, z - drop], [-RAIL_W, -RAIL_W, z], [-RAIL_W, W + RAIL_W, z]);
  wood.quad([L + RAIL_W, -RAIL_W, z - drop], [L + RAIL_W, W + RAIL_W, z - drop], [L + RAIL_W, W + RAIL_W, z], [L + RAIL_W, -RAIL_W, z]);

  // The cushions: the inner face of each segment, facing the cloth, in cloth.
  const cushion = new Mesh();
  for (const s of RAILS) {
    if (s.axis === 'y') {
      const y = s.at;
      if (y === 0) cushion.quad([s.from, 0, 0], [s.to, 0, 0], [s.to, 0, z], [s.from, 0, z]);
      else cushion.quad([s.to, W, 0], [s.from, W, 0], [s.from, W, z], [s.to, W, z]);
    } else {
      const x = s.at;
      if (x === 0) cushion.quad([0, s.to, 0], [0, s.from, 0], [0, s.from, z], [0, s.to, z]);
      else cushion.quad([L, s.from, 0], [L, s.to, 0], [L, s.to, z], [L, s.from, z]);
    }
  }

  const holes = new Mesh();
  for (const p of POCKETS) {
    holes.disc(p.x, p.y, z + 0.6, (p.corner ? CORNER_MOUTH : MIDDLE_MOUTH) / 2 + 22);
  }
  return { cloth, wood, cushion, holes };
}

/**
 * Build the view on a canvas the cabinet owns. Returns null when WebGL is not there.
 *
 * draw(state, aim, dt) paints the table as the rules have it; `aim` is
 * { angle, power, aiming } while a shot is being lined up, or null. toTable(clientX,
 * clientY) maps a pointer to the cloth, in millimetres, by casting a ray onto the plane
 * the balls' centres lie in.
 */
export function createView(canvas) {
  if (typeof document === 'undefined') return null;
  const gl = context(canvas, { alpha: false });
  if (!gl) return null;
  let prog;
  try { prog = program(gl, VERT, FRAG); } catch { return null; }
  let lostCb = null;
  const unlisten = onLost(canvas, () => { if (lostCb) lostCb(); });
  const P = locations(gl, prog, {
    attrs: ['aPos', 'aNormal', 'aUV'],
    uniforms: ['uProj', 'uView', 'uModel', 'uTex', 'uRough', 'uLamp', 'uEye', 'uTint', 'uColour', 'uGloss', 'uMode'],
  });

  const tex = {
    felt: loadTexture(gl, '/textures/felt-table.jpg', { onReady: () => { dirty = true; } }),
    feltRough: loadTexture(gl, '/textures/felt-table-rough.jpg', { onReady: () => { dirty = true; } }),
    wood: loadTexture(gl, '/textures/cab-wood.jpg', { onReady: () => { dirty = true; } }),
    bone: loadTexture(gl, '/textures/dice-bone.jpg', { onReady: () => { dirty = true; } }),
    resin: loadTexture(gl, '/textures/dice-resin.jpg', { onReady: () => { dirty = true; } }),
  };
  let dirty = true;

  const upload = (mesh) => {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.v), gl.STATIC_DRAW);
    return { buf, count: mesh.count };
  };
  const table = tableMeshes();
  const M = {
    cloth: upload(table.cloth), wood: upload(table.wood), cushion: upload(table.cushion), holes: upload(table.holes),
    ball: upload(sphere()), cue: upload(taper(1450, 14, 6)), unit: upload((() => { const m = new Mesh(); m.quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], 1); return m; })()),
  };

  let proj = null;
  let view = null;
  let aspect = 1;
  // The size the cabinet gave the canvas is the size it is shown at, shrunk to fit the
  // column on a phone; the drawing buffer is that in device pixels. The CSS size is PINNED
  // rather than read back: the arcade's stylesheet gives a canvas `max-width: 100%;
  // height: auto`, so its shown size follows its buffer size, and a buffer set from the
  // shown size times the pixel ratio would grow itself on every observe until it filled
  // the column. gl.js's sizer makes the same choice for the same reason.
  const logical = { w: canvas.width || 420, h: canvas.height || 750 };
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const host = canvas.parentElement;
    const avail = host && host.clientWidth ? host.clientWidth - 2 : logical.w;
    const w = Math.max(120, Math.min(logical.w, avail));
    const h = Math.round((w * logical.h) / logical.w);
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    // Only when it changed: assigning canvas.width clears the buffer even to the same value.
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      if (canvas.style && typeof canvas.style.setProperty === 'function') {
        canvas.style.setProperty('width', `${w}px`);
        canvas.style.setProperty('height', `${h}px`);
      }
    }
    aspect = cw / Math.max(1, ch);
    gl.viewport(0, 0, cw, ch);
    proj = perspective(FOVY, aspect, 100, 12000);
    view = lookAt(EYE, TARGET, UP);
    dirty = true;
  }

  // The camera basis, for casting a pointer onto the cloth.
  const fwd = unit(sub(TARGET, EYE));
  const right = unit(crossV(fwd, UP));
  const up = crossV(right, fwd);

  function toTable(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    const ty = Math.tan(FOVY / 2);
    const tx = ty * aspect;
    const dir = [
      fwd[0] + right[0] * nx * tx + up[0] * ny * ty,
      fwd[1] + right[1] * nx * tx + up[1] * ny * ty,
      fwd[2] + right[2] * nx * tx + up[2] * ny * ty,
    ];
    if (Math.abs(dir[2]) < 1e-6) return { x: L / 2, y: W / 2 };
    const t = (R - EYE[2]) / dir[2];
    return { x: EYE[0] + dir[0] * t, y: EYE[1] + dir[1] * t };
  }

  const spins = new Map();     // ball id -> rotation matrix, so a rolling ball rolls

  function bind(mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buf);
    gl.enableVertexAttribArray(P.a.aPos);
    gl.vertexAttribPointer(P.a.aPos, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(P.a.aNormal);
    gl.vertexAttribPointer(P.a.aNormal, 3, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(P.a.aUV);
    gl.vertexAttribPointer(P.a.aUV, 2, gl.FLOAT, false, 32, 24);
  }
  function material(mode, colour, rough, tint, gloss) {
    gl.uniform1i(P.u.uMode, mode);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, colour || tex.wood);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, rough || tex.feltRough);
    gl.uniform3fv(P.u.uTint, tint || [1, 1, 1]);
    gl.uniform1f(P.u.uGloss, gloss ?? 0.3);
  }
  const drawMesh = (mesh, model) => {
    gl.uniformMatrix4fv(P.u.uModel, false, model || identity());
    bind(mesh);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  };

  function draw(state, aim, dt) {
    if (!proj) resize();
    gl.clearColor(0.03, 0.04, 0.06, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(P.u.uProj, false, proj);
    gl.uniformMatrix4fv(P.u.uView, false, view);
    gl.uniform3fv(P.u.uLamp, LAMP);
    gl.uniform3fv(P.u.uEye, EYE);
    gl.uniform1i(P.u.uTex, 0);
    gl.uniform1i(P.u.uRough, 1);
    gl.uniform4f(P.u.uColour, 0, 0, 0, 1);

    material(1, tex.felt, tex.feltRough, [1.0, 1.0, 1.0], 0.2);
    drawMesh(M.cloth);
    material(1, tex.felt, tex.feltRough, [0.55, 0.6, 0.55], 0.2);
    drawMesh(M.cushion);
    material(0, tex.wood, tex.feltRough, [0.95, 0.88, 0.8], 0.45);
    drawMesh(M.wood);
    material(2);
    gl.uniform4f(P.u.uColour, 0.01, 0.01, 0.015, 1);
    drawMesh(M.holes);

    // Shadows first, blended onto the cloth, then the balls over them.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    material(3);
    gl.uniform4f(P.u.uColour, 0.02, 0.05, 0.03, 0.55);
    const sr = R * 1.25;
    for (const b of state.balls) {
      if (b.potted) continue;
      const m = new Float32Array([sr * 2, 0, 0, 0, 0, sr * 2, 0, 0, 0, 0, 1, 0, b.x - sr + 6, b.y - sr - 4, 0.8, 1]);
      drawMesh(M.unit, m);
    }

    // The aim: a line on the cloth to the first thing the cue ball will meet.
    if (aim && !state.over) {
      const c = cueBall(state);
      const hit = predict(state, aim.angle);
      const dx = Math.cos(aim.angle);
      const dy = Math.sin(aim.angle);
      const px = -dy;
      const py = dx;
      const m = new Mesh();
      const half = 3;
      m.quad([c.x + px * half, c.y + py * half, 1.2], [c.x - px * half, c.y - py * half, 1.2],
        [hit.x - px * half, hit.y - py * half, 1.2], [hit.x + px * half, hit.y + py * half, 1.2]);
      m.disc(hit.x, hit.y, 1.2, R, 20);
      const line = upload(m);
      material(2);
      gl.uniform4f(P.u.uColour, 1, 1, 1, aim.aiming ? 0.42 : 0.22);
      drawMesh(line);
      gl.deleteBuffer(line.buf);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // The balls: rolling with their velocity, ivory for the fifteen, resin for the биток.
    for (const b of state.balls) {
      if (b.potted) continue;
      let spin = spins.get(b.id) || identity();
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > 0 && dt > 0) {
        // A rolling ball turns about the axis across its motion, at the rate the cloth
        // takes it: angle = distance / radius.
        const axis = [-b.vy / speed, b.vx / speed, 0];
        spin = multiply(axisRotation(axis, (speed * dt) / R), spin);
        spins.set(b.id, spin);
      }
      const model = multiply(translate(b.x, b.y, R), multiply(spin, new Float32Array([R, 0, 0, 0, 0, R, 0, 0, 0, 0, R, 0, 0, 0, 0, 1])));
      if (b.cue) material(0, tex.resin, tex.feltRough, [1.0, 0.55, 0.5], 0.92);
      else material(0, tex.bone, tex.feltRough, [1.0, 0.98, 0.92], 0.88);
      drawMesh(M.ball, model);
    }

    // The cue: behind the ball along the aim, drawn back with the power.
    if (aim && !state.over && !cueBall(state).potted) {
      const c = cueBall(state);
      const back = R + 24 + aim.power * 280;
      const dx = Math.cos(aim.angle);
      const dy = Math.sin(aim.angle);
      // Along -aim from the tip, and lifted a little at the butt, the way a cue is held.
      const yaw = Math.atan2(-dy, -dx);
      const rotZ = axisRotation([0, 0, 1], yaw);
      const rotY = axisRotation([0, 1, 0], -0.06);
      const model = multiply(translate(c.x - dx * back, c.y - dy * back, R + 2), multiply(rotZ, rotY));
      material(0, tex.wood, tex.feltRough, [0.85, 0.7, 0.55], 0.5);
      drawMesh(M.cue, model);
    }
    dirty = false;
  }

  // The COLUMN is watched, not the canvas: with its CSS size pinned the canvas never
  // changes on its own, and what has to be heard is the column narrowing or widening.
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { resize(); dirty = true; });
    ro.observe(canvas.parentElement || canvas);
  }
  resize();

  return {
    kind: '3d',
    draw,
    toTable,
    resize,
    get dirty() { return dirty; },
    /** Who to tell when the context is lost; they build a new view on a new canvas. */
    onLost(cb) { lostCb = cb; },
    dispose() {
      ro?.disconnect();
      unlisten();
      for (const m of Object.values(M)) gl.deleteBuffer(m.buf);
      for (const t of Object.values(tex)) gl.deleteTexture(t);
      release(gl);
    },
  };
}
