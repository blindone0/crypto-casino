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
  // Every finished cell, by symbol and size: the strip is rebuilt around the real stop
  // on every spin, twelve cells a drum, and that must cost a few drawImage calls, not
  // sixty renders.
  const cache = new Map();

  /** One cell, drawn once, in the drum's own shape and then stretched into the strip. */
  async function render(sym, cell, width, k) {
    const out = document.createElement('canvas');
    out.width = width;
    out.height = Math.ceil(cell);
    const ctx = out.getContext('2d');
    const H = cell;
    const W = cell * k;
    ctx.scale(width / W, 1);

    // The plate: deep, near black, in the theme's colour, darker still towards the
    // drum's edges. A printed strip, not a lit panel - the symbol is the bright thing.
    const plate = ctx.createLinearGradient(0, 0, 0, H);
    plate.addColorStop(0, palette.band[0]);
    plate.addColorStop(0.5, palette.band[1]);
    plate.addColorStop(1, palette.band[2]);
    ctx.fillStyle = plate;
    ctx.fillRect(0, 0, W, H);
    const sides = ctx.createLinearGradient(0, 0, W, 0);
    sides.addColorStop(0, 'rgba(0,0,0,0.45)');
    sides.addColorStop(0.18, 'rgba(0,0,0,0)');
    sides.addColorStop(0.82, 'rgba(0,0,0,0)');
    sides.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = sides;
    ctx.fillRect(0, 0, W, H);
    // A fine brushed grain across the plate, so it is a material and not a fill. The
    // same pattern in every cell, from a small fixed sequence rather than the random.
    for (let yy = 0; yy < H; yy += 2) {
      const a = 0.02 + 0.035 * (((yy * 7919) % 97) / 97);
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.fillRect(0, yy, W, 1);
    }

    // A breath of the theme's colour behind the symbol, so it sits in light rather than
    // on black - faint, and round on the drum.
    const cx = W / 2;
    const cy = H / 2;
    const glow = ctx.createRadialGradient(cx, cy, W * 0.08, cx, cy, W * 0.55);
    glow.addColorStop(0, palette.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // The symbol: square on the drum, as large as the cell allows, over a soft dark
    // shadow. A rendered symbol is cut out to alpha and takes nearly the whole cell; the
    // drawn artwork carries a plate of its own and sits a little smaller.
    const b = await bitmap(sym, theme);
    if (b && b.img) {
      const side = Math.min(W * (b.alpha ? 0.94 : 0.8), H * (b.alpha ? 0.88 : 0.78));
      const scale = Math.min(side / b.sw, side / b.sh);
      const dw = b.sw * scale;
      const dh = b.sh * scale;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = H * 0.05;
      ctx.shadowOffsetY = H * 0.025;
      if (b.whole) ctx.drawImage(b.img, cx - dw / 2, cy - dh / 2, dw, dh);
      else ctx.drawImage(b.img, b.sx, b.sy, b.sw, b.sh, cx - dw / 2, cy - dh / 2, dw, dh);
      ctx.restore();
    }

    // The seam between cells: a hair of dark, and nothing down the sides - a reel is one
    // printed band, not a column of cards.
    const seam = Math.max(1.5, H * 0.005);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, H - seam, W, seam);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, 0, W, seam);
    return out;
  }

  return async function paint(ctx, sym, y, cell, width, extra = {}) {
    const k = extra.aspect > 0 ? extra.aspect : 0.7;
    const key = `${sym}|${width}|${Math.round(cell)}|${k.toFixed(3)}`;
    let c = cache.get(key);
    if (!c) {
      c = render(sym, cell, width, k);
      cache.set(key, c);
    }
    ctx.drawImage(await c, 0, y);
  };
}
