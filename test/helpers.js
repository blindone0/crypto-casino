'use strict';
// Shared test setup: a throwaway config and database per test file.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const configMod = require('../src/config');
const dbMod = require('../src/db');

const ROOT = path.resolve(__dirname, '..');

/** A config that never touches the real config.json or the real database. */
function testConfig(overrides = {}) {
  const dbPath = path.join(
    process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(),
    `casino-test-${crypto.randomBytes(6).toString('hex')}.db`,
  );
  const cfg = configMod.deepMerge(structuredClone(configMod.DEFAULTS), {
    adminToken: 'test-admin-token',
    faucetUnits: 0,
    host: '127.0.0.1',
    port: 0,
    wallet: { driver: 'mock', pollIntervalMs: 999999 },
    ...overrides,
  });
  cfg.root = ROOT;
  cfg.dbPath = dbPath;
  cfg.dbFile = dbPath;
  configMod.applyAssetOverrides(cfg);
  return cfg;
}

function openTestDb(cfg) {
  const db = dbMod.open(cfg.dbPath);
  return db;
}

function cleanup(cfg, db) {
  try { db?.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(cfg.dbPath + suffix); } catch { /* not there */ }
  }
}

module.exports = { testConfig, openTestDb, cleanup, ROOT };
