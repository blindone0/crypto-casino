// Дурак переводной.
//
// Your hand at the bottom, the table in the middle, everyone else around the top with the
// number of cards they hold. The stock and the turned trump sit to one side.
//
// The board offers only the moves the server said were available, and only the cards it
// said were playable. It does not work out for itself whether a nine beats a nine: that
// answer arrives with the position, and a board that guessed would eventually guess
// differently from the server holding the stake.

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED = new Set(['h', 'd']);
const RANK = {
  6: '6', 7: '7', 8: '8', 9: '9', T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A',
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** One card face. */
function cardEl(card, extra = '') {
  const rank = card[0];
  const suit = card[1];
  const node = el('div', `card ${RED.has(suit) ? 'red' : 'black'} ${extra}`);
  node.append(el('span', 'r', RANK[rank] || rank), el('span', 's', SUIT[suit] || suit));
  node.dataset.card = card;
  return node;
}

const labels = {
  ru: {
    take: 'Беру',
    done: 'Бито',
    pass: 'Перевести',
    trump: 'Козырь',
    stock: 'В колоде',
    yourTurn: 'Ваш ход',
    waiting: 'Ход соперника',
    defend: 'Отбейтесь или берите',
    attack: 'Ходите',
    add: 'Можно подкинуть',
    fool: 'Дурак',
    out: 'вышел',
    pickCard: 'Выберите карту',
  },
  en: {
    take: 'Take',
    done: 'Done',
    pass: 'Pass it on',
    trump: 'Trumps',
    stock: 'In the deck',
    yourTurn: 'Your turn',
    waiting: 'Waiting',
    defend: 'Beat it or take it',
    attack: 'Lead a card',
    add: 'You can throw one in',
    fool: 'The fool',
    out: 'out',
    pickCard: 'Pick a card',
  },
};

export function board(host, opts = {}) {
  const state = {
    view: opts.view || null,
    seat: opts.seat ?? null,
    seats: opts.seats || 2,
    myTurn: !!opts.myTurn,
    onAct: opts.onAct || (() => {}),
    lang: opts.lang === 'ru' ? 'ru' : 'en',
    // A card chosen but not yet committed, when there is more than one thing it could do.
    picked: null,
  };

  const root = el('div', 'durak');
  host.replaceChildren(root);
  const t = (k) => labels[state.lang][k];

  /** Send a move and forget any half-made choice. */
  const play = (move) => { state.picked = null; state.onAct(move); };

  function onCard(card) {
    if (!state.myTurn) return;
    const o = state.view.options || {};
    const open = state.view.attacks.filter((a) => !a.beat);

    // Defending is the common case and needs no second click: the server works out which
    // attack this card takes.
    if (o.defend && state.view.canBeat.includes(card)) { play({ play: 'defend', card }); return; }
    // Passing it on and throwing one in can both look like the same card, so if both are
    // possible the player says which.
    const canPass = o.passOn && open.length
      && card[0] === state.view.attacks[0].card[0];
    if (canPass && o.attack && state.view.playable.includes(card)) {
      state.picked = card;
      draw();
      return;
    }
    if (canPass) { play({ play: 'pass', card }); return; }
    if (o.attack && state.view.playable.includes(card)) { play({ play: 'attack', card }); return; }
  }

  function drawTable() {
    const box = el('div', 'durak-table');
    if (!state.view.attacks.length) {
      box.append(el('div', 'hint', state.myTurn ? t('attack') : t('waiting')));
      return box;
    }
    for (const a of state.view.attacks) {
      const pair = el('div', 'pair');
      pair.append(cardEl(a.card, 'attack'));
      if (a.beat) pair.append(cardEl(a.beat, 'beat'));
      box.append(pair);
    }
    return box;
  }

  function drawOthers() {
    const row = el('div', 'durak-seats');
    for (let i = 1; i < state.seats; i += 1) {
      const seat = ((state.seat ?? 0) + i) % state.seats;
      const box = el('div', `durak-seat${state.view.defender === seat ? ' defending' : ''}`);
      box.append(
        el('div', 'k', `#${seat + 1}${state.view.out[seat] ? ` (${t('out')})` : ''}`),
        el('div', 'count', String(state.view.counts[seat])),
      );
      row.append(box);
    }
    return row;
  }

  function draw() {
    if (!state.view) { root.replaceChildren(); return; }
    const v = state.view;
    const o = v.options || {};

    const deck = el('div', 'durak-deck');
    deck.append(
      el('div', 'k', `${t('trump')} ${SUIT[v.trump] || v.trump}`),
      v.trumpCard ? cardEl(v.trumpCard, 'trump-card') : el('div', 'k', ''),
      el('div', 'k', `${t('stock')}: ${v.stock}`),
    );

    const hand = el('div', 'durak-hand');
    for (const card of v.hand || []) {
      const playable = state.myTurn
        && (v.canBeat.includes(card) || v.playable.includes(card)
          || (o.passOn && v.attacks.length && card[0] === v.attacks[0].card[0]));
      const node = cardEl(card, playable ? 'playable' : 'dim');
      if (state.picked === card) node.classList.add('picked');
      if (playable) node.onclick = () => onCard(card);
      hand.append(node);
    }

    const buttons = el('div', 'row durak-actions');
    if (state.picked) {
      // Two things this card could do, so ask rather than guess.
      buttons.append(
        el('button', 'primary', t('pass')),
        el('button', '', t('add') || 'Add'),
        el('button', 'tiny', '×'),
      );
      const [passBtn, addBtn, cancel] = [...buttons.children];
      passBtn.onclick = () => play({ play: 'pass', card: state.picked });
      addBtn.onclick = () => play({ play: 'attack', card: state.picked });
      cancel.onclick = () => { state.picked = null; draw(); };
    } else {
      if (o.take) {
        const b = el('button', 'primary', t('take'));
        b.onclick = () => play({ play: 'take' });
        buttons.append(b);
      }
      if (o.done) {
        const b = el('button', '', t('done'));
        b.onclick = () => play({ play: 'done' });
        buttons.append(b);
      }
    }

    const status = el('div', 'hint durak-status');
    if (v.finished) status.textContent = `${t('fool')}: #${(v.fool ?? 0) + 1}`;
    else if (!state.myTurn) status.textContent = t('waiting');
    else if (o.defend || o.take) status.textContent = t('defend');
    else if (o.attack) status.textContent = v.attacks.length ? t('add') : t('attack');
    else status.textContent = t('yourTurn');

    root.replaceChildren(drawOthers(), deck, drawTable(), status, hand, buttons);
  }

  draw();

  return {
    update(next) {
      Object.assign(state, next);
      // A card chosen for a move that has already gone through means nothing now.
      if (state.picked && !(state.view.hand || []).includes(state.picked)) state.picked = null;
      draw();
    },
    get element() { return root; },
  };
}

export const meta = { key: 'durak' };
