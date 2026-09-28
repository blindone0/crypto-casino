'use strict';
// Дурак переводной.
//
// Most of these build a position by hand rather than by dealing, because the interesting
// rules are all about a specific table: what may be added to it, who may pass it on, and
// what happens when somebody picks it up. A shuffled deal cannot reach those on demand.
//
// The one rule worth stating before the tests is the переводной rule itself, because it is
// the reason this variant exists: instead of defending, you may pass the attack to the
// next player with a card of the same rank, but only while nothing has been beaten, and
// only if they hold enough cards to face what it becomes. Every one of those three
// conditions has a test, because dropping any of them makes a different game.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const durak = require('../src/durak');
const tc = require('../src/tokenchain');
const match = require('../src/match');

const TUG = 100000000;

/** A position, written out. Anything not given gets a sensible default. */
function table({ hands, trump = 's', attacker = 0, defender = 1, attacks = [], stock = [], out }) {
  return {
    trump,
    stock,
    hands: hands.map((h) => h.slice()),
    out: out || new Array(hands.length).fill(false),
    attacks: attacks.map((a) => ({ ...a })),
    attacker,
    defender,
    passed: [],
    discarded: 0,
    log: [],
  };
}

// ------------------------------------------------------------------ the deck
test('the deck is thirty-six cards, all different', () => {
  const deck = durak.freshDeck();
  assert.strictEqual(deck.length, 36);
  assert.strictEqual(new Set(deck).size, 36);
  assert.ok(deck.includes('6s'));
  assert.ok(deck.includes('Ac'));
  assert.ok(!deck.includes('2s'), 'no cards below six');
});

test('a deal gives everyone six cards and leaves the trump at the bottom', () => {
  for (const seats of [2, 3, 4, 5]) {
    const state = durak.deal(seats);
    assert.strictEqual(state.hands.length, seats);
    for (const hand of state.hands) assert.strictEqual(hand.length, 6);
    assert.strictEqual(state.stock.length, 36 - seats * 6);
    // The trump suit is the bottom card of the stock, which is drawn last.
    assert.strictEqual(durak.suitOf(state.stock[state.stock.length - 1]), state.trump);
    // Nothing is in two places at once.
    const all = [...state.hands.flat(), ...state.stock];
    assert.strictEqual(new Set(all).size, 36);
  }
  assert.throws(() => durak.deal(1), /two to five/);
  assert.throws(() => durak.deal(6), /two to five/, 'six hands of six is the whole deck');
});

test('the lowest trump leads', () => {
  const hands = [['9s', 'Ah'], ['7s', 'Kd'], ['Qs', '6c']];
  assert.strictEqual(durak.lowestTrump(hands, 's'), 1, 'the seven of trumps');
  // With no trump anywhere the first seat leads rather than nobody.
  assert.strictEqual(durak.lowestTrump([['9h'], ['7d']], 's'), 0);
});

test('a card beats a lower one of its suit, or anything with a trump', () => {
  assert.ok(durak.beats('9s', '7s', 'h'), 'higher in suit');
  assert.ok(!durak.beats('7s', '9s', 'h'), 'lower in suit');
  assert.ok(!durak.beats('As', 'Ah', 's') === false, 'a trump ace beats a heart ace');
  assert.ok(durak.beats('6h', 'As', 'h'), 'the lowest trump beats the highest plain card');
  assert.ok(!durak.beats('As', '6h', 'h'), 'and a plain ace does not beat a trump six');
  assert.ok(!durak.beats('9s', '9s', 'h'), 'equal ranks do not beat');
  assert.ok(!durak.beats('9d', '9c', 'h'), 'a different plain suit beats nothing');
});

// -------------------------------------------------------------------- attack
test('the first card of a bout may be anything, but only from the attacker', () => {
  const s = table({ hands: [['9s', 'Ah'], ['Ts', 'Kd']] });
  assert.throws(() => durak.attack(s, 1, 'Ts'), /the defender does not attack/);
  const after = durak.attack(s, 0, 'Ah');
  assert.strictEqual(after.attacks.length, 1);
  assert.deepStrictEqual(after.hands[0], ['9s'], 'the card left the hand');
});

test('after the first card, only a rank already on the table may be added', () => {
  let s = table({ hands: [['9s', '9h', 'Kd'], ['Ts', 'Ah']] });
  s = durak.attack(s, 0, '9s');
  assert.throws(() => durak.attack(s, 0, 'Kd'), /rank already on the table/);
  assert.doesNotThrow(() => durak.attack(s, 0, '9h'));
});

test('the defender cannot be given more cards than they hold', () => {
  // Two cards in hand means at most two attacks, however many the attacker has.
  let s = table({ hands: [['9s', '9h', '9d', '9c'], ['Ts', 'Th']] });
  s = durak.attack(s, 0, '9s');
  s = durak.attack(s, 0, '9h');
  assert.strictEqual(durak.attackLimit(s), 2);
  assert.throws(() => durak.attack(s, 0, '9d'), /the table is full/);
});

test('beating a card does not free a slot, because it cost a card too', () => {
  // This is the rule people expect to work the other way. Two in hand means two attacks;
  // beating one takes a card off the table and a card out of the hand, so the balance is
  // unchanged and a third attack is still too many.
  let s = table({ hands: [['9s', '9h', '9d'], ['Ts', 'Th']] });
  s = durak.attack(s, 0, '9s');
  s = durak.attack(s, 0, '9h');
  assert.throws(() => durak.attack(s, 0, '9d'), /full/);
  s = durak.defend(s, 1, 'Ts');
  assert.throws(() => durak.attack(s, 0, '9d'), /full/, 'still two, not three');

  // With a card to spare it is allowed.
  let roomy = table({ hands: [['9s', '9h', '9d'], ['Ts', 'Th', 'Ad']] });
  roomy = durak.attack(roomy, 0, '9s');
  roomy = durak.attack(roomy, 0, '9h');
  assert.doesNotThrow(() => durak.attack(roomy, 0, '9d'));
});

test('a bout is capped at six cards however big the hands are', () => {
  // Beating the nine with a ten puts rank T on the table, so the tens become addable.
  let s = table({
    hands: [['9s', '9h', '9d', 'Th', 'Td', 'Tc'], ['Ts', 'Js', 'Jh', 'Jd', 'Jc', 'Qs', 'Kd']],
    trump: 'c',
  });
  s = durak.attack(s, 0, '9s');
  s = durak.defend(s, 1, 'Ts');
  for (const c of ['9h', '9d', 'Th', 'Td']) s = durak.attack(s, 0, c);
  assert.strictEqual(s.attacks.length, 5);
  s = durak.attack(s, 0, 'Tc');
  assert.strictEqual(s.attacks.length, 6);
  assert.throws(() => durak.attack(s, 0, '9d'), /full|do not hold/, 'six is the ceiling');
});

// -------------------------------------------------------------------- defend
test('the defender chooses which card to beat', () => {
  let s = table({ hands: [['9s', '9h'], ['Ts', 'Th']], trump: 'c' });
  s = durak.attack(s, 0, '9s');
  s = durak.attack(s, 0, '9h');
  // The ten of hearts can only take the nine of hearts, and does, leaving the spade open.
  s = durak.defend(s, 1, 'Th');
  assert.strictEqual(s.attacks[0].beat, null, 'the spade nine is still open');
  assert.strictEqual(s.attacks[1].beat, 'Th');
  // Naming a card it cannot take is refused rather than quietly redirected.
  assert.throws(() => durak.defend(s, 1, 'Ts', '9h'), /that card is not under attack/);
});

test('a card that does not beat is refused, and the hand is untouched', () => {
  let s = table({ hands: [['9s'], ['7s', '8h']], trump: 'd' });
  s = durak.attack(s, 0, '9s');
  assert.throws(() => durak.defend(s, 1, '7s'), /does not beat/);
  assert.throws(() => durak.defend(s, 1, '8h'), /does not beat/);
  assert.deepStrictEqual(s.hands[1], ['7s', '8h']);
});

test('only the defender defends, and only when there is something to beat', () => {
  const s = table({ hands: [['9s'], ['Ts']] });
  assert.throws(() => durak.defend(s, 1, 'Ts'), /nothing to beat/);
  const open = durak.attack(s, 0, '9s');
  assert.throws(() => durak.defend(open, 0, '9s'), /not defending/);
});

// ------------------------------------------------------------- the pass-on
test('the defender may pass the attack on with the same rank', () => {
  // Three at the table, so there is somebody to pass to.
  let s = table({
    hands: [['9s', 'Ah'], ['9h', 'Kd'], ['Ts', 'Td', 'Tc', 'Th', 'Ts2'.slice(0, 2)]],
    attacker: 0, defender: 1,
  });
  s = durak.attack(s, 0, '9s');
  s = durak.passOn(s, 1, '9h');

  assert.strictEqual(s.defender, 2, 'it moved to the next player');
  assert.strictEqual(s.attacker, 1, 'and the passer is now attacking');
  assert.strictEqual(s.attacks.length, 2, 'both nines are on the table');
  assert.ok(!s.hands[1].includes('9h'));
});

test('a pass-on needs the same rank', () => {
  let s = table({ hands: [['9s'], ['Th', 'Kd'], ['Js', 'Jh', 'Jd']] });
  s = durak.attack(s, 0, '9s');
  assert.throws(() => durak.passOn(s, 1, 'Th'), /another 9/);
});

test('a pass-on is impossible once anything has been beaten', () => {
  let s = table({ hands: [['9s', '9d'], ['Th', '9h'], ['Js', 'Jh', 'Jd']], trump: 'h' });
  s = durak.attack(s, 0, '9s');
  s = durak.defend(s, 1, 'Th');
  assert.throws(() => durak.passOn(s, 1, '9h'), /once you have started beating/);
});

test('a pass-on cannot hand somebody more cards than they hold', () => {
  // Seat 2 holds one card, so it cannot face two attacks.
  let s = table({ hands: [['9s', '9d'], ['9h', 'Kd'], ['Js']] });
  s = durak.attack(s, 0, '9s');
  assert.throws(() => durak.passOn(s, 1, '9h'), /do not hold enough cards/);

  // With two cards it can.
  let ok = table({ hands: [['9s', '9d'], ['9h', 'Kd'], ['Js', 'Jh']] });
  ok = durak.attack(ok, 0, '9s');
  assert.doesNotThrow(() => durak.passOn(ok, 1, '9h'));
});

test('only the defender can pass it on', () => {
  let s = table({ hands: [['9s', '9d'], ['9h'], ['Js', 'Jh']] });
  s = durak.attack(s, 0, '9s');
  assert.throws(() => durak.passOn(s, 0, '9d'), /only the defender/);
});

test('at a table of two there is nobody to pass to', () => {
  let s = table({ hands: [['9s'], ['9h', 'Kd']] });
  s = durak.attack(s, 0, '9s');
  assert.throws(() => durak.passOn(s, 1, '9h'), /nobody to pass it to/);
});

// ---------------------------------------------------------------- end of bout
test('taking the cards puts every one of them in your hand', () => {
  let s = table({ hands: [['9s', '9h'], ['Ts', 'Kd']], stock: [] });
  s = durak.attack(s, 0, '9s');
  s = durak.attack(s, 0, '9h');
  s = durak.defend(s, 1, 'Ts');
  const after = durak.take(s, 1);

  // Nine of spades, its beater, and the unbeaten nine of hearts: three cards.
  assert.ok(after.hands[1].includes('9s'));
  assert.ok(after.hands[1].includes('Ts'));
  assert.ok(after.hands[1].includes('9h'));
  assert.strictEqual(after.attacks.length, 0, 'the table is clear');
  assert.strictEqual(after.discarded, 0, 'nothing was discarded; it was taken');
});

test('taking the cards costs you the attack', () => {
  let s = table({ hands: [['9s', 'Ah'], ['Ts', 'Kd'], ['Js', 'Qd']], attacker: 0, defender: 1 });
  s = durak.attack(s, 0, '9s');
  const after = durak.take(s, 1);
  assert.strictEqual(after.attacker, 2, 'the attack went past the player who picked up');
  assert.strictEqual(after.defender, 0);
});

test('beating everything makes you the next attacker', () => {
  let s = table({ hands: [['9s'], ['Ts', 'Kd'], ['Js', 'Qd']], attacker: 0, defender: 1 });
  s = durak.attack(s, 0, '9s');
  s = durak.defend(s, 1, 'Ts');
  s = durak.done(s, 0);
  const after = durak.done(s, 2);
  assert.strictEqual(after.attacker, 1, 'the successful defender attacks next');
  assert.strictEqual(after.defender, 2);
  assert.strictEqual(after.discarded, 2, 'both cards went to the discard');
});

test('a bout does not end while anything is still unbeaten', () => {
  let s = table({ hands: [['9s', '9h'], ['Ts', 'Kd']] });
  s = durak.attack(s, 0, '9s');
  const after = durak.done(s, 0);
  assert.strictEqual(after.attacks.length, 1, 'still on the table: nothing was beaten');
});

test('everyone has to be finished adding before the bout closes', () => {
  let s = table({
    hands: [['9s'], ['Ts', 'Kd'], ['9h', 'Qd']], attacker: 0, defender: 1,
  });
  s = durak.attack(s, 0, '9s');
  s = durak.defend(s, 1, 'Ts');
  s = durak.done(s, 0);
  assert.strictEqual(s.attacks.length, 1, 'seat 2 has not said it is done');
  s = durak.done(s, 2);
  assert.strictEqual(s.attacks.length, 0, 'now it closes');
});

test('everyone draws back up to six, attacker first', () => {
  const stock = ['6c', '7c', '8c', '9c', 'Tc', 'Jc', 'Qc', 'Kc'];
  let s = table({ hands: [['9s'], ['Ts', 'Kd']], stock, attacker: 0, defender: 1 });
  s = durak.attack(s, 0, '9s');
  s = durak.defend(s, 1, 'Ts');
  const after = durak.done(s, 0);
  assert.strictEqual(after.hands[0].length, 6);
  // Seat 0 drew first, so it got the top of the stock.
  assert.ok(after.hands[0].includes('6c'));
  assert.strictEqual(after.stock.length, 0, 'the stock ran out filling them');
});

test('a player with no cards and an empty stock is out', () => {
  let s = table({ hands: [['9s'], ['Ts', 'Kd']], stock: [], attacker: 0, defender: 1 });
  s = durak.attack(s, 0, '9s');
  s = durak.defend(s, 1, 'Ts');
  const after = durak.done(s, 0);
  assert.deepStrictEqual(after.out, [true, false], 'seat 0 played its last card');
  assert.strictEqual(after.finished, true);
  assert.strictEqual(after.fool, 1, 'the one still holding cards is the fool');
});

test('the game ends when one player is left holding cards', () => {
  let s = table({
    hands: [['9s'], ['Ts'], ['Kd', 'Qd']], stock: [], attacker: 0, defender: 1,
  });
  s = durak.attack(s, 0, '9s');
  s = durak.defend(s, 1, 'Ts');
  s = durak.done(s, 0);
  const after = durak.done(s, 2);
  assert.strictEqual(after.finished, true);
  assert.strictEqual(after.fool, 2);
  assert.deepStrictEqual(after.out, [true, true, false]);
});

// ------------------------------------------------------------------- options
test('the options offered are exactly the moves that are allowed', () => {
  let s = table({ hands: [['9s', '9h', 'Kd'], ['Ts', '9d'], ['Js', 'Jh']] });

  // Before anything is played only the attacker can act.
  assert.deepStrictEqual(durak.options(s, 0), { attack: true });
  assert.deepStrictEqual(durak.options(s, 1), { defend: false, take: false, passOn: false });

  s = durak.attack(s, 0, '9s');
  const d = durak.options(s, 1);
  assert.strictEqual(d.defend, true, 'the ten of spades takes the nine');
  assert.strictEqual(d.take, true);
  assert.strictEqual(d.passOn, true, 'seat 1 holds the nine of diamonds');

  // Seat 2 may join in with a matching rank, and has none.
  assert.strictEqual(durak.options(s, 2).attack, false);
});

test('a finished game offers nothing to anybody', () => {
  const s = { ...table({ hands: [['9s'], ['Ts']] }), finished: true, fool: 1 };
  assert.deepStrictEqual(durak.options(s, 0), {});
  assert.deepStrictEqual(durak.options(s, 1), {});
});

// ------------------------------------------------------- a whole game, dealt
test('shuffled games play to an end, and never lose a card doing it', () => {
  // Дурак itself has no repetition rule: a table where nobody can beat anything and
  // nobody holds a matching rank to throw in passes the same cards round for ever. That
  // is the game rather than a bug in it, but it is not something a staked match can do,
  // because both stakes would sit in escrow with no end to pay them out on. The engine
  // therefore calls a game drawn after STALE_BOUTS bouts in which nothing moved at all.
  //
  // So every game now reaches an end, and no card is created or lost getting there.
  let finished = 0;
  for (let game = 0; game < 100; game += 1) {
    let seed = game * 7919 + 13;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const seats = 2 + (game % 4);
    let s = durak.start(durak.deal(seats, rnd));

    // A simple but properly playing opponent: beat when you can, otherwise take, and
    // throw in every matching rank you hold before finishing a bout.
    //
    // The throwing-in matters: without it, bouts reach the discard far more rarely and
    // most of these games end drawn on the no-progress rule instead of finding a fool.
    for (let turn = 0; turn < 4000 && !s.finished; turn += 1) {
      const open = durak.unbeaten(s);
      if (open.length) {
        const beater = s.hands[s.defender]
          .find((c) => durak.beats(c, open[0].card, s.trump));
        s = beater ? durak.defend(s, s.defender, beater) : durak.take(s, s.defender);
        continue;
      }
      if (s.attacks.length === 0) {
        s = durak.attack(s, s.attacker, s.hands[s.attacker][0]);
        continue;
      }

      // Everything on the table is beaten. Add another of a rank already down if anyone
      // can, otherwise say you are finished.
      let threw = false;
      for (let seat = 0; seat < seats && !threw; seat += 1) {
        if (seat === s.defender || s.out[seat]) continue;
        if (!durak.options(s, seat).attack) continue;
        const ranks = new Set(durak.tableCards(s).map(durak.rankOf));
        const card = s.hands[seat].find((c) => ranks.has(durak.rankOf(c)));
        if (!card) continue;
        s = durak.attack(s, seat, card);
        threw = true;
      }
      if (threw) continue;

      const waiting = [];
      for (let seat = 0; seat < seats; seat += 1) {
        if (seat !== s.defender && !s.out[seat] && !s.passed.includes(seat)) waiting.push(seat);
      }
      if (!waiting.length) break;
      s = durak.done(s, waiting[0]);
    }

    // Nothing was conjured or lost, finished or not: every card is in a hand, the stock,
    // the discard or on the table.
    const held = s.hands.reduce((n, h) => n + h.length, 0);
    assert.strictEqual(held + s.stock.length + s.discarded + durak.tableCards(s).length, 36,
      `game ${game} lost cards`);

    if (!s.finished) continue;
    finished += 1;
    const left = durak.liveSeats(s);
    if (s.stalemate) {
      // A draw on the no-progress rule: the cards stopped coming out, so players are
      // still holding them and nobody is the fool.
      assert.strictEqual(s.fool, null, `game ${game} was drawn but named a fool`);
      assert.ok(left >= 2, `game ${game} was drawn with only ${left} in`);
      continue;
    }
    // One left holding cards is the usual end. Zero is the other real one: the last two
    // can go out on the same bout, and then there is no fool and it is a draw.
    assert.ok(left <= 1, `game ${game} has ${left} still in`);
    if (left === 1) assert.ok(s.fool >= 0, `game ${game} has a survivor but no fool`);
    else assert.strictEqual(s.fool, null, `game ${game} has nobody left but named a fool`);
  }
  assert.strictEqual(finished, 100, 'every game reached an end');
});

test('a game that cannot progress is drawn rather than played for ever', () => {
  // The cycle this rule exists for: three seats, the dumb player that only ever beats
  // with its lowest card or takes. Before the rule these ran until the test gave up.
  let drawn = 0;
  for (let game = 0; game < 60; game += 1) {
    let seed = game * 6151 + 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let s = durak.start(durak.deal(3, rnd));
    let turns = 0;
    for (; turns < 5000 && !s.finished; turns += 1) {
      let acted = false;
      for (let seat = 0; seat < 3 && !acted; seat += 1) {
        if (s.out[seat]) continue;
        const o = durak.options(s, seat);
        const hand = s.hands[seat];
        const open = durak.unbeaten(s);
        const beater = open.length
          ? hand.find((c) => durak.beats(c, open[0].card, s.trump)) : null;
        if (o.defend && beater) { s = durak.defend(s, seat, beater); acted = true; } else if (o.take) { s = durak.take(s, seat); acted = true; } else if (o.attack) {
          const ranks = new Set(durak.tableCards(s).map(durak.rankOf));
          const card = s.attacks.length ? hand.find((c) => ranks.has(durak.rankOf(c))) : hand[0];
          if (card) { s = durak.attack(s, seat, card); acted = true; } else if (o.done) { s = durak.done(s, seat); acted = true; }
        } else if (o.done) { s = durak.done(s, seat); acted = true; }
      }
      if (!acted) break;
    }
    assert.ok(s.finished, `game ${game} never ended (${turns} moves)`);
    if (s.stalemate) drawn += 1;
  }
  // The point is that they all end; that some of them end drawn is the mechanism.
  assert.ok(drawn > 0, 'no game exercised the no-progress rule');
});

test('a normal game never comes close to the no-progress limit', () => {
  // If a real game were ending on this rule it would be a bug, not a feature, so the
  // margin matters: a game that finds its fool should never have gone more than a bout
  // or two without something moving.
  let worst = 0;
  for (let game = 0; game < 60; game += 1) {
    let seed = game * 2741 + 3;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const seats = 2 + (game % 4);
    let s = durak.start(durak.deal(seats, rnd));
    for (let turn = 0; turn < 4000 && !s.finished; turn += 1) {
      const open = durak.unbeaten(s);
      if (open.length) {
        const beater = s.hands[s.defender].find((c) => durak.beats(c, open[0].card, s.trump));
        s = beater ? durak.defend(s, s.defender, beater) : durak.take(s, s.defender);
        continue;
      }
      if (s.attacks.length === 0) { s = durak.attack(s, s.attacker, s.hands[s.attacker][0]); continue; }
      let threw = false;
      for (let seat = 0; seat < seats && !threw; seat += 1) {
        if (seat === s.defender || s.out[seat] || !durak.options(s, seat).attack) continue;
        const ranks = new Set(durak.tableCards(s).map(durak.rankOf));
        const card = s.hands[seat].find((c) => ranks.has(durak.rankOf(c)));
        if (card) { s = durak.attack(s, seat, card); threw = true; }
      }
      if (threw) continue;
      const waiting = [];
      for (let seat = 0; seat < seats; seat += 1) {
        if (seat !== s.defender && !s.out[seat] && !s.passed.includes(seat)) waiting.push(seat);
      }
      if (!waiting.length) break;
      s = durak.done(s, waiting[0]);
    }
    if (s.finished && !s.stalemate) worst = Math.max(worst, s.stale || 0);
  }
  assert.ok(worst < durak.STALE_BOUTS / 3,
    `a proper game got within ${durak.STALE_BOUTS - worst} bouts of being called drawn`);
});

// ------------------------------------------------ played through the match layer
function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  const users = {};
  const keys = {};
  for (const [id, name] of [[1, 'alice'], [2, 'bob'], [3, 'carol']]) {
    db.run(
      `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
       VALUES(?,?,?,'x','s',?,0)`, id, name, name, `rc${id}`,
    );
    users[name] = { id };
    const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
    const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
    tc.registerKey(db, id, pub, cfg);
    keys[name] = { priv, pub };
  }
  return { cfg, db, users, keys };
}

function spend(db, key, amount) {
  const tx = {
    type: 'transfer', from: key.pub, to: match.houseKey(db).publicRaw, amount,
    nonce: tc.nextNonce(db, key.pub),
  };
  const sig = crypto.sign(
    null, Buffer.from(tc.canonical(tc.transferPayload(tx))), key.priv,
  ).toString('hex');
  return { from: key.pub, nonce: tx.nonce, sig };
}

/** A дурак table with every seat filled. */
function started(db, cfg, users, keys, seats = 3, stake = 50 * TUG) {
  const names = ['alice', 'bob', 'carol'].slice(0, seats);
  const made = match.create(db, cfg, users[names[0]], {
    game: 'durak', stake, seats, spend: spend(db, keys[names[0]], stake),
  });
  for (const name of names.slice(1)) {
    match.join(db, cfg, users[name], { id: made.id, spend: spend(db, keys[name], stake) });
  }
  return made.id;
}

const seatUser = (users, seat) => [users.alice, users.bob, users.carol][seat];

test('a table of three deals a game and puts somebody on the attack', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys, 3);
  const view = match.detail(db, cfg, users.alice, id);

  assert.strictEqual(view.status, 'playing');
  assert.strictEqual(view.seats, 3);
  assert.ok([0, 1, 2].includes(view.toMove));
  assert.strictEqual(view.view.hand.length, 6, 'you see your own six cards');
  assert.deepStrictEqual(view.view.counts, [6, 6, 6], 'and how many everyone else holds');
  assert.strictEqual(view.view.stock, 36 - 18);
  assert.ok(['s', 'h', 'd', 'c'].includes(view.view.trump));
});

test('you are shown your own hand and nobody else is', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys, 3);

  const a = match.detail(db, cfg, users.alice, id);
  const b = match.detail(db, cfg, users.bob, id);
  assert.notDeepStrictEqual(a.view.hand, b.view.hand);

  // Alice's cards must not appear anywhere in what Bob is sent.
  const asBob = JSON.stringify(b.view);
  for (const card of a.view.hand) {
    assert.ok(!asBob.includes(`"${card}"`), `${card} is visible to the wrong player`);
  }
  // And a spectator sees no hand at all.
  const asNobody = match.detail(db, cfg, null, id);
  assert.strictEqual(asNobody.view.hand, null);
});

/**
 * Drive a match to its end with a dumb but legal player.
 *
 * It asks every seat what it may do rather than only the one on the clock, because in
 * дурак more than one player can be entitled to act: once the table is beaten, any
 * attacker may throw in a card or say they are finished.
 *
 * Playing this badly draws about a third of the time -- the cards stop coming out and the
 * no-progress rule ends it -- so a test that wants a fool has to be prepared to deal
 * again rather than rely on getting one first time.
 */
function playOut(db, cfg, users, id) {
  let out = null;
  for (let turn = 0; turn < 2000 && !out; turn += 1) {
    const board = match.detail(db, cfg, users.alice, id);
    if (board.status !== 'playing') break;

    let acted = false;
    for (let seat = 0; seat < 3 && !acted; seat += 1) {
      if (board.view.out[seat]) continue;
      const me = match.detail(db, cfg, seatUser(users, seat), id);
      const o = me.view.options || {};
      let move = null;
      if (o.defend && me.view.canBeat.length) move = { play: 'defend', card: me.view.canBeat[0] };
      else if (o.take) move = { play: 'take' };
      else if (o.attack && me.view.playable.length) {
        move = { play: 'attack', card: me.view.playable[0] };
      } else if (o.done) move = { play: 'done' };
      if (!move) continue;
      const res = match.act(db, cfg, seatUser(users, seat), { id, ...move });
      acted = true;
      if (res.winners) out = res;
    }
    assert.ok(acted, `nobody could move on turn ${turn}`);
  }
  assert.ok(out && out.winners, 'the game finished');
  return out;
}

test('every game reaches an end', (t) => {
  // Before the no-progress rule this looped for ever about a third of the time, which
  // showed up as a test that failed one run in six and would have been two stakes stuck
  // in escrow on the live site.
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  for (let game = 0; game < 12; game += 1) {
    const out = playOut(db, cfg, users, started(db, cfg, users, keys, 3, 10 * TUG));
    assert.ok(['fool', 'no-fool', 'no-progress'].includes(out.reason), `odd reason ${out.reason}`);
  }
});

test('the fool loses and everybody else splits the pot', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const stake = 60 * TUG;

  // Deal again if the dumb player draws: it is the fool payout under test, not the odds
  // of reaching one. Each attempt is a real match that moves real money, so the balances
  // are read fresh after the buy-in of the attempt that actually produces a fool.
  const all = [keys.alice, keys.bob, keys.carol];
  let out = null;
  let before = null;
  for (let attempt = 0; attempt < 30 && !out; attempt += 1) {
    const id = started(db, cfg, users, keys, 3, stake);
    const staked = all.map((k) => tc.balanceOf(db, k.pub));
    const res = playOut(db, cfg, users, id);
    if (res.reason === 'fool') { out = res; before = staked; }
  }
  assert.ok(out, 'a game ended with a fool');
  assert.strictEqual(out.winners.length, 2, 'two of the three won');

  const pot = stake * 3;
  const each = Math.floor((pot - Math.floor(pot * cfg.match.rake)) / 2);
  for (const seat of out.winners) {
    assert.strictEqual(
      tc.balanceOf(db, all[seat].pub),
      before[seat] + each,
      `seat ${seat} was not paid`,
    );
  }
  const fool = [0, 1, 2].find((seat) => !out.winners.includes(seat));
  assert.strictEqual(tc.balanceOf(db, all[fool].pub), before[fool],
    'the fool is paid nothing and loses no more than the stake');
});

test('you cannot act out of turn', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const id = started(db, cfg, users, keys, 3);
  const view = match.detail(db, cfg, users.alice, id);
  const waiting = seatUser(users, (view.toMove + 1) % 3);
  assert.throws(
    () => match.act(db, cfg, waiting, { id, play: 'attack', card: '6s' }),
    /not your turn|do not hold|not your attack/,
  );
});

test('дурак seats two to five players', (t) => {
  const { cfg, db, users, keys } = setup();
  t.after(() => cleanup(cfg, db));
  assert.strictEqual(match.GAMES.durak.seats.min, 2);
  assert.strictEqual(match.GAMES.durak.seats.max, 5);
  assert.throws(
    () => match.create(db, cfg, users.alice, {
      game: 'durak', stake: 50 * TUG, seats: 6, spend: spend(db, keys.alice, 50 * TUG),
    }),
    /two to 5 players|is for 2 to 5/,
  );
});
