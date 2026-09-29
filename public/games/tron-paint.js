// Tron: the look, in one place.
//
// The arcade cabinet (tron.js) and the match board (tronboard.js) show the same race,
// and the Legacy look — black, a faint grid, every trail a bright core inside a wide
// additive glow, a crash as a ring that opens and fades — is here so the two cannot
// drift apart the way two copies would. It draws a sim from tron-rules.js and nothing
// else; what goes on top (a score, a countdown, a message) is the caller's.

import * as R from './tron-rules.js';

export const CELL = 8;
export const W = R.COLS * CELL;
export const H = R.ROWS * CELL;
export const BURST_S = 0.5;

/** A burst for a rider that has just gone down. */
export const burstFor = (r) => ({
  x: (r.x + 0.5) * CELL, y: (r.y + 0.5) * CELL, colour: R.COLOURS[r.seat], t: 0,
});

function strokeTrail(ctx, r, width, alpha) {
  ctx.strokeStyle = R.COLOURS[r.seat];
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.beginPath();
  r.path.forEach(([x, y], i) => {
    const px = (x + 0.5) * CELL;
    const py = (y + 0.5) * CELL;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();
}

/**
 * Draw the arena and the race on it. `sim` may be null before a race exists; the floor
 * is drawn either way. `bursts` are { x, y, colour, t } in pixels and seconds.
 */
export function paint(ctx, sim, { bursts = [], flash = false } = {}) {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = flash ? '#16161c' : '#050508';
  ctx.fillRect(0, 0, W, H);

  // The grid, faint, every eight cells: the floor of the arena.
  ctx.strokeStyle = 'rgba(80,200,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += CELL * 8) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
  for (let y = 0; y <= H; y += CELL * 8) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
  ctx.stroke();

  if (!sim) return;
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';
  // The glow is additive, so where two trails cross it brightens rather than covers.
  ctx.globalCompositeOperation = 'lighter';
  for (const r of sim.riders) strokeTrail(ctx, r, CELL * 1.6, 0.22);
  ctx.globalCompositeOperation = 'source-over';
  for (const r of sim.riders) strokeTrail(ctx, r, CELL * 0.5, 1);
  ctx.globalAlpha = 1;

  // The heads: a bright square with a white heart, so the front of a trail is findable.
  for (const r of sim.riders) {
    if (!r.alive) continue;
    ctx.fillStyle = R.COLOURS[r.seat];
    ctx.fillRect(r.x * CELL, r.y * CELL, CELL, CELL);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(r.x * CELL + 2, r.y * CELL + 2, CELL - 4, CELL - 4);
  }

  // A crash: a ring of the rider's colour that opens and fades, with sparks.
  for (const b of bursts) {
    const k = Math.min(1, b.t / BURST_S);
    ctx.strokeStyle = b.colour;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 6 + k * 40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = b.colour;
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      ctx.fillRect(b.x + Math.cos(a) * k * 52 - 2, b.y + Math.sin(a) * k * 52 - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }
}

/** Age the bursts by `dt` seconds and drop the ones that have faded. */
export function ageBursts(bursts, dt) {
  for (let i = bursts.length - 1; i >= 0; i -= 1) {
    bursts[i].t += dt;
    if (bursts[i].t > BURST_S) bursts.splice(i, 1);
  }
}
