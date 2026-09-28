'use strict';
// Shrink an oversized write-ahead log.
//
//   node tools/vacuum-wal.js          what it would do
//   node tools/vacuum-wal.js --yes    do it
//
// WHY THIS EXISTS
//
// The WAL reached 4.16MB in front of a 1.7MB database. That looks like corruption and is
// not: every frame in it had already been checkpointed, and `PRAGMA wal_checkpoint`
// reported busy=0 with all 718 frames written back. The database itself was compact —
// 425 pages, zero on the freelist.
//
// Two settings produced it, and only one is about checkpointing:
//
//   wal_autocheckpoint   1000 pages by default, which at a 4096-byte page is 4MB. So the
//                        WAL is ALLOWED to reach 4MB before SQLite writes it back.
//   journal_size_limit   -1 by default, meaning the file is never truncated afterwards.
//                        SQLite reuses the space instead, so the file keeps its
//                        high-water mark for as long as it exists.
//
// src/db.js now sets 256 pages and a 2MB limit, so this will not happen again. But those
// only take effect at the NEXT checkpoint on a NEW connection — an existing 4MB file
// stays 4MB until something truncates it. That is this tool.
//
// WHY NOT IN `npm run doctor`
//
// The doctor is documented as read-only and safe to run against a live server at any
// hour. It reports the WAL size and names this tool; it must not quietly write.
//
// SAFETY
//
// TRUNCATE is the strictest checkpoint: it blocks until every frame is in the database
// and every reader has finished, then resets the file to zero. It does not discard
// anything — a frame that cannot be written back means the checkpoint fails and the WAL
// is left exactly as it was. The worst case is that it does nothing.
//
// It can block briefly against a busy server. That is safe, but if you would rather not,
// stop the server first.

const fs = require('node:fs');
const configMod = require('../src/config');
const dbMod = require('../src/db');

const mb = (n) => `${(n / 1048576).toFixed(2)}MB`;
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

function main() {
  const go = process.argv.includes('--yes');
  const cfg = configMod.load();
  const dbPath = cfg.dbPath;
  const walPath = `${dbPath}-wal`;

  const before = sizeOf(walPath);
  const dbBefore = sizeOf(dbPath);

  console.log(`\n  ${cfg.siteName} — ${dbPath}\n`);

  if (!before) {
    console.log('  There is no WAL file. Nothing to do.\n');
    return;
  }

  console.log(`  database    ${mb(dbBefore)}`);
  console.log(`  wal         ${mb(before)}`);

  const db = dbMod.open(dbPath);
  try {
    // PASSIVE first, purely to report. It never blocks and never truncates, so it is a
    // safe way to show what state things are in before anything is changed.
    const state = db.raw.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    console.log(`  frames      ${state.log} in the wal, ${state.checkpointed} already written back`);
    if (state.busy) {
      console.log('  busy        a reader or writer is active — TRUNCATE may block');
    }

    if (!go) {
      console.log('\n  Nothing was changed. Re-run with --yes.\n');
      return;
    }

    const res = db.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const after = sizeOf(walPath);

    // busy=1 means it gave up rather than truncated, and the WAL is untouched.
    if (res.busy) {
      console.log('\n  The checkpoint could not finish: something is holding the database.');
      console.log('  Nothing was changed. Try again, or stop the server first.\n');
      process.exitCode = 1;
      return;
    }

    console.log(`\n  wal         ${mb(before)} -> ${mb(after)}`);
    console.log(`  reclaimed   ${mb(before - after)}`);
    console.log('\n  src/db.js caps it at 2MB from now on, so this should not recur.\n');
  } finally {
    db.raw.close();
  }
}

main();
