// Pong. The smallest cabinet in the room, and the one that proves the template.
//
// A court, two paddles, a ball. The player holds the left paddle, the machine the right.
// First to eleven. Everything that makes it a game rather than a wall is in three rules:
//
//   - The bounce angle comes from WHERE the ball hits the paddle. Centre sends it flat,
//     the edge sends it steep. Without this every rally is the same rally.
//   - The ball gains speed on every paddle hit. A rally that goes on is a rally that gets
//     away from you, which is the whole tension of the thing.
//   - The machine tracks the ball's predicted arrival, with a capped paddle speed and a
//     reaction lag that shrinks as the player's score rises. That is the entire difficulty
//     curve: an early rally is winnable, a late one is not.
//
// Same contract as every cabinet: start(canvas, callbacks) returns { stop, score, debug },
// the module exports meta, sound is a callback so the headless tests need no audio engine,
// and every random number comes from a seeded generator so a run is reproducible. A test
// that cannot replay a game cannot assert anything about it.

const W = 640;
const H = 400;
const PAD_W = 10;
const PAD_H = 64;
const PAD_X = 24;              // both paddles sit this far in from their wall
const BALL_R = 6;
const TO_WIN = 11;

const SERVE_SPEED = 260;       // px per second
const SPEED_UP = 1.06;         // per paddle hit
const MAX_SPEED = 900;
const MAX_ANGLE = Math.PI / 3; // an edge hit leaves at sixty degrees, no steeper
const PLAYER_SPEED = 420;

/** xorshift32, the same generator the other cabinets use. */
function rng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

export function start(canvas, { onScore, onEnd, onBall, seed, sound } = {}) {
  // A callback rather than an import: the cabinet stays free of the audio engine, and the
  // headless tests do not have to stub one.
  const say = (name) => { if (sound) sound(name); };
  const ctx = canvas.getContext('2d');
  canvas.width = W;
  canvas.height = H;

  const random = rng(seed ?? (Date.now() & 0xffffffff));

  let playerY = H / 2;
  let botY = H / 2;
  let player = 0;              // points
  let bot = 0;
  let hits = 0;                // paddle hits this game, for the score
  let rally = 0;               // paddle hits this point
  let score = 0;
  let running = true;
  let ended = false;

  // The ball. `serving` holds it on the centre spot for a beat so a lost point is
  // legible before the next one starts.
  const ball = { x: W / 2, y: H / 2, vx: 0, vy: 0, speed: SERVE_SPEED };
  let serving = 0.9;
  let serveTo = random() < 0.5 ? -1 : 1;   // -1 towards the player, 1 towards the machine

  // The machine's aim. It does not read the ball every frame: it refreshes its target
  // every `lag` seconds, and that lag is what a beginner beats.
  let botTarget = H / 2;
  let botTimer = 0;

  let up = false;
  let down = false;
  let pointerY = null;         // a finger or mouse on the court overrides the keys

  const award = (points) => {
    score = Math.max(0, score + points);
    if (onScore) onScore(score);
  };

  function serve() {
    ball.x = W / 2;
    ball.y = H / 2;
    ball.speed = SERVE_SPEED;
    // A shallow random angle, so the serve is not the same line every time but is always
    // returnable by a paddle that has not moved.
    const a = (random() - 0.5) * (Math.PI / 4);
    ball.vx = Math.cos(a) * ball.speed * serveTo;
    ball.vy = Math.sin(a) * ball.speed;
    rally = 0;
  }

  function finish() {
    if (ended) return;
    ended = true;
    running = false;
    if (onEnd) onEnd(score);
  }

  function point(toPlayer) {
    if (toPlayer) { player += 1; award(100); say('win'); } else { bot += 1; say('lose'); }
    if (onBall) onBall(TO_WIN - player);
    if (player >= TO_WIN || bot >= TO_WIN) { finish(); return; }
    // The loser receives the next serve, which is how the real thing works and which
    // stops a run of points snowballing.
    serveTo = toPlayer ? 1 : -1;
    serving = 0.9;
    ball.vx = 0; ball.vy = 0;
    ball.x = W / 2; ball.y = H / 2;
  }

  /**
   * The bounce off a paddle. `offset` is where the ball struck, -1 at the top edge to
   * +1 at the bottom, and it sets the angle: the one rule that makes Pong a game.
   */
  function bounce(offset, dir) {
    const a = Math.max(-1, Math.min(1, offset)) * MAX_ANGLE;
    ball.speed = Math.min(MAX_SPEED, ball.speed * SPEED_UP);
    ball.vx = Math.cos(a) * ball.speed * dir;
    ball.vy = Math.sin(a) * ball.speed;
    hits += 1;
    rally += 1;
    award(5);
    say('clack');
  }

  /** Where the ball will cross x = `atX`, following its current line, bounced off the walls. */
  function predictY(atX) {
    if (ball.vx === 0) return H / 2;
    const t = (atX - ball.x) / ball.vx;
    if (t < 0) return H / 2;
    let y = ball.y + ball.vy * t;
    // Fold the walls: the ball reflects, so its arrival is a triangle wave of the raw y.
    const span = H - 2 * BALL_R;
    y = ((y - BALL_R) % (2 * span) + 2 * span) % (2 * span);
    if (y > span) y = 2 * span - y;
    return y + BALL_R;
  }

  function step(dt) {
    // The player: keys, or a pointer on the court which wins while it is there.
    if (pointerY !== null) {
      playerY += Math.max(-PLAYER_SPEED * dt, Math.min(PLAYER_SPEED * dt, pointerY - playerY));
    } else {
      if (up) playerY -= PLAYER_SPEED * dt;
      if (down) playerY += PLAYER_SPEED * dt;
    }
    playerY = Math.max(PAD_H / 2, Math.min(H - PAD_H / 2, playerY));

    // The machine. Its paddle speed and its patience both scale with how the player is
    // doing, and nothing else: no reading the player's input, no cheating on the ball.
    const botSpeed = 220 + 18 * player;
    const lag = Math.max(0.06, 0.32 - 0.025 * player);
    botTimer -= dt;
    if (botTimer <= 0) {
      botTimer = lag;
      botTarget = ball.vx > 0 ? predictY(W - PAD_X - PAD_W) : H / 2;
    }
    botY += Math.max(-botSpeed * dt, Math.min(botSpeed * dt, botTarget - botY));
    botY = Math.max(PAD_H / 2, Math.min(H - PAD_H / 2, botY));

    if (serving > 0) { serving -= dt; if (serving <= 0) serve(); return; }

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Top and bottom walls.
    if (ball.y < BALL_R) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy); say('clack'); }
    if (ball.y > H - BALL_R) { ball.y = H - BALL_R; ball.vy = -Math.abs(ball.vy); say('clack'); }

    // The paddles. Only a ball moving towards a paddle can hit it, so a ball that has just
    // left one cannot be caught twice.
    const px = PAD_X + PAD_W;
    if (ball.vx < 0 && ball.x - BALL_R <= px && ball.x - BALL_R > px - 24
      && Math.abs(ball.y - playerY) <= PAD_H / 2 + BALL_R) {
      ball.x = px + BALL_R;
      bounce((ball.y - playerY) / (PAD_H / 2), 1);
    }
    const bx = W - PAD_X - PAD_W;
    if (ball.vx > 0 && ball.x + BALL_R >= bx && ball.x + BALL_R < bx + 24
      && Math.abs(ball.y - botY) <= PAD_H / 2 + BALL_R) {
      ball.x = bx - BALL_R;
      bounce((ball.y - botY) / (PAD_H / 2), -1);
    }

    if (ball.x < -BALL_R) point(false);
    else if (ball.x > W + BALL_R) point(true);
  }

  // ------------------------------------------------------------------- draw
  function draw() {
    ctx.fillStyle = '#07070a';
    ctx.fillRect(0, 0, W, H);

    // The net: a dashed centre line, the way every Pong has drawn it since 1972.
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (let y = 8; y < H; y += 24) ctx.fillRect(W / 2 - 1, y, 2, 12);

    // The scores, large and dim, behind the play.
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = 'bold 64px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(player), W / 2 - 80, 80);
    ctx.fillText(String(bot), W / 2 + 80, 80);

    ctx.fillStyle = '#f2f2f0';
    ctx.fillRect(PAD_X, playerY - PAD_H / 2, PAD_W, PAD_H);
    ctx.fillRect(W - PAD_X - PAD_W, botY - PAD_H / 2, PAD_W, PAD_H);

    // The ball, with a small glow so it reads at speed.
    ctx.shadowColor = 'rgba(255,255,255,0.8)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ------------------------------------------------------------------ input
  const onKey = (e, isDown) => {
    if (e.repeat) return;
    if (e.code === 'ArrowUp' || e.code === 'KeyW') { up = isDown; e.preventDefault(); }
    if (e.code === 'ArrowDown' || e.code === 'KeyS') { down = isDown; e.preventDefault(); }
  };
  const keyDown = (e) => onKey(e, true);
  const keyUp = (e) => onKey(e, false);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);

  // A finger or the mouse on the court: the paddle follows its height.
  const pointer = (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    pointerY = ((e.clientY - rect.top) / rect.height) * H;
  };
  const pointerOff = () => { pointerY = null; };
  canvas.addEventListener('pointerdown', pointer);
  canvas.addEventListener('pointermove', pointer);
  canvas.addEventListener('pointerup', pointerOff);
  canvas.addEventListener('pointercancel', pointerOff);
  canvas.addEventListener('pointerleave', pointerOff);

  if (onBall) onBall(TO_WIN);

  // ------------------------------------------------------------------- loop
  const SUBSTEPS = 2;
  let last = performance.now();
  let raf = 0;
  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
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
      canvas.removeEventListener('pointerdown', pointer);
      canvas.removeEventListener('pointermove', pointer);
      canvas.removeEventListener('pointerup', pointerOff);
      canvas.removeEventListener('pointercancel', pointerOff);
      canvas.removeEventListener('pointerleave', pointerOff);
    },
    get score() { return score; },
    /** Exposed so a test can see the court without reading pixels. */
    get debug() {
      return {
        score, player, bot, hits, rally, running, serving: serving > 0,
        ball: { x: Math.round(ball.x), y: Math.round(ball.y), speed: Math.round(ball.speed) },
        playerY: Math.round(playerY), botY: Math.round(botY),
      };
    },
  };
}

export const meta = {
  key: 'pong',
  width: W,
  height: H,
  hud: 'arc.g.pong.hud',
  controls: 'Arrow keys or W / S to move. On a phone, drag on the court.',
};
