'use strict';
// The ComfyUI plumbing every generator shares.
//
// tools/generate-materials.js grew this first, for the dice, the felt and the cards. When
// the arcade needed pictures too (tools/generate-invaders.js) the choice was a second copy
// or one module, and a second copy of a queue, poll and fetch loop is how two tools drift
// apart on the day the ComfyUI API changes. So it lives here and both import it.
//
// Everything runs on 127.0.0.1. Nothing is uploaded, and nothing is downloaded but the
// images this asks for.

const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
const COMFY = process.env.COMFY_DIR || 'D:\\ai\\comfyui';

// Juggernaut is the photoreal checkpoint of the two installed; the anime one is for the
// jigsaw pictures and would give a die a cel-shaded surface.
const MODEL = process.env.COMFY_MODEL || 'juggernaut-xl-v9.safetensors';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, options) {
  const res = await fetch(`${HOST}${pathname}`, options);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${res.statusText}`);
  return res;
}

/**
 * One SDXL text-to-image graph, in ComfyUI's API format.
 *
 * The defaults are the material settings — 1024 square, 36 steps, cfg 4.5 — because a
 * material is judged close up and on a curved surface, where the mush a low step count
 * leaves is obvious. A caller with a different subject overrides what it needs and keeps
 * the rest.
 */
function workflow(positive, seed, {
  negative = '', size = 1024, steps = 36, cfg = 4.5, prefix = 'casino', model = MODEL,
} = {}) {
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    5: {
      class_type: 'EmptyLatentImage',
      inputs: { width: size, height: size, batch_size: 1 },
    },
    6: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
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
    9: { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['8', 0] } },
  };
}

/** Queue one prompt and wait for its first image. Up to fifteen minutes, polled each second. */
async function run(positive, seed, opts = {}) {
  const body = JSON.stringify({
    prompt: workflow(positive, seed, opts), client_id: opts.client || 'casino',
  });
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

/** Pull a finished image down to a local path. */
async function fetchImage(img, to) {
  const q = new URLSearchParams({
    filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output',
  });
  fs.writeFileSync(to, Buffer.from(await (await api(`/view?${q}`)).arrayBuffer()));
}

/** ComfyUI's own Python, which has Pillow. The system one may not. */
function python() {
  const py = path.join(COMFY, 'venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(py)) {
    throw new Error(`no python at ${py} — is ComfyUI installed at ${COMFY}?`);
  }
  return py;
}

module.exports = { HOST, COMFY, MODEL, sleep, api, workflow, run, fetchImage, python };
