// Морской бой.
//
// Two phases in one component. First you arrange a fleet, which happens entirely here and
// is sent as a whole; then you shoot, which is one cell at a time.
//
// The arrangement rules are enforced here only to stop you making a mistake. The server
// checks the fleet again when it arrives and refuses anything illegal, so nothing on this
// side is load-bearing. That split matters: a client that lets you cheat is a bug, a
// server that lets you cheat is a hole.

const SIZE = 10;
const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const LETTERS = 'АБВГДЕЖЗИК';

const idx = (x, y) => y * SIZE + x;
const inside = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;

function shipCells(ship) {
  const cells = [];
  const dx = ship.dir === 'h' ? 1 : 0;
  const dy = ship.dir === 'v' ? 1 : 0;
  for (let n = 0; n < ship.len; n += 1) cells.push(idx(ship.x + dx * n, ship.y + dy * n));
  return cells;
}

/** Cells that a new ship may not occupy, given what is already down. */
function blockedBy(ships) {
  const blocked = new Set();
  for (const ship of ships) {
    for (const c of shipCells(ship)) {
      const cx = c % SIZE;
      const cy = Math.floor(c / SIZE);
      for (let ay = cy - 1; ay <= cy + 1; ay += 1) {
        for (let ax = cx - 1; ax <= cx + 1; ax += 1) {
          if (inside(ax, ay)) blocked.add(idx(ax, ay));
        }
      }
    }
  }
  return blocked;
}

const fits = (ship, ships) => {
  const cells = shipCells(ship);
  if (cells.some((c) => c === undefined)) return false;
  const dx = ship.dir === 'h' ? ship.len - 1 : 0;
  const dy = ship.dir === 'v' ? ship.len - 1 : 0;
  if (!inside(ship.x, ship.y) || !inside(ship.x + dx, ship.y + dy)) return false;
  const blocked = blockedBy(ships);
  return !cells.some((c) => blocked.has(c));
};

/** Arrange a whole fleet at random. The same idea as the server's, for the same rules. */
function randomFleet() {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const ships = [];
    let ok = true;
    for (const len of FLEET) {
      let placed = false;
      for (let tries = 0; tries < 300 && !placed; tries += 1) {
        const dir = Math.random() < 0.5 ? 'h' : 'v';
        const x = Math.floor(Math.random() * (dir === 'h' ? SIZE - len + 1 : SIZE));
        const y = Math.floor(Math.random() * (dir === 'v' ? SIZE - len + 1 : SIZE));
        const ship = { x, y, len, dir };
        if (!fits(ship, ships)) continue;
        ships.push(ship);
        placed = true;
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return ships;
  }
  return null;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const labels = {
  ru: {
    yours: 'Ваше поле',
    theirs: 'Поле соперника',
    place: 'Расставьте корабли',
    random: 'Расставить случайно',
    clear: 'Убрать все',
    ready: 'Готово',
    rotate: 'Повернуть',
    left: 'Осталось',
    waiting: 'Ждём соперника',
    hint: 'Выберите корабль, потом клетку. Корабли не должны касаться друг друга.',
  },
  en: {
    yours: 'Your waters',
    theirs: 'Their waters',
    place: 'Arrange your fleet',
    random: 'Arrange for me',
    clear: 'Clear',
    ready: 'Ready',
    rotate: 'Rotate',
    left: 'Left to place',
    waiting: 'Waiting for the other side',
    hint: 'Pick a ship, then a square. Ships may not touch, corners included.',
  },
};

export function board(host, opts = {}) {
  const state = {
    view: opts.view || null,
    seat: opts.seat || null,
    myTurn: !!opts.myTurn,
    onAct: opts.onAct || (() => {}),
    lang: opts.lang === 'ru' ? 'ru' : 'en',
    // setup
    placed: [],
    dir: 'h',
    picking: 0,
    sent: false,
  };

  const root = el('div', 'seabattle');
  host.replaceChildren(root);

  const t = (k) => labels[state.lang][k];

  /** Which ship lengths are still waiting to go down. */
  const remaining = () => {
    const left = FLEET.slice();
    for (const ship of state.placed) {
      const at = left.indexOf(ship.len);
      if (at >= 0) left.splice(at, 1);
    }
    return left;
  };

  function gridEl(cls, paint, onCell) {
    const grid = el('div', `sea-grid ${cls}`);
    // A blank corner, then the column letters.
    grid.append(el('i', 'coord', ''));
    for (let x = 0; x < SIZE; x += 1) grid.append(el('i', 'coord', LETTERS[x]));
    for (let y = 0; y < SIZE; y += 1) {
      grid.append(el('i', 'coord', String(y + 1)));
      for (let x = 0; x < SIZE; x += 1) {
        const cell = el('div', 'sea-cell');
        paint(cell, x, y);
        if (onCell) cell.onclick = () => onCell(x, y);
        grid.append(cell);
      }
    }
    return grid;
  }

  // -------------------------------------------------------------- setting up
  function tryPlace(x, y) {
    const left = remaining();
    const len = left[Math.min(state.picking, left.length - 1)];
    if (len === undefined) return;
    const ship = { x, y, len, dir: state.dir };
    if (!fits(ship, state.placed)) return;
    state.placed = [...state.placed, ship];
    state.picking = 0;
    draw();
  }

  function drawSetup() {
    const mine = new Set(state.placed.flatMap(shipCells));
    const left = remaining();

    const grid = gridEl('own', (cell, x, y) => {
      if (mine.has(idx(x, y))) cell.classList.add('ship');
    }, tryPlace);

    const fleetRow = el('div', 'fleet-row');
    left.forEach((len, i) => {
      const chip = el('button', `ship-chip${i === state.picking ? ' on' : ''}`);
      for (let n = 0; n < len; n += 1) chip.append(el('span', 'seg'));
      chip.onclick = () => { state.picking = i; draw(); };
      fleetRow.append(chip);
    });

    const tools = el('div', 'row');
    const rotate = el('button', 'tiny', `${t('rotate')} (${state.dir === 'h' ? '↔' : '↕'})`);
    rotate.onclick = () => { state.dir = state.dir === 'h' ? 'v' : 'h'; draw(); };
    const shuffle = el('button', 'tiny', t('random'));
    shuffle.onclick = () => {
      const fleet = randomFleet();
      if (fleet) { state.placed = fleet; state.picking = 0; draw(); }
    };
    const clear = el('button', 'tiny', t('clear'));
    clear.onclick = () => { state.placed = []; state.picking = 0; draw(); };
    tools.append(rotate, shuffle, clear);

    const ready = el('button', 'primary big', t('ready'));
    ready.disabled = left.length > 0 || state.sent;
    ready.onclick = () => {
      if (remaining().length) return;
      state.sent = true;
      ready.disabled = true;
      state.onAct({ fleet: state.placed });
    };

    root.replaceChildren(
      el('h3', 'sea-title', t('place')),
      el('p', 'hint', t('hint')),
      grid,
      el('div', 'sea-left', `${t('left')}: ${left.length}`),
      fleetRow,
      tools,
      ready,
    );
  }

  // ------------------------------------------------------------------ playing
  function paintOwn(cell, x, y) {
    const own = state.view.own;
    if (!own) return;
    const at = idx(x, y);
    const mine = new Set((own.ships || []).flatMap(shipCells));
    if (mine.has(at)) cell.classList.add('ship');
    if (own.shots[at] === 'hit') cell.classList.add('hit');
    if (own.shots[at] === 'miss') cell.classList.add('miss');
  }

  function paintTheirs(cell, x, y) {
    const theirs = state.view.theirs;
    if (!theirs) return;
    const at = idx(x, y);
    if (theirs.shots[at] === 'hit') cell.classList.add('hit');
    if (theirs.shots[at] === 'miss') cell.classList.add('miss');
    // Only ships they have already lost are drawn; the rest are not in the data at all.
    if ((theirs.sunk || []).some((ship) => shipCells(ship).includes(at))) {
      cell.classList.add('sunk');
    }
  }

  function drawPlay() {
    const waiting = state.view.phase === 'setup';
    const fire = (x, y) => {
      if (!state.myTurn) return;
      const at = idx(x, y);
      if (state.view.theirs?.shots[at]) return;
      state.onAct({ cell: at });
    };

    const side = (title, grid, afloat) => {
      const box = el('div', 'sea-side');
      box.append(
        el('h4', 'sea-title', title),
        grid,
        el('div', 'sea-left', `${afloat ?? '-'} ⚓`),
      );
      return box;
    };

    const pair = el('div', 'sea-pair');
    pair.append(
      side(t('theirs'), gridEl(`enemy${state.myTurn ? ' live' : ''}`, paintTheirs, fire),
        state.view.theirs?.afloat),
      side(t('yours'), gridEl('own', paintOwn, null), state.view.own?.afloat),
    );

    root.replaceChildren(pair);
    // Our fleet is down but theirs is not, so there is nothing to shoot at yet.
    if (waiting) root.prepend(el('p', 'hint', t('waiting')));
  }

  function draw() {
    if (!state.view) { root.replaceChildren(); return; }
    const needsFleet = state.view.phase === 'setup' && state.seat
      && !state.view.placed[state.seat];
    if (needsFleet) drawSetup();
    else drawPlay();
  }

  draw();

  return {
    update(next) {
      Object.assign(state, next);
      // Once the server has our fleet, the local arrangement is history.
      if (state.seat && state.view?.placed?.[state.seat]) {
        state.sent = false;
        state.placed = [];
      }
      draw();
    },
    get element() { return root; },
  };
}

export const meta = { key: 'seabattle' };
