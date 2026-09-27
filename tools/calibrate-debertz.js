'use strict';
// Measures how often the trump-chooser wins at Debertz, and by how much.
//
// Like Preferans, this game has no closed-form win probability: the answer depends on how
// well the hand is played. So it is measured by simulating the bot playing both seats,
// and the resulting distribution is pasted into src/games/debertz.js.
//
// Re-run this and update OUTCOMES whenever the bot's card play or hand evaluation
// changes. test/debertz.test.js re-simulates and fails if the stored table has drifted,
// so a change to the bot cannot silently leave the payouts priced against the old one.
//
//   node tools/calibrate-debertz.js [hands]
const deb = require('../src/games/debertz');
const fair = require('../src/fair');

const N = Number(process.argv[2]) || 40000;
const BANDS = [0, 20, 50, 90, 140];

function run(n) {
  const seed = fair.newServerSeed();
  const atLeast = new Array(BANDS.length).fill(0);
  let bete = 0;
  let marginSum = 0;
  let wins = 0;
  const margins = [];

  for (let i = 0; i < n; i += 1) {
    const r = deb.simulateHand(seed, 'calibrate', i);
    if (r.bete) bete += 1;
    else {
      wins += 1;
      for (const [b, threshold] of BANDS.entries()) {
        if (r.margin >= threshold) atLeast[b] += 1;
      }
    }
    marginSum += r.margin;
    margins.push(r.margin);
  }
  margins.sort((a, b) => a - b);
  return {
    probs: atLeast.map((c) => c / n),
    beteRate: bete / n,
    winRate: wins / n,
    meanMargin: marginSum / n,
    medianMargin: margins[Math.floor(margins.length / 2)],
    p90: margins[Math.floor(margins.length * 0.9)],
  };
}

const started = Date.now();
const out = run(N);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\n  Debertz chooser calibration (${N} hands, ${seconds}s)`);
console.log('  ' + '-'.repeat(56));
console.log(`  chooser wins      ${(out.winRate * 100).toFixed(2)}%`);
console.log(`  goes bete         ${(out.beteRate * 100).toFixed(2)}%`);
console.log(`  mean margin       ${out.meanMargin.toFixed(1)} points`);
console.log(`  median margin     ${out.medianMargin}`);
console.log(`  90th percentile   ${out.p90}\n`);

for (const [i, threshold] of BANDS.entries()) {
  const p = out.probs[i];
  console.log(`  wins by >= ${String(threshold).padStart(3)}   ${(p * 100).toFixed(2).padStart(6)}%  `
    + '#'.repeat(Math.round(p * 60)));
}

console.log('\n  Paste into src/games/debertz.js as OUTCOMES:\n');
console.log('const OUTCOMES = {');
console.log(`  samples: ${N},`);
console.log(`  measured: '${new Date().toISOString().slice(0, 10)}',`);
console.log('  // Probability the chooser wins by at least this margin. Index 0 is "won at all".');
console.log(`  bands: [${BANDS.join(', ')}],`);
console.log(`  probs: [${out.probs.map((p) => p.toFixed(4)).join(', ')}],`);
console.log('};\n');
