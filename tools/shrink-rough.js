'use strict';
// Re-encode the roughness maps at the quality they should have had.
//
//   node tools/shrink-rough.js          what it would do
//   node tools/shrink-rough.js --yes    do it
//
// WHY
//
// A roughness map here is local contrast: a blur subtracted from the colour map, then
// auto-contrasted. That is a high-frequency noise field, and noise is the worst possible
// input for JPEG — there is no smooth region for the DCT to spend few bits on. Saved at
// the same q88 as the colour maps, a single-channel 512x512 roughness map cost MORE than
// the full-colour map beside it: dice-bone was 104KB of roughness against 37KB of colour.
//
// tools/generate-materials.js now uses ROUGH_QUALITY for these, so anything generated
// from here on is already right. This is for the files already committed, which would
// otherwise need the whole RTX pipeline re-run to fix a compression setting.
//
// WHAT THIS IS NOT
//
// It does not change what the maps depict. Every pixel comes from the existing file,
// re-encoded — no blur, no resize, no regeneration. The artwork is untouched; only the
// number of bytes used to store it changes.
//
// Measured before writing this: at q70 the specular response moves by under 8/255 on
// every map, and at 2x zoom the result is indistinguishable from q88.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'public', 'textures');
const QUALITY = 70;

function python() {
  for (const c of ['python', 'python3', 'py']) {
    try { execFileSync(c, ['-c', 'import PIL'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  return null;
}

function main() {
  const go = process.argv.includes('--yes');
  const py = python();

  if (!py) {
    console.log('\n  Needs Python with Pillow, the same as tools/generate-materials.js.\n');
    process.exitCode = 1;
    return;
  }

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('-rough.jpg'));
  if (!files.length) {
    console.log('\n  No roughness maps found.\n');
    return;
  }

  // Ask Python what each would become, without writing anything.
  const script = `
import io, os, sys
from PIL import Image
q = int(sys.argv[1])
write = sys.argv[2] == 'write'
for p in sys.argv[3:]:
    im = Image.open(p)
    im.load()
    before = os.path.getsize(p)
    buf = io.BytesIO()
    # mode L already: these are single channel. convert() would be a no-op but is kept
    # honest in case a future map arrives as RGB.
    im.convert('L').save(buf, 'JPEG', quality=q, optimize=True)
    after = buf.tell()
    if write and after < before:
        open(p, 'wb').write(buf.getvalue())
    print('%s\t%d\t%d' % (os.path.basename(p), before, after))
`;

  const out = execFileSync(py, ['-c', script, String(QUALITY), go ? 'write' : 'dry',
    ...files.map((f) => path.join(DIR, f))], { encoding: 'utf8' }).trim();

  let before = 0;
  let after = 0;
  console.log(`\n  ${go ? 'Re-encoded' : 'Would re-encode'} at quality ${QUALITY}:\n`);
  for (const line of out.split('\n')) {
    const [name, b, a] = line.split('\t');
    before += Number(b);
    after += Number(a);
    console.log(`  ${name.padEnd(26)} ${(b / 1024).toFixed(1).padStart(7)}K -> ${(a / 1024).toFixed(1).padStart(7)}K`);
  }

  const pct = Math.round(100 - (after / before) * 100);
  console.log(`\n  ${(before / 1024).toFixed(1)}K -> ${(after / 1024).toFixed(1)}K  (${pct}% smaller)`);
  console.log(go
    ? '\n  Done. The pixels are the same; only the encoding changed.\n'
    : '\n  Nothing was written. Re-run with --yes.\n');
}

main();
