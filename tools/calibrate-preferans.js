'use strict';
// Measures how many tricks a competent declarer takes, which is what the Preferans
// payout table is built from.
//
// Unlike dice or slots, this game has no closed-form win probability: the answer depends
// on how well the hand is played. So it is measured by simulating the bot playing all
// three seats, and the resulting distribution is pasted into src/games/preferans.js.
//
// Re-run this and update the constant whenever the bot's play or hand evaluation changes.
// test/preferans.test.js re-simulates and fails if the stored table has drifted, so a
// change to the bot cannot silently leave the payouts calibrated against the old one.
//
//   node tools/calibrate-preferans.js [hands]
const pref = require('../src/games/preferans');
const fair = require('../src/fair');

const N = Number(process.argv[2]) || 40000;

function run(n) {
  const seed = fair.newServerSeed();
  const dist = new Array(pref.HAND_SIZE + 1).fill(0);
  let total = 0;

  for (let i = 0; i < n; i += 1) {
    const d = pref.deal(seed, 'calibrate', i);
    const withTalon = pref.sortHand([...d.hands[0], ...d.talon]);

    let trump = null;
    let best = -1;
    for (const t of [...pref.SUITS, pref.NO_TRUMP]) {
      const est = pref.estimateTricks(withTalon, t);
      if (est > best) { best = est; trump = t; }
    }
    const discards = pref.chooseDiscards(withTalon, trump);
    const hand = withTalon.filter((c) => !discards.includes(c));

    const hands = [...d.hands];
    hands[0] = hand;
    const won = pref.playHand({
      hands, trump, declarer: 0, controller: (seat, st) => pref.chooseCard(st, seat),
    });
    dist[won[0]] += 1;
    total += won[0];
  }
  return { dist: dist.map((c) => c / n), average: total / n, samples: n };
}

const started = Date.now();
const out = run(N);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\n  Preferans declarer calibration (${N} hands, ${seconds}s)`);
console.log('  ' + '-'.repeat(52));
for (const [k, p] of out.dist.entries()) {
  if (p < 0.00005) continue;
  console.log(`  ${String(k).padStart(2)} tricks  ${(p * 100).toFixed(3).padStart(7)}%  `
    + '#'.repeat(Math.round(p * 100)));
}
const atLeast = (k) => out.dist.slice(k).reduce((s, x) => s + x, 0);
console.log(`\n  average tricks   ${out.average.toFixed(3)}`);
console.log(`  P(>= 6 tricks)   ${(atLeast(6) * 100).toFixed(2)}%`);
console.log(`  P(>= 8 tricks)   ${(atLeast(8) * 100).toFixed(2)}%`);

console.log('\n  Paste this into src/games/preferans.js as TRICK_DISTRIBUTION:\n');
console.log('const TRICK_DISTRIBUTION = {');
console.log(`  samples: ${N},`);
console.log(`  measured: '${new Date().toISOString().slice(0, 10)}',`);
console.log(`  average: ${out.average.toFixed(4)},`);
console.log(`  dist: [${out.dist.map((p) => p.toFixed(6)).join(', ')}],`);
console.log('};\n');
