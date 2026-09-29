// Русская пирамида, in the arcade: you against the machine.
//
// The game is not in this file. billiards-rules.js holds the table in millimetres, the
// physics and the rules of the classic pyramid — only the биток is struck, any ball
// dropped counts, a свояк counts, a foul hands the other side a ball, eight wins — and
// billiards3d.js draws that table in WebGL when there is WebGL. What this file owns is
// the cabinet: the pointer and the keys, the machine's turn and its pause for thought,
// the arcade score, and a flat drawing of the cloth for a browser with no WebGL, which is
// also what the headless tests run against. Both renderers show the same millimetres,
// and both look up the table from the house with +y to the left, so the arrow keys turn
// the cue the same way whichever is on.
//
// The same contract as every cabinet: start(canvas, callbacks) returns { stop, score,
// debug }, the module exports meta, sound is a callback, and the machine's one bit of
// chance comes from a seeded generator, so a run with the same shots is the same run.

import * as B from './billiards-rules.js';
import { createView } from './billiards3d.js';

const CW = 420;
const CH = 750;
const MARGIN = 30;
const THINK_S = 0.9;          // the machine's pause before it shoots
const DRAW_MM = 900;          // a pull this long on the cloth is full power
const SHOT_CAP = 300;         // a game that has not ended by then ends
const CUE_RED = '#c0392b';
const IVORY = '#f4f1e8';

export function start(canvas, { onScore, onEnd, onBall, seed, sound } = {}) {
  const say = (name) => { if (sound) sound(name); };
  const random = B.rng(seed ?? (Date.now() & 0xffffffff));
  canvas.width = CW;
  canvas.height = CH;

  const state = B.create();

  // The view: the table in three dimensions, or the cloth flat. A canvas that handed out a
  // WebGL context and then failed to compile cannot hand out a 2D one, so in that one case
  // the flat cloth goes on a fresh canvas put in its place.
  let surface = canvas;
  const view = createView(canvas);
  let ctx = null;
  if (!view) {
    ctx = canvas.getContext('2d');
    if (!ctx && typeof document !== 'undefined') {
      surface = document.createElement('canvas');
      surface.width = CW;
      surface.height = CH;
      surface.className = canvas.className;
      canvas.replaceWith(surface);
      ctx = surface.getContext('2d');
    }
  }
  // In three dimensions there is no text on the canvas, so what the table has to say goes
  // on a caption under it.
  let caption = null;
  if (view && typeof document !== 'undefined' && canvas.parentNode) {
    caption = document.createElement('div');
    caption.className = 'arcade-caption';
    canvas.parentNode.insertBefore(caption, canvas.nextSibling);
  }

  // The flat cloth: the length runs up the canvas with the house at the bottom, near you,
  // and +y to the left — mirrored, so it agrees with the camera in billiards3d.js.
  const s2 = (CH - 2 * MARGIN) / B.L;
  const ox = (CW - B.W * s2) / 2;
  const toScreen = (x, y) => ({ sx: ox + (B.W - y) * s2, sy: CH - MARGIN - x * s2 });
  const fromScreen = (clientX, clientY) => {
    const rect = surface.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * CW;
    const py = ((clientY - rect.top) / rect.height) * CH;
    return { x: (CH - MARGIN - py) / s2, y: B.W - (px - ox) / s2 };
  };
  const toTable = (e) => (view ? view.toTable(e.clientX, e.clientY) : fromScreen(e.clientX, e.clientY));

  let score = 0;
  let running = true;
  let ended = false;
  let message = 'Your break: pull back from the cue ball and let go';
  let messageFor = 6;
  let aiming = false;
  let aimAt = { x: 0, y: 0 };
  let power = 0;
  let keyAngle = 0;             // up the table, at the pyramid
  let keyCharging = false;
  let botAim = null;
  let think = 0;

  const award = (points) => {
    score = Math.max(0, score + points);
    if (onScore) onScore(score);
  };

  function finish() {
    if (ended) return;
    ended = true;
    running = false;
    if (onEnd) onEnd(score);
  }

  const hooks = {
    onContact: () => say('clack'),
    onPocket: () => say('pocket'),
  };

  /** What the last shot came to, in words, and what it is worth on the arcade's scale. */
  function announce(last) {
    const mine = last.seat === 0;
    // A thousand for every ball of yours — the ones you dropped, and the one the machine
    // hands you when it fouls. The machine's own balls are worth nothing to you.
    if (mine) award(last.counted * 1000);
    else if (last.penalty) award(1000);
    if (state.over) {
      if (state.winner === 0) {
        award(5000 + B.toGo(state, 1) * 500);
        message = 'Eight. You win.';
      } else if (state.winner === 1) message = 'Eight. The machine wins.';
      else message = 'Nothing left on the table. A draw.';
    } else if (last.foul) {
      message = mine ? 'Foul: nothing touched. One to the machine.' : 'The machine fouls: one to you.';
    } else if (last.svoyak) {
      message = mine ? `Свояк! ${B.toGo(state, 0)} to go — shoot again.` : `A свояк for the machine: ${B.toGo(state, 1)} to go.`;
    } else if (last.counted) {
      message = mine ? `${last.counted} down, ${B.toGo(state, 0)} to go — shoot again.` : `The machine drops one: ${B.toGo(state, 1)} to go.`;
    } else {
      message = mine ? 'Nothing. The machine shoots.' : 'Your shot.';
    }
    messageFor = 4;
    if (onBall) onBall(B.toGo(state, 0));
    if (state.over) finish();
  }

  function step(dt) {
    if (messageFor > 0) messageFor -= dt;
    const inFlight = !!state.shot;
    for (let i = 0; i < B.SUBSTEPS; i += 1) B.step(state, dt / B.SUBSTEPS, hooks);
    if (inFlight && !state.shot && state.last) {
      const last = state.last;
      state.last = null;
      announce(last);
      if (!running) return;
    }
    if (!B.moving(state) && state.shots >= SHOT_CAP) { finish(); return; }

    // The machine's turn: it lines the shot up, holds the cue there for a moment so you can
    // see what it means to do, then shoots.
    if (state.turn === 1 && !state.shot && !B.moving(state) && !state.over) {
      if (!botAim) {
        botAim = B.botShot(state, random);
        think = THINK_S;
      }
      think -= dt;
      if (think <= 0) {
        const aim = botAim;
        botAim = null;
        if (B.shoot(state, aim.angle, aim.power)) say('cue');
      }
    }
  }

  /** Where the cue is pointing right now, if anyone is holding it. */
  function aimNow() {
    if (state.over || state.shot || B.moving(state)) return null;
    if (state.turn === 1) return botAim ? { angle: botAim.angle, power: botAim.power, aiming: true } : null;
    const c = B.cueBall(state);
    if (aiming) return { angle: Math.atan2(c.y - aimAt.y, c.x - aimAt.x), power, aiming: true };
    return { angle: keyAngle, power: keyCharging ? power : 0, aiming: keyCharging };
  }

  // ------------------------------------------------------------- the cloth
  function drawFlat() {
    ctx.fillStyle = '#0b1410';
    ctx.fillRect(0, 0, CW, CH);
    const rail = 14;
    const top = CH - MARGIN - B.L * s2;
    ctx.fillStyle = '#5a3a1c';
    ctx.fillRect(ox - rail, top - rail, B.W * s2 + rail * 2, B.L * s2 + rail * 2);
    ctx.fillStyle = '#12613f';
    ctx.fillRect(ox, top, B.W * s2, B.L * s2);
    for (const p of B.POCKETS) {
      const q = toScreen(p.x, p.y);
      ctx.beginPath();
      ctx.arc(q.sx, q.sy, ((p.corner ? B.CORNER_MOUTH : B.MIDDLE_MOUTH) / 2 + 22) * s2, 0, Math.PI * 2);
      ctx.fillStyle = '#07100c';
      ctx.fill();
    }
    ctx.strokeStyle = '#0d4a30';
    ctx.lineWidth = 3;
    for (const s of B.RAILS) {
      const a = s.axis === 'y' ? toScreen(s.from, s.at) : toScreen(s.at, s.from);
      const b = s.axis === 'y' ? toScreen(s.to, s.at) : toScreen(s.at, s.to);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    }
    const rp = B.R * s2;
    for (const b of state.balls) {
      if (b.potted) continue;
      const q = toScreen(b.x, b.y);
      ctx.beginPath();
      ctx.arc(q.sx, q.sy, rp, 0, Math.PI * 2);
      const g = ctx.createRadialGradient(q.sx - rp * 0.35, q.sy - rp * 0.35, 1, q.sx, q.sy, rp);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.35, b.cue ? CUE_RED : IVORY);
      g.addColorStop(1, '#00000055');
      ctx.fillStyle = g;
      ctx.fill();
    }
    const aim = aimNow();
    if (aim) {
      const c = B.cueBall(state);
      const hit = B.predict(state, aim.angle);
      const from = toScreen(c.x, c.y);
      const to = toScreen(hit.x, hit.y);
      ctx.strokeStyle = 'rgba(255,255,255,.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(from.sx, from.sy); ctx.lineTo(to.sx, to.sy); ctx.stroke();
      ctx.setLineDash([]);
      // The cue, drawn back with the power.
      const back = B.R + 24 + aim.power * 280;
      const tip = toScreen(c.x - Math.cos(aim.angle) * back, c.y - Math.sin(aim.angle) * back);
      const butt = toScreen(c.x - Math.cos(aim.angle) * (back + 1400), c.y - Math.sin(aim.angle) * (back + 1400));
      ctx.strokeStyle = '#c9a36a';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(tip.sx, tip.sy); ctx.lineTo(butt.sx, butt.sy); ctx.stroke();
    }
    ctx.fillStyle = '#e8edf6';
    ctx.font = '600 13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`You ${state.scores[0]}`, 12, CH - 8);
    ctx.textAlign = 'right';
    ctx.fillText(`Machine ${state.scores[1]}`, CW - 12, CH - 8);
    if (messageFor > 0 && message) {
      ctx.fillStyle = '#ffd166';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(message, CW / 2, 16);
    }
    ctx.textAlign = 'left';
  }

  let captionText = '';
  function draw(dt) {
    if (view) {
      view.draw(state, aimNow(), dt);
      if (caption) {
        const tally = `You ${state.scores[0]} — Machine ${state.scores[1]}`;
        const text = messageFor > 0 && message ? `${message}   ·   ${tally}` : tally;
        if (text !== captionText) { captionText = text; caption.textContent = text; }
      }
    } else if (ctx) {
      drawFlat();
    }
  }

  // ---------------------------------------------------------------- input
  const mayShoot = () => running && state.turn === 0 && !state.shot && !state.over && !B.moving(state);
  const pullPower = (at) => {
    const c = B.cueBall(state);
    return Math.min(1, Math.hypot(at.x - c.x, at.y - c.y) / DRAW_MM);
  };

  const pDown = (e) => {
    if (!mayShoot()) return;
    e.preventDefault();
    aimAt = toTable(e);
    aiming = true;
    power = pullPower(aimAt);
  };
  const pMove = (e) => {
    if (!aiming) return;
    aimAt = toTable(e);
    power = pullPower(aimAt);
  };
  const pUp = (e) => {
    if (!aiming) return;
    e.preventDefault();
    aiming = false;
    const c = B.cueBall(state);
    // Pull back to shoot forward: the ball goes away from where you dragged to.
    if (mayShoot() && B.shoot(state, Math.atan2(c.y - aimAt.y, c.x - aimAt.x), power)) say('cue');
    power = 0;
  };
  // The press is on the table; the drag and the release are heard on the WINDOW, so a
  // pull past the edge of the canvas — the only way to draw the cue back from a ball
  // against a cushion — still counts.
  surface.addEventListener('pointerdown', pDown);
  window.addEventListener('pointermove', pMove);
  window.addEventListener('pointerup', pUp);
  window.addEventListener('pointercancel', pUp);

  // +y is to the left in both views, and a bigger angle turns the aim toward +y.
  const onKey = (e, down) => {
    if (e.repeat) return;
    if (e.code === 'ArrowLeft') { if (down) keyAngle += 0.06; e.preventDefault(); }
    if (e.code === 'ArrowRight') { if (down) keyAngle -= 0.06; e.preventDefault(); }
    if (e.code === 'Space') {
      e.preventDefault();
      if (down) {
        if (mayShoot()) keyCharging = true;
      } else if (keyCharging) {
        keyCharging = false;
        if (mayShoot() && B.shoot(state, keyAngle, Math.max(0.2, power))) say('cue');
        power = 0;
      }
    }
  };
  const keyDown = (e) => onKey(e, true);
  const keyUp = (e) => onKey(e, false);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);

  if (onBall) onBall(B.TARGET);

  // ----------------------------------------------------------------- loop
  let prev = performance.now();
  let raf = 0;
  function frame(t) {
    const dt = Math.min(0.05, (t - prev) / 1000);
    prev = t;
    if (!running) { draw(dt); return; }
    if (keyCharging) power = Math.min(1, power + dt * 0.9);
    step(dt);
    draw(dt);
    if (running) raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      surface.removeEventListener('pointerdown', pDown);
      window.removeEventListener('pointermove', pMove);
      window.removeEventListener('pointerup', pUp);
      window.removeEventListener('pointercancel', pUp);
      if (view) view.dispose();
      if (caption) caption.remove();
    },
    get score() { return score; },
    /** Exposed so the shell, and a test, can see the table without reading pixels. */
    get debug() {
      const c = B.cueBall(state);
      return {
        score,
        running,
        over: state.over,
        winner: state.winner,
        moving: B.moving(state),
        turn: state.turn,
        thinking: !!botAim,
        scores: state.scores.slice(),
        toGo: B.toGo(state, 0),
        remaining: B.onTable(state).length,
        balls: state.balls.filter((b) => !b.potted).length,
        shots: state.shots,
        cue: { x: Math.round(c.x), y: Math.round(c.y), potted: c.potted },
        message,
        view: view ? '3d' : '2d',
      };
    },
    /** For the test harness: the player's shot without a pointer. Angle in the table's frame. */
    shootAt(angle, strength) {
      if (mayShoot() && B.shoot(state, angle, strength)) say('cue');
    },
  };
}

export const meta = {
  key: 'billiards',
  width: CW,
  height: CH,
  hud: 'arc.g.billiards.hud',
  controls: 'Pull back from the cue ball and let go: the longer the pull, the harder the shot. Arrow keys to aim, SPACE to strike.',
};
