'use strict';
// Is this site sound?
//
//   npm run doctor
//
// Reads only, so it is safe against a running server at any hour. Exits non-zero if
// anything is wrong, which is the point: put it in cron and you hear about a problem
// instead of finding it.
//
//   0 * * * * cd /home/casino/casino && npm run --silent doctor || mail -s 'casino' you@…

const configMod = require('../src/config');
const dbMod = require('../src/db');
const doctor = require('../src/doctor');

const cfg = configMod.load();
const db = dbMod.open(cfg.dbPath);

try {
  const { ok, checks } = doctor.checkAll(db, cfg);
  const width = checks.reduce((n, c) => Math.max(n, c.name.length), 0);

  console.log(`\n  ${cfg.siteName} — ${cfg.dbPath}\n`);
  for (const check of checks) {
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  console.log(ok
    ? '\n  everything checks out\n'
    : `\n  ${checks.filter((c) => !c.ok).length} problem(s). Nothing was changed.\n`);

  process.exitCode = ok ? 0 : 1;
} finally {
  db.raw.close();
}
