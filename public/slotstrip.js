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

/**
 * A painter for one theme: (ctx, sym, y, cell, width, extra) => Promise, the shape
 * slot3d.js's stripTexture calls it with. `extra.aspect` is the cell's width over its
 * height ON THE DRUM. `bitmap` is symbolBitmap unless a test supplies its own.
 *
 * THE CELL IS DRAWN IN THE DRUM'S OWN SHAPE
 *
 * The strip's cell is 512 texels wide and 341 tall; the drum wraps it round a barrel
 * whose face is narrow and whose cells are tall, about 0.7 wide to 1 tall. The texture
 * is stretched between the two, and anything drawn square in it comes out more than
 * twice as tall as it is wide on the reel - which every symbol did, the first time.
 * So the cell is drawn in a space the shape of the drum's cell, and one transform
 * stretches it into the texture, which the drum then squashes back to what was drawn.
 */
export function cellPainter(theme, palette, bitmap = symbolBitmap) {
  return async function paint(ctx, sym, y, cell, width, extra = {}) {
    const k = extra.aspect > 0 ? extra.aspect : 0.7;
    const H = cell;
    const W = cell * k;
    ctx.save();
    ctx.translate(0, y);
    ctx.scale(width / W, 1);

    // The plate.
    const plate = ctx.createLinearGradient(0, 0, 0, H);
    plate.addColorStop(0, palette.band[0]);
    plate.addColorStop(0.5, palette.band[1]);
    plate.addColorStop(1, palette.band[2]);
    ctx.fillStyle = plate;
    ctx.fillRect(0, 0, W, H);

    // The light behind the symbol: round on the drum.
    const cx = W / 2;
    const cy = H / 2;
    const halo = ctx.createRadialGradient(cx, cy, W * 0.05, cx, cy, W * 0.62);
    halo.addColorStop(0, palette.glow);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);

    // The symbol, square on the drum, with a shadow under it. A rendered symbol, cut out
    // to alpha, takes most of the cell's width; the drawn artwork carries a plate of its
    // own and sits a little smaller.
    const b = await bitmap(sym, theme);
    if (b && b.img) {
      const side = Math.min(W * (b.alpha ? 0.88 : 0.76), H * 0.8);
      const scale = Math.min(side / b.sw, side / b.sh);
      const dw = b.sw * scale;
      const dh = b.sh * scale;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = H * 0.04;
      ctx.shadowOffsetY = H * 0.02;
      if (b.whole) ctx.drawImage(b.img, cx - dw / 2, cy - dh / 2, dw, dh);
      else ctx.drawImage(b.img, b.sx, b.sy, b.sw, b.sh, cx - dw / 2, cy - dh / 2, dw, dh);
      ctx.restore();
    }

    // A sheen across the top of the cell, as a printed strip under glass has.
    const sheen = ctx.createLinearGradient(0, 0, W * 0.6, H * 0.7);
    sheen.addColorStop(0, 'rgba(255,255,255,0.09)');
    sheen.addColorStop(0.45, 'rgba(255,255,255,0.02)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, W, H);

    // The seams of the strip: a fine bright line where one cell meets the next and a dark
    // one below it, and nothing down the sides - a reel is one printed band, not a
    // column of cards.
    const seam = Math.max(1.5, H * 0.006);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(0, 0, W, seam);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, H - seam, W, seam);
    ctx.restore();
  };
}
