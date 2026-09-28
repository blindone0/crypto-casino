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

/** model = translate * rotateX, done by hand because it is two matrices. */
function modelMatrix(x, angle) {
  const r = rotationX(angle);
  const m = new Float32Array(r);
  m[12] = x;
  return m;
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
  };

  // A drum wide enough that five sit side by side across the window with a small gap, and
  // a radius that puts `rows` symbols across the visible face.
  const halfW = 0.46;
  const radius = (perDrum / (Math.PI * 2)) * (2 * halfW) * (3 / rows) * 0.52;
  const mesh = cylinder(gl, halfW, radius);

  const drums = Array.from({ length: reels }, (_, i) => ({
    x: (i - (reels - 1) / 2) * (halfW * 2 + 0.06),
    angle: 0,
    spin: 0,
    tex: null,
    dim: 1,
  }));

  let raf = null;
  let running = false;

  function resize() {
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();

  function draw() {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.useProgram(prog);

    const aspect = canvas.width / Math.max(1, canvas.height);
    gl.uniformMatrix4fv(loc.proj, false, perspective(0.62, aspect, 0.1, 40));
    gl.uniformMatrix4fv(loc.view, false, translation(0, 0, -3.15));

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
      gl.uniformMatrix4fv(loc.model, false, modelMatrix(d.x, d.angle));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, mesh.count);
    }
  }

  let last = 0;
  function frame(now) {
    const dt = Math.min(now - (last || now), 50);
    last = now;
    let moving = false;
    for (const d of drums) {
      if (d.spin !== 0) {
        d.angle += d.spin * dt;
        moving = true;
      }
    }
    draw();
    if (moving && running) raf = requestAnimationFrame(frame);
    else { raf = null; last = 0; }
  }

  function wake() {
    if (raf === null && running) raf = requestAnimationFrame(frame);
  }

  return {
    get element() { return canvas; },
    resize() { resize(); draw(); },

    /** Hand a drum its strip. `symbols` is the reel's own order. */
    async setStrip(index, symbols, drawSymbol) {
      const d = drums[index];
      if (!d) return;
      if (d.tex) gl.deleteTexture(d.tex);
      d.tex = await stripTexture(gl, symbols, drawSymbol);
      draw();
    },

    /** Park a drum so `stop` is the symbol on the centre line. */
    setStop(index, stop, stripLength) {
      const d = drums[index];
      if (!d) return;
      d.spin = 0;
      // v runs one full turn over the strip, and the middle row sits at the front.
      d.angle = -((stop + 1) / stripLength) * Math.PI * 2;
      draw();
    },

    start() {
      running = true;
      for (const d of drums) d.spin = -0.011;
      wake();
    },

    stopAt(index, stop, stripLength) {
      const d = drums[index];
      if (!d) return;
      d.spin = 0;
      d.angle = -((stop + 1) / stripLength) * Math.PI * 2;
      if (!drums.some((x) => x.spin !== 0)) running = false;
      draw();
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
