'use strict';
// Space Invaders' pictures, from the RTX, by seed.
//
//   node tools/generate-invaders.js                     what it would do
//   node tools/generate-invaders.js --yes               render, then build the pack
//   node tools/generate-invaders.js --yes --seed 7      a particular look
//   node tools/generate-invaders.js --yes --pack-only   rebuild the pack from the last renders
//   node tools/generate-invaders.js --yes --seed 7 --only nebula
//                                                     redo one render, keep the others
//
// igor: "fancy animations generated with random seeded prompt and local rtx."
//
// WHEN IT RUNS
//
// At build time, never in the game. An SDXL frame is thirty seconds on the 4080 and the
// Linux node has no GPU at all, so a cabinet cannot wait for one. This writes a pack into
// public/textures/invaders/ that is committed like the jigsaw pictures, and the game reads
// it like any other image. "Random seeded prompt" means the seed chooses the words and
// makes the pack reproducible; it does not mean a new look is rolled per play.
//
// WHAT THE MODEL DRAWS, AND WHAT THE ARITHMETIC DOES
//
// The model is asked for HERO IMAGES, one per subject, on a pure black background. It is
// not asked for animation: SDXL cannot be trusted to keep a sprite coherent across frames
// from seed variation alone, and the pips, the cards and the mine icons all made the same
// call — the model supplies the look, the arithmetic supplies anything that must be exact.
//
//   - Three alien species, one hero each. Black is keyed to alpha, the creature is cropped
//     and fitted to 64 px, and the WALK CYCLE is the classic two-frame invader trick: the
//     second frame is the first with its lower legs mirrored. It reads as walking at any
//     size, and it is what the original cabinet did.
//   - One explosion hero. The BURST is eight frames of it scaled from 0.3 to 1.3 with the
//     alpha falling away and the hue leaning towards red: a burst that expands and cools,
//     from one picture.
//   - One nebula, made to tile by the same offset-and-blend trick generate-materials.js
//     uses on the felt, and shipped as a 1024 JPEG the game scrolls slowly.
//
// The atlas layout is FIXED and the game hard-codes it (public/games/invaders.js), so the
// game never fetches the manifest. The manifest is for tools and for the test.
//
// NOTE: no backticks anywhere in the Python below. It is a JS template literal, and a
// backtick inside it ends the string and turns the rest of the Python into JavaScript.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const comfy = require('./comfy');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'textures', 'invaders');
// export/ is gitignored: the hero renders are kept for --pack-only and never committed.
const WORK = path.join(ROOT, 'export', 'invaders');

/** The atlas geometry. public/games/invaders.js carries the same numbers. */
const LAYOUT = { alien: 64, species: 3, walk: 2, burst: 96, burstFrames: 8, backdrop: 1024 };

// The seed chooses one word from each list. Short lists, chosen so that any combination
// is a plausible creature: the point is a different look per seed, not a lottery.
const WORDS = {
  species: ['chitinous', 'crystalline', 'bioluminescent', 'armoured', 'spined', 'skeletal', 'mechanical', 'gelatinous'],
  material: ['pearl', 'brass', 'jade', 'bone', 'coral', 'opal', 'rusted iron', 'frosted glass'],
  palette: ['cyan and violet', 'acid green and yellow', 'amber and teal', 'crimson and gold', 'ice blue and white', 'magenta and sky blue'],
  mood: ['menacing', 'ancient', 'elegant', 'grotesque', 'sleek', 'ceremonial'],
};
const FORMS = ['small scout', 'broad brute', 'crowned commander'];

/** xorshift32, the generator every cabinet uses, so the choice is repeatable anywhere. */
function rng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

function wordsFor(seed) {
  const random = rng(seed);
  // xorshift32 takes a few steps to mix a small seed: the first outputs of seeds 1 to 20
  // are nearly the same number, and every pack came out chitinous. Discard them.
  for (let i = 0; i < 16; i += 1) random();
  const pick = (list) => list[Math.floor(random() * list.length)];
  return {
    species: pick(WORDS.species), material: pick(WORDS.material),
    palette: pick(WORDS.palette), mood: pick(WORDS.mood),
  };
}

const SPRITE_NEGATIVE = 'text, watermark, logo, multiple creatures, frame, border, scenery, '
  + 'landscape, gradient background, grey background, blur, cropped, cut off';
// "ice blue and white gas clouds" once came back as a sky full of cumulus, which no sprite
// can be seen against. The prompt now asks for the void first and the gas second, and the
// pack step below darkens whatever arrives regardless.
const NEBULA_NEGATIVE = 'planet, spaceship, text, watermark, frame, border, vignette, bright centre, '
  + 'lens flare, object, clouds, cumulus, sky, fog, smoke, daylight, bright, white';

function jobs(seed, w) {
  const out = [];
  FORMS.forEach((form, i) => out.push({
    name: `alien-${i}`, size: 768, seed: seed * 1000 + i + 1, negative: SPRITE_NEGATIVE,
    prompt: `a single ${w.mood} ${w.species} alien invader creature, ${form}, ${w.material} `
      + `carapace, ${w.palette} colours, symmetrical front view, centered, brightly lit, isolated on a pure `
      + 'black background, videogame sprite, high contrast, crisp edges, no text',
  }));
  out.push({
    name: 'burst', size: 768, seed: seed * 1000 + 8, negative: SPRITE_NEGATIVE,
    prompt: `a single ${w.palette} plasma explosion burst, bright white-hot core, sparks and `
      + 'shards, centered, isolated on a pure black background, no text',
  });
  out.push({
    name: 'nebula', size: 1024, seed: seed * 1000 + 9, negative: NEBULA_NEGATIVE,
    prompt: `seamless tileable deep space, mostly black void, faint thin wisps of ${w.palette} `
      + 'nebula gas, tiny distant stars, dark, low key, soft, even, no planet, no bright object, '
      + 'no vignette',
  });
  return out;
}

const PY = `
import json, os, sys
from PIL import Image, ImageOps, ImageFilter, ImageChops, ImageEnhance, ImageStat

work, out, seed, words, layout = sys.argv[1], sys.argv[2], int(sys.argv[3]), json.loads(sys.argv[4]), json.loads(sys.argv[5])
ALIEN, SPECIES, WALK = layout['alien'], layout['species'], layout['walk']
BURST, FRAMES, BACK = layout['burst'], layout['burstFrames'], layout['backdrop']

def keyed(p):
    # Luminance to alpha. The model was asked for pure black behind the subject; what it
    # gives is near-black, so the ramp starts a little above zero and is soft, and the
    # matte is blurred a touch so the cut edge is not a staircase at 64 px.
    im = Image.open(p).convert('RGB')
    lum = ImageOps.grayscale(im)
    alpha = lum.point(lambda v: 0 if v < 18 else (255 if v > 58 else int((v - 18) * 255 / 40)))
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.2))
    rgba = im.copy()
    rgba.putalpha(alpha)
    return rgba

def cropped(rgba, margin=0.06):
    box = rgba.split()[3].point(lambda v: 255 if v > 40 else 0).getbbox()
    if not box:
        return None
    w, h = box[2] - box[0], box[3] - box[1]
    m = int(max(w, h) * margin)
    box = (max(0, box[0] - m), max(0, box[1] - m), min(rgba.width, box[2] + m), min(rgba.height, box[3] + m))
    return rgba.crop(box)

def fit(rgba, size):
    im = rgba.copy()
    im.thumbnail((size, size), Image.LANCZOS)
    cell = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    cell.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
    return cell

def walk2(cell):
    # The classic two-frame invader: the lower legs swap sides.
    split = int(cell.height * 0.6)
    legs = cell.crop((0, split, cell.width, cell.height))
    other = cell.copy()
    other.paste(ImageOps.mirror(legs), (0, split))
    return other

atlas_w = max(SPECIES * WALK * ALIEN, FRAMES * BURST)
atlas_h = ALIEN + BURST
atlas = Image.new('RGBA', (atlas_w, atlas_h), (0, 0, 0, 0))
manifest = {
    'seed': seed, 'words': words,
    'atlas': {'file': 'atlas.png', 'w': atlas_w, 'h': atlas_h},
    'alien': {'size': ALIEN, 'species': SPECIES, 'frames': WALK, 'y': 0},
    'burst': {'size': BURST, 'frames': FRAMES, 'y': ALIEN},
    'backdrop': {'file': 'backdrop.jpg', 'size': BACK},
    'empty': [],
}

blank = Image.new('RGBA', (8, 8), (0, 0, 0, 0))
for s in range(SPECIES):
    c = cropped(keyed(os.path.join(work, 'alien-%d.png' % s)))
    if c is None:
        manifest['empty'].append('alien-%d' % s)
        c = blank
    f0 = fit(c, ALIEN)
    f1 = walk2(f0)
    atlas.paste(f0, ((s * WALK + 0) * ALIEN, 0))
    atlas.paste(f1, ((s * WALK + 1) * ALIEN, 0))

c = cropped(keyed(os.path.join(work, 'burst.png')))
if c is None:
    manifest['empty'].append('burst')
    c = blank
base = fit(c, BURST)
for f in range(FRAMES):
    t = f / (FRAMES - 1)
    size = max(2, int(BURST * (0.3 + 1.0 * t)))
    fr = base.resize((size, size), Image.LANCZOS)
    cell = Image.new('RGBA', (BURST, BURST), (0, 0, 0, 0))
    off = (BURST - size) // 2
    cell.paste(fr, (off, off), fr)
    r, g, b, a = cell.split()
    # Expanding and cooling: red up, blue down, and the whole thing fading out.
    r = r.point(lambda v, t=t: min(255, int(v * (1 + 0.5 * t))))
    b = b.point(lambda v, t=t: int(v * (1 - 0.6 * t)))
    a = a.point(lambda v, t=t: int(v * (1 - 0.95 * t)))
    atlas.paste(Image.merge('RGBA', (r, g, b, a)), (f * BURST, ALIEN))

# The backdrop: roll by half in both axes so the edges meet in the middle, then blend the
# original back over that cross with a soft mask. The seam becomes interior detail and the
# new edge is what used to be the middle, which already agreed with itself.
neb = Image.open(os.path.join(work, 'nebula.png')).convert('RGB').resize((BACK, BACK), Image.LANCZOS)
rolled = ImageChops.offset(neb, BACK // 2, BACK // 2)
band = BACK // 6
mask = Image.new('L', (BACK, BACK), 0)
px = mask.load()
for y in range(BACK):
    dy = max(0.0, 1 - abs(y - BACK / 2) / band)
    for x in range(BACK):
        dx = max(0.0, 1 - abs(x - BACK / 2) / band)
        px[x, y] = int(255 * max(dx, dy))
tiled = Image.composite(neb, rolled, mask)

# The backdrop sits behind 32px sprites, so it has to stay darker than they are whatever
# the palette asked for. The mean is pulled down to a ceiling; a render that is already
# dark is left as it came.
CEILING = 56
mean = ImageStat.Stat(tiled.convert('L')).mean[0]
if mean > CEILING:
    tiled = ImageEnhance.Brightness(tiled).enhance(CEILING / mean)

os.makedirs(out, exist_ok=True)
atlas.save(os.path.join(out, 'atlas.png'), 'PNG', optimize=True)
tiled.save(os.path.join(out, 'backdrop.jpg'), 'JPEG', quality=80, optimize=True)
with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as fh:
    json.dump(manifest, fh, indent=2)
    fh.write(chr(10))
print('atlas ' + str(atlas_w) + 'x' + str(atlas_h) + ', backdrop ' + str(BACK) + ', empty ' + json.dumps(manifest['empty']))
`;

async function main() {
  const args = process.argv.slice(2);
  const go = args.includes('--yes');
  const packOnly = args.includes('--pack-only');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const seedArg = args.includes('--seed') ? Number(args[args.indexOf('--seed') + 1]) : NaN;
  const seed = Number.isInteger(seedArg) && seedArg > 0 ? seedArg : (Date.now() % 1000000);
  const words = wordsFor(seed);
  const list = jobs(seed, words);

  console.log(`\n  seed      ${seed}`);
  console.log(`  look      ${words.mood} ${words.species}, ${words.material}, ${words.palette}`);
  console.log(`  renders   ${list.length}  (${list.map((j) => j.name).join(', ')})`);
  console.log(`  into      ${OUT}`);
  console.log('');
  for (const j of list) console.log(`  ${j.name.padEnd(8)} ${j.prompt}`);
  console.log('');

  if (!go) {
    console.log('  Nothing was rendered. Re-run with --yes, and --seed N for this look again.\n');
    return;
  }

  fs.mkdirSync(WORK, { recursive: true });
  if (!packOnly) {
    for (const j of list) {
      if (only && j.name !== only) continue;
      process.stdout.write(`  ${j.name.padEnd(8)} `);
      const img = await comfy.run(j.prompt, j.seed, {
        negative: j.negative, size: j.size, prefix: 'invaders', client: 'casino-inv',
      });
      await comfy.fetchImage(img, path.join(WORK, `${j.name}.png`));
      console.log('ok');
    }
  }
  // The pack needs every hero: rendered just now, or left in export/ by an earlier run.
  for (const j of list) {
    if (!fs.existsSync(path.join(WORK, `${j.name}.png`))) {
      throw new Error(`${j.name}.png is not in ${WORK}; render it without --pack-only or --only`);
    }
  }

  process.stdout.write('  pack     ');
  const report = execFileSync(comfy.python(), [
    '-c', PY, WORK, OUT, String(seed), JSON.stringify(words), JSON.stringify(LAYOUT),
  ], { encoding: 'utf8' }).trim();
  console.log(report);

  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  if (manifest.empty.length) {
    // The model gave back an all-black image for these. The pack is written, but with a
    // hole in it: try another seed rather than shipping an invisible alien.
    console.log(`\n  WARNING: nothing keyed out of ${manifest.empty.join(', ')} — try another seed.\n`);
    process.exitCode = 1;
    return;
  }
  const size = (f) => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0);
  console.log(`\n  atlas.png ${size('atlas.png')}KB, backdrop.jpg ${size('backdrop.jpg')}KB. Commit public/textures/invaders/.\n`);
}

main().catch((e) => { console.error(`\n  ${e.message}\n`); process.exitCode = 1; });
