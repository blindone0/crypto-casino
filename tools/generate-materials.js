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

/**
 * The roughness maps get their own, lower quality, and they are the larger files.
 *
 * A roughness map here is built from local contrast — a blur subtracted from the image,
 * auto-contrasted. That is a high-frequency noise field, which is the worst possible
 * input for JPEG: there is no smooth area for the DCT to spend few bits on, so at q88 a
 * single-channel 512x512 map cost MORE than the full-colour map beside it. dice-bone was
 * 104KB of roughness against 37KB of colour.
 *
 * The detail is also the part nobody looks at. The map is blended 0.55 into a mid grey
 * and then only modulates a specular term, so an error in it moves a highlight slightly
 * rather than changing anything anyone can point at. Measured across all six maps, q70
 * shifts the specular response by under 8/255 and at 2x zoom is indistinguishable from
 * q88 — while cutting the six from 686KB to 400KB.
 *
 * q55 would save another 49KB and still looked fine, but the margin over "fine" is worth
 * more than the bytes on a file this small.
 */
const ROUGH_QUALITY = 70;

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

src, colour_out, rough_out, edge, q, rough_q = sys.argv[1:7]
edge, q, rough_q = int(edge), int(q), int(rough_q)

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
# Its own quality: see ROUGH_QUALITY above for why this is not q.
rough.save(rough_out, "JPEG", quality=rough_q, optimize=True)

print(f"{tiled.size[0]}x{tiled.size[1]}")
`;
  return execFileSync(python(), ['-c', script, pngPath, colourOut, roughOut,
    String(OUT_EDGE), String(JPEG_QUALITY), String(ROUGH_QUALITY)],
    { encoding: 'utf8' }).trim();
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
 * The chess pieces, drawn rather than typed.
 *
 * They were Unicode glyphs, which meant each piece was whatever shape the player's font
 * happened to have: a colour emoji on some phones, a box on Linux, and a different set
 * on every machine. Worse, GLYPHS mixed the two Unicode series — white used the OUTLINED
 * codepoints and black the FILLED ones — while the stylesheet comment beside it claimed
 * both were filled. The comment described an intention the data did not implement.
 *
 * These are six silhouettes, each rendered twice: ivory on the top row, ebony beneath.
 * The shading is a relief rather than a ray trace — blur the mask, offset a copy toward
 * the key light, difference the two — which is enough to read as a turned piece at the
 * forty-four pixels a board square actually gets, and a great deal less code than tracing
 * a lathe profile would be. Every piece stands on the same foot, because that is what
 * makes a set look like a set rather than six unrelated objects.
 *
 * Output is one atlas, six across by two down, in the order k q r b n p.
 *
 * NOTE: no backticks anywhere below. This whole string is a JS template literal, and a
 * backtick inside it ends the string and turns the rest of the Python into JavaScript.
 */
function chessPieces(outPath, cell = 128) {
  const script = `
import math
import sys
from PIL import Image, ImageDraw, ImageFilter

out, s = sys.argv[1], int(sys.argv[2])

SS = 4                       # supersample: the silhouettes are all curves
N = s * SS

# The same key light as every other rendered asset (KEY_DIR in gl.js), so a knight and a
# die are lit by the same lamp. Only the horizontal part matters for a 2D relief.
LX, LY = -0.42, -0.76        # y is down in image space, so the light is up and left

WHITE = (238, 230, 214)
BLACK = (28, 32, 40)

ORDER = ['k', 'q', 'r', 'b', 'n', 'p']


def shaded(mask, base, lift):
    """Turn a flat silhouette into a lit piece.

    The mask is the shape. Blurring it and subtracting gives a distance-like field that
    is bright in the middle and dark at the rim, which is enough to read as volume; the
    light direction comes from sampling that field offset against itself. This is a
    relief, not a ray trace — a chess piece at 44 pixels does not need one, and a real
    trace of a turned bishop would cost more code than the whole board.
    """
    inner = mask.filter(ImageFilter.GaussianBlur(N * 0.030))
    # Offset the blur toward the light and difference it: where the piece falls away from
    # the lamp the offset copy is brighter, which is exactly the shading term.
    dx, dy = int(LX * N * 0.026), int(LY * N * 0.026)
    lit = Image.new('L', mask.size, 0)
    lit.paste(inner, (dx, dy))

    px_m, px_i, px_l = mask.load(), inner.load(), lit.load()
    img = Image.new('RGBA', mask.size, (0, 0, 0, 0))
    px = img.load()
    w, h = mask.size
    for y in range(h):
        for x in range(w):
            a = px_m[x, y]
            if not a:
                continue
            # Body shading: the difference gives the lit side, the inner blur gives the
            # sense of thickness away from the outline.
            face = (px_l[x, y] - px_i[x, y]) / 255.0          # -1..1, lit side positive
            core = px_i[x, y] / 255.0
            v = 0.62 + 0.55 * face + 0.30 * core
            col = [int(max(0, min(255, c * v + lift * 255 * max(0.0, face)))) for c in base]
            px[x, y] = (col[0], col[1], col[2], a)
    return img


def outline(img, mask, colour, width):
    """A rim the opposite value of the body, so a black king reads on a dark square."""
    grown = mask.filter(ImageFilter.MaxFilter(width if width % 2 else width + 1))
    ring = Image.new('RGBA', img.size, (0, 0, 0, 0))
    rp, gp = ring.load(), grown.load()
    mp = mask.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            if gp[x, y] and not mp[x, y]:
                rp[x, y] = (colour[0], colour[1], colour[2], gp[x, y])
    return Image.alpha_composite(ring, img)


def base_shape(d, cx, w, bottom):
    """Every piece stands on the same foot, which is what makes a set look like a set."""
    fw = w * 0.92
    d.rounded_rectangle([cx - fw / 2, bottom - w * 0.20, cx + fw / 2, bottom],
                        radius=w * 0.07, fill=255)
    d.polygon([(cx - fw * 0.40, bottom - w * 0.20), (cx + fw * 0.40, bottom - w * 0.20),
               (cx + fw * 0.30, bottom - w * 0.34), (cx - fw * 0.30, bottom - w * 0.34)],
              fill=255)


def collar(d, cx, y, w):
    d.rounded_rectangle([cx - w * 0.30, y, cx + w * 0.30, y + w * 0.09],
                        radius=w * 0.04, fill=255)


def draw_piece(kind):
    """The silhouette of one piece, in a mask the size of one cell."""
    m = Image.new('L', (N, N), 0)
    d = ImageDraw.Draw(m)
    cx = N * 0.5
    w = N * 0.62                 # nominal piece width
    bottom = N * 0.90

    if kind == 'p':              # pawn
        base_shape(d, cx, w * 0.78, bottom)
        d.polygon([(cx - w * 0.17, bottom - w * 0.34), (cx + w * 0.17, bottom - w * 0.34),
                   (cx + w * 0.11, N * 0.44), (cx - w * 0.11, N * 0.44)], fill=255)
        d.ellipse([cx - w * 0.21, N * 0.26, cx + w * 0.21, N * 0.26 + w * 0.42], fill=255)

    elif kind == 'r':            # rook
        base_shape(d, cx, w * 0.92, bottom)
        d.polygon([(cx - w * 0.30, bottom - w * 0.34), (cx + w * 0.30, bottom - w * 0.34),
                   (cx + w * 0.26, N * 0.42), (cx - w * 0.26, N * 0.42)], fill=255)
        collar(d, cx, N * 0.38, w)
        # Battlements: three merlons with two gaps.
        top, hgt = N * 0.24, N * 0.14
        d.rectangle([cx - w * 0.40, top, cx + w * 0.40, top + hgt], fill=255)
        for gx in (-0.17, 0.17):
            d.rectangle([cx + w * gx - w * 0.06, top, cx + w * gx + w * 0.06, top + hgt * 0.55],
                        fill=0)

    elif kind == 'b':            # bishop
        base_shape(d, cx, w * 0.82, bottom)
        d.polygon([(cx - w * 0.22, bottom - w * 0.34), (cx + w * 0.22, bottom - w * 0.34),
                   (cx + w * 0.14, N * 0.48), (cx - w * 0.14, N * 0.48)], fill=255)
        collar(d, cx, N * 0.44, w * 0.8)
        # The mitre: a teardrop.
        d.ellipse([cx - w * 0.24, N * 0.24, cx + w * 0.24, N * 0.24 + w * 0.46], fill=255)
        d.polygon([(cx, N * 0.16), (cx - w * 0.15, N * 0.34), (cx + w * 0.15, N * 0.34)], fill=255)
        d.ellipse([cx - w * 0.05, N * 0.12, cx + w * 0.05, N * 0.12 + w * 0.10], fill=255)
        # The slit every bishop has.
        d.line([(cx + w * 0.02, N * 0.26), (cx + w * 0.13, N * 0.37)], fill=0, width=int(N * 0.018))

    elif kind == 'n':            # knight
        base_shape(d, cx, w * 0.86, bottom)
        # A horse head in profile, facing right. Points, not curves: a knight is the one
        # piece whose silhouette people actually recognise, so it is drawn explicitly.
        head = [
            (cx - w * 0.26, bottom - w * 0.32),
            (cx - w * 0.22, N * 0.56),
            (cx - w * 0.30, N * 0.42),
            (cx - w * 0.20, N * 0.26),
            (cx - w * 0.02, N * 0.16),
            (cx + w * 0.10, N * 0.14),
            (cx + w * 0.07, N * 0.23),
            (cx + w * 0.22, N * 0.20),
            (cx + w * 0.34, N * 0.33),
            (cx + w * 0.30, N * 0.47),
            (cx + w * 0.14, N * 0.56),
            (cx + w * 0.20, bottom - w * 0.32),
        ]
        d.polygon(head, fill=255)
        # The ear notch and the eye.
        d.polygon([(cx + w * 0.08, N * 0.17), (cx + w * 0.13, N * 0.10), (cx + w * 0.16, N * 0.20)],
                  fill=255)
        d.ellipse([cx + w * 0.06, N * 0.27, cx + w * 0.12, N * 0.33], fill=0)

    elif kind == 'q':            # queen
        base_shape(d, cx, w * 0.94, bottom)
        d.polygon([(cx - w * 0.28, bottom - w * 0.34), (cx + w * 0.28, bottom - w * 0.34),
                   (cx + w * 0.20, N * 0.44), (cx - w * 0.20, N * 0.44)], fill=255)
        collar(d, cx, N * 0.40, w)
        # A five-point coronet: the points are circles on the tips, the classic shape.
        top = N * 0.30
        d.polygon([(cx - w * 0.40, top), (cx + w * 0.40, top),
                   (cx + w * 0.30, N * 0.42), (cx - w * 0.30, N * 0.42)], fill=255)
        for i in range(5):
            f = (i - 2) / 2.0
            px_ = cx + f * w * 0.34
            py_ = top - (N * 0.10) * (1.0 - abs(f) * 0.45)
            d.polygon([(px_ - w * 0.07, top), (px_ + w * 0.07, top), (px_, py_)], fill=255)
            d.ellipse([px_ - w * 0.055, py_ - w * 0.055, px_ + w * 0.055, py_ + w * 0.055], fill=255)

    else:                        # king
        base_shape(d, cx, w * 0.94, bottom)
        d.polygon([(cx - w * 0.28, bottom - w * 0.34), (cx + w * 0.28, bottom - w * 0.34),
                   (cx + w * 0.20, N * 0.44), (cx - w * 0.20, N * 0.44)], fill=255)
        collar(d, cx, N * 0.40, w)
        top = N * 0.28
        d.polygon([(cx - w * 0.38, top), (cx + w * 0.38, top),
                   (cx + w * 0.28, N * 0.42), (cx - w * 0.28, N * 0.42)], fill=255)
        # The cross that says king and nothing else does.
        bar = N * 0.030
        d.rectangle([cx - bar, N * 0.10, cx + bar, top], fill=255)
        d.rectangle([cx - w * 0.15, N * 0.155, cx + w * 0.15, N * 0.155 + bar * 2], fill=255)

    return m


# Two rows: white on top, black beneath, six pieces across in ORDER.
atlas = Image.new('RGBA', (s * 6, s * 2), (0, 0, 0, 0))

for row, (base, rim, lift) in enumerate((
        (WHITE, (40, 34, 28), 0.00),
        (BLACK, (214, 206, 190), 0.18))):
    for col, kind in enumerate(ORDER):
        mask = draw_piece(kind)
        body = shaded(mask, base, lift)
        body = outline(body, mask, rim, int(N * 0.012) | 1)
        small = body.resize((s, s), Image.LANCZOS)

        # A contact shadow, so a piece sits on its square instead of floating.
        blurred = small.filter(ImageFilter.GaussianBlur(s * 0.028))
        black_ch = Image.new('L', blurred.size, 0)
        shadow = Image.merge('RGBA', (black_ch, black_ch, black_ch,
                                      blurred.split()[3].point(lambda v: int(v * 0.42))))
        cell = Image.alpha_composite(shadow, small)
        atlas.paste(cell, (col * s, row * s))

atlas.save(out, 'PNG', optimize=True)
print(str(atlas.size[0]) + 'x' + str(atlas.size[1]))
`;
  return execFileSync(python(), ['-c', script, outPath, String(cell)],
    { encoding: 'utf8' }).trim();
}

/**
 * The Мины gem and bomb, ray traced rather than generated.
 *
 * Same reasoning as the dice pips and the card faces: a model cannot be relied on to
 * produce two icons that read instantly at forty pixels and sit on the same light. These
 * are two shapes with known geometry, so the arithmetic does them.
 *
 * The gem is a brilliant cut seen face on — a flat octagonal table ringed by facets whose
 * normals tilt outward. Each facet is a plane, so its normal is constant across it, and
 * alternating facets are darkened: that alternation is what makes a cut read as cut
 * rather than as a blurry ball.
 *
 * The bomb is an actual ray traced sphere: solve for the front surface, take the normal
 * from the hit point. The fuse is stamped as discs of shrinking radius so it tapers
 * without a polygon path, and the spark at its tip is two gaussians, a hot core inside a
 * wide halo, on its own layer.
 *
 * Both are lit by KEY_DIR from gl.js, normalised [-0.45, 1.0, 0.55], so a gem on the
 * board and a die on the felt are lit by the same lamp.
 *
 * Output is one atlas, two cells wide: gem at x=0, bomb at x=size.
 *
 * NOTE: no backticks anywhere below. This whole string is a JS template literal, and a
 * backtick inside it ends the string and turns the rest of the Python into JavaScript.
 * test/gl.test.js guards this for the renderers; this file is checked by eye.
 */
function mineIcons(outPath, cell = 256) {
  const script = `
import math
import sys
from PIL import Image, ImageFilter

out, s = sys.argv[1], int(sys.argv[2])

SS = 2                      # supersample; the ray march is the expensive part
N = s * SS

# The same key light the WebGL renderers use, so the board agrees with the felt.
KX, KY, KZ = -0.45, 1.0, 0.55
kl = math.sqrt(KX * KX + KY * KY + KZ * KZ)
KX, KY, KZ = KX / kl, KY / kl, KZ / kl

def norm3(x, y, z):
    l = math.sqrt(x * x + y * y + z * z) or 1.0
    return x / l, y / l, z / l

def clamp(v, a, b):
    return a if v < a else (b if v > b else v)

def shade(nx, ny, nz, base, spec_power, spec_amt, rim_amt):
    # Lambert plus a Blinn-Phong highlight, with a rim term so the silhouette reads
    # against a dark tile without needing an outline.
    lam = max(0.0, nx * KX + ny * KY + nz * KZ)
    # The viewer is straight on, so the half vector is the key plus (0,0,1).
    hx, hy, hz = norm3(KX, KY, KZ + 1.0)
    spec = max(0.0, nx * hx + ny * hy + nz * hz) ** spec_power
    rim = (1.0 - max(0.0, nz)) ** 2.5
    res = []
    for c in base:
        v = c * (0.22 + 0.78 * lam) + 255.0 * spec * spec_amt + 90.0 * rim * rim_amt
        res.append(int(clamp(v, 0, 255)))
    return (res[0], res[1], res[2])

# ---------------------------------------------------------------- the gem
#
# A brilliant cut seen face on: an octagonal table surrounded by facets. Each facet is a
# flat plane, so its normal is constant across it and the gem reads as cut stone rather
# than a blurry ball. Facet normals tilt outward from the centre by a fixed angle.

GEM_RGB = (150, 250, 226)       # paler than the tile it sits on, deliberately
FACETS = 8
TABLE_R = 0.34                  # where the flat top ends
EDGE_R = 0.92                   # the outer silhouette

gem = Image.new("RGBA", (N, N), (0, 0, 0, 0))
gp = gem.load()

for py in range(N):
    for px in range(N):
        # To -1..1, y up.
        x = (px + 0.5) / N * 2.0 - 1.0
        y = 1.0 - (py + 0.5) / N * 2.0
        r = math.sqrt(x * x + y * y)
        if r > EDGE_R:
            continue

        a = math.atan2(y, x)
        # Which facet this pixel belongs to, and the angle to that facet's centre.
        seg = int(math.floor((a + math.pi) / (2 * math.pi) * FACETS))
        mid = -math.pi + (seg + 0.5) * (2 * math.pi / FACETS)

        if r < TABLE_R:
            nx, ny, nz = 0.0, 0.0, 1.0          # the flat table
            base = [c * 1.0 for c in GEM_RGB]
        else:
            # Tilt outward: further from the table means a steeper facet.
            t = (r - TABLE_R) / (EDGE_R - TABLE_R)
            tilt = 0.30 + 0.85 * t
            nx, ny, nz = norm3(math.cos(mid) * tilt, math.sin(mid) * tilt, 1.0)
            # Alternate facets slightly darker: this is what makes a cut read as cut.
            base = [c * (0.52 if seg % 2 else 0.92) for c in GEM_RGB]

        col = shade(nx, ny, nz, base, 16.0, 0.55, 0.30)
        # A dark rim in the last few percent of the radius. Without it a pale green
        # stone on a green tile has no silhouette, and the facets read as noise.
        band = clamp((r - EDGE_R * 0.86) / (EDGE_R * 0.14), 0.0, 1.0)
        dark = 1.0 - 0.55 * band
        col = (int(col[0] * dark), int(col[1] * dark), int(col[2] * dark))
        # Antialias the silhouette by fading the outermost sliver of the radius.
        edge = clamp((EDGE_R - r) / (EDGE_R * 0.015), 0.0, 1.0)
        gp[px, py] = (col[0], col[1], col[2], int(255 * edge))

# --------------------------------------------------------------- the bomb
#
# A sphere, ray traced properly: solve for the front surface, take the normal from the
# hit point. Plus a fuse, and the specular dot that makes a sphere look polished.

BOMB_RGB = (58, 54, 60)
BR = 0.74

bomb = Image.new("RGBA", (N, N), (0, 0, 0, 0))
bp = bomb.load()

for py in range(N):
    for px in range(N):
        x = (px + 0.5) / N * 2.0 - 1.0
        y = 1.0 - (py + 0.5) / N * 2.0
        # Sit the body slightly low, leaving room for the fuse.
        cy = y + 0.10
        d2 = x * x + cy * cy
        if d2 > BR * BR:
            continue
        z = math.sqrt(BR * BR - d2)
        nx, ny, nz = x / BR, cy / BR, z / BR
        col = shade(nx, ny, nz, BOMB_RGB, 28.0, 0.70, 0.75)
        edge = clamp((BR - math.sqrt(d2)) / (BR * 0.02), 0.0, 1.0)
        bp[px, py] = (col[0], col[1], col[2], int(255 * edge))

# The fuse: a short curved taper out of the top right, stamped as discs so it narrows
# smoothly without needing a polygon path.
fuse = Image.new("RGBA", (N, N), (0, 0, 0, 0))
fd = fuse.load()
steps = 90
for i in range(steps + 1):
    t = i / steps
    fx = 0.30 + 0.34 * t + 0.10 * math.sin(t * 2.6)
    fy = 0.52 + 0.40 * t
    rad = (0.055 * (1.0 - 0.45 * t)) * N
    cxp = (fx + 1.0) * 0.5 * N
    cyp = (1.0 - fy) * 0.5 * N
    tone = 150 - int(40 * t)
    ri = int(rad)
    for oy in range(-ri, ri + 1):
        for ox in range(-ri, ri + 1):
            if ox * ox + oy * oy > rad * rad:
                continue
            qx, qy = int(cxp + ox), int(cyp + oy)
            if 0 <= qx < N and 0 <= qy < N:
                # Light the cord from the same side as everything else.
                lit = clamp(0.5 - (oy / rad) * 0.5, 0.0, 1.0)
                v = int(tone * (0.55 + 0.75 * lit))
                fd[qx, qy] = (v, int(v * 0.82), int(v * 0.6), 255)

# A spark at the fuse tip.
#
# Drawn into its OWN layer rather than into the fuse: composited into the cord it was
# competing with the cord's own opaque alpha, and a spark that cannot brighten what is
# under it is just a pale dot. This layer is added on top of the finished bomb.
t_end = 1.0
tipx = ((0.30 + 0.34 * t_end + 0.10 * math.sin(t_end * 2.6)) + 1.0) * 0.5 * N
tipy = (1.0 - (0.52 + 0.40 * t_end)) * 0.5 * N

spark = Image.new("RGBA", (N, N), (0, 0, 0, 0))
sp = spark.load()
spark_r = 0.11 * N
span = int(spark_r * 2.4)
for oy in range(-span, span + 1):
    for ox in range(-span, span + 1):
        dd = math.sqrt(ox * ox + oy * oy)
        qx, qy = int(tipx + ox), int(tipy + oy)
        if not (0 <= qx < N and 0 <= qy < N):
            continue
        # A hot core with a wide soft falloff, which is what a burning tip looks like:
        # two gaussians rather than one, so it does not read as a flat disc.
        # Clip to a circle first. Without this the square iteration window leaves a
        # visible rectangular block wherever the gaussian is still above the cutoff at
        # the corners — which it is, because a gaussian never actually reaches zero.
        reach = spark_r * 2.4
        if dd > reach:
            continue
        core = math.exp(-(dd / (spark_r * 0.42)) ** 2)
        halo = math.exp(-(dd / (spark_r * 1.5)) ** 2)
        f = clamp(core + halo * 0.55, 0.0, 1.0)
        # And taper the last stretch to zero, so the circle's own edge is not a step.
        f *= clamp((reach - dd) / (reach * 0.35), 0.0, 1.0)
        if f <= 0.004:
            continue
        sp[qx, qy] = (
            int(clamp(255 * f, 0, 255)),
            int(clamp((150 + 105 * core) * f, 0, 255)),
            int(clamp(70 * f * f, 0, 255)),
            int(clamp(255 * f, 0, 255)),
        )

bomb = Image.alpha_composite(bomb, fuse)
bomb = Image.alpha_composite(bomb, spark)

# Down to final size, and a soft contact shadow under each so they sit on the tile
# rather than floating above it.
atlas = Image.new("RGBA", (s * 2, s), (0, 0, 0, 0))
for i, img in enumerate((gem, bomb)):
    small = img.resize((s, s), Image.LANCZOS)
    blurred = small.filter(ImageFilter.GaussianBlur(s * 0.035))
    black = Image.new("L", blurred.size, 0)
    shadow = Image.merge("RGBA", (
        black, black, black,
        blurred.split()[3].point(lambda v: int(v * 0.45))))
    atlas.paste(Image.alpha_composite(shadow, small), (i * s, 0))

atlas.save(out, "PNG", optimize=True)
print(str(atlas.size[0]) + "x" + str(atlas.size[1]))
`;
  return execFileSync(python(), ['-c', script, outPath, String(cell)],
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
        f = font_at(int(cell * 0.19) * SS)
        for corner in (0, 1):
            layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            dl = ImageDraw.Draw(layer)
            dl.text((w * 0.045, h * 0.018), rank, font=f, fill=colour)
            suit_path(dl, w * 0.088, h * 0.142, w * 0.034, colour, suit)
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
  console.log('  mines     mine-icons     drawn, not generated — a cut gem and a lit bomb');
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

  process.stdout.write('  mines     ');
  try {
    const size = mineIcons(path.join(out, 'mine-icons.png'));
    console.log('ok  ' + size);
  } catch (e) {
    // fromCharCode(10) rather than a backslash-n: this file is edited through layers
    // that eat escapes, and a literal newline inside a string is a parse error.
    console.log('FAILED  ' + String(e.message).split(String.fromCharCode(10))[0]);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('  chess     ');
  try {
    const size = chessPieces(path.join(out, 'chess-pieces.png'));
    console.log('ok  ' + size);
  } catch (e) {
    console.log('FAILED  ' + String(e.message).split(String.fromCharCode(10))[0]);
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
