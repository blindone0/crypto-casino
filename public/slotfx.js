// Sparks and flashes over the slot reels.
//
// Drawn on a canvas laid over the drums rather than with DOM nodes: a big win throws a
// few hundred particles, and a few hundred elements being added and removed is how you
// make a phone stutter at exactly the moment the player is meant to be enjoying himself.
//
// The loop only runs while there is something alive to draw. An idle machine costs
// nothing, which matters because the reels sit idle most of the time.
//
// No images — the policy forbids remote assets and a spark is a line with a gradient.

const GRAVITY = 0.00042;   // px per ms², tuned to look like sparks rather than confetti
const DRAG = 0.9985;

/** One spark. Plain object rather than a class: there are a lot of these. */
function spark(x, y, angle, speed, life, hue, size) {
  return {
    x, y, life, age: 0, hue, size,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
  };
}

export function createSparks(host) {
  const canvas = document.createElement('canvas');
  canvas.className = 'slot-fx';
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let particles = [];
  let flashes = [];
  let raf = null;
  let last = 0;
  let dpr = 1;

  function resize() {
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
  }
  resize();

  function frame(now) {
    const dt = Math.min(now - (last || now), 48);
    last = now;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    // Flashes first, so sparks sit on top of their own light.
    ctx.globalCompositeOperation = 'lighter';
    flashes = flashes.filter((f) => {
      f.age += dt;
      const t = f.age / f.life;
      if (t >= 1) return false;
      const a = (1 - t) * (1 - t) * f.strength;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * (0.5 + t * 0.9));
      g.addColorStop(0, `hsla(${f.hue}, 95%, 72%, ${a})`);
      g.addColorStop(1, `hsla(${f.hue}, 95%, 60%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * (0.5 + t * 0.9), 0, Math.PI * 2);
      ctx.fill();
      return true;
    });

    particles = particles.filter((p) => {
      p.age += dt;
      if (p.age >= p.life) return false;
      p.vy += GRAVITY * dt;
      p.vx *= DRAG;
      p.vy *= DRAG;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const t = p.age / p.life;
      const a = 1 - t * t;
      // A streak along the direction of travel reads as a spark; a dot reads as dust.
      const len = Math.min(9, Math.hypot(p.vx, p.vy) * 26);
      const nx = p.vx === 0 && p.vy === 0 ? 0 : p.vx / Math.hypot(p.vx, p.vy);
      const ny = p.vx === 0 && p.vy === 0 ? 0 : p.vy / Math.hypot(p.vx, p.vy);
      ctx.strokeStyle = `hsla(${p.hue}, 100%, ${62 + 30 * (1 - t)}%, ${a})`;
      ctx.lineWidth = p.size * (1 - t * 0.55);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x - nx * len, p.y - ny * len);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      return true;
    });

    ctx.globalCompositeOperation = 'source-over';

    if (particles.length || flashes.length) {
      raf = requestAnimationFrame(frame);
    } else {
      raf = null;
      last = 0;
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    }
  }

  function wake() {
    if (raf === null) raf = requestAnimationFrame(frame);
  }

  return {
    resize,

    /** A shower at a point. Used when a drum slams to a stop. */
    burst(x, y, {
      count = 16, hue = 45, speed = 0.22, spread = Math.PI, aim = -Math.PI / 2,
      life = 620, size = 1.8, flash = 26,
    } = {}) {
      for (let i = 0; i < count; i += 1) {
        const a = aim + (Math.random() - 0.5) * spread;
        const v = speed * (0.45 + Math.random() * 0.85);
        particles.push(spark(x, y, a, v, life * (0.6 + Math.random() * 0.7),
          hue + (Math.random() - 0.5) * 22, size * (0.6 + Math.random() * 0.8)));
      }
      if (flash) flashes.push({ x, y, r: flash, hue, life: 320, age: 0, strength: 0.5 });
      wake();
    },

    /** Sparks running along a winning line, so the eye follows the payline. */
    line(points, { hue = 45, per = 7 } = {}) {
      for (let i = 0; i < points.length - 1; i += 1) {
        const [ax, ay] = points[i];
        const [bx, by] = points[i + 1];
        for (let k = 0; k < per; k += 1) {
          const t = k / per;
          this.burst(ax + (bx - ax) * t, ay + (by - ay) * t, {
            count: 3, hue, speed: 0.12, spread: Math.PI * 2, life: 520, size: 1.4, flash: 0,
          });
        }
      }
      for (const [x, y] of points) {
        flashes.push({ x, y, r: 34, hue, life: 520, age: 0, strength: 0.55 });
      }
      wake();
    },

    /** The whole machine goes off. For a win worth looking up from your phone for. */
    bigWin() {
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      for (let i = 0; i < 26; i += 1) {
        const x = Math.random() * w;
        const y = h * (0.25 + Math.random() * 0.6);
        setTimeout(() => {
          this.burst(x, y, {
            count: 14,
            hue: [45, 45, 45, 18, 168][Math.floor(Math.random() * 5)],
            speed: 0.3, spread: Math.PI * 2, life: 900, size: 2.2, flash: 40,
          });
        }, i * 55);
      }
    },

    stop() {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      particles = [];
      flashes = [];
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    },

    get element() { return canvas; },
  };
}
