// Orbit Pinball.
//
// The mechanics of pinball belong to nobody; the Microsoft table this nods to does not,
// so the layout, art and name here are original.
//
// Physics notes, because pinball lives or dies on feel:
//   - Fixed timestep with substeps. A ball moving 900 units a second across a 12-unit
//     radius will tunnel straight through a wall at one step per frame.
//   - Walls are line segments resolved as capsules, so a ball never catches on a joint
//     between two segments the way it does with naive half-plane tests.
//   - Flippers are rotating capsules. The kick comes from the surface velocity at the
//     contact point, which is what makes a flipper feel like a flipper rather than a
//     wall that happens to move.

const W = 400;
const H = 640;
const BALL_R = 8;
const GRAVITY = 900;
const SUBSTEPS = 6;
const BALLS = 3;
// The ball must clear the launch lane, which runs from y=580 up past the lip at y=168.
// Under this gravity that costs sqrt(2 * 900 * 412) = 861 units/s, so the weakest possible
// launch has to beat it; a plunger that cannot get the ball onto the table is not a
// difficulty setting, it is a dead game.
const LAUNCH_MIN = 940;
const LAUNCH_SPAN = 340;

const v = (x, y) => ({ x, y });
const add = (a, b) => v(a.x + b.x, a.y + b.y);
const sub = (a, b) => v(a.x - b.x, a.y - b.y);
const mul = (a, k) => v(a.x * k, a.y * k);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const norm = (a) => { const l = len(a) || 1; return v(a.x / l, a.y / l); };

/** Closest point on segment ab to p, used for every capsule collision here. */
function closestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return add(a, mul(ab, t));
}

// --------------------------------------------------------------- the table
// Outer shell, launch lane and the slingshots above the flippers.
const WALLS = [
  // left wall, and the curved shoulder at the top left
  [v(16, 600), v(16, 150)], [v(16, 150), v(60, 60)], [v(60, 60), v(150, 24)],
  // top and the right shoulder down into the launch lane
  [v(150, 24), v(280, 24)], [v(280, 24), v(340, 70)], [v(340, 70), v(352, 150)],
  // launch lane: a narrow channel on the right the ball is fired up through
  [v(352, 150), v(352, 620)], [v(320, 200), v(320, 620)],
  // funnels down to the flippers
  [v(16, 600), v(120, 560)], [v(320, 620), v(280, 560)],
  // slingshots
  [v(60, 430), v(120, 500)], [v(60, 430), v(60, 500)], [v(60, 500), v(120, 500)],
  [v(278, 430), v(220, 500)], [v(278, 430), v(278, 500)], [v(278, 500), v(220, 500)],
];

// The gate across the top of the launch lane. It only exists for a ball coming down: a
// ball on its way up passes straight through. Held in a separate list from WALLS because
// as an ordinary wall it sits directly in the launch path, absorbs the plunger's whole
// impulse and drops the ball back into the lane, which is a cabinet nobody can play. It
// slopes up to the right so a ball turned back is sent left, into the playfield.
const GATES = [
  [v(320, 200), v(352, 172)],
];

const BUMPERS = [
  { pos: v(110, 190), r: 22, points: 500 },
  { pos: v(200, 140), r: 22, points: 500 },
  { pos: v(280, 200), r: 22, points: 500 },
  { pos: v(155, 260), r: 16, points: 250 },
  { pos: v(240, 260), r: 16, points: 250 },
];

// Drop targets: hit one and it goes down; clear the bank for a bonus.
// Top rollover lanes. A launch at full power rides the ceiling and crosses all three,
// which is what makes a hard plunger worth pulling: without them the strongest shot flies
// over every bumper and scores nothing, so more power was strictly worse.
const ROLLOVERS = [
  { pos: v(170, 46), r: 11, points: 1000 },
  { pos: v(215, 46), r: 11, points: 1000 },
  { pos: v(260, 46), r: 11, points: 1000 },
];

const TARGETS = [
  { a: v(70, 330), b: v(100, 330), points: 800 },
  { a: v(110, 330), b: v(140, 330), points: 800 },
  { a: v(200, 330), b: v(230, 330), points: 800 },
  { a: v(240, 330), b: v(270, 330), points: 800 },
];

// The pivots are set so the resting tips leave a gap of roughly two and a bit ball widths.
// Closer together and the pair form a floor: the ball simply sits on them and the game
// never ends, which is what happened when the tips were twenty units apart.
const FLIPPERS = [
  { pivot: v(122, 566), length: 66, rest: 0.50, lift: -0.55, side: 1, key: 'left' },
  { pivot: v(274, 566), length: 66, rest: Math.PI - 0.50, lift: Math.PI + 0.55, side: -1, key: 'right' },
];

/**
 * Start a game on a canvas.
 * Returns { stop() }. `onScore` and `onEnd` report upward to the cabinet shell.
 */
export function start(canvas, { onScore, onEnd, onBall, sound } = {}) {
  // A callback rather than an import, so the table has no dependency on the audio engine
  // and the headless tests do not have to stub one.
  const say = (name) => { if (sound) sound(name); };
  const ctx = canvas.getContext('2d');
  canvas.width = W;
  canvas.height = H;

  let score = 0;
  let ballsLeft = BALLS;
  let running = true;
  let plunger = 0;
  let plungerHeld = false;
  let plungerReleased = false;
  let inLane = true;
  let message = 'Hold SPACE to pull the plunger';

  const targets = TARGETS.map((t) => ({ ...t, down: false }));
  const rollovers = ROLLOVERS.map((r) => ({ ...r, lit: false }));
  const flippers = FLIPPERS.map((f) => ({ ...f, angle: f.rest, prevAngle: f.rest, up: false }));

  const ball = { pos: v(336, 580), vel: v(0, 0), stuckFor: 0 };

  function resetBall() {
    ball.pos = v(336, 580);
    ball.vel = v(0, 0);
    ball.stuckFor = 0;
    inLane = true;
    plunger = 0;
    plungerHeld = false;
    plungerReleased = false;
    for (const lane of rollovers) lane.lit = false;
    message = 'Hold SPACE to pull the plunger';
  }

  function award(points) {
    score += points;
    if (onScore) onScore(score);
  }

  // ------------------------------------------------------------- collisions
  /** Reflect the ball off a capsule (segment + radius), with optional surface velocity. */
  function hitSegment(a, b, restitution, surfaceVel, radius = 0) {
    const c = closestOnSegment(ball.pos, a, b);
    const delta = sub(ball.pos, c);
    const dist = len(delta);
    const minDist = BALL_R + radius;
    if (dist > minDist || dist === 0) return false;

    const n = norm(delta);
    ball.pos = add(c, mul(n, minDist + 0.01));

    const rel = surfaceVel ? sub(ball.vel, surfaceVel) : ball.vel;
    const along = dot(rel, n);
    if (along < 0) {
      const bounce = mul(n, -(1 + restitution) * along);
      ball.vel = add(ball.vel, bounce);
    }
    return true;
  }

  function hitCircle(centre, r, restitution, boost) {
    const delta = sub(ball.pos, centre);
    const dist = len(delta);
    if (dist > r + BALL_R || dist === 0) return false;
    const n = norm(delta);
    ball.pos = add(centre, mul(n, r + BALL_R + 0.01));
    const along = dot(ball.vel, n);
    if (along < 0) ball.vel = add(ball.vel, mul(n, -(1 + restitution) * along));
    if (boost) ball.vel = add(ball.vel, mul(n, boost));
    return true;
  }

  function flipperEnd(f) {
    return add(f.pivot, v(Math.cos(f.angle) * f.length, Math.sin(f.angle) * f.length));
  }

  // ------------------------------------------------------------------ step
  function step(dt) {
    // The substep loop must not keep simulating a table whose game is already over, or a
    // single drain is counted once per substep and the last ball ends the game six times.
    if (!running) return;

    // Flippers move toward their target angle fast enough to actually kick.
    for (const f of flippers) {
      f.prevAngle = f.angle;
      const target = f.up ? f.lift : f.rest;
      const speed = 18;
      const diff = target - f.angle;
      f.angle += Math.max(-speed * dt, Math.min(speed * dt, diff));
    }

    if (inLane) {
      // In the launch lane the ball only moves when the plunger releases it. A tap counts
      // as a release too, at the floor power, so nothing a player does leaves the ball sat
      // in the lane with no way to get it out.
      if (plungerReleased) {
        const power = Math.max(0.25, Math.min(1, plunger / 60));
        ball.vel = v(0, -(LAUNCH_MIN + power * LAUNCH_SPAN));
        say('cue');
        plunger = 0;
        plungerReleased = false;
        inLane = false;
        message = '';
      }
      return;
    }

    ball.vel = add(ball.vel, v(0, GRAVITY * dt));
    ball.pos = add(ball.pos, mul(ball.vel, dt));

    for (const [a, b] of WALLS) hitSegment(a, b, 0.45, null);

    // One-way: only a falling ball is stopped, and gently, so it drops into play rather
    // than being fired back up the lane.
    if (ball.vel.y > 0) for (const [a, b] of GATES) hitSegment(a, b, 0.2, null);

    for (const bump of BUMPERS) {
      if (hitCircle(bump.pos, bump.r, 0.5, 260)) { say('clack'); award(bump.points); }
    }

    // Rollovers score on the way past and do not touch the ball's path.
    for (const lane of rollovers) {
      if (lane.lit) continue;
      if (len(sub(ball.pos, lane.pos)) > lane.r + BALL_R) continue;
      lane.lit = true;
      award(lane.points);
      if (rollovers.every((l) => l.lit)) {
        award(3000);
        message = 'TOP LANES  +3000';
      }
    }

    for (const target of targets) {
      if (target.down) continue;
      if (hitSegment(target.a, target.b, 0.4, null, 4)) {
        target.down = true;
        award(target.points);
        if (targets.every((x) => x.down)) {
          award(5000);
          message = 'BANK CLEARED  +5000';
          for (const x of targets) x.down = false;
        }
      }
    }

    // Flippers: the kick is the surface speed at the contact point.
    for (const f of flippers) {
      const end = flipperEnd(f);
      const omega = (f.angle - f.prevAngle) / dt;
      const contact = closestOnSegment(ball.pos, f.pivot, end);
      const arm = sub(contact, f.pivot);
      const surface = v(-arm.y * omega, arm.x * omega);
      hitSegment(f.pivot, end, 0.35, surface, 6);
    }

    // Drain.
    if (ball.pos.y > H + 40) {
      ballsLeft -= 1;
      say('lose');
      if (onBall) onBall(ballsLeft);
      if (ballsLeft <= 0) {
        running = false;
        if (onEnd) onEnd(score);
        return;
      }
      message = `Ball ${BALLS - ballsLeft + 1} of ${BALLS}`;
      resetBall();
      return;
    }

    // A ball resting in a corner is not fun; nudge it rather than letting it sit.
    if (len(ball.vel) < 12) {
      ball.stuckFor += dt;
      if (ball.stuckFor > 2.5) {
        ball.vel = add(ball.vel, v((Math.random() - 0.5) * 120, -160));
        ball.stuckFor = 0;
      }
    } else {
      ball.stuckFor = 0;
    }
  }

  // ----------------------------------------------------------------- render
  function draw() {
    ctx.fillStyle = '#0a1420';
    ctx.fillRect(0, 0, W, H);

    // playfield glow
    const g = ctx.createRadialGradient(W / 2, 220, 20, W / 2, 260, 340);
    g.addColorStop(0, 'rgba(90,180,255,.10)');
    g.addColorStop(1, 'rgba(10,20,32,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = '#3d5a78';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    for (const [a, b] of WALLS) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const bump of BUMPERS) {
      ctx.beginPath();
      ctx.arc(bump.pos.x, bump.pos.y, bump.r, 0, Math.PI * 2);
      ctx.fillStyle = '#123650';
      ctx.fill();
      ctx.strokeStyle = '#5fd6ff';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(bump.pos.x, bump.pos.y, bump.r * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = '#5fd6ff';
      ctx.fill();
    }

    for (const lane of rollovers) {
      ctx.beginPath();
      ctx.arc(lane.pos.x, lane.pos.y, lane.r, 0, Math.PI * 2);
      ctx.fillStyle = lane.lit ? 'rgba(255,209,102,.85)' : 'rgba(30,52,72,.9)';
      ctx.fill();
      ctx.strokeStyle = lane.lit ? '#ffd166' : '#3d5a78';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = '#2f4a63';
    ctx.lineWidth = 3;
    for (const [a, b] of GATES) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();

    for (const target of targets) {
      ctx.strokeStyle = target.down ? '#2c3a48' : '#ffd166';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(target.a.x, target.a.y);
      ctx.lineTo(target.b.x, target.b.y);
      ctx.stroke();
    }

    for (const f of flippers) {
      const end = flipperEnd(f);
      ctx.strokeStyle = '#e8a83c';
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.moveTo(f.pivot.x, f.pivot.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }

    // plunger
    if (inLane) {
      const y = 600 + plunger * 0.6;
      ctx.strokeStyle = '#8fa4b8';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(336, y);
      ctx.lineTo(336, 632);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(ball.pos.x, ball.pos.y, BALL_R, 0, Math.PI * 2);
    const bg = ctx.createRadialGradient(
      ball.pos.x - 3, ball.pos.y - 3, 1, ball.pos.x, ball.pos.y, BALL_R,
    );
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(1, '#8c97a3');
    ctx.fillStyle = bg;
    ctx.fill();

    ctx.fillStyle = '#e8edf6';
    ctx.font = '600 16px ui-monospace, monospace';
    ctx.fillText(String(score).padStart(7, '0'), 20, 620);
    ctx.fillText('o'.repeat(Math.max(0, ballsLeft - 1)), 150, 620);
    if (message) {
      ctx.fillStyle = '#ffd166';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(message, W / 2, 96);
      ctx.textAlign = 'left';
    }
  }

  // ------------------------------------------------------------------ input
  const setFlipper = (side, down) => {
    for (const f of flippers) if (f.key === side) f.up = down;
  };

  const onKey = (e, down) => {
    if (e.repeat) return;
    if (e.code === 'ArrowLeft' || e.code === 'KeyZ') { setFlipper('left', down); e.preventDefault(); }
    if (e.code === 'ArrowRight' || e.code === 'KeyM') { setFlipper('right', down); e.preventDefault(); }
    if (e.code === 'Space') {
      if (!down && inLane) plungerReleased = true;
      plungerHeld = down;
      e.preventDefault();
    }
  };
  const keyDown = (e) => onKey(e, true);
  const keyUp = (e) => onKey(e, false);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);

  // Touch and mouse: left half flips left, right half flips right, hold to plunge.
  const pointer = (e, down) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const touches = e.changedTouches ? [...e.changedTouches] : [e];
    for (const point of touches) {
      const x = (point.clientX - rect.left) / rect.width;
      if (inLane) {
        if (!down) plungerReleased = true;
        plungerHeld = down;
      } else setFlipper(x < 0.5 ? 'left' : 'right', down);
    }
  };
  const pDown = (e) => pointer(e, true);
  const pUp = (e) => pointer(e, false);
  canvas.addEventListener('pointerdown', pDown);
  canvas.addEventListener('pointerup', pUp);
  canvas.addEventListener('pointercancel', pUp);

  // ------------------------------------------------------------------- loop
  let last = performance.now();
  let raf = 0;
  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;

    if (inLane && plungerHeld) plunger = Math.min(60, plunger + dt * 90);
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
      canvas.removeEventListener('pointerup', pUp);
      canvas.removeEventListener('pointercancel', pUp);
    },
    get score() { return score; },
    // Exposed so the cabinet, and a test harness, can see what the table is doing without
    // having to read pixels back off the canvas.
    get debug() {
      return {
        x: Math.round(ball.pos.x), y: Math.round(ball.pos.y),
        vx: Math.round(ball.vel.x), vy: Math.round(ball.vel.y),
        inLane, plunger: Math.round(plunger), ballsLeft, score, message,
      };
    },
  };
}

export const meta = {
  key: 'pinball',
  width: W,
  height: H,
  controls: 'Arrow keys or Z / M to flip, SPACE to launch. On a phone, tap left or right.',
};
