'use strict';
// Put your own pictures behind the puzzle.
//
// Drop image files in a folder, run this, and they become puzzle pictures alongside the
// drawn ones. Nothing is fetched and nothing is sent anywhere: the files are read off the
// disk, encoded, and written into the site's own data directory.
//
// What goes in the folder is entirely your decision and this tool does not look at it. It
// checks that a file is an image, that it is not too large to serve, and nothing else.
//
// Usage:
//   node tools/puzzle-import.js <folder>            see what would be imported
//   node tools/puzzle-import.js <folder> --yes      write it
//   node tools/puzzle-import.js --clear             remove every imported picture
//
// Notes on size. Each picture is inlined as a data URI, because the site runs under a
// Content-Security-Policy that forbids remote images, and it is sent with the round. A
// 4MB photograph is a 4MB page. Resize to somewhere around 1200px on the long edge before
// importing; this tool will refuse anything over the limit below rather than quietly make
// the site unusable on a phone.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const configMod = require('../src/config');

// Per picture, encoded. Base64 is about a third larger than the file on disk.
const MAX_BYTES = 900 * 1024;
const MAX_TOTAL = 12 * 1024 * 1024;

const TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

/** Check the file really is what its extension claims. */
function sniff(buf, ext) {
  const b = buf;
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b.slice(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (b.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.slice(4, 8).toString('latin1') === 'ftyp' && b.slice(8, 12).toString('latin1').startsWith('avif')) return 'image/avif';
  return TYPES[ext] || null;
}

const human = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);

/** A stable key from the filename, so re-importing the same file keeps its place. */
function keyFor(name, used) {
  const base = path.basename(name, path.extname(name))
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  let key = `own-${base || crypto.randomBytes(3).toString('hex')}`;
  let n = 2;
  while (used.has(key)) { key = `own-${base}-${n}`; n += 1; }
  used.add(key);
  return key;
}

function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  const clearing = args.includes('--clear');
  const folder = args.find((a) => !a.startsWith('--'));

  const cfg = configMod.load();
  const out = path.join(cfg.dataDir, 'puzzle-pictures.json');

  if (clearing) {
    if (fs.existsSync(out)) fs.unlinkSync(out);
    console.log(`Removed ${out}.`);
    console.log('The drawn pictures are unaffected; they live in public/pictures.js.');
    // The server holds the imported pictures in memory, so deleting the file is not the
    // same as taking them off the site. Saying so here because not saying it looks like
    // the clear did not work.
    console.log('Restart the server; until you do it will keep serving the old ones.');
    return;
  }

  if (!folder) {
    console.log('Usage: node tools/puzzle-import.js <folder> [--yes]');
    console.log('       node tools/puzzle-import.js --clear');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    console.log(`Not a folder: ${folder}`);
    process.exitCode = 1;
    return;
  }

  const used = new Set();
  const pictures = {};
  const skipped = [];
  let total = 0;

  for (const name of fs.readdirSync(folder).sort()) {
    const full = path.join(folder, name);
    const ext = path.extname(name).toLowerCase();
    if (!fs.statSync(full).isFile()) continue;
    if (!TYPES[ext]) { skipped.push([name, 'not an image extension']); continue; }

    const size = fs.statSync(full).size;
    if (size > MAX_BYTES) {
      // Far and away the commonest failure is a generator that saved PNG. The same
      // picture as a JPEG is usually a quarter of the size, so say that rather than
      // just quoting the number back.
      const fix = ext === '.png' || ext === '.avif' || ext === '.webp'
        ? ' — re-save as JPEG, quality 85'
        : ' — resize to about 1024px on the long edge';
      skipped.push([name, `${human(size)}, over the ${human(MAX_BYTES)} limit${fix}`]);
      continue;
    }

    const buf = fs.readFileSync(full);
    const mime = sniff(buf, ext);
    if (!mime) { skipped.push([name, 'does not look like an image inside']); continue; }

    const encoded = buf.toString('base64');
    total += encoded.length;
    if (total > MAX_TOTAL) { skipped.push([name, 'would push the pack over the total limit']); continue; }

    const key = keyFor(name, used);
    pictures[key] = { name, mime, data: encoded };
    console.log(`  ${key.padEnd(28)} ${human(size).padStart(7)}  ${name}`);
  }

  console.log('');
  for (const [name, why] of skipped) console.log(`  skipped: ${name} — ${why}`);
  console.log('');
  console.log(`${Object.keys(pictures).length} picture(s), ${human(total)} encoded.`);
  console.log(`destination  ${out}`);

  if (!Object.keys(pictures).length) {
    console.log('Nothing to write.');
    return;
  }
  if (!confirmed) {
    console.log('');
    console.log('Nothing was written. Re-run with --yes to import.');
    return;
  }

  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ pictures }, null, 0), 'utf8');
  console.log('');
  console.log('Written. Restart the server; the new pictures join the pool the puzzle draws from.');
}

main();
