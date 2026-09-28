'use strict';
// What every puzzle tier actually pays, and whether the house could honour it.
//
//   node tools/puzzle-ladder.js
//
// This exists because the tier table is four lines of innocent-looking numbers that decide
// a payout ladder nobody can compute in their head. A 6x6 grid with four broken tiles pays
// 58,315x on a full clear and one with three pays 7,068x — an eightfold difference from a
// single digit, in the direction nobody expects.
//
// The check that matters is the last column. The supply is fixed at 21,000,000 tugriks and
// the house pays wins out of what it holds, so a prize larger than the house balance is not
// unlikely, it is impossible: `capPayout` truncates it and the player is shown a number the
// site will not honour. That is the one failure this tool is here to catch.

const configMod = require('../src/config');
const puzzle = require('../src/games/puzzle');
const tokenchain = require('../src/tokenchain');
const dbMod = require('../src/db');

const money = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function main() {
  const cfg = configMod.load();
  const edge = cfg.houseEdge.puzzle;

  // The house balance is a live figure, so read it rather than assume one. Without a
  // database yet there is nothing to compare against, and the tool still prints the
  // ladders — the ceiling column simply says so.
  let house = null;
  try {
    const db = dbMod.open(cfg.dbPath);
    const matches = require('../src/match');
    house = tokenchain.balanceOf(db, matches.houseKey(db).publicRaw) / 1e8;
    db.close();
  } catch { /* no database, or no chain in it yet */ }

  console.log('');
  console.log(`  house edge ${(edge * 100).toFixed(2)}%`);
  console.log(house === null
    ? '  house balance: unknown (no database), so the ceiling is not checked'
    : `  house holds ${money(house)} TUG, which is the most any single win can pay`);
  console.log('');
  console.log('  tier     grid   tiles broken  steps    first     full clear   payable on a 1 TUG stake');
  console.log('  ' + '-'.repeat(88));

  let trouble = 0;
  for (const [name, tier] of Object.entries(puzzle.TIERS)) {
    const tiles = tier.cols * tier.rows;
    const safe = tiles - tier.broken;
    const ladder = puzzle.ladder(name, edge);
    const top = ladder[ladder.length - 1];

    // A one-tugrik stake is the table minimum, so this is the smallest bet that could
    // ever ask for the top prize. If the house cannot cover that, it cannot cover any.
    let verdict = 'not checked';
    if (house !== null) {
      const ok = top <= house;
      if (!ok) trouble += 1;
      verdict = ok ? 'yes' : `NO — needs ${money(top)}, house has ${money(house)}`;
    }

    console.log(
      `  ${name.padEnd(8)} ${`${tier.cols}x${tier.rows}`.padEnd(6)} `
      + `${String(tiles).padEnd(5)} ${String(tier.broken).padEnd(6)} `
      + `${String(ladder.length).padEnd(6)} ${`${ladder[0]}x`.padEnd(8)} `
      + `${`${money(top)}x`.padEnd(14)} ${verdict}`,
    );
  }

  console.log('');
  if (trouble) {
    console.log(`  ${trouble} tier(s) advertise a prize the house cannot currently pay.`);
    console.log('  Either raise `broken` for those tiers, which lowers the top prize, or');
    console.log('  give the house a larger float. Do not leave it: capPayout will truncate');
    console.log('  the win silently and the player will have been shown a number that was');
    console.log('  never real.');
    console.log('');
    process.exitCode = 1;
    return;
  }
  if (house !== null) console.log('  Every tier can be paid in full.\n');
}

main();
