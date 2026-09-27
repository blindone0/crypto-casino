'use strict';
// Interactive treasury setup: whitelist the cold-wallet addresses that operator profit
// is allowed to leave to.
//
// This tool deliberately does NOT generate keys. Wallet seed generation belongs in
// audited wallet software that has been reviewed by people whose job that is, and whose
// seed phrases you can restore in any other wallet:
//
//   Bitcoin  -> Sparrow Wallet or Electrum. Write the 12/24 words on paper, twice.
//   Monero   -> Monero GUI or Feather. Keep the 25-word seed offline.
//   Litecoin -> Electrum-LTC.
//
// Create the wallet there, copy a RECEIVE address, and paste it below. The address is
// checksum-verified before it is saved, so a typo cannot silently send profit nowhere.
//
//   node tools/treasury-setup.js            list and add addresses
//   node tools/treasury-setup.js --list     list only
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const configMod = require('../src/config');
const addrcheck = require('../src/addrcheck');
const treasury = require('../src/treasury');

const DRIVERS = ['bitcoind', 'monero', 'manual', 'mock'];

function show(cfg) {
  const list = treasury.list(cfg);
  console.log('\n  Treasury addresses');
  console.log('  ' + '-'.repeat(68));
  if (!list.length) {
    console.log('  (none yet)\n');
    return list;
  }
  for (const [i, a] of list.entries()) {
    const mark = a.valid ? 'ok ' : 'BAD';
    console.log(`  ${i + 1}. [${mark}] ${a.label}  (${a.driver})`);
    console.log(`         ${a.address}`);
    if (!a.valid) console.log(`         ${a.problem}`);
  }
  console.log('');
  return list;
}

async function main() {
  const cfg = configMod.load();
  console.log(`\n  ${cfg.siteName} treasury setup`);
  console.log(`  active wallet driver: ${cfg.wallet.driver}`);
  show(cfg);

  if (process.argv.includes('--list')) return;

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log('  Create the wallet in real wallet software first (Sparrow, Electrum,');
    console.log('  Monero GUI), then paste a receive address here.');
    console.log('  Press Enter on an empty label to finish.\n');

    for (;;) {
      const label = (await rl.question('  Label (e.g. "BTC cold"): ')).trim();
      if (!label) break;

      const driverIn = (await rl.question(
        `  Wallet driver [${DRIVERS.join('/')}] (default ${cfg.wallet.driver}): `,
      )).trim();
      const driver = driverIn || cfg.wallet.driver;
      if (!DRIVERS.includes(driver)) {
        console.log(`  Unknown driver "${driver}". Skipping.\n`);
        continue;
      }

      const address = (await rl.question('  Receive address: ')).trim();
      const check = addrcheck.validate(driver, address);
      if (!check.ok) {
        console.log(`  Rejected: ${check.reason}\n`);
        continue;
      }
      if (check.kind === 'unchecked') {
        console.log('  Note: this chain has no checksum check here, so re-read the address'
          + ' character by character before you send anything real.');
      }

      try {
        const out = treasury.addAddress(cfg, { label, driver, address });
        console.log(`  Saved to config.json (${out.count} total, verified as ${out.added.kind}).\n`);
      } catch (e) {
        console.log(`  ${e.message}\n`);
      }
    }
  } finally {
    rl.close();
  }

  show(cfg);
  console.log('  Payouts are limited to free capital (bankroll minus what you owe');
  console.log('  players), so taking profit can never leave you unable to pay a winner.');
  console.log('  Send profit from the admin panel: Treasury -> Send to treasury.\n');
}

main().catch((e) => {
  console.error(`treasury setup failed: ${e.message}`);
  process.exit(1);
});
