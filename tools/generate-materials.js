'use strict';
// Render the dice materials locally on the RTX, as tileable textures.
//
//   node tools/generate-materials.js                 what it would render
//   node tools/generate-materials.js --yes           render it
//   node tools/generate-materials.js --yes --only bone
//
// WHY THIS IS NOT generate-pictures.js
//
// That tool makes pictures: 1024x1024 photographs for the jigsaw, where a seam at the
// edge is invisible because the edge is the edge. A material is the opposite problem. It
// is wrapped repeatedly around geometry, so a seam is a line that runs across the middle
// of every die, and "a photo of a dice" is useless because the geometry is already going
// to be a cube — what is wanted is only its SURFACE.
//
// Three things follow from that, and all three are why this is a separate file:
//
//   1. **Tiling.** The prompts ask for a flat, evenly-lit, top-down surface with no
//      object in it, and the result is then seam-fixed by an offset-blend pass rather
//      than trusted. SDXL does not produce tileable output on request, whatever the
//      prompt says.
//   2. **No lighting baked in.** A texture with a highlight painted into it looks wrong
//      the moment the object turns, because the highlight turns with it. The prompts ask
//      for flat diffuse light, and the renderer adds the real highlight at run time.
//   3. **Maps, not one image.** A surface is a colour map and a roughness map at least.
//      Roughness is derived here from the colour's own local contrast, which is crude
//      but is what makes resin read as resin rather than as a painted photograph.
//
// The pips are NOT generated. They are drawn — see `pips()` below — because a generative
// model cannot reliably place six dots in the exact grid a die needs, and a die whose
// five is slightly wrong is a broken object rather than a stylish one. The model does the
// material; the arithmetic does the layout.
//
// Everything runs on 127.0.0.1. Nothing is uploaded and nothing is downloaded but the
// images this asks for.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HOST = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
const COMFY = process.env.COMFY_DIR || 'D:\\ai\\comfyui';

// Juggernaut is the photoreal checkpoint of the two installed; the anime one is for the
// jigsaw pictures and would give a die a cel-shaded surface.
const MODEL = process.env.COMFY_MODEL || 'juggernaut-xl-v9.safetensors';

/** Square, and a power of two, because it is going onto geometry and will be mipmapped. */
const SIZE = 1024;

/** What the browser finally gets. A material does not need the detail a photo does. */
const OUT_EDGE = 512;
const JPEG_QUALITY = 88;

const NEGATIVE = [
  'dice, die, cube, object, product shot, text, numbers, dots, logo, watermark, signature',
  'vignette, shadow, drop shadow, specular highlight, reflection, glare, spotlight',
  'perspective, angle, depth of field, blur, bokeh, border, frame',
].join(', ');

/**
 * The materials, each a surface rather than a thing.
 *
 * The wording is deliberate and was arrived at by looking at what came back: "seamless
 * texture" and "flat even lighting" do most of the work, "macro photograph" gets the
 * scale right, and naming the material twice (once as a noun, once as its surface) keeps
 * the model from drifting into rendering an object made of it.
 */
const MATERIALS = {
  bone: {
    file: 'dice-bone',
    prompt: 'seamless tileable texture of polished ivory bone material surface, '
      + 'warm off-white cream colour, very fine natural grain, faint hairline scratches '
      + 'from use, subtle age patina, macro photograph, flat even diffuse studio lighting, '
      + 'no shadows, top down orthographic, uniform, high detail',
    note: 'the body of a casino die: ivory, used, not new',
  },
  resin: {
    file: 'dice-resin',
    prompt: 'seamless tileable texture of deep red translucent casino dice resin, '
      + 'polished cast acrylic surface, faint internal depth and tiny suspended bubbles, '
      + 'glassy smooth, macro photograph, flat even diffuse lighting, no shadows, '
      + 'no highlights, top down orthographic, uniform colour',
    note: 'the alternative body: the red casino die',
  },
  felt: {
    file: 'felt-table',
    prompt: 'seamless tileable texture of dark green casino billiard felt cloth, '
      + 'fine woven wool nap, subtle fibre direction, slightly worn, '
      + 'macro photograph, flat even diffuse lighting, no shadows, top down orthographic',
    note: 'the table the dice land on',
  },
  // The card back. A back is the one part of a card that IS a tileable pattern, so it
  // comes off the model like any other material. The faces are not, and are drawn below,
  // because a model cannot be trusted to put exactly seven pips in the right places.
  cardback: {
    file: 'card-back',
    prompt: 'seamless tileable ornate guilloche pattern, deep crimson red and dark '
      + 'burgundy, fine engraved rosette lattice, symmetrical, antique Russian playing '
      + 'card back design, intricate line engraving, flat even diffuse lighting, '
      + 'no shadows, top down orthographic, high detail',
    note: 'the back of every card',
  },
  // The stock the faces are printed on: aged, slightly uneven, not white paper.
  cardstock: {
    file: 'card-stock',
    prompt: 'seamless tileable texture of aged ivory card stock paper, warm off-white, '
      + 'very fine linen grain, subtle age toning, faint handling wear, '
      + 'macro photograph, flat even diffuse lighting, no shadows, top down orthographic',
    note: 'the face side of every card',
  },
  leather: {
    file: 'cup-leather',
    prompt: 'seamless tileable texture of dark brown worn leather, '
      + 'fine natural pebble grain, soft creases, aged and oiled, '
      + 'macro photograph, flat even diffuse lighting, no shadows, top down orthographic',
    note: 'the dice cup',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, options) {
  const res = await fetch(`${HOST}${pathname}`, options);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${res.statusText}`);
  return res;
}

/** One SDXL text-to-image graph, in ComfyUI's API format. */
function workflow(positive, seed) {
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: MODEL } },
    5: {
      class_type: 'EmptyLatentImage',
      inputs: { width: SIZE, height: SIZE, batch_size: 1 },
    },
    6: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE, clip: ['4', 1] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed,
        // More steps than the jigsaw pictures use. A material is judged close up and on
        // a curved surface, where the mush a low step count leaves is obvious.
        steps: 36,
        cfg: 4.5,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'material', images: ['8', 0] } },
  };
}

async function run(positive, seed) {
  const body = JSON.stringify({ prompt: workflow(positive, seed), client_id: 'casino-mat' });
  const queued = await (await api('/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })).json();
  const id = queued.prompt_id;

  for (let i = 0; i < 900; i += 1) {
    await sleep(1000);
    const entry = (await (await api(`/history/${id}`)).json())[id];
    if (!entry) continue;
    if (entry.status && entry.status.status_str === 'error') {
      throw new Error('ComfyUI reported an error for this prompt');
    }
    const images = [];
    for (const node of Object.values(entry.outputs || {})) {
      for (const img of node.images || []) images.push(img);
    }
    if (images.length) return images[0];
  }
  throw new Error('timed out waiting for ComfyUI');
}

async function fetchImage(img, to) {
  const q = new URLSearchParams({
    filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output',
  });
  fs.writeFileSync(to, Buffer.from(await (await api(`/view?${q}`)).arrayBuffer()));
}

const python = () => {
  const py = path.join(COMFY, 'venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(py)) {
    throw new Error(`no python at ${py} — is ComfyUI installed at ${COMFY}?`);
  }
  return py;
};

/**
 * Make it tile, and derive a roughness map from it.
 *
 * The offset trick: roll the image by half its width and height, so the four outer edges
 * meet in the middle, then blend across that cross with a soft mask. What was the seam is
 * now interior detail, and the new outer edge is what used to be the middle — which
 * already agreed with itself. This is the standard way and it is standard because it
 * works on any material that has no large-scale structure, which is exactly what these
 * prompts ask for.
 *
 * Roughness comes from local contrast: a scratch or a fibre is a small bright-dark
 * transition, and those are the parts of a surface that scatter light. It is an
 * approximation of a real roughness map, not a substitute for one, and it is honest to
 * say so — but it is the difference between a surface that catches the light where it is
 * scratched and one that is uniformly shiny like a sticker.
 */
function process_(pngPath, colourOut, roughOut) {
  const script = `
import sys
from PIL import Image, ImageChops, ImageFilter, ImageOps

src, colour_out, rough_out, edge, q = sys.argv[1:6]
edge, q = int(edge), int(q)

im = Image.open(src).convert("RGB")
w, h = im.size

# --- make it tile.
#
# The first attempt blurred across the seam, and it was obviously wrong the moment it was
# looked at: a blurred stripe through the middle of a felt texture reads as a crease in
# the cloth, because the detail IS the material. Destroying the detail to hide a seam
# trades a thin fault for a wide one.
#
# So: cross-fade instead. Offset the image by half, which moves the four outer edges into
# the middle as a visible cross, then fade between that offset copy and a MIRRORED copy of
# it across the seam. The mirror has the same grain, the same scale and the same contrast
# — it is the same photograph — so the blend is between two equally detailed images and
# nothing is softened. Away from the seam the mask is 0 or 1 and the pixels are untouched.
off = ImageChops.offset(im, w // 2, h // 2)
mirror_x = off.transpose(Image.FLIP_LEFT_RIGHT)
mirror_y = off.transpose(Image.FLIP_TOP_BOTTOM)

def ramp_mask(size, horizontal, band):
    """1 at the seam line, falling to 0 over band pixels either side."""
    w_, h_ = size
    m = Image.new("L", (w_, h_), 0)
    px = m.load()
    centre = (w_ if horizontal else h_) // 2
    for i in range(centre - band, centre + band):
        # Smoothstep, so the join has no visible edge of its own where the ramp ends.
        t = 1.0 - abs(i - centre) / band
        v = int(255 * (t * t * (3 - 2 * t)))
        if horizontal:
            for y in range(h_):
                px[i, y] = v
        else:
            for x in range(w_):
                px[x, i] = v
    return m

band = max(24, w // 8)
tiled = Image.composite(mirror_x, off, ramp_mask(im.size, True, band))
tiled = Image.composite(mirror_y, tiled, ramp_mask(im.size, False, band))

tiled.thumbnail((edge, edge), Image.LANCZOS)
tiled.save(colour_out, "JPEG", quality=q, optimize=True)

# --- roughness from local contrast.
#
# A scratch or a fibre is a small bright-dark transition, and those are the parts of a
# surface that scatter light. This approximates a real roughness map rather than replacing
# one, which is worth saying plainly — but it is the difference between a surface that
# catches light where it is worn and one that is uniformly shiny like a sticker.
grey = ImageOps.grayscale(tiled)
detail = ImageChops.difference(grey, grey.filter(ImageFilter.GaussianBlur(3)))
detail = ImageOps.autocontrast(detail, cutoff=1)
# Biased to the middle: a black roughness map is a mirror, which no real surface is, and
# a white one is chalk.
rough = Image.blend(Image.new("L", detail.size, 150), detail, 0.55)
rough.save(rough_out, "JPEG", quality=q, optimize=True)

print(f"{tiled.size[0]}x{tiled.size[1]}")
`;
  return execFileSync(python(), ['-c', script, pngPath, colourOut, roughOut,
    String(OUT_EDGE), String(JPEG_QUALITY)], { encoding: 'utf8' }).trim();
}

/**
 * The pips, drawn rather than generated.
 *
 * A die's faces are not decoration, they are the readout — the whole game is "which
 * number is on top". A generative model cannot be trusted to put exactly five dots in
 * exactly the right places, and a die with a wrong five is not a stylish die, it is a
 * broken one. So the arithmetic does it: one 3x3 grid, the standard pattern for each
 * value, as a transparent PNG atlas of six faces in a row.
 *
 * Drawn with a soft inner shadow so a pip reads as drilled INTO the surface rather than
 * printed onto it, which is the single detail that separates a real die from a sticker.
 */
function pips(outPath, faceSize = 256) {
  const script = `
import sys
from PIL import Image, ImageDraw, ImageFilter

out, s = sys.argv[1], int(sys.argv[2])

# Where a pip sits on a 3x3 grid, per face value. Standard casino layout.
LAYOUT = {
    1: [(1, 1)],
    2: [(0, 0), (2, 2)],
    3: [(0, 0), (1, 1), (2, 2)],
    4: [(0, 0), (2, 0), (0, 2), (2, 2)],
    5: [(0, 0), (2, 0), (1, 1), (0, 2), (2, 2)],
    6: [(0, 0), (2, 0), (0, 1), (2, 1), (0, 2), (2, 2)],
}

# Supersample, then shrink: the only way to get a clean round pip edge out of PIL.
SS = 4
atlas = Image.new("RGBA", (s * 6, s), (0, 0, 0, 0))

for i, value in enumerate(range(1, 7)):
    face = Image.new("RGBA", (s * SS, s * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(face)
    n = s * SS
    r = n * 0.085          # pip radius
    for (gx, gy) in LAYOUT[value]:
        cx = n * (0.26 + 0.24 * gx)
        cy = n * (0.26 + 0.24 * gy)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(16, 12, 10, 255))

    face = face.resize((s, s), Image.LANCZOS)

    # A drilled pip has a soft dark rim: blur a copy and lay it underneath, so the edge
    # of the hole picks up shading rather than being a flat cut.
    rim = face.filter(ImageFilter.GaussianBlur(s * 0.012))
    out_face = Image.alpha_composite(rim, face)
    atlas.paste(out_face, (i * s, 0))

atlas.save(out, "PNG", optimize=True)
print(f"{atlas.size[0]}x{atlas.size[1]}")
`;
  return execFileSync(python(), ['-c', script, outPath, String(faceSize)],
    { encoding: 'utf8' }).trim();
}

/**
 * The card faces, drawn rather than generated.
 *
 * Same reasoning as the dice pips, only more so. A generative model cannot be relied on
 * to put exactly seven pips in the two-three-two arrangement a seven of spades has, and a
 * card whose pip count is wrong is not a stylish card, it is a card that says the wrong
 * thing — in a game where reading it correctly is the whole activity. So the arithmetic
 * places every pip and index, and the model only supplies the stock it is printed on.
 *
 * Output is one atlas: 8 ranks across by 4 suits down. The renderer picks a card by its
 * (rank, suit) offset, exactly as the dice pick a face out of their pip atlas.
 *
 * The deck is the Russian short deck both games use: 7 8 9 10 J Q K A in four suits.
 *
 * NOTE: no backticks anywhere below. This whole string is a JS template literal, and a
 * backtick inside it ends the string and turns the rest of the Python into JavaScript.
 */
function cards(outPath, cell = 256) {
  const script = `
import sys
from PIL import Image, ImageDraw, ImageFont

out, cell = sys.argv[1], int(sys.argv[2])

RANKS = ["7", "8", "9", "10", "J", "Q", "K", "A"]
SUITS = ["S", "C", "D", "H"]
RED = (168, 22, 41)
BLACK = (24, 20, 18)

# Where the pips sit, as fractions of the face. These are the standard arrangements every
# deck uses, written out because they are not derivable: a seven is not "a six plus one in
# the middle", it is its own layout.
COL_L, COL_M, COL_R = 0.30, 0.50, 0.70
def row(t): return 0.18 + t * 0.64

PIPS = {
    "7": [(COL_L, row(0)), (COL_R, row(0)), (COL_M, row(0.25)),
          (COL_L, row(0.5)), (COL_R, row(0.5)), (COL_L, row(1)), (COL_R, row(1))],
    "8": [(COL_L, row(0)), (COL_R, row(0)), (COL_M, row(0.25)),
          (COL_L, row(0.5)), (COL_R, row(0.5)), (COL_M, row(0.75)),
          (COL_L, row(1)), (COL_R, row(1))],
    "9": [(COL_L, row(0)), (COL_R, row(0)), (COL_L, row(0.33)), (COL_R, row(0.33)),
          (COL_M, row(0.5)),
          (COL_L, row(0.67)), (COL_R, row(0.67)), (COL_L, row(1)), (COL_R, row(1))],
    "10": [(COL_L, row(0)), (COL_R, row(0)), (COL_M, row(0.17)),
           (COL_L, row(0.33)), (COL_R, row(0.33)),
           (COL_L, row(0.67)), (COL_R, row(0.67)), (COL_M, row(0.83)),
           (COL_L, row(1)), (COL_R, row(1))],
    "A": [(COL_M, 0.5)],
}

def suit_path(d, cx, cy, r, colour, kind):
    """One pip, from primitives. No font: a glyph depends on what is installed."""
    if kind == "D":
        d.polygon([(cx, cy - r), (cx + r * 0.72, cy), (cx, cy + r), (cx - r * 0.72, cy)],
                  fill=colour)
        return
    if kind == "H":
        d.ellipse([cx - r * 0.78, cy - r * 0.9, cx - r * 0.02, cy + r * 0.05], fill=colour)
        d.ellipse([cx + r * 0.02, cy - r * 0.9, cx + r * 0.78, cy + r * 0.05], fill=colour)
        d.polygon([(cx - r * 0.78, cy - r * 0.28), (cx + r * 0.78, cy - r * 0.28),
                   (cx, cy + r)], fill=colour)
        return
    if kind == "S":
        # A spade is a heart upside down, with a stem.
        d.ellipse([cx - r * 0.78, cy - r * 0.05, cx - r * 0.02, cy + r * 0.85], fill=colour)
        d.ellipse([cx + r * 0.02, cy - r * 0.05, cx + r * 0.78, cy + r * 0.85], fill=colour)
        d.polygon([(cx - r * 0.78, cy + r * 0.28), (cx + r * 0.78, cy + r * 0.28),
                   (cx, cy - r)], fill=colour)
        d.polygon([(cx - r * 0.30, cy + r), (cx + r * 0.30, cy + r),
                   (cx + r * 0.10, cy + r * 0.45), (cx - r * 0.10, cy + r * 0.45)],
                  fill=colour)
        return
    lobe = r * 0.46
    d.ellipse([cx - lobe, cy - r * 0.92, cx + lobe, cy - r * 0.92 + lobe * 2], fill=colour)
    d.ellipse([cx - r * 0.92, cy - r * 0.10,
               cx - r * 0.92 + lobe * 2, cy - r * 0.10 + lobe * 2], fill=colour)
    d.ellipse([cx + r * 0.92 - lobe * 2, cy - r * 0.10,
               cx + r * 0.92, cy - r * 0.10 + lobe * 2], fill=colour)
    d.polygon([(cx - r * 0.32, cy + r), (cx + r * 0.32, cy + r),
               (cx + r * 0.10, cy + r * 0.30), (cx - r * 0.10, cy + r * 0.30)], fill=colour)

def court(d, w, h, colour):
    """
    A court card as a panel rather than a portrait.

    Drawing a credible Russian king at this size with primitives is not achievable, and a
    bad one is worse than none. A real court card is two rotationally symmetric halves
    anyway, so this is a bordered panel split down the middle. It reads as a court card at
    a glance, which is what the game needs of it.
    """
    m = w * 0.16
    d.rounded_rectangle([m, m, w - m, h - m], radius=w * 0.05, outline=colour,
                        width=max(2, int(w * 0.018)))
    d.rounded_rectangle([m * 1.35, m * 1.35, w - m * 1.35, h - m * 1.35],
                        radius=w * 0.04, outline=colour, width=max(1, int(w * 0.008)))
    d.line([m * 1.6, h / 2, w - m * 1.6, h / 2], fill=colour, width=max(1, int(w * 0.008)))

SS = 3
aw, ah = cell, int(cell * 1.4)
atlas = Image.new("RGBA", (aw * len(RANKS), ah * len(SUITS)), (0, 0, 0, 0))

def font_at(px):
    for name in ("georgia.ttf", "times.ttf", "arial.ttf", "DejaVuSerif.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except Exception:
            continue
    return ImageFont.load_default()

for si, suit in enumerate(SUITS):
    colour = RED if suit in ("D", "H") else BLACK
    for ri, rank in enumerate(RANKS):
        w, h = aw * SS, ah * SS
        face = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(face)

        # THE BODY FIRST, while d still refers to face.
        #
        # The first version drew the indices first, and each index composite rebinds face
        # to a NEW image. The ImageDraw handle taken beforehand kept pointing at the
        # original, so every pip drawn afterwards went onto an orphan nothing pasted. The
        # deck came out with corner indices and blank middles. Drawing the body before any
        # compositing removes the hazard instead of working around it.
        if rank in ("J", "Q", "K"):
            court(d, w, h, colour)
            fb = font_at(int(cell * 0.62) * SS)
            bbox = d.textbbox((0, 0), rank, font=fb)
            d.text(((w - (bbox[2] - bbox[0])) / 2, (h - (bbox[3] - bbox[1])) / 2 - h * 0.06),
                   rank, font=fb, fill=colour)
        else:
            r = w * 0.085
            for (fx, fy) in PIPS[rank]:
                cx, cy = w * fx, h * fy
                suit_path(d, cx, cy, w * 0.20 if rank == "A" else r, colour, suit)

        # Then the index, top-left and again bottom-right upside down.
        f = font_at(int(cell * 0.24) * SS)
        for corner in (0, 1):
            layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            dl = ImageDraw.Draw(layer)
            dl.text((w * 0.07, h * 0.035), rank, font=f, fill=colour)
            suit_path(dl, w * 0.115, h * 0.175, w * 0.040, colour, suit)
            if corner:
                layer = layer.rotate(180)
            face = Image.alpha_composite(face, layer)

        face = face.resize((aw, ah), Image.LANCZOS)
        atlas.paste(face, (ri * aw, si * ah))

atlas.save(out, "PNG", optimize=True)
print(str(atlas.size[0]) + "x" + str(atlas.size[1]))
`;
  return execFileSync(python(), ['-c', script, outPath, String(cell)],
    { encoding: 'utf8' }).trim();
}

async function main() {
  const args = process.argv.slice(2);
  const go = args.includes('--yes');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

  const wanted = only ? { [only]: MATERIALS[only] } : MATERIALS;
  if (only && !MATERIALS[only]) {
    console.log(`  unknown material "${only}"; pick one of ${Object.keys(MATERIALS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const out = path.join(path.resolve(__dirname, '..'), 'public', 'textures');
  console.log('');
  console.log(`  model     ${MODEL}`);
  console.log(`  comfyui   ${HOST}`);
  console.log(`  size      ${SIZE} rendered, ${OUT_EDGE} shipped`);
  console.log(`  into      ${out}`);
  console.log('');
  for (const [name, m] of Object.entries(wanted)) {
    console.log(`  ${name.padEnd(9)} ${m.file.padEnd(14)} ${m.note}`);
  }
  console.log(`  pips      dice-pips      drawn, not generated — six faces, exact layout`);
  console.log('');

  if (!go) {
    console.log('  Nothing was rendered. Re-run with --yes.\n');
    return;
  }

  try {
    await api('/system_stats');
  } catch {
    console.log(`  Cannot reach ComfyUI at ${HOST}.`);
    console.log('  Start it first: the desktop shortcut, or D:\\ai\\comfyui\\start-comfyui.bat\n');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(out, { recursive: true });
  const raw = path.join(path.resolve(__dirname, '..'), 'export', 'materials-png');
  fs.mkdirSync(raw, { recursive: true });

  // The pips first: they need no GPU and prove the Python side works before spending
  // four minutes of rendering to find out it does not.
  process.stdout.write('  cards     ');
  try {
    console.log(`ok  ${cards(path.join(out, 'card-faces.png'))}`);
  } catch (e) {
    console.log('FAILED  ' + String(e.message).split('\n')[0]);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('  pips      ');
  try {
    const size = pips(path.join(out, 'dice-pips.png'));
    console.log(`ok  ${size}`);
  } catch (e) {
    console.log(`FAILED  ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
    return;
  }

  let made = 0;
  for (const [name, m] of Object.entries(wanted)) {
    const seed = crypto.randomInt(0, 2 ** 31);
    process.stdout.write(`  ${name.padEnd(9)} `);
    try {
      const img = await run(m.prompt, seed);
      const png = path.join(raw, `${m.file}.png`);
      await fetchImage(img, png);
      const size = process_(png,
        path.join(out, `${m.file}.jpg`),
        path.join(out, `${m.file}-rough.jpg`));
      const kb = Math.round(fs.statSync(path.join(out, `${m.file}.jpg`)).size / 1024);
      console.log(`ok  ${size}  ${kb}KB  seed ${seed}`);
      made += 1;
    } catch (e) {
      console.log(`FAILED  ${e.message.split('\n')[0]}`);
    }
  }

  console.log('');
  console.log(`  ${made} of ${Object.keys(wanted).length} material(s) rendered into public/textures/`);
  console.log('  The PNGs are kept in export/materials-png/ if one needs redoing.\n');
}

main().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
});
