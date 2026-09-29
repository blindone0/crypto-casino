// Billiards.
//
// One cue ball, fifteen white object balls, six pockets, and a shot count. Pot everything in as few
// shots as you can. There are no fouls at all, because a game room cabinet is
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
// A CAPTURE RADIUS from the pocket point, not a mouth width. The cushions keep a ball's
// centre at least R from each wall, so its closest approach to a corner point is R*sqrt(2),
// about 12.7 px: any radius below that and the corner pockets can never take a ball. The
// pool value was 1.9R. Free pyramid is played with pockets barely wider than the ball, and
// 1.55R is that here: a corner drops only a ball driven almost exactly into it, and a side
// pocket takes a ball within about 21 px of its centre against a ball 18 px wide.
const POCKET = R * 1.55;
// Free pyramid ends at eight of the fifteen.
const TARGET = 8;
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

// Fifteen white balls and a red cue, the way a Russian table is laid: the colour is
// which ball is which, not what it is worth. Every ball is worth the same.
const IVORY = '#f4f1e8';
const CUE_RED = '#c0392b';

const len = (x, y) => Math.hypot(x, y);

/**
 * Start a game on a canvas.
 * Returns { stop() }. `onScore` and `onEnd` report upward to the cabinet shell.
 */
export function start(canvas, { onScore, onEnd, onBall, sound } = {}) {
  // Sound arrives as a callback rather than an import, so the cabinet has no dependency
  // on the audio engine and the headless tests do not have to stub one.
  const say = (name) => { if (sound) sound(name); };
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
    balls.push({ x: W / 2, y: H * 0.74, vx: 0, vy: 0, cue: true, potted: false, colour: CUE_RED });
    // A pyramid: rows of one to five down from the apex spot, fifteen balls.
    const spot = { x: W / 2, y: H * 0.3 };
    const gap = R * 2 + 0.6;
    const rows = [1, 2, 3, 4, 5];
    let n = 0;
    rows.forEach((count, row) => {
      for (let i = 0; i < count; i += 1) {
        balls.push({
          x: spot.x + (i - (count - 1) / 2) * gap,
          y: spot.y + row * gap * 0.88,
          vx: 0, vy: 0, cue: false, potted: false, colour: IVORY,
        });
        n += 1;
      }
    });
  }
  rack();

  const cue = () => balls[0];

  // Free pyramid: any ball may be played, so "the striker" is a choice, not a role. The
  // cue is only the default. `pocketed` counts every ball that dropped, the cue included.
  let striker = 0;
  let pocketed = 0;
  const toGo = () => Math.max(0, TARGET - pocketed);
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
    // Only a solid contact is worth a click. A graze at walking pace is not a noise.
    if (rel < -60) say('clack');
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
        pocketed += 1;
        award(1000);
        say('pocket');
        if (b.cue) {
          // Free pyramid: the cue is a ball like any other, so pocketing it SCORES. It
          // comes back to its spot only so there is always something to strike.
          b.x = W / 2; b.y = H * 0.74;
          message = `Cue potted — ${toGo()} to go`;
        } else {
          b.potted = true;
          if (balls.indexOf(b) === striker) striker = 0;
          message = `Potted — ${toGo()} to go`;
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

    if (pocketed >= TARGET) {
      // The eighth ball is worth the shots you did not take.
      award(shots * 250 + 3000);
      message = 'Eight. Game.';
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

  /** Fire the striker. `power` is 0..1. */
  function shoot(angle, strength) {
    if (!running || moving() || shots <= 0) return;
    if (balls[striker].potted) striker = 0;
    const p = Math.max(0.12, Math.min(1, strength));
    balls[striker].vx = Math.cos(angle) * MAX_POWER * p;
    balls[striker].vy = Math.sin(angle) * MAX_POWER * p;
    shots -= 1;
    message = '';
    say('cue');
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
    // A press on a ball makes it the striker; a press elsewhere keeps the current one,
    // so the drag still starts anywhere, as it always did.
    const on = balls.findIndex((b) => !b.potted && len(p.x - b.x, p.y - b.y) <= R * 2.2);
    if (on >= 0) striker = on;
    aiming = true;
    aimX = p.x; aimY = p.y;
    power = Math.min(1, len(p.x - balls[striker].x, p.y - balls[striker].y) / 220);
  };
  const pMove = (e) => {
    if (!aiming) return;
    const p = toTable(e);
    aimX = p.x; aimY = p.y;
    power = Math.min(1, len(p.x - balls[striker].x, p.y - balls[striker].y) / 220);
  };
  const pUp = (e) => {
    if (!aiming) return;
    e.preventDefault();
    aiming = false;
    const c = balls[striker];
    // Pull back to shoot forward: the ball goes away from where you dragged to, which is
    // how a cue works and how every pool game on a phone behaves.
    shoot(Math.atan2(c.y - aimY, c.x - aimX), power);
    power = 0;
  };

  // The press starts on the table; the drag and the release are heard on the WINDOW.
  // With all three on the canvas, a pull that left it went silent, and a ball against a
  // cushion had no room to pull at all: the cue could not be drawn past the table edge.
  // toTable() works from the canvas rectangle, so coordinates outside it are still right.
  canvas.addEventListener('pointerdown', pDown);
  window.addEventListener('pointermove', pMove);
  window.addEventListener('pointerup', pUp);
  window.addEventListener('pointercancel', pUp);

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
      window.removeEventListener('pointermove', pMove);
      window.removeEventListener('pointerup', pUp);
      window.removeEventListener('pointercancel', pUp);
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
        pocketed,
        toGo: toGo(),
        striker,
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
  controls: 'Tap a ball to play it, drag back from it and release. Arrow keys to aim, SPACE to strike.',
};
