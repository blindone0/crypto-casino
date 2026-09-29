// Tron: Legacy, at a table.
//
// The first match board with a clock of its own. The others render a position and wait
// for a click; this one runs the race locally at the tick rate, on the same rules file the
// server replays (tron-rules.js), and only the INPUTS travel. The server's view is the
// list of turns and when the race started, and the board rebuilds the race from it on
// every update. Your own turn is applied here at once, so your ride never waits for a
// round trip; the server records it at its own next tick, and the next update reconciles
// the two — to the same cell, or a tick apart on a slow line.
//
// Same contract as every board: board(host, { view, seat, seats, myTurn, lang, onAct })
// returns { update, element }. Input goes out as onAct({ turn }). When the local race ends
// the board asks for the result with onAct({ claim: true }), which the shell routes to the
// claim route. In solo it also syncs now and then with onAct({ turn: 'straight' }), because
// the machines' turns are decided on the server only when someone asks.

import * as R from './tron-rules.js';
import { paint, burstFor, ageBursts, W, H } from './tron-paint.js';

const SYNC_MS = 600;
const CLAIM_RETRY_MS = 3000;

const KEYS = {
  ArrowUp: 'n', KeyW: 'n', ArrowRight: 'e', KeyD: 'e',
  ArrowDown: 's', KeyS: 's', ArrowLeft: 'w', KeyA: 'w',
};

const labels = {
  ru: {
    ready: 'Старт через',
    riding: 'Гонка идёт',
    out: 'Вы выбыли',
    won: 'Вы победили',
    lost: 'Вы проиграли',
    draw: 'Ничья',
    watching: 'Вы смотрите',
    hint: 'Стрелки или W A S D — поворот. На телефоне — свайп в нужную сторону.',
  },
  en: {
    ready: 'Riding in',
    riding: 'Riding',
    out: 'You are out',
    won: 'You won',
    lost: 'You lost',
    draw: 'A draw',
    watching: 'Watching',
    hint: 'Arrow keys or W A S D to turn. On a phone, swipe the way you want to go.',
  },
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export function board(host, opts = {}) {
  const state = {
    view: opts.view || null,
    seat: Number.isInteger(opts.seat) ? opts.seat : null,
    solo: !!opts.solo,
    onAct: opts.onAct || (() => {}),
    lang: opts.lang === 'ru' ? 'ru' : 'en',
    offset: 0,              // the server's clock minus ours
    sim: null,
    pending: [],            // the view's turns still ahead of the local race
    turnsSeen: -1,          // how many turns the sim was built from
    startSeen: 0,
    lastSync: 0,
    claimedAt: 0,
    bursts: [],
    last: 0,
  };
  const t = (k) => labels[state.lang][k];

  const root = el('div', 'tron');
  const status = el('div', 'tron-status mono');
  const canvas = el('canvas', 'tron-arena');
  canvas.width = W;
  canvas.height = H;
  root.append(status, canvas, el('div', 'hint', t('hint')));
  host.replaceChildren(root);
  const ctx = canvas.getContext('2d');

  const serverNow = () => Date.now() + state.offset;
  const limit = (v) => Math.floor(v.roundMs / v.tickMs);
  const tickNow = (v) => Math.min(limit(v), Math.max(0, Math.floor((serverNow() - v.startMs) / v.tickMs)));

  /** Rebuild the race from the server's inputs. Done only when the inputs changed. */
  function rebuild() {
    const v = state.view;
    if (!v || !Array.isArray(v.turns)) return;
    if (v.turns.length === state.turnsSeen && v.startMs === state.startSeen && state.sim) return;
    if (typeof v.nowMs === 'number') state.offset = v.nowMs - Date.now();
    state.sim = R.replay(v.n, v.turns, tickNow(v));
    state.pending = v.turns.filter((x) => x.t > state.sim.tick).sort((a, b) => a.t - b.t);
    state.turnsSeen = v.turns.length;
    state.startSeen = v.startMs;
  }

  /** Bring the local race up to the current tick, applying scheduled turns on the way. */
  function advance() {
    const v = state.view;
    const sim = state.sim;
    if (!v || !sim) return;
    const upto = tickNow(v);
    while (sim.tick < upto && !sim.over) {
      while (state.pending.length && state.pending[0].t <= sim.tick + 1) {
        const x = state.pending.shift();
        R.setHeading(sim, x.seat, x.h);
      }
      for (const seat of R.step(sim)) state.bursts.push(burstFor(sim.riders[seat]));
    }
  }

  const finished = () => {
    const v = state.view;
    if (!v) return false;
    if (v.result) return true;
    return !!state.sim && (state.sim.over || state.sim.tick >= limit(v));
  };

  function statusText() {
    const v = state.view;
    if (!v || !state.sim) return '';
    const left = v.startMs - serverNow();
    if (left > 0) return `${t('ready')} ${Math.ceil(left / 1000)}`;
    const result = v.result || (state.sim.over ? { winners: state.sim.winners } : null);
    if (result) {
      if (state.seat === null) return t('watching');
      if (!result.winners.includes(state.seat)) return t('lost');
      return result.winners.length > 1 ? t('draw') : t('won');
    }
    const me = state.seat === null ? null : state.sim.riders[state.seat];
    if (me && !me.alive) return t('out');
    return state.seat === null ? t('watching') : t('riding');
  }

  function turn(h) {
    const v = state.view;
    const sim = state.sim;
    if (!v || !sim || state.seat === null || sim.over) return;
    if (serverNow() < v.startMs) return;
    const me = sim.riders[state.seat];
    if (!me || !me.alive) return;
    // Applied here at once, and sent; the server's answer is the one that counts.
    if (!R.setHeading(sim, state.seat, h)) return;
    state.onAct({ turn: h });
  }

  // ------------------------------------------------------------------ input
  const keyDown = (e) => {
    const h = KEYS[e.code];
    if (!h) return;
    e.preventDefault();
    if (e.repeat) return;
    turn(h);
  };
  let swipe = null;
  const pointerDown = (e) => { e.preventDefault(); swipe = { x: e.clientX, y: e.clientY }; };
  const pointerMove = (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n'));
    swipe = null;
  };
  const pointerOff = () => { swipe = null; };
  window.addEventListener('keydown', keyDown);
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerOff);
  canvas.addEventListener('pointercancel', pointerOff);

  function teardown() {
    window.removeEventListener('keydown', keyDown);
    canvas.removeEventListener('pointerdown', pointerDown);
    canvas.removeEventListener('pointermove', pointerMove);
    canvas.removeEventListener('pointerup', pointerOff);
    canvas.removeEventListener('pointercancel', pointerOff);
  }

  // ------------------------------------------------------------------- loop
  function frame(now) {
    // The shell replaces the stage when the table is left; a board with no page under
    // it has nothing to draw and no keys to hear.
    if (!root.isConnected) { teardown(); return; }
    const dt = Math.min(0.05, (now - (state.last || now)) / 1000);
    state.last = now;
    advance();
    ageBursts(state.bursts, dt);
    paint(ctx, state.sim, { bursts: state.bursts });

    const v = state.view;
    if (v && state.sim) {
      const left = v.startMs - serverNow();
      if (left > 0) {
        ctx.fillStyle = '#e8f6ff';
        ctx.font = 'bold 48px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(Math.ceil(left / 1000)), W / 2, H / 2);
      }
      if (finished() && !v.result && now - state.claimedAt > CLAIM_RETRY_MS) {
        state.claimedAt = now;
        state.onAct({ claim: true });
      } else if (state.solo && !finished() && left <= 0 && now - state.lastSync > SYNC_MS) {
        state.lastSync = now;
        state.onAct({ turn: 'straight' });
      }
    }
    status.textContent = statusText();
    requestAnimationFrame(frame);
  }

  rebuild();
  requestAnimationFrame(frame);

  return {
    update(next) {
      Object.assign(state, next);
      if (next && 'seat' in next) state.seat = Number.isInteger(next.seat) ? next.seat : null;
      rebuild();
    },
    get element() { return root; },
  };
}

export const meta = { key: 'tron' };
