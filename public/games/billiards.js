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

export function start(canvas, { onScore, onEnd, onBall, seed, sound } = {}) {
  const say = (name) => { if (sound) sound(name); };
  const random = B.rng(seed ?? (Date.now() & 0xffffffff));
  canvas.width = CW;
  canvas.height = CH;

  const state = B.create();

  // The view: the table in three dimensions, and nothing else. There is no flat cloth any
  // more: a browser that will not give a context gets a sentence on the canvas saying so,
  // and the game underneath still runs (which is also what the headless tests drive). A
  // canvas that handed out a WebGL context cannot hand out a 2D one, so the notice goes on
  // a fresh canvas put in its place - and so does a rebuilt view when a context is lost.
  let surface = canvas;
  let view = null;
  let ctx = null;
  let glTries = 0;
  let retryAt = 0;
  const swapCanvas = () => {
    if (typeof document === 'undefined' || !surface.parentNode) return false;
    const fresh = document.createElement('canvas');
    fresh.width = CW;
    fresh.height = CH;
    fresh.className = surface.className;
    surface.replaceWith(fresh);
    surface.removeEventListener('pointerdown', pDown);
    surface = fresh;
    surface.addEventListener('pointerdown', pDown);
    return true;
  };
  const buildView = () => {
    view = createView(surface);
    if (view) {
      glTries = 0;
      ensureCaption();
      view.onLost(() => {
        // Thrown away and built again on a new canvas, after a pause that grows.
        view.dispose();
        view = null;
        glTries += 1;
        retryAt = performance.now() + Math.min(30000, 500 * 2 ** Math.min(glTries, 6));
        if (swapCanvas()) ctx = surface.getContext('2d');
      });
      return;
    }
    if (!ctx) ctx = surface.getContext('2d');
    if (!ctx && swapCanvas()) ctx = surface.getContext('2d');
    glTries += 1;
    retryAt = performance.now() + Math.min(30000, 1000 * 2 ** Math.min(glTries, 5));
  };
  // In three dimensions there is no text on the canvas, so what the table has to say goes
  // on a caption under it, put there the first time a view is built.
  let caption = null;
  const ensureCaption = () => {
    if (caption || typeof document === 'undefined' || !surface.parentNode) return;
    caption = document.createElement('div');
    caption.className = 'arcade-caption';
    surface.parentNode.insertBefore(caption, surface.nextSibling);
  };

  // The pointer without a view: the table laid flat on the canvas, the length running up
  // it with the house at the bottom and +y to the left, mirrored so it agrees with the
  // camera in billiards3d.js. Nothing is drawn this way any more; the headless tests
  // press on it, and a table waiting for WebGL still hears its pulls.
  const s2 = (CH - 2 * MARGIN) / B.L;
  const ox = (CW - B.W * s2) / 2;
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

  // ----------------------------------------------------------- the notice
  /** What the canvas shows while there is no WebGL: the fact, and the score. */
  function drawNotice() {
    ctx.fillStyle = '#0b1410';
    ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = '#ffd166';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('This table is drawn with WebGL,', CW / 2, CH / 2 - 30);
    ctx.fillText('and the browser will not give it a context.', CW / 2, CH / 2 - 8);
    ctx.fillStyle = '#e8edf6';
    ctx.font = '500 13px system-ui, sans-serif';
    ctx.fillText('Turn on hardware acceleration and reload. Trying again meanwhile.', CW / 2, CH / 2 + 22);
    ctx.font = '600 13px ui-monospace, monospace';
    ctx.fillText(`You ${state.scores[0]}   ·   Machine ${state.scores[1]}`, CW / 2, CH - 12);
    ctx.textAlign = 'left';
  }

  let captionText = '';
  function draw(dt) {
    if (!view && retryAt && performance.now() >= retryAt) {
      // Another go at a context, on a fresh canvas: the one with the notice on it has
      // handed out a 2D context and cannot hand out WebGL.
      retryAt = 0;
      if (swapCanvas()) { ctx = null; buildView(); }
    }
    if (view) {
      view.draw(state, aimNow(), dt);
      if (caption) {
        const tally = `You ${state.scores[0]} — Machine ${state.scores[1]}`;
        const text = messageFor > 0 && message ? `${message}   ·   ${tally}` : tally;
        if (text !== captionText) { captionText = text; caption.textContent = text; }
      }
    } else if (ctx) {
      drawNotice();
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
  // Only now, with the handlers in place: a view that fails swaps the canvas, and the
  // swap moves the press handler with it.
  buildView();

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
        view: view ? '3d' : 'none',
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
