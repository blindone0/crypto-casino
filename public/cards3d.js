// The card table: felt, a dealt trick, the talon, and the backs of other people's hands.
//
// WHAT THIS DRAWS AND WHAT IT DOES NOT
//
// It draws everything on the table. It does NOT draw your own hand — those stay DOM
// buttons, and that is a deliberate split rather than an unfinished job.
//
// A card you must pick, correctly, under time pressure, for money, should be a real
// button: it gets the browser's own hit testing, its focus ring, its tap target, and a
// keyboard. Ray-picking a 3D mesh would be a hand-rolled hit test standing between a
// player and the card they meant to play, and a misfire there does not look like a
// rendering bug, it looks like the site played the wrong card. The table is where the
// motion is — dealing, taking a trick, turning the upcard — and none of it needs to be
// clickable.
//
// So: canvas for the table, DOM for the hand, and the two share the deck's look because
// they share the same rendered texture.
//
// A CARD IS TWO QUADS, NOT A BOX
//
// Real cards are thin enough that their edge is a line, not a face. Drawing each as a
// six-sided box would triple the geometry for something nobody can see, so a card here is
// a front quad and a back quad a hair apart. Turning one over swaps which faces you,
// which is exactly what a real card does.
//
// The faces come from one atlas, 8 ranks by 4 suits, drawn rather than generated — see
// tools/generate-materials.js for why a model cannot be trusted to count pips.

import {
  context, program, locations, loadTexture, sizer,
  perspective, lookAt, multiply, translation, rotation, scaling, normalMatrix,
  KEY_DIR, ACES,
} from './gl.js';

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUV;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUV;
void main() {
  vNormal = normalize(uNormalMat * aNormal);
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vUV = aUV;
  gl_Position = uProj * uView * world;
}`;

// A printed card, lit.
//
// The card is paper, so it is almost entirely diffuse — a strong specular on a playing
// card reads as plastic, which is the exact wrong material. What little there is comes
// from the finish, and it is broad and weak.
const FRAG = `
precision highp float;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUV;

uniform sampler2D uStock;     // the paper
uniform sampler2D uArt;       // the face atlas, or the back pattern
uniform vec4 uArtRect;        // which part of the atlas this card shows: x, y, w, h
uniform vec3 uEye;
uniform vec3 uKey;
uniform float uIsBack;        // 1 when this quad shows the back
uniform float uDim;           // a played card is not the card in your hand
${ACES}

void main() {
  vec2 art = uArtRect.xy + vUV * uArtRect.zw;
  vec4 ink = texture2D(uArt, art);

  // The stock shows through wherever the ink is not. On the back the pattern IS the card,
  // so it covers the paper entirely; on a face the pips sit on visible stock.
  vec3 paper = texture2D(uStock, vUV * vec2(1.0, 1.4)).rgb;
  vec3 albedo = mix(paper, ink.rgb, uIsBack > 0.5 ? 1.0 : ink.a);

  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  vec3 k = normalize(uKey);

  float key = max(dot(n, k), 0.0);
  float fill = max(dot(n, normalize(vec3(0.6, 0.35, -0.5))), 0.0) * 0.30;
  vec3 ambient = vec3(0.30, 0.29, 0.27);

  // Weak and broad: card stock is matte, and a tight highlight would make it plastic.
  vec3 h = normalize(k + v);
  float spec = pow(max(dot(n, h), 0.0), 18.0) * 0.10;

  // The edge of the card against the felt. Cheap, and it is most of what stops a card
  // looking like a decal printed on the table.
  float rim = pow(1.0 - max(dot(n, v), 0.0), 4.0) * 0.10;

  vec3 lit = albedo * (ambient + key * vec3(1.0, 0.98, 0.95) + fill * vec3(0.6, 0.65, 0.75));
  lit += spec + rim;
  lit *= uDim;
  gl_FragColor = vec4(tonemap(lit), 1.0);
}`;

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

// The felt, and the shadow each card drops on it.
//
// Same approach as the dice table: two samples at different scales so the tile period
// does not show as a plaid, a grazing sheen off the nap, and shadows projected along the
// key light rather than painted underneath.
const TABLE_FRAG = `
precision highp float;
varying vec2 vUV;
varying vec3 vWorld;
uniform sampler2D uFelt;
uniform sampler2D uFeltRough;
uniform vec3 uEye;
uniform vec3 uKey;
uniform vec3 uCards[8];       // xyz of up to eight cards on the table
uniform float uCardCount;
${ACES}

void main() {
  vec2 uvA = vWorld.xz * 0.40;
  vec2 uvB = vec2(vWorld.x * 0.10 - vWorld.z * 0.07, vWorld.x * 0.07 + vWorld.z * 0.10);
  vec3 felt = mix(texture2D(uFelt, uvA).rgb, texture2D(uFelt, uvB).rgb, 0.35);
  float rough = texture2D(uFeltRough, uvA).r;

  vec3 v = normalize(uEye - vWorld);
  float graze = pow(1.0 - max(v.y, 0.0), 3.0);
  float sheen = graze * (1.0 - rough) * 0.16;

  float d = length(vWorld.xz) / 7.5;
  float pool = 1.0 - smoothstep(0.1, 1.0, d);

  vec3 lit = felt * (0.30 + pool * 1.40);
  lit += sheen * vec3(0.16, 0.30, 0.22) * (0.3 + pool);

  // A card's shadow is a soft rectangle offset along the light, not a disc. The loop is
  // fixed length because GLSL ES 1.0 will not take a variable bound.
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uCardCount) break;
    vec3 c = uCards[i];
    float hgt = max(c.y, 0.0);
    vec2 lift = uKey.xz * (hgt / max(uKey.y, 0.15));
    vec2 rel = abs(vWorld.xz + lift - c.xz);
    // Card-shaped: wider across than along, matching the quad.
    float box = max(rel.x / 0.62, rel.y / 0.88);
    float soft = 0.16 + hgt * 0.5;
    lit *= 1.0 - (0.42 / (1.0 + hgt * 2.0)) * (1.0 - smoothstep(1.0 - soft, 1.0 + soft, box));
  }

  gl_FragColor = vec4(tonemap(lit), 1.0);
}`;

/** The deck both games use: 7 through A, four suits. Must match the atlas layout. */
const RANKS = ['7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['S', 'C', 'D', 'H'];

/** Where a card's art sits in the atlas, as a 0..1 rectangle. */
function artRect(card) {
  const ri = RANKS.indexOf(card[0]);
  const si = SUITS.indexOf(card[1]);
  if (ri < 0 || si < 0) return [0, 0, 1 / RANKS.length, 1 / SUITS.length];
  // The atlas is flipped vertically on upload, like every texture here, so the row index
  // counts from the bottom.
  return [ri / RANKS.length, (SUITS.length - 1 - si) / SUITS.length,
    1 / RANKS.length, 1 / SUITS.length];
}

/** A card, as two quads back to back. Width 1, height 1.4, matching a real card. */
function cardMesh(gl) {
  const W = 0.5;
  const H = 0.7;
  const T = 0.006;          // half the thickness: enough to stop z-fighting, too thin to see
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];

  // Front, facing +Y, then back, facing -Y. The back's UVs run the other way in x so the
  // pattern is not mirrored when the card turns over.
  const quad = (y, ny, flip) => {
    const base = pos.length / 3;
    const xs = flip ? [1, 0, 1, 0] : [0, 1, 0, 1];
    pos.push(-W, y, -H, W, y, -H, -W, y, H, W, y, H);
    for (let i = 0; i < 4; i += 1) nrm.push(0, ny, 0);
    // v runs 1 at the far edge to 0 at the near edge, which looks backwards and is not.
    //
    // Every texture here is uploaded with UNPACK_FLIP_Y, so v = 0 samples the BOTTOM of
    // the image. A card lying on the table has its top edge pointing away from the
    // camera, at -H — so the far edge needs the image's top, which after the flip is
    // v = 1. Getting this the intuitive way round printed every court card upside down.
    uv.push(xs[0], 1, xs[1], 1, xs[2], 0, xs[3], 0);
    if (ny > 0) idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    else idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  };
  quad(T, 1, false);
  quad(-T, -1, true);

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
    idx: buf(idx, Uint16Array, gl.ELEMENT_ARRAY_BUFFER),
    // Six indices per quad; the front is the first six.
    frontCount: 6,
    backOffset: 6,
    backCount: 6,
  };
}

const ease = (t) => 1 - (1 - t) ** 3;

/**
 * Build a card table.
 *
 * Returns null when WebGL cannot be had, and the caller keeps its DOM table. A game that
 * does not draw is worse than a game drawn plainly.
 */
export function createTable(host, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'cards-canvas';
  host.appendChild(canvas);

  const gl = context(canvas);
  if (!gl) { canvas.remove(); return null; }

  let progCard;
  let progTable;
  try {
    progCard = program(gl, VERT, FRAG);
    progTable = program(gl, TABLE_VERT, TABLE_FRAG);
  } catch {
    canvas.remove();
    return null;
  }

  const L = locations(gl, progCard, {
    attrs: ['aPos', 'aNormal', 'aUV'],
    uniforms: ['uProj', 'uView', 'uModel', 'uNormalMat', 'uStock', 'uArt',
      'uArtRect', 'uEye', 'uKey', 'uIsBack', 'uDim'],
  });
  const T = locations(gl, progTable, {
    attrs: ['aPos', 'aUV'],
    uniforms: ['uProj', 'uView', 'uFelt', 'uFeltRough', 'uEye', 'uKey',
      'uCards', 'uCardCount'],
  });

  /**
   * Scratch buffers, filled in place rather than reallocated every frame.
   *
   * `eye` and `KEY_DIR` are constants and were boxed into a fresh Float32Array twice each
   * per frame; `uArtRect` allocated twice per card, one of them for the literal
   * [0, 0, 1, 1]. With six cards on the table that was about ninety allocations a frame,
   * five thousand a second, all of them immediately garbage. It does not lower the average
   * frame rate — it produces a hitch every few hundred frames, which is the artefact a
   * player actually notices.
   */
  const EYE = new Float32Array(3);
  const KEY = new Float32Array(KEY_DIR);
  const CARD_XYZ = new Float32Array(24);
  const ART = new Float32Array(4);
  const BACK_RECT = new Float32Array([0, 0, 1, 1]);

  const mesh = cardMesh(gl);
  const base = opts.textures || '/textures/';
  let raf = null;
  const repaint = () => { try { if (raf === null) draw(); } catch { /* not built yet */ } };

  const texStock = loadTexture(gl, `${base}card-stock.jpg`, { onReady: repaint });
  const texFaces = loadTexture(gl, `${base}card-faces.png`, { repeat: false, onReady: repaint });
  const texBack = loadTexture(gl, `${base}card-back.jpg`, { onReady: repaint });
  const texFelt = loadTexture(gl, `${base}felt-table.jpg`, { onReady: repaint });
  const texFeltRough = loadTexture(gl, `${base}felt-table-rough.jpg`, { onReady: repaint });

  const tableBuf = (() => {
    const s = 9;
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -s, 0, -s, 0, 0, s, 0, -s, 1, 0, s, 0, s, 1, 1,
      -s, 0, -s, 0, 0, s, 0, s, 1, 1, -s, 0, s, 0, 1,
    ]), gl.STATIC_DRAW);
    return b;
  })();

  /**
   * What is on the table.
   *
   * Each entry is a card with a place to be. `from` and `t` exist only while it is
   * travelling: a card being dealt interpolates from the deck to its seat, and once it
   * arrives it simply sits there.
   */
  let cards = [];

  // Looking down at 67 degrees, which is steeper than it first looks and is deliberate.
  //
  // A card lying flat has its long axis running away from the camera, so perspective
  // foreshortens exactly the dimension that makes a card a card. At the 47 degrees this
  // started at, a correctly proportioned 1:1.4 card rendered at 1:1.03 on screen — square,
  // and it read as a tile rather than a card. The mesh was right and the camera was wrong.
  // At 67 degrees it reads 1:1.28, which is card-like while keeping enough angle that the
  // table still has depth.
  const eye = [0, 9.2, 4.4];
  const view = lookAt(eye, [0, 0, 0.4], [0, 1, 0]);

  function draw() {
    const aspect = canvas.width / Math.max(1, canvas.height);
    const proj = perspective(0.66, aspect, 0.1, 40);

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.035, 0.05, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // --- felt
    gl.useProgram(progTable);
    gl.bindBuffer(gl.ARRAY_BUFFER, tableBuf);
    gl.enableVertexAttribArray(T.a.aPos);
    gl.vertexAttribPointer(T.a.aPos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(T.a.aUV);
    gl.vertexAttribPointer(T.a.aUV, 2, gl.FLOAT, false, 20, 12);
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
    gl.uniform3fv(T.u.uKey, KEY);

    // Reused across frames, so it must be cleared: the previous frame's card positions
    // are still in it, and a frame with fewer cards than the last one would otherwise
    // leave a shadow lying on the felt under a card that is no longer there. The old code
    // allocated a fresh zeroed array each frame and got this for free.
    CARD_XYZ.fill(0);
    const shadowCount = Math.min(cards.length, 8);
    for (let i = 0; i < shadowCount; i += 1) {
      const p = placeOf(cards[i]);
      CARD_XYZ[i * 3] = p[0];
      CARD_XYZ[i * 3 + 1] = p[1];
      CARD_XYZ[i * 3 + 2] = p[2];
    }
    gl.uniform3fv(T.u.uCards, CARD_XYZ);
    gl.uniform1f(T.u.uCardCount, shadowCount);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- cards
    gl.useProgram(progCard);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pos);
    gl.enableVertexAttribArray(L.a.aPos);
    gl.vertexAttribPointer(L.a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrm);
    gl.enableVertexAttribArray(L.a.aNormal);
    gl.vertexAttribPointer(L.a.aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv);
    gl.enableVertexAttribArray(L.a.aUV);
    gl.vertexAttribPointer(L.a.aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idx);

    gl.uniformMatrix4fv(L.u.uProj, false, proj);
    gl.uniformMatrix4fv(L.u.uView, false, view);
    gl.uniform3fv(L.u.uEye, EYE);
    gl.uniform3fv(L.u.uKey, KEY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texStock);
    gl.uniform1i(L.u.uStock, 0);

    for (const c of cards) {
      const p = placeOf(c);
      const model = multiply(
        translation(p[0], p[1] + 0.02, p[2]),
        multiply(rotation(0, c.turn ?? 0, 0), scaling(c.scale ?? 1)),
      );
      gl.uniformMatrix4fv(L.u.uModel, false, model);
      gl.uniformMatrix3fv(L.u.uNormalMat, false, normalMatrix(model));
      gl.uniform1f(L.u.uDim, c.dim ?? 1);

      // The face, if this card is shown. A hidden card draws its back on both quads —
      // there is no "other side" to leak, which is the point of a card back.
      gl.activeTexture(gl.TEXTURE1);
      if (c.card) {
        gl.bindTexture(gl.TEXTURE_2D, texFaces);
        gl.uniform1i(L.u.uArt, 1);
        ART.set(artRect(c.card));
        gl.uniform4fv(L.u.uArtRect, ART);
        gl.uniform1f(L.u.uIsBack, 0);
        gl.drawElements(gl.TRIANGLES, mesh.frontCount, gl.UNSIGNED_SHORT, 0);
      }
      gl.bindTexture(gl.TEXTURE_2D, texBack);
      gl.uniform1i(L.u.uArt, 1);
      gl.uniform4fv(L.u.uArtRect, BACK_RECT);
      gl.uniform1f(L.u.uIsBack, 1);
      // A hidden card shows its back to the room; a face-up one shows it downwards.
      if (c.card) {
        gl.drawElements(gl.TRIANGLES, mesh.backCount, gl.UNSIGNED_SHORT, mesh.backOffset * 2);
      } else {
        gl.drawElements(gl.TRIANGLES, mesh.frontCount, gl.UNSIGNED_SHORT, 0);
        gl.drawElements(gl.TRIANGLES, mesh.backCount, gl.UNSIGNED_SHORT, mesh.backOffset * 2);
      }
    }
  }

  /** Where a card is right now, interpolating if it is still on its way. */
  function placeOf(c) {
    if (!c.from || c.t >= 1) return c.at;
    const e = ease(c.t);
    return [
      c.from[0] + (c.at[0] - c.from[0]) * e,
      c.from[1] + (c.at[1] - c.from[1]) * e + Math.sin(c.t * Math.PI) * 0.9,
      c.from[2] + (c.at[2] - c.from[2]) * e,
    ];
  }

  let last = 0;
  function frame(now) {
    if (!last) last = now;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    let busy = false;
    for (const c of cards) {
      if (c.from && c.t < 1) {
        c.t = Math.min(1, c.t + dt / (c.ms / 1000));
        if (c.t < 1) busy = true;
      }
    }
    draw();
    if (busy) {
      raf = requestAnimationFrame(frame);
    } else {
      raf = null;
      last = 0;
    }
  }

  const wake = () => { if (raf === null) raf = requestAnimationFrame(frame); };

  const size = sizer(canvas, gl, host, { aspect: opts.aspect ?? 0.58 });
  size.resize();
  draw();
  size.observe(draw);

  return {
    canvas,

    /**
     * Put the table into a state.
     *
     * `layout` is a list of `{ card, at, turn, dim, scale, deal }`. A `card` of null is a
     * face-down back. `deal: true` means it should fly in from the deck rather than
     * appear, which is what makes a hand being dealt read as dealing.
     *
     * The whole table is replaced each time rather than diffed: a trick is at most a
     * handful of cards, and a diff would be more code and more ways to be wrong than the
     * thing it saves.
     */
    show(layout, { ms = 420 } = {}) {
      const deck = [-3.6, 0.9, -1.2];
      cards = layout.map((c) => ({
        ...c,
        at: c.at,
        from: c.deal ? deck : null,
        t: c.deal ? 0 : 1,
        ms,
      }));
      if (cards.some((c) => c.from)) wake();
      else draw();
    },

    /** Redraw without changing anything. */
    refresh: draw,

    destroy() {
      if (raf !== null) cancelAnimationFrame(raf);
      size.disconnect();
      canvas.remove();
    },
  };
}

export { RANKS, SUITS, artRect };
