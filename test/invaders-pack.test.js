'use strict';
// The committed Invaders pack, held against the game that draws it.
//
// tools/generate-invaders.js renders the pack on the RTX and writes a manifest beside it.
// The game does not read the manifest — a cabinet never has a network request in it — so
// it hard-codes the layout instead, and that is a promise two files make to each other.
// This is where the promise is checked: the manifest agrees with the game's constants, the
// atlas is the size the manifest says, every cell the game will cut lies inside it, and
// the generator found no empty cell. Whether a cell is empty is read from the manifest,
// which the generator computed from the pixels at build time; decoding the PNG here would
// only repeat that with a second decoder to keep right.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'public', 'textures', 'invaders');
const MODULE = '../public/games/invaders.js';

/** The width and height a PNG declares in its IHDR, which is always the first chunk. */
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.strictEqual(b.toString('latin1', 1, 4), 'PNG', `${file} is not a PNG`);
  assert.strictEqual(b.toString('latin1', 12, 16), 'IHDR');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

test('the manifest names a seed and a look, and the generator left no cell empty', () => {
  assert.ok(Number.isInteger(manifest.seed), 'a pack is reproducible from its seed');
  for (const k of ['species', 'material', 'palette', 'mood']) {
    assert.ok(manifest.words[k], `the ${k} word that seeded the prompt`);
  }
  assert.deepStrictEqual(manifest.empty, [], 'every frame has something in it');
});

test('the atlas is the size the manifest says, and every cell lies inside it', () => {
  const size = pngSize(path.join(DIR, manifest.atlas.file));
  assert.deepStrictEqual(size, { w: manifest.atlas.w, h: manifest.atlas.h });
  const a = manifest.alien;
  const b = manifest.burst;
  assert.ok(a.species * a.frames * a.size <= size.w, 'the alien row fits across');
  assert.ok(a.y + a.size <= size.h, 'the alien row fits down');
  assert.ok(b.frames * b.size <= size.w, 'the burst row fits across');
  assert.ok(b.y + b.size <= size.h, 'the burst row fits down');
  assert.ok(b.y >= a.y + a.size, 'the rows do not overlap');
});

test('the backdrop is a JPEG the game can tile', () => {
  const b = fs.readFileSync(path.join(DIR, manifest.backdrop.file));
  assert.strictEqual(b[0], 0xff);
  assert.strictEqual(b[1], 0xd8, 'JPEG magic');
  assert.ok(manifest.backdrop.size > 0);
});

test('the game cuts the atlas exactly as the manifest lays it out', async () => {
  const { meta } = await import(MODULE);
  assert.strictEqual(meta.pack.url, '/textures/invaders/');
  const g = meta.pack.atlas;
  assert.strictEqual(g.alien, manifest.alien.size);
  assert.strictEqual(g.species, manifest.alien.species);
  assert.strictEqual(g.walk, manifest.alien.frames);
  assert.strictEqual(g.burst, manifest.burst.size);
  assert.strictEqual(g.burstFrames, manifest.burst.frames);
  assert.strictEqual(g.burstY, manifest.burst.y);
});

test('the pack stays small enough to ship with the page', () => {
  const bytes = ['atlas.file', 'backdrop.file']
    .map((k) => k.split('.').reduce((o, p) => o[p], manifest))
    .reduce((n, f) => n + fs.statSync(path.join(DIR, f)).size, 0);
  assert.ok(bytes < 300 * 1024, `the pack is ${Math.round(bytes / 1024)} KB; the budget is 300`);
});
