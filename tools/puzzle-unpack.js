'use strict';
// Turn the base64 picture pack into plain .jpg files.
//
//   node tools/puzzle-unpack.js            what it would do
//   node tools/puzzle-unpack.js --yes      do it
//
// WHY
//
// `data/puzzle-pictures.json` holds 48 pictures as base64 data URIs: 8.1MB committed, for
// 6.1MB of actual JPEG. Base64 costs exactly a third, and that third is paid in the
// repository, in `.git` forever, and in memory every time the server parses the file.
//
// As files under `public/pictures/` the same pictures are:
//
//   - a third smaller, because they are bytes rather than base64 of bytes
//   - individually cacheable, so a returning player revalidates one with an ETag instead
//     of re-downloading it
//   - correctly skipped by the gzip layer, which compresses text and leaves already
//     compressed formats alone
//   - not parsed into memory at boot
//
// WHAT STAYS
//
// The JSON, reduced to a manifest: the keys and which file each one is, and nothing else.
// The pool must stay explicit and ordered, because `pictureFor` (src/pictures.js) indexes
// into it from the round seed — a pool that changed because someone dropped a file into a
// directory would change which picture a past round replays as, and replay is the point.
// A directory listing cannot promise that; a committed manifest can.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PACK = path.join(ROOT, 'data', 'puzzle-pictures.json');
const OUT = path.join(ROOT, 'public', 'pictures');

const EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

function main() {
  const go = process.argv.includes('--yes');

  if (!fs.existsSync(PACK)) {
    console.log(`\n  No pack at ${PACK}. Nothing to unpack.\n`);
    return;
  }

  const pack = JSON.parse(fs.readFileSync(PACK, 'utf8'));
  const entries = Object.entries(pack.pictures || {});
  if (!entries.length) {
    console.log('\n  The pack holds no pictures.\n');
    return;
  }

  // Already a manifest? Then this has been run before and there is nothing to do.
  if (entries.every(([, p]) => p.file && !p.data)) {
    console.log(`\n  Already unpacked: ${entries.length} pictures under public/pictures/.\n`);
    return;
  }

  const before = fs.statSync(PACK).size;
  let bytes = 0;
  for (const [, pic] of entries) {
    if (pic.data) bytes += Buffer.byteLength(pic.data, 'base64');
  }

  console.log('');
  console.log(`  pack        ${(before / 1048576).toFixed(1)}MB of base64`);
  console.log(`  pictures    ${entries.length}`);
  console.log(`  as files    ${(bytes / 1048576).toFixed(1)}MB  (base64 costs a third)`);
  console.log(`  into        ${OUT}`);
  console.log('');

  if (!go) {
    console.log('  Nothing was written. Re-run with --yes.\n');
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const manifest = { pictures: {} };
  let written = 0;

  for (const [key, pic] of entries) {
    const ext = EXT[pic.mime] || '.jpg';
    const file = `${key}${ext}`;
    if (pic.data) {
      fs.writeFileSync(path.join(OUT, file), Buffer.from(pic.data, 'base64'));
      written += 1;
    }
    // `name` is the original filename the importer saw; keeping it means the manifest
    // still says where a picture came from, which is the only provenance there is.
    manifest.pictures[key] = { name: pic.name, file, mime: pic.mime || 'image/jpeg' };
  }

  fs.writeFileSync(PACK, `${JSON.stringify(manifest, null, 2)}\n`);
  const after = fs.statSync(PACK).size;

  console.log(`  wrote ${written} file(s)`);
  console.log(`  manifest is now ${(after / 1024).toFixed(1)}KB, was ${(before / 1048576).toFixed(1)}MB`);
  console.log('');
  console.log('  The old 8MB blob stays in git history until that is rewritten.');
  console.log('  Restart the server: the pack is parsed once at first use.\n');
}

main();
