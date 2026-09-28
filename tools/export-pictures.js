'use strict';
// Write the drawn puzzle pictures out as standalone .svg files.
//
//   node tools/export-pictures.js            into export/pictures/
//   node tools/export-pictures.js <folder>   somewhere else
//
// The artwork lives in public/pictures.js as functions that build markup, which is right
// for the site and awkward for everything else: you cannot open it in an editor, drop it
// into a moodboard, or hand it to an image tool. This writes each one out as a file.
//
// Nothing is downloaded and nothing is sent anywhere. The pictures are original work, so
// they are yours to do what you like with.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const out = path.resolve(process.argv[2] || path.join(ROOT, 'export', 'pictures'));

  // public/ is ES modules and this package is CommonJS, so node decides by extension and
  // disagrees with the browser. Copying it to .mjs is the honest way round that.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pictures-'));
  const copy = path.join(tmp, 'pictures.mjs');
  fs.writeFileSync(copy, fs.readFileSync(path.join(ROOT, 'public', 'pictures.js')));

  try {
    const mod = await import(pathToFileURL(copy).href);
    fs.mkdirSync(out, { recursive: true });

    let total = 0;
    for (const key of mod.PICTURE_KEYS) {
      const svg = mod.pictureSvg(key).trim();
      const file = path.join(out, `${key}.svg`);
      fs.writeFileSync(file, svg);
      total += svg.length;
      console.log(`  ${key.padEnd(12)} ${String(Math.round(svg.length / 1024)).padStart(3)}KB  ${file}`);
    }
    console.log(`\n  ${mod.PICTURE_KEYS.length} picture(s), ${Math.round(total / 1024)}KB.`);
    console.log('  They are 120x120 vectors, so they scale to any size without going soft.\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
