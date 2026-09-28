'use strict';
// Drive ComfyUI from a file of prompts and turn the output into puzzle pictures.
//
//   node tools/generate-pictures.js prompts.txt            what it would do
//   node tools/generate-pictures.js prompts.txt --yes      generate
//   node tools/generate-pictures.js prompts.txt --yes --each 4
//
// The prompts file is yours. One prompt per line; blank lines and lines starting with #
// are ignored. A line beginning with `!` sets the negative prompt for everything after
// it. No prompt text is written into this file — it reads what you wrote and passes it
// to the model unchanged.
//
// Why this exists: the puzzle wants a pool, not a picture. Fifty images through the web
// interface is fifty rounds of clicking, and each one then has to be converted out of PNG
// by hand because the importer will not take a 3MB file. This does the whole loop.
//
// It talks only to ComfyUI on 127.0.0.1. Nothing is uploaded anywhere.
//
// Start ComfyUI first — the desktop shortcut, or D:\ai\comfyui\start-comfyui.bat.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HOST = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
const COMFY = process.env.COMFY_DIR || 'D:\\ai\\comfyui';
const MODEL = process.env.COMFY_MODEL || 'animagine-xl-4.0.safetensors';

// The importer's ceiling is 900KB. Aim well under it: JPEG size swings a lot with how
// busy a picture is, and a busy picture is exactly what a jigsaw wants.
const TARGET_LONG_EDGE = 1024;
const JPEG_QUALITY = 85;

/**
 * One SDXL text-to-image graph in ComfyUI's API format.
 *
 * The same nodes the default workflow wires up in the interface: load the checkpoint,
 * encode both prompts, make an empty latent, sample, decode, save.
 */
function workflow(positive, negative, seed, batch) {
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: MODEL } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: batch } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: 28,
        cfg: 5,
        sampler_name: 'euler_ancestral',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'puzzle', images: ['8', 0] } },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, options) {
  const res = await fetch(`${HOST}${pathname}`, options);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${res.statusText}`);
  return res;
}

/** Queue one graph and wait for the images it produced. */
async function run(positive, negative, seed, batch) {
  const body = JSON.stringify({
    prompt: workflow(positive, negative, seed, batch), client_id: 'casino',
  });
  const queued = await (await api('/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })).json();
  const id = queued.prompt_id;

  // Polling rather than a websocket: this is a batch job, not a progress bar, and one
  // fewer moving part is worth more than knowing the percentage.
  for (let i = 0; i < 1800; i += 1) {
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
    if (images.length) return images;
  }
  throw new Error('timed out waiting for ComfyUI');
}

async function fetchImage(img, to) {
  const q = new URLSearchParams({
    filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output',
  });
  fs.writeFileSync(to, Buffer.from(await (await api(`/view?${q}`)).arrayBuffer()));
}

/**
 * PNG to JPEG, resized to fit.
 *
 * Node has no image codec, and this project has no npm dependencies and is not getting
 * any. ComfyUI's own virtual environment has Pillow, which is already on the disk for
 * exactly this sort of work, so the conversion runs there.
 */
function toJpeg(pngPath, jpgPath) {
  const py = path.join(COMFY, 'venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(py)) {
    throw new Error(`no python at ${py} — is ComfyUI installed at ${COMFY}?`);
  }
  const script = [
    'import sys',
    'from PIL import Image',
    'src, dst, edge, q = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])',
    'im = Image.open(src).convert("RGB")',
    'im.thumbnail((edge, edge), Image.LANCZOS)',
    'im.save(dst, "JPEG", quality=q, optimize=True)',
  ].join('\n');
  execFileSync(py, ['-c', script, pngPath, jpgPath,
    String(TARGET_LONG_EDGE), String(JPEG_QUALITY)], { stdio: 'pipe' });
}

/** Read the prompt file: `#` comments, `!` sets the negative from there on. */
function readPrompts(file) {
  const out = [];
  let negative = '';
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('!')) { negative = t.slice(1).trim(); continue; }
    out.push({ positive: t, negative });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const go = args.includes('--yes');
  const each = Number(args[args.indexOf('--each') + 1]) || 2;
  // Different jobs want different folders: puzzle pictures and slot symbols should not
  // land in the same pile and then have to be told apart by eye.
  const outName = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'generated';

  if (!file || !fs.existsSync(file)) {
    console.log('Usage: node tools/generate-pictures.js <prompts.txt> [--yes] [--each N] [--out folder]');
    console.log('       one prompt per line; # comments; a !line sets the negative prompt');
    process.exitCode = 1;
    return;
  }

  const prompts = readPrompts(file);
  const out = path.join(path.resolve(__dirname, '..'), 'export', outName);
  console.log(`\n  ${prompts.length} prompt(s) x ${each} = ${prompts.length * each} picture(s)`);
  console.log(`  model     ${MODEL}`);
  console.log(`  comfyui   ${HOST}`);
  console.log(`  into      ${out}\n`);

  if (!go) {
    prompts.forEach((p, i) => console.log(`  ${String(i + 1).padStart(3)}. ${p.positive.slice(0, 92)}`));
    console.log('\n  Nothing was generated. Re-run with --yes.\n');
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
  const raw = path.join(out, '_png');
  fs.mkdirSync(raw, { recursive: true });

  let made = 0;
  for (const [i, p] of prompts.entries()) {
    const seed = crypto.randomInt(0, 2 ** 31);
    process.stdout.write(`  [${i + 1}/${prompts.length}] `);
    try {
      const images = await run(p.positive, p.negative, seed, each);
      for (const [n, img] of images.entries()) {
        const stem = `gen-${String(i + 1).padStart(3, '0')}-${n + 1}`;
        const png = path.join(raw, `${stem}.png`);
        const jpg = path.join(out, `${stem}.jpg`);
        await fetchImage(img, png);
        toJpeg(png, jpg);
        fs.unlinkSync(png);
        made += 1;
      }
      console.log(`${images.length} image(s)`);
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }

  fs.rmSync(raw, { recursive: true, force: true });
  console.log(`\n  ${made} picture(s) in ${out}`);
  console.log('  Look through them, delete the duds, then:');
  console.log(`    node tools/puzzle-import.js "${out}" --yes`);
  console.log('  and restart the casino server.\n');
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
