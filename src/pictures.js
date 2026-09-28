'use strict';
// The picture pool every picture game draws from.
//
// This lived inside src/games/puzzle.js until that game was removed. It is not a property
// of any one game: the pool is the four drawn pictures plus whatever the operator imported
// with tools/puzzle-import.js, and which one a round shows is decided by that round's own
// seed — so a picture is as replayable as the rest of the result and cannot be
// cherry-picked by anyone, operator included.
//
// Nothing here looks at what is in a picture. It deals in keys.
const fair = require('./fair');

/** Original artwork drawn in the client. Keys only here. */
const PICTURES = ['deco', 'peacock', 'skyline', 'mandala'];

/**
 * Pictures the operator imported, if there are any.
 *
 * Read once and cached. They join the drawn ones in the same pool, so an imported picture
 * is chosen the same way and by the same seed as a drawn one.
 */
let importedKeys = null;
function imported(cfg) {
  if (importedKeys) return importedKeys;
  importedKeys = [];
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(cfg.dataDir, 'puzzle-pictures.json');
    if (fs.existsSync(file)) {
      const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
      importedKeys = Object.keys(pack.pictures || {});
    }
  } catch { /* no pack, or an unreadable one; the drawn pictures stand alone */ }
  return importedKeys;
}

/** Forget the cache. The importer tells the operator to restart, but tests need this. */
const forgetImported = () => { importedKeys = null; };

/** Which picture this round shows, from the seed so it is not cherry-picked. */
function pictureFor(serverSeed, clientSeed, nonce, cfg) {
  const pool = [...PICTURES, ...imported(cfg)];
  const [f] = fair.floats(serverSeed, `${clientSeed}:picture`, nonce, 1);
  return pool[Math.floor(f * pool.length)];
}

module.exports = { PICTURES, imported, forgetImported, pictureFor };
