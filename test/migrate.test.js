'use strict';
// Schema changes on a database that already has rows.
//
// The point of the migration runner is the case nobody tests by accident: not a fresh
// database, which works under any scheme at all, but one with a year of bets in it that
// needs a column it has not got. So most of these build a database, put rows in it, and
// then migrate it, checking the rows are still there afterwards — a migration that
// arrives correctly and takes the data with it is the only kind worth having.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const migrate = require('../src/migrate');
const { SCHEMA, PRAGMAS } = require('../src/db');

/** A database on disk, because user_version is a property of the file. */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
  const file = path.join(dir, 'test.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

function openRaw(file) {
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  return db;
}

test('a fresh database ends up at the latest version', (t) => {
  const db = openRaw(scratch(t));
  assert.strictEqual(migrate.version(db), 0, 'a new file has never been migrated');

  const out = migrate.run(db, { schema: SCHEMA });

  assert.strictEqual(out.from, 0);
  assert.strictEqual(out.to, migrate.latest());
  assert.strictEqual(migrate.version(db), migrate.latest());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='users'").get());
  db.close();
});

test('migrating again does nothing', (t) => {
  const db = openRaw(scratch(t));
  migrate.run(db, { schema: SCHEMA });

  const out = migrate.run(db, { schema: SCHEMA });

  assert.deepStrictEqual(out.applied, [], 'no step ran a second time');
  assert.strictEqual(out.from, out.to);
  db.close();
});

test('a database built before migrations existed is adopted, not rebuilt', (t) => {
  // This is the database on the machine this was written on: every table already there,
  // rows in them, and no version recorded because nothing was recording one.
  const file = scratch(t);
  const db = openRaw(file);
  db.exec(SCHEMA);
  db.exec(`INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
           VALUES(1,'igor','igor','x','seed','rc1',123)`);
  assert.strictEqual(migrate.version(db), 0, 'no version was ever stamped');

  const out = migrate.run(db, { schema: SCHEMA });

  assert.strictEqual(out.to, migrate.latest());
  const row = db.prepare('SELECT username, created_at FROM users WHERE id=1').get();
  assert.strictEqual(row.username, 'igor', 'the row survived');
  assert.strictEqual(row.created_at, 123, 'and was not rewritten');
  db.close();
});

test('the baseline can be run over a live database without touching it', (t) => {
  // Why the adoption above is safe rather than lucky: every statement in the schema is
  // CREATE ... IF NOT EXISTS, so applying it to a database that already has the tables
  // changes nothing. If that ever stops being true this test fails and the runner needs
  // a stamping path instead.
  const db = openRaw(scratch(t));
  db.exec(SCHEMA);
  db.exec(`INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
           VALUES(7,'bob','bob','h','s','rc7',99)`);
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  db.exec(SCHEMA);

  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before);
  assert.strictEqual(db.prepare('SELECT username FROM users WHERE id=7').get().username, 'bob');
  db.close();
});

// ------------------------------------------------- what a real change looks like

test('a new step reaches a database that already has data', (t) => {
  // The case the whole file exists for. A column added in step 2 has to arrive on a
  // database that stopped at step 1, with its rows intact.
  const file = scratch(t);
  const db = openRaw(file);
  migrate.run(db, { schema: SCHEMA });
  db.exec(`INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
           VALUES(1,'alice','alice','x','s','rc1',1000)`);

  const steps = [
    ...migrate.STEPS,
    {
      id: migrate.latest() + 1,
      name: 'users.nickname',
      up: (d) => d.exec('ALTER TABLE users ADD COLUMN nickname TEXT'),
    },
  ];
  const out = migrate.run(db, { schema: SCHEMA, steps });

  assert.strictEqual(out.applied.length, 1, 'only the new step ran');
  assert.ok(out.applied[0].endsWith('users.nickname'));
  const row = db.prepare('SELECT username, created_at, nickname FROM users WHERE id=1').get();
  assert.strictEqual(row.username, 'alice', 'the row is still there');
  assert.strictEqual(row.created_at, 1000);
  assert.strictEqual(row.nickname, null, 'with the new column, empty');
  db.close();
});

test('steps run in order of their id, not the order they were listed', (t) => {
  const db = openRaw(scratch(t));
  const order = [];
  const steps = [
    { id: 3, name: 'third', up: () => order.push(3) },
    { id: 1, name: 'first', up: () => order.push(1) },
    { id: 2, name: 'second', up: () => order.push(2) },
  ];
  migrate.run(db, { schema: SCHEMA, steps });

  assert.deepStrictEqual(order, [1, 2, 3]);
  assert.strictEqual(migrate.version(db), 3);
  db.close();
});

test('a step that throws leaves the version where it was', (t) => {
  // Half a migration is the state you can never reason about, so a step commits with its
  // own version number or not at all.
  const db = openRaw(scratch(t));
  const steps = [
    ...migrate.STEPS,
    {
      id: 50,
      name: 'adds a column',
      up: (d) => d.exec('ALTER TABLE users ADD COLUMN good TEXT'),
    },
    {
      id: 51,
      name: 'falls over',
      up: (d) => {
        d.exec('ALTER TABLE users ADD COLUMN half TEXT');
        throw new Error('deliberate');
      },
    },
  ];

  assert.throws(() => migrate.run(db, { schema: SCHEMA, steps }), /migration 51 \(falls over\)/);

  assert.strictEqual(migrate.version(db), 50, 'stopped at the last step that worked');
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('good'), 'the step before it stuck');
  assert.ok(!cols.includes('half'), 'and the one that threw was rolled back whole');
  db.close();
});

test('the step after a failure runs once the failure is fixed', (t) => {
  const db = openRaw(scratch(t));
  let explode = true;
  const steps = [
    ...migrate.STEPS,
    {
      id: 60,
      name: 'flaky',
      up: (d) => {
        if (explode) throw new Error('not yet');
        d.exec('ALTER TABLE users ADD COLUMN later TEXT');
      },
    },
  ];
  assert.throws(() => migrate.run(db, { schema: SCHEMA, steps }));
  assert.strictEqual(migrate.version(db), migrate.latest());

  explode = false;
  const out = migrate.run(db, { schema: SCHEMA, steps });

  assert.strictEqual(out.to, 60);
  assert.ok(db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'later'));
  db.close();
});

// --------------------------------------------------------------- numbering

test('two steps cannot share an id', () => {
  assert.throws(() => migrate.checkSteps([
    { id: 1, name: 'a', up() {} },
    { id: 1, name: 'b', up() {} },
  ]), /share id 1/);
});

test('a step needs a positive integer id and something to do', () => {
  assert.throws(() => migrate.checkSteps([{ id: 0, name: 'a', up() {} }]), /positive integers/);
  assert.throws(() => migrate.checkSteps([{ id: 1.5, name: 'a', up() {} }]), /positive integers/);
  assert.throws(() => migrate.checkSteps([{ id: 1, name: 'a' }]), /has no up/);
});

test('the shipped steps are numbered properly', () => {
  // Cheap insurance against a careless merge: two people adding "the next one" at once.
  migrate.checkSteps(migrate.STEPS);
  const ids = migrate.STEPS.map((s) => s.id);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b), 'listed in order');
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('a bad version number is refused rather than interpolated', () => {
  // setVersion builds a PRAGMA by interpolation because PRAGMA takes no parameters, so
  // the check in front of it is doing real work.
  const db = new DatabaseSync(':memory:');
  assert.throws(() => migrate.setVersion(db, '1; DROP TABLE users'), /bad schema version/);
  assert.throws(() => migrate.setVersion(db, -1), /bad schema version/);
  assert.throws(() => migrate.setVersion(db, 1.5), /bad schema version/);
  db.close();
});

// ------------------------------------------------------------- connection

test('connection settings are not left to a migration', (t) => {
  // They cannot live in one: foreign_keys and synchronous are per-connection, so a
  // database that has already migrated would open without them.
  const file = scratch(t);
  const first = openRaw(file);
  migrate.run(first, { schema: SCHEMA });
  first.close();

  const db = require('../src/db').open(file);
  assert.strictEqual(db.raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1,
    'foreign keys are on even though no migration ran');
  db.raw.close();
});
