'use strict';
// The slot symbols, rendered on the RTX, one pack per theme.
//
//   node tools/generate-slot-symbols.js                          what it would do
//   node tools/generate-slot-symbols.js --yes                    render every theme, then pack
//   node tools/generate-slot-symbols.js --yes --theme noir       one theme
//   node tools/generate-slot-symbols.js --yes --theme noir --only K --seed 5
//                                                                redo one symbol, another seed
//   node tools/generate-slot-symbols.js --yes --pack-only        rebuild the packs from the
//                                                                last renders, no GPU
//
// igor: "доработай или переделай слоты - выглядят ужасно".
//
// WHAT THIS MAKES
//
// Ten symbols per theme — the five ranks, the bell, the gem, the crown, the wild and the
// scatter, whatever each theme draws them as — asked of the model one at a time as a
// single object on pure black, keyed to alpha, cropped, fitted into a cell and packed
// into one atlas per theme under public/textures/slots/. Then public/slotpacks.js is
// written from the manifests, so the machine knows which themes have a pack and where
// each symbol sits in it. A theme with no pack keeps its vector artwork; a pack with a
// hole in it (a render that keyed to nothing) is refused rather than shipped.
//
// The atlas is WebP with alpha, not PNG: ten photographic renders at 384 px are two or
// three megabytes as PNG and under half a megabyte as WebP, and the browser draws it into
// the strip texture once per theme, so the format costs nothing at play time.
//
// At build time, never in the game, like the invaders' pack and the materials: an SDXL
// frame is thirty seconds on the 4080, and the Linux node has no GPU at all. The renders
// live in export/ (gitignored) so a pack can be rebuilt or one symbol redone without
// rendering the rest again.
//
// NOTE: no backticks anywhere in the Python below. It is a JS template literal, and a
// backtick inside it ends the string and turns the rest of the Python into JavaScript.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const comfy = require('./comfy');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'textures', 'slots');
const WORK = path.join(ROOT, 'export', 'slots');
const PACKS_JS = path.join(ROOT, 'public', 'slotpacks.js');

const CELL = 384;
const COLS = 5;
const KEYS = ['T', 'J', 'Q', 'K', 'A', 'BELL', 'GEM', 'CROWN', 'WILD', 'SCAT'];

// What SDXL is told about every symbol, whatever the theme: one object, centred, on black,
// so the keying has something to key.
const SUFFIX = ', a single object centered, isolated on a pure black background, casino slot '
  + 'machine symbol, high detail, sharp focus, no text, no watermark';
const NEGATIVE = 'text, letters, writing, watermark, logo, signature, frame, border, multiple objects, '
  + 'collage, grid, cropped, cut off, blurry, grey background, gradient background, scenery, '
  + 'person, face, hands';
// The ranks are letters, and a letter prompt must be allowed its letter.
const RANK_NEGATIVE = 'watermark, logo, signature, multiple letters, two letters, repeated letter, duplicate, '
  + 'extra letters, small letters, words, sentence, collage, grid, cropped, cut off, blurry, '
  + 'grey background, gradient background, scenery, person, face, hands';

// "one single large glyph": asked for a letter alone, the model likes to add a second,
// smaller one beside it (classic's first J came back as two).
const RANK_NAME = {
  T: 'the number 10, one single large glyph',
  J: 'the capital letter J, one single large glyph',
  Q: 'the capital letter Q, one single large glyph',
  K: 'the capital letter K, one single large glyph',
  A: 'the capital letter A, one single large glyph',
};
const RANK_TEXT = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };

// --glyph: the rank is drawn first, with a real font, and the model is started from that
// picture (image to image, see comfy.js) rather than from noise. Asked for a bare letter
// from nothing, SDXL returned a second small J beside the first, a C for a Q, a B for a
// J and a neon squiggle for a J five times running; started from the drawn glyph it
// keeps the letter and adds the material. The glyph is tinted towards the theme's metal
// so the colour has less to fight.
const GLYPH_FONT = process.env.GLYPH_FONT || 'C:\\Windows\\Fonts\\georgiab.ttf';
// 0.62 kept the letter but returned it nearly flat; 0.7 lets the material and a little
// ornament in while the letterform still holds.
const GLYPH_DENOISE = 0.7;
const GLYPH_TINT = {
  classic: '#e6c060', afterdark: '#ff4fa3', russian: '#e8a83c', noir: '#cfd8e4', couch: '#8fa6e8',
};

const GLYPH_PY = `
import sys
from PIL import Image, ImageDraw, ImageFont
text, out, font_path, tint = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
SIZE = 1024
im = Image.new('RGB', (SIZE, SIZE), (0, 0, 0))
d = ImageDraw.Draw(im)
size = 700
font = ImageFont.truetype(font_path, size)
box = d.textbbox((0, 0), text, font=font)
w, h = box[2] - box[0], box[3] - box[1]
# Fit the glyph to about seventy percent of the frame either way.
scale = min(SIZE * 0.70 / max(w, 1), SIZE * 0.70 / max(h, 1))
font = ImageFont.truetype(font_path, max(10, int(size * scale)))
box = d.textbbox((0, 0), text, font=font)
w, h = box[2] - box[0], box[3] - box[1]
rgb = tuple(int(tint.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4))
d.text(((SIZE - w) / 2 - box[0], (SIZE - h) / 2 - box[1]), text, font=font, fill=rgb)
im.save(out, 'PNG')
print('glyph ' + text + ' ' + str(w) + 'x' + str(h))
`;

/** Draw the rank with a font and upload it: the picture the model starts from. */
async function glyphInit(themeKey, key, work) {
  const file = path.join(work, `${key}.init.png`);
  execFileSync(comfy.python(), ['-c', GLYPH_PY, RANK_TEXT[key], file, GLYPH_FONT, GLYPH_TINT[themeKey] || '#e6c060'], { encoding: 'utf8' });
  return comfy.uploadImage(file);
}

/**
 * Each theme: the seed its pack is reproducible from, the material its ranks are cut
 * from, and what its five objects are. The subjects match the vector artwork's, so a
 * theme reads the same with or without its pack.
 */
const THEMES = {
  classic: {
    seed: 101,
    style: 'premium casino, 3D render, glossy, studio lighting, rich gold and jewel tones',
    rank: (name) => `${name} as a thick ornate polished gold casino emblem with a small jewel, `
      + 'beveled, mirror shine',
    objects: {
      BELL: 'a golden casino bell with a red ribbon bow, polished brass',
      GEM: 'a large brilliant-cut emerald gemstone, faceted, glowing green',
      CROWN: 'a jewelled royal crown, red velvet, gold, diamonds and rubies',
      WILD: 'a radiant golden five-pointed star, faceted, beams of light',
      SCAT: 'a glowing crystal orb with golden light swirling inside',
    },
  },
  afterdark: {
    seed: 202,
    style: 'nightclub at night, neon pink and cyan glow, glossy black, 3D render',
    rank: (name) => `${name} as a glowing pink neon sign made of glass tubing, bright, cyan reflection`,
    objects: {
      BELL: 'a cocktail glass with a cherry and an umbrella, lit by pink and cyan neon',
      GEM: 'a glossy red lipstick, open, neon reflections',
      CROWN: 'a champagne coupe with rising bubbles, lit by pink and cyan neon',
      WILD: 'a venetian masquerade mask, black and gold with feathers',
      SCAT: 'a mirror disco ball, sparkling, throwing pink and cyan light',
    },
  },
  russian: {
    seed: 303,
    style: 'Russian folk art, khokhloma, red gold and black lacquer, painted wood, warm light, 3D render',
    rank: (name) => `${name} painted in khokhloma style, gold on black lacquer with red berries and golden leaves`,
    objects: {
      BELL: 'a wooden bowl of buckwheat kasha with a painted khokhloma wooden spoon, steam',
      GEM: 'three painted easter eggs in a straw nest, red gold and black patterns',
      CROWN: 'a frosted bottle of vodka with a small shot glass, ice cold',
      WILD: 'an old bearded genie in a turban rising out of a brass oil lamp in a swirl of smoke, folk tale',
      SCAT: 'a balalaika, triangular Russian folk instrument, painted wood, three strings',
    },
  },
  noir: {
    seed: 404,
    style: '1940s film noir, monochrome, dramatic hard light, brushed silver, cigarette smoke, 3D render',
    rank: (name) => `${name} in brushed silver metal with cigarette smoke curling around it, monochrome`,
    objects: {
      BELL: 'a burning cigarette in a glass ashtray, a thin thread of smoke, monochrome',
      GEM: 'a glass of whisky on the rocks, amber against monochrome, hard light',
      CROWN: 'a silver wedding ring on black velvet, one highlight, monochrome',
      WILD: 'an open switchblade knife, chrome blade, black handle, monochrome',
      SCAT: 'the silhouette of a woman waiting at a lit window at night, seen from outside, film noir',
    },
  },
  couch: {
    seed: 505,
    style: 'surreal dreamlike, midnight blue and moon gold, glossy, soft glow, 3D render',
    rank: (name) => `${name} cut from midnight blue glass with a golden moonlit glint, glossy`,
    objects: {
      BELL: 'a small brown medicine bottle with a cork and a glass beside it, moonlit',
      GEM: 'a zodiac wheel, golden signs on midnight blue, glowing',
      CROWN: 'a crescent moon, silver and gold, glowing softly, a few stars',
      WILD: 'a symmetrical rorschach inkblot, dark blue ink on white card',
      SCAT: 'a prescription pad with a fountain pen, midnight blue and gold',
    },
  },
};

/** One render job per symbol of one theme. `override` replaces one key's subject. */
function jobs(themeKey, seed, override = null) {
  const t = THEMES[themeKey];
  return KEYS.map((key, i) => {
    const rank = RANK_NAME[key];
    const own = override && override.key === key ? override.subject : null;
    const subject = own || (rank ? t.rank(rank) : t.objects[key]);
    return {
      key,
      seed: seed * 1000 + i + 1,
      size: 1024,
      negative: rank ? RANK_NEGATIVE : NEGATIVE,
      prompt: `${subject}, ${t.style}${SUFFIX}`,
    };
  });
}

const PY = `
import json, os, sys
from PIL import Image, ImageOps, ImageFilter

work, out, theme, seed, cell, cols, keys = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), json.loads(sys.argv[7])

def keyed(p):
    # Luminance to alpha. The model was asked for pure black behind the subject; what it
    # gives is near-black, so the ramp starts a little above zero and is soft. A dark
    # object (a black lacquer letter, a noir ring on velvet) keeps its own dark pixels
    # through the ramp because they sit next to lit ones; what goes is the field.
    im = Image.open(p).convert('RGB')
    lum = ImageOps.grayscale(im)
    alpha = lum.point(lambda v: 0 if v < 14 else (255 if v > 64 else int((v - 14) * 255 / 50)))
    # Close small holes inside the object, then soften the cut edge.
    alpha = alpha.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.0))
    rgba = im.copy()
    rgba.putalpha(alpha)
    return rgba

def cropped(rgba, margin=0.04):
    box = rgba.split()[3].point(lambda v: 255 if v > 48 else 0).getbbox()
    if not box:
        return None
    w, h = box[2] - box[0], box[3] - box[1]
    # A speck is not a symbol: the model sometimes returns a near-empty frame.
    if w < rgba.width * 0.12 or h < rgba.height * 0.12:
        return None
    m = int(max(w, h) * margin)
    box = (max(0, box[0] - m), max(0, box[1] - m), min(rgba.width, box[2] + m), min(rgba.height, box[3] + m))
    return rgba.crop(box)

def fit(rgba, size):
    inner = int(size * 0.94)
    im = rgba.copy()
    im.thumbnail((inner, inner), Image.LANCZOS)
    c = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    c.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
    return c

rows = (len(keys) + cols - 1) // cols
atlas = Image.new('RGBA', (cols * cell, rows * cell), (0, 0, 0, 0))
manifest = {'theme': theme, 'seed': seed, 'cell': cell, 'cols': cols, 'file': theme + '.webp', 'cells': {}, 'empty': []}
for i, key in enumerate(keys):
    x, y = (i % cols) * cell, (i // cols) * cell
    manifest['cells'][key] = [x, y]
    c = cropped(keyed(os.path.join(work, key + '.png')))
    if c is None:
        manifest['empty'].append(key)
        continue
    atlas.paste(fit(c, cell), (x, y))

os.makedirs(out, exist_ok=True)
atlas.save(os.path.join(out, theme + '.webp'), 'WEBP', quality=92, method=6)
# A contact sheet beside the renders, for looking at: the atlas over the strip's dark
# plate colour, as a JPEG any viewer opens. Not shipped.
sheet = Image.new('RGB', atlas.size, (18, 16, 40))
sheet.paste(atlas, (0, 0), atlas)
sheet.save(os.path.join(work, 'sheet.jpg'), 'JPEG', quality=85)
with open(os.path.join(out, theme + '.json'), 'w', encoding='utf-8') as fh:
    json.dump(manifest, fh, indent=2)
    fh.write(chr(10))
print('atlas ' + str(atlas.width) + 'x' + str(atlas.height) + ', empty ' + json.dumps(manifest['empty']))
`;

/** public/slotpacks.js, from every manifest in public/textures/slots/. */
function writePacks() {
  const packs = {};
  if (fs.existsSync(OUT)) {
    for (const f of fs.readdirSync(OUT).filter((n) => n.endsWith('.json')).sort()) {
      const m = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
      if (m.empty && m.empty.length) continue;          // a pack with a hole is not a pack
      packs[m.theme] = { atlas: `/textures/slots/${m.file}`, cell: m.cell, cells: m.cells };
    }
  }
  const body = JSON.stringify(packs, null, 2).replace(/"([A-Za-z_]\w*)":/g, '$1:');
  const src = `// Rendered symbol packs, one per theme: written by tools/generate-slot-symbols.js.
//
// A pack is an atlas of the ten symbols, rendered on the GPU in this machine and keyed
// to alpha, and the cell each symbol sits in. A theme with no pack is drawn from its
// vector artwork in symbols.js, exactly as before, so this file may be empty and the
// machine still works. Generated: do not edit by hand.
export const PACKS = ${body};
`;
  fs.writeFileSync(PACKS_JS, src);
  return Object.keys(packs);
}

async function main() {
  const args = process.argv.slice(2);
  const go = args.includes('--yes');
  const packOnly = args.includes('--pack-only');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const themeArg = args.includes('--theme') ? args[args.indexOf('--theme') + 1] : null;
  const seedArg = args.includes('--seed') ? Number(args[args.indexOf('--seed') + 1]) : NaN;
  // A subject of your own for one symbol, when the model keeps missing the one in the
  // table (a bare letter is what it misses most); the theme's style is still appended.
  const promptArg = args.includes('--prompt') ? args[args.indexOf('--prompt') + 1] : null;
  if (promptArg && !only) throw new Error('--prompt needs --only KEY');
  const glyph = args.includes('--glyph');
  if (glyph && !fs.existsSync(GLYPH_FONT)) throw new Error(`--glyph needs a font: ${GLYPH_FONT} (set GLYPH_FONT)`);
  // How far the model may wander from the drawn glyph: more ornament, less letter.
  const denoiseArg = args.includes('--denoise') ? Number(args[args.indexOf('--denoise') + 1]) : NaN;
  const denoise = denoiseArg > 0 && denoiseArg <= 1 ? denoiseArg : GLYPH_DENOISE;
  const themes = themeArg ? [themeArg] : Object.keys(THEMES);
  for (const t of themes) if (!THEMES[t]) throw new Error(`no such theme: ${t} (${Object.keys(THEMES).join(', ')})`);
  if (only && !KEYS.includes(only)) throw new Error(`no such symbol: ${only} (${KEYS.join(', ')})`);

  console.log(`\n  themes    ${themes.join(', ')}`);
  console.log(`  renders   ${themes.length * (only ? 1 : KEYS.length)} at 1024, packed into ${CELL} px cells`);
  console.log(`  into      ${OUT}\n`);
  const override = promptArg ? { key: only, subject: promptArg } : null;
  for (const t of themes) {
    const seed = Number.isInteger(seedArg) && seedArg > 0 ? seedArg : THEMES[t].seed;
    for (const j of jobs(t, seed, override)) {
      if (only && j.key !== only) continue;
      console.log(`  ${t.padEnd(10)} ${j.key.padEnd(6)} ${j.prompt}`);
    }
  }
  console.log('');
  if (!go) {
    console.log('  Nothing was rendered. Re-run with --yes.\n');
    return;
  }

  for (const t of themes) {
    const seed = Number.isInteger(seedArg) && seedArg > 0 ? seedArg : THEMES[t].seed;
    const work = path.join(WORK, t);
    fs.mkdirSync(work, { recursive: true });
    if (!packOnly) {
      for (const j of jobs(t, seed, override)) {
        if (only && j.key !== only) continue;
        process.stdout.write(`  ${t.padEnd(10)} ${j.key.padEnd(6)} `);
        const init = glyph && RANK_TEXT[j.key] ? await glyphInit(t, j.key, work) : null;
        const img = await comfy.run(j.prompt, j.seed, {
          negative: j.negative, size: j.size, steps: 30, cfg: 5, prefix: `slot-${t}`, client: 'casino-slots',
          init, denoise,
        });
        await comfy.fetchImage(img, path.join(work, `${j.key}.png`));
        console.log('ok');
      }
    }
    const missing = KEYS.filter((k) => !fs.existsSync(path.join(work, `${k}.png`)));
    if (missing.length) {
      console.log(`  ${t.padEnd(10)} not packed: ${missing.join(', ')} not rendered yet`);
      continue;
    }
    process.stdout.write(`  ${t.padEnd(10)} pack   `);
    const report = execFileSync(comfy.python(), [
      '-c', PY, work, OUT, t, String(seed), String(CELL), String(COLS), JSON.stringify(KEYS),
    ], { encoding: 'utf8' }).trim();
    console.log(report);
  }

  const packed = writePacks();
  console.log(`\n  public/slotpacks.js: ${packed.length ? packed.join(', ') : 'no complete pack'}`);
  for (const f of fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((n) => n.endsWith('.json')) : []) {
    const m = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    if (m.empty.length) console.log(`  WARNING: ${m.theme}: nothing keyed out of ${m.empty.join(', ')} - redo them with --only and another --seed`);
  }
  console.log('  Commit public/textures/slots/ and public/slotpacks.js.\n');
}

main().catch((e) => { console.error(`\n  ${e.message}\n`); process.exitCode = 1; });
