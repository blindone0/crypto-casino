// Billiards.
//
// One cue ball, nine object balls, six pockets, and a shot count. Pot everything in as few
// shots as you can. There are no fouls beyond the scratch, because a game room cabinet is
// not a rulebook and nobody ever read the small print on one.
//
// Physics notes:
//   - Fixed timestep with substeps. A ball at nine hundred units a second crosses its own
//     diameter in a frame, and two balls that never overlap never collide.
//   - Ball on ball is the equal-mass elastic case, resolved along the line of centres.
//     That is the whole of pool: the object ball leaves along the line from the cue ball's
//     centre through its own, which is why aiming is aiming at a ghost ball.
//   - Overlap is pushed apart before the impulse is applied. Skipping that lets a pair
//     settle inside each other and jitter forever.
//   - Rolling friction is exponential, with a floor below which a ball is simply stopped.
//     Balls that creep for another ten seconds are not realism, they are waiting.

const W = 360;
const H = 680;
const CUSHION = 20;
const R = 9;                 // ball radius
const POCKET = 17;
const FRICTION = 1.6;        // per second, exponential
const STOP_BELOW = 6;        // units per second
const SUBSTEPS = 6;
const MAX_SHOTS = 30;
const MAX_POWER = 1150;

const LEFT = CUSHION;
const RIGHT = W - CUSHION;
const TOP = CUSHION;
const BOTTOM = H - CUSHION;

const POCKETS = [
  { x: LEFT, y: TOP }, { x: RIGHT, y: TOP },
  { x: LEFT, y: (TOP + BOTTOM) / 2 }, { x: RIGHT, y: (TOP + BOTTOM) / 2 },
  { x: LEFT, y: BOTTOM }, { x: RIGHT, y: BOTTOM },
];

// Nine object balls in the usual diamond, plus the cue ball on its spot.
const COLOURS = [
  '#f2c230', '#2f6fd0', '#d13b3b', '#7b4fc4', '#e2823a',
  '#2e9e6b', '#9e2e3f', '#1d1d20', '#d9d34a',
];

const len = (x, y) => Math.hypot(x, y);

/**
 * Start a game on a canvas.
 * Returns { stop() }. `onScore` and `onEnd` report upward to the cabinet shell.
 */
export function start(canvas, { onScore, onEnd, onBall } = {}) {
  const ctx = canvas.getContext('2d');
  canvas.width = W;
  canvas.height = H;

  let score = 0;
  let shots = MAX_SHOTS;
  let running = true;
  let message = 'Drag from the cue ball to aim';

  // Aiming state. `power` is 0..1 and only means anything while aiming.
  let aiming = false;
  let aimX = W / 2;
  let aimY = H * 0.25;
  let power = 0;
  let keyAngle = -Math.PI / 2;
  let keyCharging = false;

  const balls = [];

  function rack() {
    balls.length = 0;
    balls.push({ x: W / 2, y: H * 0.74, vx: 0, vy: 0, cue: true, potted: false, colour: '#f4f1e8' });
    // A diamond: rows of 1, 2, 3, 2, 1 around the head spot.
    const spot = { x: W / 2, y: H * 0.3 };
    const gap = R * 2 + 0.6;
    const rows = [1, 2, 3, 2, 1];
    let n = 0;
    rows.forEach((count, row) => {
      for (let i = 0; i < count; i += 1) {
        balls.push({
          x: spot.x + (i - (count - 1) / 2) * gap,
          y: spot.y + (row - 2) * gap * 0.88,
          vx: 0, vy: 0, cue: false, potted: false, colour: COLOURS[n % COLOURS.length],
        });
        n += 1;
      }
    });
  }
  rack();

  const cue = () => balls[0];
  const moving = () => balls.some((b) => !b.potted && (b.vx !== 0 || b.vy !== 0));
  const remaining = () => balls.filter((b) => !b.cue && !b.potted).length;

  function award(points) {
    score = Math.max(0, score + points);
    if (onScore) onScore(score);
  }

  // ------------------------------------------------------------- collisions
  /** Equal masses, resolved along the line of centres. This is all of pool. */
  function hitBalls(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = len(dx, dy);
    if (dist === 0 || dist > R * 2) return false;

    const nx = dx / dist;
    const ny = dy / dist;

    // Separate first. A pair left overlapping will re-collide every substep and buzz.
    const overlap = (R * 2 - dist) / 2 + 0.01;
    a.x -= nx * overlap; a.y -= ny * overlap;
    b.x += nx * overlap; b.y += ny * overlap;

    const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rel > 0) return false; // already separating
    const impulse = rel * 0.98; // a touch of energy lost to the cloth
    a.vx += impulse * nx; a.vy += impulse * ny;
    b.vx -= impulse * nx; b.vy -= impulse * ny;
    return true;
  }

  function cushions(b) {
    if (b.x - R < LEFT) { b.x = LEFT + R; b.vx = -b.vx * 0.9; }
    if (b.x + R > RIGHT) { b.x = RIGHT - R; b.vx = -b.vx * 0.9; }
    if (b.y - R < TOP) { b.y = TOP + R; b.vy = -b.vy * 0.9; }
    if (b.y + R > BOTTOM) { b.y = BOTTOM - R; b.vy = -b.vy * 0.9; }
  }

  function checkPockets() {
    for (const b of balls) {
      if (b.potted) continue;
      for (const p of POCKETS) {
        if (len(b.x - p.x, b.y - p.y) > POCKET) continue;
        b.vx = 0; b.vy = 0;
        if (b.cue) {
          // A scratch costs a shot and the cue ball comes back on its spot.
          b.x = W / 2; b.y = H * 0.74;
          shots = Math.max(0, shots - 1);
          award(-200);
          message = 'Scratch';
          if (onBall) onBall(shots);
        } else {
          b.potted = true;
          award(1000);
          message = `Potted — ${remaining()} left`;
        }
        break;
      }
    }
  }

  // ------------------------------------------------------------------ step
  function step(dt) {
    if (!running) return;

    for (const b of balls) {
      if (b.potted) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      const decay = Math.exp(-FRICTION * dt);
      b.vx *= decay;
      b.vy *= decay;
      if (len(b.vx, b.vy) < STOP_BELOW) { b.vx = 0; b.vy = 0; }
      cushions(b);
    }

    for (let i = 0; i < balls.length; i += 1) {
      if (balls[i].potted) continue;
      for (let j = i + 1; j < balls.length; j += 1) {
        if (balls[j].potted) continue;
        hitBalls(balls[i], balls[j]);
      }
    }

    checkPockets();

    if (remaining() === 0) {
      // Clearing the table is worth the shots you did not take.
      award(shots * 250 + 3000);
      message = 'Table cleared';
      finish();
    } else if (shots <= 0 && !moving()) {
      finish();
    }
  }

  function finish() {
    if (!running) return;
    running = false;
    if (onEnd) onEnd(score);
  }

  /** Fire the cue ball. `power` is 0..1. */
  function shoot(angle, strength) {
    if (!running || moving() || shots <= 0) return;
    const p = Math.max(0.12, Math.min(1, strength));
    cue().vx = Math.cos(angle) * MAX_POWER * p;
    cue().vy = Math.sin(angle) * MAX_POWER * p;
    shots -= 1;
    message = '';
    if (onBall) onBall(shots);
  }

  // ----------------------------------------------------------------- render
  function draw() {
    ctx.fillStyle = '#0b1410';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#5a3a1c';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#12613f';
    ctx.fillRect(LEFT, TOP, RIGHT - LEFT, BOTTOM - TOP);

    ctx.strokeStyle = '#0d4a30';
    ctx.lineWidth = 2;
    ctx.strokeRect(LEFT, TOP, RIGHT - LEFT, BOTTOM - TOP);

    for (const p of POCKETS) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, POCKET, 0, Math.PI * 2);
      ctx.fillStyle = '#07100c';
      ctx.fill();
    }

    for (const b of balls) {
      if (b.potted) continue;
      ctx.beginPath();
      ctx.arc(b.x, b.y, R, 0, Math.PI * 2);
      const g = ctx.createRadialGradient(b.x - 3, b.y - 3, 1, b.x, b.y, R);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.35, b.colour);
      g.addColorStop(1, '#00000055');
      ctx.fillStyle = g;
      ctx.fill();
    }

    // The aiming line, and a ghost of where the cue ball is going.
    if (running && !moving()) {
      const c = cue();
      const angle = aiming ? Math.atan2(aimY - c.y, aimX - c.x) : keyAngle;
      const reach = 70 + (aiming ? power : (keyCharging ? power : 0)) * 90;
      ctx.strokeStyle = 'rgba(255,255,255,.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + Math.cos(angle) * reach, c.y + Math.sin(angle) * reach);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = '#e8edf6';
    ctx.font = '600 15px ui-monospace, monospace';
    ctx.fillText(`${shots}`, 24, H - 6);
    if (message) {
      ctx.fillStyle = '#ffd166';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(message, W / 2, 14);
      ctx.textAlign = 'left';
    }
  }

  // ------------------------------------------------------------------ input
  const toTable = (e) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  };

  const pDown = (e) => {
    if (!running || moving()) return;
    e.preventDefault();
    const p = toTable(e);
    aiming = true;
    aimX = p.x; aimY = p.y;
    power = Math.min(1, len(p.x - cue().x, p.y - cue().y) / 220);
  };
  const pMove = (e) => {
    if (!aiming) return;
    const p = toTable(e);
    aimX = p.x; aimY = p.y;
    power = Math.min(1, len(p.x - cue().x, p.y - cue().y) / 220);
  };
  const pUp = (e) => {
    if (!aiming) return;
    e.preventDefault();
    aiming = false;
    const c = cue();
    // Pull back to shoot forward: the ball goes away from where you dragged to, which is
    // how a cue works and how every pool game on a phone behaves.
    shoot(Math.atan2(c.y - aimY, c.x - aimX), power);
    power = 0;
  };

  canvas.addEventListener('pointerdown', pDown);
  canvas.addEventListener('pointermove', pMove);
  canvas.addEventListener('pointerup', pUp);
  canvas.addEventListener('pointercancel', pUp);

  const onKey = (e, down) => {
    if (e.repeat) return;
    if (e.code === 'ArrowLeft') { if (down) keyAngle -= 0.09; e.preventDefault(); }
    if (e.code === 'ArrowRight') { if (down) keyAngle += 0.09; e.preventDefault(); }
    if (e.code === 'Space') {
      e.preventDefault();
      if (down) { keyCharging = true; }
      else if (keyCharging) {
        keyCharging = false;
        shoot(keyAngle, Math.max(0.2, power));
        power = 0;
      }
    }
  };
  const keyDown = (e) => onKey(e, true);
  const keyUp = (e) => onKey(e, false);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);

  // ------------------------------------------------------------------- loop
  let last = performance.now();
  let raf = 0;
  function frame(t) {
    if (!running) { draw(); return; }
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    if (keyCharging) power = Math.min(1, power + dt * 0.9);
    for (let i = 0; i < SUBSTEPS && running; i += 1) step(dt / SUBSTEPS);
    draw();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      canvas.removeEventListener('pointerdown', pDown);
      canvas.removeEventListener('pointermove', pMove);
      canvas.removeEventListener('pointerup', pUp);
      canvas.removeEventListener('pointercancel', pUp);
    },
    get score() { return score; },
    /** Exposed so the shell, and a test, can see the table without reading pixels. */
    get debug() {
      return {
        score,
        shots,
        running,
        moving: moving(),
        remaining: remaining(),
        cue: { x: Math.round(cue().x), y: Math.round(cue().y) },
        balls: balls.filter((b) => !b.potted).length,
        message,
      };
    },
    /** For the test harness: take a shot without going through a pointer. */
    shootAt(angle, strength) { shoot(angle, strength); },
  };
}

export const meta = {
  key: 'billiards',
  width: W,
  height: H,
  controls: 'Drag back from the cue ball and release. Arrow keys to aim, SPACE to strike.',
};
