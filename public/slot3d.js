// The slot reels as real geometry.
//
// Five cylinders, lit, turning on a shared axis, drawn with WebGL. The CSS version this
// replaces was genuine 3D as far as the browser's transform model goes, but it can only
// rotate flat rectangles: a drum built that way is a ring of facets, and no amount of
// shading hides that the surface between them is straight.
//
// Written against the WebGL API directly rather than through three.js. WebGL is a browser
// feature, not a package, so this keeps the zero-dependency rule intact — the rule was
// never about refusing to use the platform.
//
// The symbols come from whatever artwork is already in use, drawn into a strip texture.
// Nothing here changes an existing asset; it photographs them onto a cylinder.
//
// If the context cannot be had — old hardware, a blocked context, software rendering
// turned off — createReels returns null and the caller keeps the CSS drums. A slot that
// does not draw is worse than a slot that draws flat.

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUV;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec2 vUV;
void main() {
  vNormal = mat3(uModel) * aNormal;
  vUV = aUV;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}`;

// One key light from up and in front, a dim fill from below so the underside of the barrel
// is dark but not black, and a tight specular band that slides across as the drum turns.
// That moving highlight is most of what makes it read as a polished cylinder.
const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform float uDim;
uniform float uWinV;     // v at the centre of a winning symbol, or -1 for none
uniform float uRowHalf;  // half a symbol, in v
varying vec3 vNormal;
varying vec2 vUV;
void main() {
  vec3 n = normalize(vNormal);
  vec3 key = normalize(vec3(-0.25, 0.75, 0.62));
  float d = max(dot(n, key), 0.0);
  float fill = max(dot(n, vec3(0.0, -1.0, 0.2)), 0.0) * 0.16;
  float spec = pow(max(dot(n, normalize(vec3(0.0, 0.35, 1.0))), 0.0), 22.0) * 0.5;
  vec4 tex = texture2D(uTex, vUV);
  vec3 lit = tex.rgb * (0.30 + 0.85 * d + fill) + spec;
  // A winning symbol lights up on the drum itself. Wrapped distance, because the band
  // can straddle the seam where v rolls over.
  if (uWinV >= 0.0) {
    float dv = abs(fract(vUV.y - uWinV + 0.5) - 0.5);
    float band = smoothstep(uRowHalf, uRowHalf * 0.35, dv);
    lit += tex.rgb * band * 1.25 + vec3(0.30, 0.24, 0.10) * band;
  }
  gl_FragColor = vec4(lit * uDim, tex.a);
}`;

/** Compile one shader and say plainly what was wrong if it will not. */
function shader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader: ${log}`);
  }
  return sh;
}

function program(gl) {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

/**
 * A cylinder lying along X, wrapped by the texture around its circumference.
 *
 * SEGMENTS is how round it is. Thirty-two is past the point where more stops helping at
 * the size a reel is drawn, and the texture runs from v=0 to v=1 once around, so a strip
 * of N symbols puts one symbol every 1/N of a turn.
 */
function cylinder(gl, halfWidth, radius, segments = 48) {
  const pos = [];
  const nor = [];
  const uv = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const a = t * Math.PI * 2;
    const cy = Math.cos(a);
    const sy = Math.sin(a);
    // Two vertices per ring step, one at each end of the barrel.
    pos.push(-halfWidth, radius * cy, radius * sy);
    nor.push(0, cy, sy);
    uv.push(0, t);
    pos.push(halfWidth, radius * cy, radius * sy);
    nor.push(0, cy, sy);
    uv.push(1, t);
  }
  const buf = (data, size) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return { buffer: b, size };
  };
  return {
    pos: buf(pos, 3),
    nor: buf(nor, 3),
    uv: buf(uv, 2),
    count: (segments + 1) * 2,
  };
}

// ------------------------------------------------------------------ matrices
// Four-by-four column-major, written out rather than imported. A projection, a translate
// and a rotate about X is the whole of what this needs.

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

const translation = (x, y, z) => new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1,
]);

const rotationX = (a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
};

/**
 * translate(x) * scaleX(w) * rotateX(a), written straight out.
 *
 * Scaling on X is how a drum gets its width: the mesh is a unit cylinder and each reel
 * stretches it, so the row can be laid out to whatever the window turns out to be without
 * rebuilding geometry. X is the axis of rotation, so the scale and the rotation do not
 * interfere and the normals stay correct.
 */
function modelMatrix(x, angle, halfWidth) {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  return new Float32Array([
    halfWidth, 0, 0, 0,
    0, c, sn, 0,
    0, -sn, c, 0,
    x, 0, 0, 1,
  ]);
}

/**
 * Draw a reel's symbols down a tall canvas, to be wrapped round the drum.
 *
 * The strip is the reel's real symbol order, so what comes past the window as it turns is
 * what is genuinely next on that reel rather than a decorative loop.
 */
export async function stripTexture(gl, symbols, drawSymbol, width = 256, height = 2048) {
  // Both sides must be a power of two.
  //
  // The texture has to wrap on T to go round the drum, and WebGL 1 will not REPEAT a
  // non-power-of-two texture — it silently samples black instead, which is exactly what
  // a barrel drawn with a 256x3072 strip looks like: correct geometry, correct lighting,
  // and no picture on it at all.
  //
  // So the strip is a fixed 256x2048 and the symbols divide it, rather than the symbol
  // size deciding the height. v still runs 0..1 over the whole strip, so each symbol
  // occupies 1/N of a turn however many pixels that works out to be.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const cell = height / symbols.length;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#15110c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < symbols.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await drawSymbol(ctx, symbols[i], i * cell, cell, width);
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, i * cell + 0.5);
    ctx.lineTo(width, i * cell + 0.5);
    ctx.stroke();
  }

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // Wrap round the circumference, clamp across the width.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return tex;
}

/**
 * Five drums in a row.
 *
 * `opts.reels` is how many, `opts.rows` how many show at once. The camera is placed so
 * exactly that many symbols fill the window, which is what keeps the WebGL reels lined up
 * with the cabinet drawn around them in CSS.
 */
export function createReels(host, opts = {}) {
  const reels = opts.reels || 5;
  const rows = opts.rows || 3;
  const perDrum = opts.perDrum || 12;

  const canvas = document.createElement('canvas');
  canvas.className = 'slot-gl';
  host.appendChild(canvas);

  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false })
    || canvas.getContext('experimental-webgl');
  if (!gl) {
    canvas.remove();
    return null;
  }

  let prog;
  try {
    prog = program(gl);
  } catch (e) {
    canvas.remove();
    return null;
  }

  const loc = {
    pos: gl.getAttribLocation(prog, 'aPos'),
    nor: gl.getAttribLocation(prog, 'aNormal'),
    uv: gl.getAttribLocation(prog, 'aUV'),
    proj: gl.getUniformLocation(prog, 'uProj'),
    view: gl.getUniformLocation(prog, 'uView'),
    model: gl.getUniformLocation(prog, 'uModel'),
    tex: gl.getUniformLocation(prog, 'uTex'),
    dim: gl.getUniformLocation(prog, 'uDim'),
    winV: gl.getUniformLocation(prog, 'uWinV'),
    rowHalf: gl.getUniformLocation(prog, 'uRowHalf'),
  };

  // A drum wide enough that five sit side by side across the window with a small gap, and
  // a radius that puts `rows` symbols across the visible face.
  // A unit cylinder. Everything about how big a drum is and where it sits is decided at
  // resize, from the window, and applied through the model matrix.
  const mesh = cylinder(gl, 1, 1);

  // Where the camera has to sit for exactly `rows` symbols to fill the height.
  //
  // The obvious answer — make the view as tall as the arc those symbols cover — is wrong,
  // and wrong in a way that shows: it puts the camera far enough back that the whole
  // front of the barrel fits in frame and you see five or six rows instead of three.
  //
  // A point at angle t on a unit drum sits at y = sin t, and its distance from the camera
  // is camZ - cos t. What lands on screen is the ratio of those, not the height alone, so
  // the top row reaches the top edge when
  //
  //     sin t / (camZ - cos t) = tan(fovy / 2)
  //
  // which solves for camZ directly. Perspective is the whole difference: the near face of
  // the barrel is closer than its centre, so it projects larger than a flat calculation
  // expects.
  const FOVY = 0.62;
  const edge = (rows * Math.PI) / perDrum;
  const camZ = Math.cos(edge) + Math.sin(edge) / Math.tan(FOVY / 2);
  // The view height at the drum's front face, which is what the row has to be laid out in.
  const viewH = 2 * (camZ - 1) * Math.tan(FOVY / 2);
  let pitch = 0.95;
  let halfW = 0.44;

  const drums = Array.from({ length: reels }, (_, i) => ({
    seat: i,
    x: 0,
    angle: 0,
    spin: 0,
    tex: null,
    dim: 1,
    ease: null,
    winRow: -1,
  }));

  // Where the front of the barrel is, and how wide one symbol is, in the drum's own
  // angular terms. a = 0 is the top of the cylinder, so the face pointing at the camera
  // is a quarter turn round.
  const FRONT = Math.PI / 2;
  const STEP = (Math.PI * 2) / perDrum;

  /**
   * The angle that parks symbol `i` on the centre line.
   *
   * A symbol occupies v from i/N to (i+1)/N, so its middle is at (i + 0.5)/N, and that
   * is what has to arrive at the front — not its leading edge. Leaving the half out puts
   * every drum half a symbol off, which reads as the centre row showing the wrong one.
   */
  const angleFor = (i) => FRONT - ((i + 0.5) / perDrum) * Math.PI * 2;

  let raf = null;
  let running = false;

  function resize() {
    // offsetWidth, not getBoundingClientRect.
    //
    // The cabinet this sits in is rotated in 3D, and getBoundingClientRect reports the
    // projected box on screen — which is bigger than the element's own layout box and
    // gets projected a second time when the canvas inside it is drawn. Sizing from it
    // makes the canvas larger than the window it is supposed to fill: too much barrel in
    // frame, and a gap down each side of the machine.
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);

    // The visible width at the front of the barrel, divided between the reels.
    const aspect = w / Math.max(1, h);
    pitch = (viewH * aspect) / reels;
    halfW = pitch * 0.47;
    for (const d of drums) d.x = (d.seat - (reels - 1) / 2) * pitch;
  }
  resize();

  function draw() {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    // No face culling.
    //
    // The strip winding round a cylinder comes out backwards, so culling BACK removed the
    // near surface and left the inside of the far half showing through — which looks like
    // a drum with twice as many rows on it, at the wrong size, and took a while to
    // recognise for what it was. Depth testing already picks the nearer surface, and five
    // low-poly barrels are not worth the fragility of getting the winding exactly right.
    gl.disable(gl.CULL_FACE);
    gl.useProgram(prog);

    const aspect = canvas.width / Math.max(1, canvas.height);
    gl.uniformMatrix4fv(loc.proj, false, perspective(FOVY, aspect, 0.1, 40));
    gl.uniformMatrix4fv(loc.view, false, translation(0, 0, -camZ));

    const bind = (b, l) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buffer);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, b.size, gl.FLOAT, false, 0, 0);
    };
    bind(mesh.pos, loc.pos);
    bind(mesh.nor, loc.nor);
    bind(mesh.uv, loc.uv);

    for (const d of drums) {
      if (!d.tex) continue;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, d.tex);
      gl.uniform1i(loc.tex, 0);
      gl.uniform1f(loc.dim, d.dim);
      gl.uniform1f(loc.winV, d.winRow >= 0 ? (d.winRow + 0.5) / perDrum : -1);
      gl.uniform1f(loc.rowHalf, 0.5 / perDrum);
      gl.uniformMatrix4fv(loc.model, false, modelMatrix(d.x, d.angle, halfW));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, mesh.count);
    }
  }

  let last = 0;
  function frame(now) {
    const dt = Math.min(now - (last || now), 50);
    last = now;
    let moving = false;
    for (const d of drums) {
      if (d.ease) {
        // Slowing into the stop, with a little overrun and settle at the end. A reel that
        // simply assigns its final angle looks broken however good the rest of it is —
        // the deceleration is most of what sells the machine as mechanical.
        const k = Math.min(1, (now - d.ease.t0) / d.ease.dur);
        const eased = 1 - (1 - k) ** 3;
        const bounce = Math.sin(k * Math.PI) * STEP * 0.16;
        d.angle = d.ease.from + (d.ease.to - d.ease.from) * eased - bounce;
        if (k >= 1) { d.angle = d.ease.to; d.ease = null; }
        moving = true;
      } else if (d.spin !== 0) {
        d.angle += d.spin * dt;
        moving = true;
      }
    }
    draw();
    if (moving) raf = requestAnimationFrame(frame);
    else { raf = null; last = 0; running = false; }
  }

  function wake() {
    if (raf === null) raf = requestAnimationFrame(frame);
  }

  return {
    get element() { return canvas; },
    /** What the layout actually resolved to. For calibrating the framing by measurement. */
    debug() {
      return {
        w: canvas.width, h: canvas.height,
        aspect: canvas.width / canvas.height,
        camZ, viewH, pitch, halfW,
        span: pitch * (reels - 1) + halfW * 2,
        halfViewAtFace: (camZ - 1) * Math.tan(FOVY / 2) * (canvas.width / canvas.height),
      };
    },
    resize() { resize(); draw(); },

    /** Hand a drum its strip. `symbols` is the reel's own order. */
    async setStrip(index, symbols, drawSymbol) {
      const d = drums[index];
      if (!d) return;
      if (d.tex) gl.deleteTexture(d.tex);
      d.tex = await stripTexture(gl, symbols, drawSymbol);
      draw();
    },

    /** Park a drum so the middle row shows the symbol at `stop` + 1, with no animation. */
    setStop(index, stop) {
      const d = drums[index];
      if (!d) return;
      d.spin = 0;
      d.ease = null;
      d.angle = angleFor(stop + 1);
      draw();
    },

    /** Light the symbol on one row of one drum, or pass -1 to clear it. */
    setWin(index, stop, row) {
      const d = drums[index];
      if (!d) return;
      d.winRow = row < 0 ? -1 : (((stop + row) % perDrum) + perDrum) % perDrum;
      draw();
    },

    clearWins() {
      for (const d of drums) d.winRow = -1;
      draw();
    },

    /**
     * Where a symbol actually lands on the canvas, in CSS pixels.
     *
     * The paylines used to be measured off the DOM faces, which are hidden when this is
     * running and laid out by different rules anyway — so they were drawn somewhere the
     * symbols no longer are. This projects the real thing.
     */
    symbolPoint(index, row) {
      const d = drums[index];
      if (!d) return null;
      // Rows run down the screen, and down the screen is forward through the strip.
      const a = FRONT + (row - 1) * STEP;
      const y = Math.cos(a);
      const z = Math.sin(a);
      const depth = camZ - z;
      if (depth <= 0.01) return null;
      const f = 1 / Math.tan(FOVY / 2);
      const aspect = canvas.width / Math.max(1, canvas.height);
      const ndcX = (d.x * (f / aspect)) / depth;
      const ndcY = (y * f) / depth;
      const cssW = canvas.clientWidth || canvas.width;
      const cssH = canvas.clientHeight || canvas.height;
      return [(ndcX * 0.5 + 0.5) * cssW, (0.5 - ndcY * 0.5) * cssH];
    },

    start() {
      running = true;
      for (const d of drums) d.spin = -0.011;
      wake();
    },

    /** Bring a drum down to its stop, still turning the way it was going. */
    stopAt(index, stop) {
      const d = drums[index];
      if (!d) return;
      let to = angleFor(stop + 1);
      // Keep going the way it was: wind the target back past the current angle so the
      // last of the travel is in the same direction rather than a jerk backwards.
      while (to > d.angle - Math.PI * 0.75) to -= Math.PI * 2;
      d.spin = 0;
      d.ease = { from: d.angle, to, t0: performance.now(), dur: 620 };
      wake();
    },

    stop() {
      running = false;
      for (const d of drums) d.spin = 0;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      draw();
    },

    dispose() {
      this.stop();
      for (const d of drums) if (d.tex) gl.deleteTexture(d.tex);
      canvas.remove();
    },
  };
}
