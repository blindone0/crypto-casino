'use strict';
// Bankroll simulator. Answers the two questions that decide whether this is a business:
//
//   1. How much do I expect to make?          wagered * houseEdge, minus what you give back.
//   2. How likely am I to go broke first?     depends on bankroll, bet size and variance.
//
// The house edge guarantees profit only in the long run. In the short run a run of bad
// luck can bust you, and a bust site never gets to collect its long run. This runs the
// real fairness engine against the real risk caps so the numbers are not hand-waved.
//
// Usage:
//   node tools/simulate.js
//   node tools/simulate.js --bankroll 500 --players 200 --bets 2000 --edge 0.01 --risk 0.01
//   node tools/simulate.js --game limbo --target 10 --runs 200
const fair = require('../src/fair');

function parseArgs(argv) {
  const out = {
    bankroll: 1000,   // starting operator capital, in credits
    players: 100,     // distinct players
    bets: 500,        // bets each
    bet: 1,           // average stake, in credits
    edge: 0.01,
    risk: 0.01,       // bankrollRiskFraction: max win per bet as a share of bankroll
    game: 'dice',
    target: 2,        // dice: payout multiplier aimed at; limbo/crash: cashout target
    runs: 100,        // independent simulations
    referral: 0.2,
    rakeback: 0.05,
    referredShare: 0.5, // fraction of players who came through an affiliate
  };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const val = argv[i + 1];
    if (!(key in out)) continue;
    out[key] = typeof out[key] === 'number' ? Number(val) : val;
  }
  return out;
}

const fmt = (n, dp = 2) => n.toLocaleString('en-US', {
  minimumFractionDigits: dp, maximumFractionDigits: dp,
});

/** One full simulation. Returns the outcome of a single hypothetical month. */
function runOnce(a, seed) {
  let bankroll = a.bankroll;
  let wagered = 0;
  let paid = 0;
  let lowest = bankroll;
  let busted = false;
  let affiliateOwed = 0;
  let rakebackOwed = 0;

  const totalBets = a.players * a.bets;
  for (let i = 0; i < totalBets; i += 1) {
    // Bet size varies a little so the run is not perfectly uniform.
    const stake = a.bet * (0.5 + ((i * 7919) % 100) / 100);

    // Risk cap: a bet may never win more than this slice of the current bankroll.
    const maxProfit = bankroll * a.risk;
    const wantedProfit = stake * (a.target - 1);
    const scale = wantedProfit > maxProfit ? maxProfit / wantedProfit : 1;
    const realStake = stake * scale;
    if (realStake <= 0) { busted = true; break; }

    let payout = 0;
    if (a.game === 'dice') {
      const chance = (1 - a.edge) / a.target;
      const target = Math.round(chance * fair.DICE_OUTCOMES);
      const mult = fair.payoutMultiplier(target / fair.DICE_OUTCOMES, a.edge);
      if (fair.diceRoll(seed, `p${i % a.players}`, i) < target) payout = realStake * mult;
    } else if (a.game === 'limbo') {
      if (fair.limboMultiplier(seed, `p${i % a.players}`, i, a.edge) >= a.target) {
        payout = realStake * a.target;
      }
    } else {
      if (fair.crashPoint(seed, i, a.edge) >= a.target) payout = realStake * a.target;
    }

    wagered += realStake;
    paid += payout;
    bankroll += realStake - payout;

    // Commissions come out of the theoretical edge on every bet.
    const edgeUnits = realStake * a.edge;
    if ((i % a.players) / a.players < a.referredShare) {
      const cut = edgeUnits * a.referral;
      affiliateOwed += cut;
      bankroll -= cut;
    }
    const back = edgeUnits * a.rakeback;
    rakebackOwed += back;
    bankroll -= back;

    if (bankroll < lowest) lowest = bankroll;
    if (bankroll <= 0) { busted = true; break; }
  }

  return {
    bankroll, wagered, paid, lowest, busted,
    profit: bankroll - a.bankroll,
    affiliateOwed, rakebackOwed,
  };
}

function main() {
  const a = parseArgs(process.argv);
  console.log('\n  Bankroll simulation');
  console.log('  ' + '-'.repeat(66));
  console.log(`  game            ${a.game} at ${a.target}x target`);
  console.log(`  house edge      ${(a.edge * 100).toFixed(2)}%`);
  console.log(`  bankroll        ${fmt(a.bankroll)} credits`);
  console.log(`  max win/bet     ${(a.risk * 100).toFixed(2)}% of bankroll `
    + `(${fmt(a.bankroll * a.risk)} credits at the start)`);
  console.log(`  traffic         ${a.players} players x ${a.bets} bets, `
    + `avg stake ${fmt(a.bet)}`);
  console.log(`  given back      ${(a.referral * 100).toFixed(0)}% affiliate on `
    + `${(a.referredShare * 100).toFixed(0)}% of players, `
    + `${(a.rakeback * 100).toFixed(0)}% rakeback to everyone`);
  console.log(`  simulations     ${a.runs}\n`);

  const results = [];
  for (let r = 0; r < a.runs; r += 1) results.push(runOnce(a, fair.newServerSeed()));

  const profits = results.map((x) => x.profit).sort((x, y) => x - y);
  const busts = results.filter((x) => x.busted).length;
  const mean = profits.reduce((s, x) => s + x, 0) / profits.length;
  const pick = (q) => profits[Math.min(profits.length - 1, Math.floor(q * profits.length))];
  const avgWagered = results.reduce((s, x) => s + x.wagered, 0) / results.length;
  const theoretical = avgWagered * a.edge;
  const givenBack = results.reduce((s, x) => s + x.affiliateOwed + x.rakebackOwed, 0) / results.length;

  console.log('  Expected economics per run');
  console.log('  ' + '-'.repeat(66));
  console.log(`  volume wagered            ${fmt(avgWagered)}`);
  console.log(`  theoretical gross (edge)  ${fmt(theoretical)}`);
  console.log(`  paid to affiliates+rake   ${fmt(givenBack)}`);
  console.log(`  theoretical net           ${fmt(theoretical - givenBack)}`);
  console.log(`  actual net (simulated)    ${fmt(mean)}\n`);

  console.log('  Distribution of outcomes');
  console.log('  ' + '-'.repeat(66));
  console.log(`  worst run                 ${fmt(profits[0])}`);
  console.log(`  5th percentile            ${fmt(pick(0.05))}`);
  console.log(`  median                    ${fmt(pick(0.5))}`);
  console.log(`  95th percentile           ${fmt(pick(0.95))}`);
  console.log(`  best run                  ${fmt(profits[profits.length - 1])}`);
  console.log(`  runs that went broke      ${busts} of ${a.runs} `
    + `(${((busts / a.runs) * 100).toFixed(1)}%)\n`);

  const losing = profits.filter((x) => x < 0).length;
  console.log('  Read this as');
  console.log('  ' + '-'.repeat(66));
  console.log(`  ${((1 - losing / profits.length) * 100).toFixed(1)}% of runs ended in profit.`);
  if (busts > 0) {
    console.log(`  ${busts} run(s) went broke. Cut risk (--risk) or raise the bankroll`);
    console.log('  until that column reads zero; a bust site never collects its long run.');
  } else {
    console.log('  No run went broke at this bankroll and risk cap.');
  }
  const need = theoretical > 0 ? Math.ceil((a.bankroll * 0.5) / theoretical) : 0;
  console.log(`  At this volume it takes about ${need} run(s) of the same size to earn`);
  console.log('  back half the starting bankroll.\n');
}

main();
