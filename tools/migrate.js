'use strict';
// Show or apply schema migrations without starting the server.
//
//   node tools/migrate.js            what this database is at, and what is waiting
//   node tools/migrate.js --run      apply everything pending
//
// Opening the database at all applies migrations, because that is what src/db.js does
// and a half-migrated database is worse than either state. So --run exists mostly to say
// out loud what happened; the reason to run this before starting the server is the
// listing, so you can see what a deployment is about to do to a live file.
//
// Back the file up first. DEPLOY.md section 7 has the one-liner.

const { DatabaseSync } = require('node:sqlite');
const configMod = require('../src/config');
const migrate = require('../src/migrate');

const { dbPath } = configMod.load();
const apply = process.argv.includes('--run');

const db = new DatabaseSync(dbPath);
try {
  const at = migrate.version(db);
  const waiting = migrate.pending(db);

  console.log(`\n  database: ${dbPath}`);
  console.log(`  schema version: ${at} of ${migrate.latest()}\n`);

  if (!waiting.length) {
    console.log('  up to date, nothing to apply\n');
  } else {
    console.log(`  ${waiting.length} pending:`);
    for (const step of waiting) console.log(`    ${step.id}  ${step.name}`);
    console.log('');
    if (!apply) {
      console.log('  nothing was changed. Re-run with --run to apply.\n');
    } else {
      const { SCHEMA } = require('../src/db');
      const out = migrate.run(db, { schema: SCHEMA });
      console.log(`  applied ${out.applied.length}, now at version ${out.to}:`);
      for (const line of out.applied) console.log(`    ${line}`);
      console.log('');
    }
  }
} finally {
  db.close();
}
