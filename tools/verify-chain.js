'use strict';
// Replay the whole token chain from genesis, and say so.
//
//   npm run verify-chain
//
// The doctor verifies from the latest checkpoint, which is quick and is what keeps it
// worth running hourly, but it trusts the blocks below the anchor as long as the anchor
// still hashes. This is the unconditional replay — every link, every signature, every
// balance, from block zero — and it is meant for cron, weekly:
//
//   0 4 * * 1 cd /home/casino/casino && npm run --silent verify-chain || mail -s 'chain' you@…
//
// Unlike the doctor, this WRITES: a fresh checkpoint at the tip, and the time of the
// replay, which the doctor reports so an overdue week is noticed. Both are caches of a
// verification that passed; nothing is written when it did not. Safe against a running
// server: SQLite serialises the two, and the checkpoint is one small transaction.

const configMod = require('../src/config');
const dbMod = require('../src/db');
const tokenchain = require('../src/tokenchain');

const cfg = configMod.load();
const db = dbMod.open(cfg.dbPath);

try {
  const started = Date.now();
  const out = tokenchain.verifyChain(db, { checkpoint: false });
  const took = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n  ${cfg.siteName} — ${cfg.dbPath}\n`);
  if (!out.ok) {
    console.log(`  FAIL  the chain does not verify: ${out.reason}\n`);
    process.exitCode = 1;
  } else {
    const cp = db.tx(() => tokenchain.writeCheckpoint(db, { full: true }));
    db.kvSet('chain.fullVerifiedAt', Math.floor(Date.now() / 1000));
    console.log(`  ok    ${out.blocks} blocks replayed from genesis in ${took}s`);
    console.log(`        ${out.accounts} accounts, ${out.events} game events, head ${out.head.slice(0, 16)}…`);
    console.log(cp.written
      ? `        checkpoint written at block ${cp.height}\n`
      : `        checkpoint at block ${cp.height} already there\n`);
  }
} finally {
  db.raw.close();
}
