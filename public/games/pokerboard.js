// Texas Hold'em, as a sit-and-go.
//
// The board draws what the server sent and offers the moves it said were available. It
// does not work out what a call costs or whether a raise is legal: those numbers arrive
// with the position, because the server is the one holding the chips.
//
// Hole cards other than your own are never in the data at all, so there is nothing here
// that could accidentally show them.

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED = new Set(['h', 'd']);
const RANK = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A',
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function cardEl(card, extra = '') {
  if (!card) return el('div', `card back ${extra}`);
  const node = el('div', `card ${RED.has(card[1]) ? 'red' : 'black'} ${extra}`);
  node.append(el('span', 'r', RANK[card[0]] || card[0]), el('span', 's', SUIT[card[1]] || card[1]));
  return node;
}

/**
 * The nine hand categories, in the order src/holdem.js ranks them.
 *
 * The server sends the category as a number rather than its English name, because a table
 * played in Russian cannot translate prose that arrived already written.
 */
const HANDS = {
  ru: ['старшая карта', 'пара', 'две пары', 'сет', 'стрит',
    'флеш', 'фулл-хаус', 'каре', 'стрит-флеш'],
  en: ['high card', 'a pair', 'two pair', 'three of a kind', 'a straight',
    'a flush', 'a full house', 'four of a kind', 'a straight flush'],
};

const labels = {
  ru: {
    fold: 'Пас', check: 'Чек', call: 'Колл', raise: 'Рейз', allin: 'Ва-банк',
    next: 'Следующая раздача', pot: 'Банк', blinds: 'Блайнды', hand: 'Раздача',
    yourTurn: 'Ваш ход', waiting: 'Ждём', allInShort: 'ва-банк', folded: 'пас',
    out: 'выбыл', wins: 'выигрывает', winner: 'Победитель',
  },
  en: {
    fold: 'Fold', check: 'Check', call: 'Call', raise: 'Raise', allin: 'All in',
    next: 'Next hand', pot: 'Pot', blinds: 'Blinds', hand: 'Hand',
    yourTurn: 'Your turn', waiting: 'Waiting', allInShort: 'all in', folded: 'folded',
    out: 'out', wins: 'wins', winner: 'Winner',
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
    raiseTo: null,
  };

  const root = el('div', 'poker');
  host.replaceChildren(root);
  const t = (k) => labels[state.lang][k];

  const send = (move, amount) => { state.raiseTo = null; state.onAct({ play: move, amount }); };

  function drawSeats() {
    const row = el('div', 'poker-seats');
    // Everyone but you, starting to your left, so the table reads the way it would look.
    for (let i = 1; i <= state.seats - 1; i += 1) {
      const seat = ((state.seat ?? 0) + i) % state.seats;
      row.append(seatBox(seat, false));
    }
    return row;
  }

  function seatBox(seat, mine) {
    const v = state.view;
    const out = v.chips[seat] === 0 && !v.dealt[seat];
    const box = el('div', `poker-seat${v.toAct === seat ? ' acting' : ''}${out ? ' out' : ''}`);
    const tags = [];
    if (v.button === seat) tags.push('D');
    if (v.folded[seat] && v.dealt[seat]) tags.push(t('folded'));
    if (v.allIn[seat]) tags.push(t('allInShort'));
    if (out) tags.push(t('out'));

    box.append(
      el('div', 'k', `#${seat + 1}${mine ? ' •' : ''}${tags.length ? `  ${tags.join(' ')}` : ''}`),
      el('div', 'chips', String(v.chips[seat])),
    );
    if (v.bets[seat] > 0) box.append(el('div', 'bet', String(v.bets[seat])));
    return box;
  }

  function drawBoard() {
    const v = state.view;
    const box = el('div', 'poker-board');
    for (let i = 0; i < 5; i += 1) box.append(cardEl(v.board[i] || null));
    return box;
  }

  function drawShowdown() {
    const v = state.view;
    if (!v.showdown) return null;
    const box = el('div', 'poker-showdown');
    for (const s of v.showdown.shown) {
      const line = el('div', 'row');
      line.append(el('span', 'k', `#${s.seat + 1}`));
      for (const c of s.hole) line.append(cardEl(c, 'small'));
      line.append(el('span', 'hint', HANDS[state.lang][s.hand] ?? ''));
      box.append(line);
    }
    for (const a of v.showdown.awards) {
      box.append(el('div', 'hint',
        `${a.winners.map((w) => `#${w + 1}`).join(', ')} ${t('wins')} ${a.amount}`));
    }
    return box;
  }

  function drawActions() {
    const v = state.view;
    const o = v.options || {};
    const row = el('div', 'row poker-actions');

    if (v.finished) {
      row.append(el('div', 'hint', `${t('winner')}: #${(v.winner ?? 0) + 1}`));
      return row;
    }
    if (v.street === 'showdown') {
      if (state.myTurn) {
        const b = el('button', 'primary', t('next'));
        b.onclick = () => send('next');
        row.append(b);
      } else {
        row.append(el('div', 'hint', t('waiting')));
      }
      return row;
    }
    if (!state.myTurn) {
      row.append(el('div', 'hint', t('waiting')));
      return row;
    }

    const fold = el('button', '', t('fold'));
    fold.onclick = () => send('fold');
    row.append(fold);

    if (o.check) {
      const b = el('button', 'primary', t('check'));
      b.onclick = () => send('check');
      row.append(b);
    } else if (o.call > 0) {
      const b = el('button', 'primary', `${t('call')} ${o.call}`);
      b.onclick = () => send('call');
      row.append(b);
    }

    // A raise needs a number, so it gets a slider rather than a guess.
    const canRaise = o.raise > 0 && o.maxRaiseTo > o.minRaiseTo;
    if (canRaise) {
      const min = o.minRaiseTo;
      const max = o.maxRaiseTo;
      const at = state.raiseTo === null ? min : Math.min(Math.max(state.raiseTo, min), max);
      const slider = el('input', 'poker-slider');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.value = String(at);
      const amount = el('span', 'v', String(at));
      slider.oninput = () => { state.raiseTo = Number(slider.value); amount.textContent = slider.value; };
      const go = el('button', '', `${t('raise')} →`);
      go.onclick = () => send('raise', Number(slider.value));
      row.append(slider, amount, go);
    }

    if (o.allIn > 0) {
      const b = el('button', 'tiny', `${t('allin')} ${o.allIn}`);
      b.onclick = () => send('allin');
      row.append(b);
    }
    return row;
  }

  function draw() {
    if (!state.view) { root.replaceChildren(); return; }
    const v = state.view;

    const head = el('div', 'poker-head');
    head.append(
      el('span', 'k', `${t('hand')} ${v.hand + 1}`),
      el('span', 'k', `${t('blinds')} ${v.blinds ? `${v.blinds.small}/${v.blinds.big}` : ''}`),
      el('span', 'v', `${t('pot')} ${v.pot}`),
    );

    const mine = el('div', 'poker-hole');
    if (v.hole) for (const c of v.hole) mine.append(cardEl(c));

    // Filtered before the call, not cleaned up after: replaceChildren turns a null into
    // the literal text "null" on the page.
    const parts = [
      head,
      drawSeats(),
      drawBoard(),
      drawShowdown(),
      state.seat === null ? null : seatBox(state.seat, true),
      mine,
      drawActions(),
    ].filter(Boolean);
    root.replaceChildren(...parts);
  }

  draw();

  return {
    update(next) {
      Object.assign(state, next);
      draw();
    },
    get element() { return root; },
  };
}

export const meta = { key: 'poker' };
