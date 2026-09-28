// Балда.
//
// Pick an empty square that touches a letter, type a letter into it, then type the word
// you are claiming. The server finds the path and scores it, or refuses; nothing here
// tries to work out whether a word is on the board, because the answer that counts is the
// one the server gives.
//
// The board does highlight the squares you are allowed to write to, because being told
// where you may play is help rather than adjudication.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const labels = {
  ru: {
    letter: 'Буква',
    word: 'Слово',
    play: 'Сходить',
    pass: 'Пропустить',
    hint: 'Выберите пустую клетку рядом с буквой, впишите букву и слово через неё.',
    used: 'Сыграно',
    score: 'Счёт',
    pick: 'Сначала выберите клетку',
    theirTurn: 'Ход соперника',
  },
  en: {
    letter: 'Letter',
    word: 'Word',
    play: 'Play',
    pass: 'Pass',
    hint: 'Pick an empty square next to a letter, add a letter, and name a word through it.',
    used: 'Played',
    score: 'Score',
    pick: 'Choose a square first',
    theirTurn: 'Their turn',
  },
};

export function board(host, opts = {}) {
  const state = {
    view: opts.view || null,
    seat: opts.seat || null,
    myTurn: !!opts.myTurn,
    onAct: opts.onAct || (() => {}),
    lang: opts.lang === 'ru' ? 'ru' : 'en',
    picked: null,
  };

  const root = el('div', 'balda');
  host.replaceChildren(root);
  const t = (k) => labels[state.lang][k];

  function draw() {
    if (!state.view) { root.replaceChildren(); return; }
    const { grid, size, playable } = state.view;
    const allowed = new Set(playable || []);

    const gridEl = el('div', 'balda-grid');
    gridEl.style.setProperty('--n', String(size));
    for (let cell = 0; cell < grid.length; cell += 1) {
      const sq = el('div', 'balda-cell', grid[cell] ? grid[cell].toUpperCase() : '');
      if (grid[cell]) sq.classList.add('filled');
      else if (state.myTurn && allowed.has(cell)) sq.classList.add('open');
      if (state.picked === cell) sq.classList.add('picked');
      if (state.myTurn && allowed.has(cell) && !grid[cell]) {
        sq.onclick = () => { state.picked = cell; draw(); };
      }
      gridEl.append(sq);
    }

    const letter = el('input', 'balda-letter mono');
    letter.maxLength = 1;
    letter.placeholder = t('letter');
    const word = el('input', 'balda-word mono');
    word.placeholder = t('word');
    word.maxLength = 25;

    const send = () => {
      if (state.picked === null) return;
      const l = letter.value.trim();
      const w = word.value.trim();
      if (!l || !w) return;
      state.onAct({ cell: state.picked, letter: l, word: w });
      state.picked = null;
    };

    const go = el('button', 'primary', t('play'));
    go.onclick = send;
    go.disabled = !state.myTurn;
    word.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    const pass = el('button', 'tiny', t('pass'));
    pass.onclick = () => state.onAct({ pass: true });
    pass.disabled = !state.myTurn;

    const controls = el('div', 'balda-controls');
    controls.append(letter, word, go, pass);

    const scores = el('div', 'balda-scores');
    const mine = state.seat || 'host';
    scores.append(
      el('span', 'v', `${state.view.scores[mine] ?? 0}`),
      el('span', 'k', t('score')),
      el('span', 'v', `${state.view.scores[mine === 'host' ? 'guest' : 'host'] ?? 0}`),
    );

    const used = el('div', 'balda-used');
    for (const w of state.view.used || []) used.append(el('span', 'chip', w));

    root.replaceChildren(
      scores,
      gridEl,
      el('p', 'hint', state.myTurn
        ? (state.picked === null ? t('pick') : t('hint'))
        : t('theirTurn')),
      controls,
      el('div', 'balda-usedwrap', el('span', 'k', t('used')), used),
    );
    if (state.myTurn && state.picked !== null) letter.focus();
  }

  draw();

  return {
    update(next) {
      Object.assign(state, next);
      // A square chosen for a move that has already gone through means nothing now.
      if (state.picked !== null && state.view?.grid?.[state.picked]) state.picked = null;
      draw();
    },
    get element() { return root; },
  };
}

export const meta = { key: 'balda' };
