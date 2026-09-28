'use strict';
// Start the token chain over.
//
// You need this exactly once, and only in development: if a chain already exists, its
// genesis block is signed and every later block links to it, so the supply it was born
// with is the supply it has forever. That is the point of the design, and it means a
// chain started under different rules cannot be brought into line by editing the config.
//
// Running this destroys every token balance, every block and every wallet registration.
// It does not touch player accounts, casino balances, bets or the bankroll, which live in
// a different set of tables entirely.
//
// Usage:
//   node tools/token-reset.js            show what would be destroyed
//   node tools/token-reset.js --yes      do it

const configMod = require('../src/config');
const dbMod = require('../src/db');
const tokenchain = require('../src/tokenchain');
const U = require('../src/util');

// Tugriks are divisible to eight places, so raw units are unreadable. Print the coin.
const tug = (units) => U.formatAmount(units);

function main() {
  const confirmed = process.argv.includes('--yes');
  const cfg = configMod.load();
  const db = dbMod.open(cfg.dbPath);

  const blocks = db.get('SELECT COUNT(*) AS n FROM token_blocks').n;
  const wallets = db.get('SELECT COUNT(*) AS n FROM token_keys').n;
  const held = db.get('SELECT COALESCE(SUM(balance),0) AS n FROM token_balances').n;
  const current = blocks ? tokenchain.supply(db) : null;

  console.log(`database    ${cfg.dbPath}`);
  console.log(`blocks      ${blocks}`);
  console.log(`wallets     ${wallets}`);
  console.log(`held        ${tug(held)} ${cfg.token.symbol}`);
  if (current) {
    console.log(`minted      ${tug(current.minted)} (this chain's fixed supply)`);
    console.log(`burned      ${tug(current.burned)}`);
  }
  console.log(`new supply  ${tug(cfg.token.maxSupply)} ${cfg.token.symbol}`);

  if (!confirmed) {
    console.log('');
    console.log('Nothing was changed. Re-run with --yes to destroy the above and start again.');
    console.log('Player accounts, casino balances and the bankroll are not affected.');
    db.close();
    return;
  }

  db.tx(() => {
    db.run('DELETE FROM token_nonces');
    db.run('DELETE FROM token_balances');
    db.run('DELETE FROM token_blocks');
    db.run('DELETE FROM token_keys');
    // The keys themselves go too. A treasury key that once held a different supply is
    // confusing to look at later, and nothing signed by it survives this.
    db.run("DELETE FROM kv WHERE key IN ('token.treasuryKey','token.houseKey')");
    db.audit('system', 'token.chain.reset', { blocks, wallets, held });
  });

  const made = tokenchain.ensureGenesis(db, cfg);
  const supply = tokenchain.supply(db);
  const check = tokenchain.verifyChain(db);

  console.log('');
  console.log(made ? 'Genesis block written.' : 'Genesis already present, nothing minted.');
  console.log(`treasury    ${tokenchain.treasuryKey(db).publicRaw}`);
  console.log(`supply      ${tug(supply.minted)} ${cfg.token.symbol}, all of it in the treasury`);
  console.log(`verifies    ${check.ok ? 'yes' : `NO: ${check.reason}`}`);
  console.log('');
  console.log('Every wallet will need to be created again from its phrase.');
  db.close();
}

main();
