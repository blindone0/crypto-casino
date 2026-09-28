'use strict';
// Move tugriks from the treasury to the house, so the house can pay what the tables
// advertise.
//
//   node tools/house-float.js                  what it would do
//   node tools/house-float.js 10000 --yes      move 10,000 TUG
//
// WHY THIS IS NEEDED
//
// Every game here caps a win at what the house holds (`bank.capPayout`). That is correct
// — the supply is fixed at 21,000,000 and the house cannot hand over money it does not
// have — but it means a thin house silently truncates wins. A player calling 12 on Кости
// is quoted 35.64x and paid whatever the house had, which is a number shown that will not
// be honoured, and it is the failure this project keeps removing.
//
// The treasury holds almost the entire supply and does nothing with it. The house is the
// account that actually settles bets. Moving a float between them changes no total: the
// supply is unchanged, the chain still verifies, and `npm run doctor` still balances. It
// is a transfer, not a mint — there is no way to mint after genesis and this does not
// try.
//
// HOW MUCH
//
// Enough to cover the largest single win the tables can offer at the largest stake anyone
// is likely to place. The tool prints what the current float can and cannot cover before
// it moves anything, so the number is chosen against the real pay tables rather than
// guessed.

const configMod = require('../src/config');
const dbMod = require('../src/db');
const tokenchain = require('../src/tokenchain');
const matches = require('../src/match');
const bones = require('../src/games/bones');
const jigsaw = require('../src/games/jigsaw');

const UNIT = 100000000;
const money = (units) => (units / UNIT).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** The biggest multiple each game can be asked to pay, so the float can be judged. */
function worstCase(cfg) {
  const rows = [];

  // Кости: the longest call on the board.
  let top = 0;
  for (let sum = bones.MIN_SUM; sum <= bones.MAX_SUM; sum += 1) {
    const { multiplier } = bones.quote(cfg, sum, sum);
    if (multiplier > top) top = multiplier;
  }
  rows.push({ game: 'bones', multiplier: top });

  // The jigsaw pays a fixed top multiple.
  rows.push({
    game: 'jigsaw',
    multiplier: jigsaw.payoutMultiplier(0, jigsaw.boardOf('medium'), cfg.houseEdge.jigsaw),
  });

  // Dice at its narrowest offered chance, which is the 1% floor the server enforces.
  rows.push({ game: 'dice', multiplier: (1 - cfg.houseEdge.dice) / 0.01 });

  return rows.sort((a, b) => b.multiplier - a.multiplier);
}

function main() {
  const args = process.argv.slice(2);
  const go = args.includes('--yes');
  const amountArg = args.find((a) => !a.startsWith('--'));
  const cfg = configMod.load();
  const db = dbMod.open(cfg.dbPath);

  try {
    const houseKey = matches.houseKey(db).publicRaw;
    const treasuryKey = tokenchain.treasuryKey(db).publicRaw;
    const house = tokenchain.balanceOf(db, houseKey);
    const treasury = tokenchain.balanceOf(db, treasuryKey);

    console.log('');
    console.log(`  house      ${money(house).padStart(18)} TUG`);
    console.log(`  treasury   ${money(treasury).padStart(18)} TUG`);
    console.log('');
    console.log('  The largest win each game can be asked to pay, and the stake at which');
    console.log('  the current float stops covering it:');
    console.log('');
    for (const row of worstCase(cfg)) {
      // A win is capped at `house + wager`, so a stake pays in full while
      // `wager * multiplier <= house + wager`.
      const maxStake = row.multiplier > 1 ? house / (row.multiplier - 1) : Infinity;
      console.log(`    ${row.game.padEnd(8)} ${row.multiplier.toFixed(2).padStart(8)}x`
        + `   full payout up to a ${money(maxStake)} TUG stake`);
    }
    console.log('');

    if (!amountArg) {
      console.log('  Pass an amount in TUG to move, plus --yes:');
      console.log('      node tools/house-float.js 10000 --yes\n');
      return;
    }

    const tug = Number(amountArg);
    if (!Number.isFinite(tug) || tug <= 0) {
      console.log(`  "${amountArg}" is not an amount of tugriks.\n`);
      process.exitCode = 1;
      return;
    }
    const units = Math.round(tug * UNIT);
    if (units > treasury) {
      console.log(`  The treasury holds ${money(treasury)} TUG; it cannot send ${money(units)}.\n`);
      process.exitCode = 1;
      return;
    }

    console.log(`  Would move ${money(units)} TUG from the treasury to the house,`);
    console.log(`  leaving the house at ${money(house + units)} TUG.`);
    console.log('  The total supply does not change: this is a transfer, not a mint.');
    console.log('');

    if (!go) {
      console.log('  Nothing was moved. Re-run with --yes.\n');
      return;
    }

    tokenchain.appendBlock(db, [tokenchain.treasuryTransfer(db, houseKey, units)]);

    const after = tokenchain.balanceOf(db, houseKey);
    const chain = tokenchain.verifyChain(db);
    console.log(`  house is now ${money(after)} TUG`);
    console.log(`  chain ${chain.ok ? 'verifies' : 'DOES NOT VERIFY'} (${chain.height ?? '?'} blocks)`);
    if (!chain.ok) process.exitCode = 1;
    console.log('');
  } finally {
    db.close();
  }
}

main();
