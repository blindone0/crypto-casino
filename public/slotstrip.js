// The printed strip: how one cell of a reel is painted into the drum's texture.
//
// A reel is a band of printed cells, and a cell is more than a picture: a dark plate in
// the theme's colours, a light behind the symbol, a hairline frame, a sheen across the
// top, the symbol itself with a shadow under it, and a bright seam where one cell meets
// the next. The symbol comes from the theme's rendered pack when there is one
// (slotpacks.js, keyed to alpha, drawn straight in) and from the vector artwork in
// symbols.js when there is not, rasterised at the cell's own size so it is never
// upscaled. The barrel's lighting is the shader's job; nothing here is lit.

import { PACKS } from './slotpacks.js';
import { symbolSvgStandalone } from './symbols.js';

const atlases = new Map();     // theme -> Promise<HTMLImageElement | null>

/** The pack's atlas image, loaded once per theme, or null when there is no pack. */
function atlasFor(theme) {
  const pack = PACKS[theme];
  if (!pack) return Promise.resolve(null);
  if (!atlases.has(theme)) {
    atlases.set(theme, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = pack.atlas;
    }));
  }
  return atlases.get(theme);
}

/** One symbol as a bitmap: where to draw it from, and how it composites. */
export async function symbolBitmap(sym, theme) {
  const pack = PACKS[theme];
  const cellOf = pack && pack.cells && pack.cells[sym];
  if (cellOf) {
    const img = await atlasFor(theme);
    if (img) return { img, sx: cellOf[0], sy: cellOf[1], sw: pack.cell, sh: pack.cell, alpha: true };
  }
  return new Promise((resolve) => {
    const img = new Image();
    // Drawn whole, never through a source rectangle: Chrome takes the rectangle of an
    // SVG image in a coordinate space of its own and hands back one corner of it,
    // enlarged. The artwork is square: a 100 by 100 viewBox.
    img.onload = () => resolve({ img, whole: true, sw: 1, sh: 1, alpha: false });
    img.onerror = () => resolve(null);
    // Standalone: an img is its own document and cannot see the page's shared defs.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(symbolSvgStandalone(sym, theme))}`;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * A painter for one theme: (ctx, sym, y, cell, width) => Promise, the shape slot3d.js's
 * stripTexture calls it with. `bitmap` is symbolBitmap unless a test supplies its own.
 */
export function cellPainter(theme, palette, bitmap = symbolBitmap) {
  return async function paint(ctx, sym, y, cell, width) {
    // The plate.
    const plate = ctx.createLinearGradient(0, y, 0, y + cell);
    plate.addColorStop(0, palette.band[0]);
    plate.addColorStop(0.5, palette.band[1]);
    plate.addColorStop(1, palette.band[2]);
    ctx.fillStyle = plate;
    ctx.fillRect(0, y, width, cell);

    // The light behind the symbol.
    const cx = width / 2;
    const cy = y + cell / 2;
    const halo = ctx.createRadialGradient(cx, cy, cell * 0.04, cx, cy, cell * 0.58);
    halo.addColorStop(0, palette.glow);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, y, width, cell);

    // The frame: a hairline inset from the edge, with a darker line just inside it so it
    // reads as a groove rather than a drawn rectangle.
    const inset = width * 0.055;
    const radius = width * 0.05;
    ctx.lineWidth = Math.max(2, width * 0.007);
    roundRect(ctx, inset, y + inset * 0.8, width - inset * 2, cell - inset * 1.6, radius);
    ctx.strokeStyle = palette.frame;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = '#000';
    roundRect(ctx, inset + ctx.lineWidth * 1.4, y + inset * 0.8 + ctx.lineWidth * 1.4,
      width - inset * 2 - ctx.lineWidth * 2.8, cell - inset * 1.6 - ctx.lineWidth * 2.8, radius);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // The symbol, with a shadow under it, filling most of the cell.
    const b = await bitmap(sym, theme);
    if (b && b.img) {
      // A rendered symbol, cut out to alpha, fills the cell's height; the drawn artwork
      // keeps its own plate and sits a little smaller.
      const boxH = cell * (b.alpha ? 0.90 : 0.74);
      const boxW = width * (b.alpha ? 0.78 : 0.74);
      const scale = Math.min(boxW / b.sw, boxH / b.sh);
      const dw = b.sw * scale;
      const dh = b.sh * scale;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = width * 0.035;
      ctx.shadowOffsetY = width * 0.018;
      if (b.whole) ctx.drawImage(b.img, cx - dw / 2, cy - dh / 2, dw, dh);
      else ctx.drawImage(b.img, b.sx, b.sy, b.sw, b.sh, cx - dw / 2, cy - dh / 2, dw, dh);
      ctx.restore();
    }

    // A sheen across the top of the plate, as printed cells under glass have.
    const sheen = ctx.createLinearGradient(0, y, width * 0.6, y + cell * 0.7);
    sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
    sheen.addColorStop(0.45, 'rgba(255,255,255,0.02)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, y, width, cell);

    // The seam: a bright edge at the top of the cell and a dark one at the bottom.
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(0, y, width, Math.max(2, width * 0.004));
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, y + cell - Math.max(2, width * 0.004), width, Math.max(2, width * 0.004));
  };
}
