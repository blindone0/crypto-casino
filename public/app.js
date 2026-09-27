import { LANGS, t, setLocale, getLocale, applyAll } from './i18n.js';
import { ensureSymbolDefs, symbolSvg } from './symbols.js';

// ---------------------------------------------------------------- plumbing
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const state = {
  cfg: null, user: null, csrf: null,
  game: 'dice', feed: 'recent',
  mines: null, crash: null, es: null,
  // 'real' or 'demo'. Practice money is a completely separate balance that cannot be
  // deposited to or withdrawn from; it exists so someone with nothing can still learn.
  wallet: 'real', demoBalance: 0,
};

const UNIT = 1e8;
const fmt = (units, dp = 8) => (Number(units) / UNIT).toFixed(dp);
const fmtShort = (units) => {
  const n = Number(units) / UNIT;
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
};

const STAKE_ROUTES = ['/api/bet/', '/api/crash/bet'];

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  // Anything that stakes money carries the active wallet, set in one place rather than
  // at each of the dozen call sites, so a new game cannot forget it and bet real funds.
  let payload = body;
  if (method === 'POST' && state.wallet === 'demo' && STAKE_ROUTES.some((r) => path.startsWith(r))) {
    payload = { ...(body || {}), wallet: 'demo' };
  }
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (state.csrf && method !== 'GET') headers['x-csrf-token'] = state.csrf;
  let res;
  try {
    res = await fetch(path, {
      method, headers, credentials: 'same-origin',
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch {
    throw new Error(t('err.network'));
  }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = '') {
  const node = el('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  }, 3600);
}

function setBalance(units, direction) {
  const box = $('#balanceBox');
  const v = $('#balanceValue');
  box.hidden = false;
  if (state.wallet === 'demo') state.demoBalance = units;
  else if (state.user) state.user.balance = units;
  v.textContent = fmt(units);
  if (direction) {
    v.className = `value ${direction > 0 ? 'flash' : 'flash-down'}`;
    setTimeout(() => { v.className = 'value'; }, 320);
  }
}

// ----------------------------------------------------------------- modals
function openModal(title, buildBody, { tabs } = {}) {
  closeModal();
  const body = el('div');
  const head = el('header', {}, el('h2', {}, title),
    el('button', { class: 'ghost tiny', onclick: closeModal }, t('common.close')));
  const modal = el('div', { class: 'modal' }, head);
  if (tabs) {
    const bar = el('div', { class: 'modal-tabs' });
    tabs.forEach((tab, i) => {
      const b = el('button', {
        class: i === 0 ? 'on' : '',
        onclick: () => {
          [...bar.children].forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
          body.replaceChildren();
          tab.build(body);
          applyAll(body);
        },
      }, tab.label);
      bar.append(b);
    });
    modal.append(bar);
    tabs[0].build(body);
  } else {
    buildBody(body);
  }
  modal.append(body);
  const back = el('div', {
    class: 'modal-back',
    onclick: (e) => { if (e.target === back) closeModal(); },
  }, modal);
  $('#modalRoot').replaceChildren(back);
  applyAll(back);
  document.addEventListener('keydown', escClose);
  return body;
}
const escClose = (e) => { if (e.key === 'Escape') closeModal(); };
function closeModal() {
  $('#modalRoot').replaceChildren();
  document.removeEventListener('keydown', escClose);
}

// ------------------------------------------------------------------- auth
function authModal(mode = 'login') {
  const build = (body) => {
    const u = el('input', { id: 'au', autocomplete: 'username', maxlength: '20' });
    const p = el('input', { id: 'ap', type: 'password', autocomplete: 'current-password' });
    const r = el('input', { id: 'ar', maxlength: '16' });
    const err = el('p', { class: 'hint neg' });
    const params = new URLSearchParams(location.search);
    if (params.get('ref')) r.value = params.get('ref');

    const submit = async () => {
      err.textContent = '';
      try {
        const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
        const payload = { username: u.value, password: p.value };
        if (mode === 'register') payload.referralCode = r.value || undefined;
        const out = await api(path, { method: 'POST', body: payload });
        state.user = out.user;
        state.csrf = out.csrf;
        closeModal();
        afterAuth();
        toast(t('auth.welcome', { name: out.user.username }));
      } catch (e) {
        err.textContent = e.message;
      }
    };

    body.append(
      el('label', { class: 'field' }, el('span', { 'data-i18n': 'auth.username' }), u),
      el('label', { class: 'field' }, el('span', { 'data-i18n': 'auth.password' }), p),
      mode === 'register'
        ? el('label', { class: 'field' }, el('span', { 'data-i18n': 'auth.refcode' }), r)
        : null,
      mode === 'register' ? el('p', { class: 'hint', 'data-i18n': 'auth.rules' }) : null,
      err,
      el('button', { class: 'primary big', onclick: submit },
        t(mode === 'login' ? 'auth.login' : 'auth.register')),
      el('p', { class: 'hint' },
        el('a', {
          href: '#',
          onclick: (e) => { e.preventDefault(); authModal(mode === 'login' ? 'register' : 'login'); },
        }, t(mode === 'login' ? 'auth.noAccount' : 'auth.haveAccount'))),
    );
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => u.focus(), 30);
  };
  openModal(t(mode === 'login' ? 'auth.login' : 'auth.register'), build);
}

function afterAuth() {
  $('#authButtons').classList.add('hide');
  $('#userButtons').classList.remove('hide');
  $('#btnAdmin').classList.toggle('hide', state.user.role !== 'admin');
  $('#modeSwitch').classList.toggle('hide', !state.cfg?.demo?.enabled);
  applyWallet();
  renderGame();
  loadFeed();
}

/** Reflect the active wallet everywhere: balance, styling, banner, switch. */
function applyWallet() {
  const demo = state.wallet === 'demo';
  document.body.classList.toggle('practice', demo);
  for (const b of document.querySelectorAll('#modeSwitch button')) {
    b.classList.toggle('on', b.dataset.wallet === state.wallet);
  }
  setBalance(demo ? state.demoBalance : (state.user?.balance ?? 0));
  renderBanners();
}

async function setWallet(next) {
  if (state.wallet === next) return;
  state.wallet = next;
  try { localStorage.setItem('wallet', next); } catch { /* private mode */ }
  if (next === 'demo' && state.user) {
    try { state.demoBalance = (await api('/api/demo')).balance; } catch { /* keep last */ }
  }
  // Any half-finished round belongs to the other wallet, so start clean.
  state.mines = null;
  state.pref = null;
  applyWallet();
  renderGame();
}

async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  state.csrf = null;
  $('#authButtons').classList.remove('hide');
  $('#userButtons').classList.add('hide');
  $('#modeSwitch').classList.add('hide');
  $('#balanceBox').hidden = true;
  state.wallet = 'real';
  document.body.classList.remove('practice');
  renderBanners();
  renderGame();
}

const requireLogin = () => {
  if (!state.user) { authModal('login'); return false; }
  return true;
};

// ------------------------------------------------------- shared bet controls
/** Amount input with ½ / 2× / max helpers. Returns { node, get, set }. */
function amountControl(initial = '0.001') {
  const input = el('input', { class: 'mono', value: initial, inputmode: 'decimal' });
  const bump = (f) => () => {
    const cur = Number(input.value) || 0;
    input.value = Math.max(0, f(cur)).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    input.dispatchEvent(new Event('input'));
  };
  const node = el('label', { class: 'field' },
    el('span', { 'data-i18n': 'bet.amount' }),
    el('div', { class: 'input-row' },
      input,
      el('button', { class: 'tiny', onclick: bump((v) => v / 2), type: 'button' }, '½'),
      el('button', { class: 'tiny', onclick: bump((v) => v * 2), type: 'button' }, '2×'),
      el('button', {
        class: 'tiny',
        type: 'button',
        onclick: () => {
          if (!state.user) return;
          input.value = fmt(state.user.balance);
          input.dispatchEvent(new Event('input'));
        },
      }, t('bet.max'))));
  return { node, input, get: () => input.value, set: (v) => { input.value = v; } };
}

const statRow = (key, valueNode) => el('div', { class: 'stat-row' },
  el('span', { class: 'k', 'data-i18n': key }), el('span', { class: 'v' }, valueNode));

function infoPanel(extra = []) {
  const p = $('#infoPanel');
  p.replaceChildren(
    el('h3', { 'data-i18n': 'bet.edge' }),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('game.' + state.game)),
      el('span', { class: 'v' }, `${(state.cfg.houseEdge[state.game] * 100).toFixed(2)}%`)),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k', 'data-i18n': 'bet.maxWin' }),
      el('span', { class: 'v' }, fmtShort(state.cfg.risk.maxProfitPerBet))),
    ...extra,
  );
  applyAll(p);
}

// ------------------------------------------------------------------- dice
function renderDice() {
  const panel = $('#betPanel');
  const amount = amountControl();
  // The slider is win chance in hundredths of a percent; the threshold derives from it.
  const chance = el('input', { type: 'range', min: '100', max: '9500', step: '1', value: '5000' });
  const mode = el('select', {},
    el('option', { value: 'under' }, t('dice.under')),
    el('option', { value: 'over' }, t('dice.over')));
  const thresholdOut = el('input', { class: 'mono', readonly: 'readonly' });
  const multOut = el('span', {});
  const chanceOut = el('span', {});
  const profitOut = el('span', {});
  const go = el('button', { class: 'primary big', 'data-i18n': 'bet.place' });

  const target = () => (mode.value === 'over'
    ? 9999 - Number(chance.value)
    : Number(chance.value));

  const recalc = () => {
    const c = Number(chance.value) / 10000;
    const mult = Math.floor(((1 - state.cfg.houseEdge.dice) / c) * 100) / 100;
    thresholdOut.value = (target() / 100).toFixed(2);
    chanceOut.textContent = `${(c * 100).toFixed(2)}%`;
    multOut.textContent = `${mult.toFixed(2)}×`;
    const amt = Number(amount.get()) || 0;
    profitOut.textContent = (amt * mult - amt).toFixed(8);
    const track = $('#diceTrack');
    if (track) {
      track.style.setProperty('--win', `${Number(chance.value) / 100}%`);
      track.classList.toggle('over', mode.value === 'over');
    }
    const lbl = $('#diceThresholdLabel');
    if (lbl) lbl.textContent = t(mode.value === 'over' ? 'dice.targetOver' : 'dice.target');
  };
  chance.addEventListener('input', recalc);
  mode.addEventListener('change', recalc);
  amount.input.addEventListener('input', recalc);

  go.addEventListener('click', async () => {
    if (!requireLogin()) return;
    go.disabled = true;
    try {
      const out = await api('/api/bet/dice', {
        method: 'POST',
        body: { amount: amount.get(), target: target(), mode: mode.value },
      });
      showDiceResult(out);
      state.user.balance = out.balance;
      setBalance(out.balance, out.profit);
      loadFeed();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      go.disabled = false;
    }
  });

  panel.replaceChildren(
    amount.node,
    el('label', { class: 'field' }, el('span', { 'data-i18n': 'dice.mode' }), mode),
    el('label', { class: 'field' },
      el('span', { id: 'diceThresholdLabel' }, t('dice.target')), thresholdOut),
    el('label', { class: 'field' }, el('span', { 'data-i18n': 'bet.chance' }), chance),
    statRow('bet.chance', chanceOut),
    statRow('bet.multiplier', multOut),
    statRow('bet.profit', profitOut),
    go,
  );
  applyAll(panel);

  $('#stage').replaceChildren(
    el('div', { class: 'dice-readout' },
      el('div', { class: 'roll', id: 'diceRoll' }, '00.00'),
      el('div', { class: 'verdict', id: 'diceVerdict' }, '')),
    el('div', { class: 'dice-track', id: 'diceTrack' },
      el('div', { class: 'marker', id: 'diceMarker', style: 'left:50%' })),
    el('div', { class: 'dice-scale' },
      el('span', {}, '0.00'), el('span', {}, '25'), el('span', {}, '50'),
      el('span', {}, '75'), el('span', {}, '99.99')),
  );
  infoPanel();
  recalc();
}

function showDiceResult(out) {
  const roll = $('#diceRoll');
  roll.textContent = out.rollDisplay;
  roll.className = `roll ${out.won ? 'win' : 'lose'}`;
  $('#diceVerdict').textContent = out.won
    ? `${t('bet.won')} +${fmtShort(out.profit)} (${out.multiplier.toFixed(2)}×)`
    : `${t('bet.lost')} ${fmtShort(out.wager)}`;
  $('#diceMarker').style.left = `${(out.roll / 9999) * 100}%`;
}

// ------------------------------------------------------------------ limbo
function renderLimbo() {
  const panel = $('#betPanel');
  const amount = amountControl();
  const target = el('input', { class: 'mono', value: '2.00', inputmode: 'decimal' });
  const chanceOut = el('span', {});
  const profitOut = el('span', {});
  const go = el('button', { class: 'primary big', 'data-i18n': 'bet.place' });

  const recalc = () => {
    const tg = Math.max(1.01, Math.floor(Number(target.value) * 100) / 100 || 1.01);
    const c = (1 - state.cfg.houseEdge.limbo) / tg;
    chanceOut.textContent = `${(c * 100).toFixed(4)}%`;
    const amt = Number(amount.get()) || 0;
    profitOut.textContent = (amt * tg - amt).toFixed(8);
  };
  target.addEventListener('input', recalc);
  amount.input.addEventListener('input', recalc);

  go.addEventListener('click', async () => {
    if (!requireLogin()) return;
    go.disabled = true;
    try {
      const out = await api('/api/bet/limbo', {
        method: 'POST', body: { amount: amount.get(), target: target.value },
      });
      const m = $('#limboMult');
      m.textContent = `${out.drawn.toFixed(2)}×`;
      m.className = `mult ${out.won ? 'pos' : 'neg'}`;
      $('#limboVerdict').textContent = out.won
        ? `${t('bet.won')} +${fmtShort(out.profit)}`
        : `${t('bet.lost')} ${fmtShort(out.wager)}`;
      state.user.balance = out.balance;
      setBalance(out.balance, out.profit);
      loadFeed();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      go.disabled = false;
    }
  });

  panel.replaceChildren(
    amount.node,
    el('label', { class: 'field' }, el('span', { 'data-i18n': 'limbo.target' }), target),
    statRow('bet.chance', chanceOut),
    statRow('bet.profit', profitOut),
    go,
  );
  applyAll(panel);
  $('#stage').replaceChildren(
    el('div', { class: 'limbo-readout' },
      el('div', { class: 'mult', id: 'limboMult' }, '1.00×'),
      el('div', { class: 'verdict muted', id: 'limboVerdict' }, '')),
  );
  infoPanel();
  recalc();
}

// ------------------------------------------------------------------ mines
function renderMines() {
  const panel = $('#betPanel');
  const amount = amountControl();
  const count = el('select', {}, ...Array.from({ length: 24 }, (_, i) =>
    el('option', { value: String(i + 1), selected: i + 1 === 3 ? 'selected' : false }, String(i + 1))));
  const nextOut = el('span', {});
  const start = el('button', { class: 'primary big', 'data-i18n': 'mines.start' });
  const cash = el('button', { class: 'big hide' });

  const refreshLadder = async () => {
    try {
      const { table } = await api(`/api/bet/mines/table?mines=${count.value}`);
      nextOut.textContent = `${table[0].toFixed(2)}×`;
    } catch { /* offline */ }
  };
  count.addEventListener('change', refreshLadder);

  start.addEventListener('click', async () => {
    if (!requireLogin()) return;
    start.disabled = true;
    try {
      const g = await api('/api/bet/mines/start', {
        method: 'POST', body: { amount: amount.get(), mines: Number(count.value) },
      });
      state.mines = g;
      state.user.balance = g.balance;
      setBalance(g.balance, -1);
      paintMines();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      start.disabled = false;
    }
  });

  cash.addEventListener('click', async () => {
    try {
      const out = await api('/api/bet/mines/cashout', { method: 'POST' });
      toast(t('mines.cashedOut', { mult: out.multiplier.toFixed(2) }));
      state.mines = { ...out, state: 'cashed' };
      state.user.balance = out.balance;
      setBalance(out.balance, 1);
      paintMines();
      loadFeed();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });

  panel.replaceChildren(
    amount.node,
    el('label', { class: 'field' }, el('span', { 'data-i18n': 'mines.count' }), count),
    statRow('mines.next', nextOut),
    start, cash,
  );
  applyAll(panel);
  state.minesUi = { start, cash, amount, count, nextOut };
  refreshLadder();
  paintMines();
  infoPanel();
}

function paintMines() {
  const g = state.mines;
  const ui = state.minesUi;
  const live = g && g.state === 'active';
  if (ui) {
    ui.start.classList.toggle('hide', !!live);
    ui.cash.classList.toggle('hide', !live);
    ui.cash.disabled = !live || !g.picks?.length;
    ui.cash.textContent = live
      ? t('mines.cashout', { amount: fmtShort(g.cashoutValue || 0) })
      : t('mines.cashout', { amount: '0' });
    if (live && g.nextMultiplier) ui.nextOut.textContent = `${g.nextMultiplier.toFixed(2)}×`;
  }

  const picks = new Set(g?.picks || []);
  const mines = new Set(g?.mines || []);
  const grid = el('div', { class: 'mine-grid' });
  for (let i = 0; i < 25; i += 1) {
    const isGem = picks.has(i);
    const isMine = mines.has(i);
    const done = !live || isGem;
    grid.append(el('button', {
      class: `tile ${isGem ? 'gem' : ''} ${isMine ? 'mine' : ''} ${done && !isGem && !isMine ? 'dim' : ''}`,
      disabled: (!live || isGem) ? 'disabled' : false,
      onclick: () => revealTile(i),
    }, isGem ? '◆' : (isMine ? '✕' : '')));
  }

  const status = g && g.state === 'lost' ? t('mines.boom')
    : (g && g.state === 'cashed' ? t('mines.cashedOut', { mult: (g.multiplier || 0).toFixed(2) })
      : (live ? `${(g.multiplier || 0).toFixed(2)}×` : t('mines.pickTile')));

  $('#stage').replaceChildren(
    el('div', { class: 'crash-status', style: 'font-size:22px;font-family:var(--mono);padding:8px 0' }, status),
    grid,
  );
}

async function revealTile(tile) {
  try {
    const out = await api('/api/bet/mines/reveal', { method: 'POST', body: { tile } });
    state.mines = out;
    if (out.balance != null) {
      state.user.balance = out.balance;
      setBalance(out.balance, out.safe ? 0 : -1);
    }
    paintMines();
    if (!out.safe) { toast(t('mines.boom'), 'bad'); loadFeed(); }
    if (out.autoCashout) { toast(t('mines.cashedOut', { mult: out.multiplier.toFixed(2) })); loadFeed(); }
  } catch (e) {
    toast(e.message, 'bad');
  }
}

// ------------------------------------------------------------------ crash
function renderCrash() {
  const panel = $('#betPanel');
  const amount = amountControl();
  const auto = el('input', { class: 'mono', value: '2.00', inputmode: 'decimal' });
  const bet = el('button', { class: 'primary big', 'data-i18n': 'crash.joinNext' });
  const cash = el('button', { class: 'big hide', 'data-i18n': 'crash.cashout' });

  bet.addEventListener('click', async () => {
    if (!requireLogin()) return;
    bet.disabled = true;
    try {
      const out = await api('/api/crash/bet', {
        method: 'POST', body: { amount: amount.get(), autoCashout: auto.value },
      });
      toast(t('crash.placed', { id: out.roundId }));
      state.user.balance = out.balance;
      setBalance(out.balance, -1);
      state.crashBet = out;
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      bet.disabled = false;
    }
  });

  cash.addEventListener('click', async () => {
    try {
      const out = await api('/api/crash/cashout', { method: 'POST' });
      toast(`${t('bet.won')} ${out.cashedAt.toFixed(2)}× +${fmtShort(out.profit)}`);
      state.user.balance = out.balance;
      setBalance(out.balance, 1);
      state.crashBet = null;
      loadFeed();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });

  panel.replaceChildren(
    amount.node,
    el('label', { class: 'field' }, el('span', { 'data-i18n': 'crash.autoCashout' }), auto),
    bet, cash,
  );
  applyAll(panel);
  state.crashUi = { bet, cash };

  $('#stage').replaceChildren(
    el('div', { class: 'crash-stage' },
      el('div', { class: 'crash-mult', id: 'crashMult' }, '1.00×'),
      el('div', { class: 'crash-status', id: 'crashStatus' }, t('crash.waiting')),
      crashCurve(),
      el('div', { class: 'crash-hist', id: 'crashHist' })),
  );
  infoPanel([
    el('div', { class: 'stat-row' },
      el('span', { class: 'k', 'data-i18n': 'fair.crashCommitment' }),
      el('span', { class: 'v faint' }, (state.cfg.crashCommitment || '').slice(0, 12))),
  ]);
  connectCrash();
}

function crashCurve() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'crash-curve');
  svg.setAttribute('viewBox', '0 0 300 130');
  svg.setAttribute('preserveAspectRatio', 'none');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('id', 'crashPath');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'var(--accent)');
  p.setAttribute('stroke-width', '2');
  svg.append(p);
  return svg;
}

/** Draw the multiplier curve so the climb is visible, not just a number ticking. */
function drawCurve(mult, busted) {
  const p = document.getElementById('crashPath');
  if (!p) return;
  const span = Math.max(2, mult);
  const pts = [];
  for (let i = 0; i <= 40; i += 1) {
    const frac = i / 40;
    const m = 1 + (mult - 1) * frac;
    pts.push(`${(frac * 300).toFixed(1)},${(130 - ((m - 1) / (span - 1 || 1)) * 120).toFixed(1)}`);
  }
  p.setAttribute('d', `M${pts.join(' L')}`);
  p.setAttribute('stroke', busted ? 'var(--danger)' : 'var(--accent)');
}

function connectCrash() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/crash/stream');
  state.es = es;

  const setMult = (m, cls) => {
    const node = $('#crashMult');
    if (!node) return;
    node.textContent = `${Number(m).toFixed(2)}×`;
    node.className = `crash-mult ${cls || ''}`;
  };
  const showHistory = (hist) => {
    const box = $('#crashHist');
    if (!box || !hist) return;
    box.replaceChildren(...hist.map((h) => el('span', {
      class: `pill ${h.crashPoint >= 2 ? 'hi' : (h.crashPoint < 1.2 ? 'lo' : '')}`,
    }, `${h.crashPoint.toFixed(2)}×`)));
  };
  const setPhase = (phase) => {
    if (!state.crashUi) return;
    state.crashUi.bet.classList.toggle('hide', phase === 'running');
    state.crashUi.cash.classList.toggle('hide', phase !== 'running');
  };

  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    setMult(s.multiplier, s.state === 'ended' ? 'busted' : (s.state === 'running' ? 'running' : ''));
    showHistory(s.history);
    setPhase(s.state);
    if ($('#crashStatus')) {
      $('#crashStatus').textContent = s.state === 'betting'
        ? t('crash.betting', { s: Math.ceil((s.msLeft || 0) / 1000) })
        : (s.state === 'running' ? t('crash.running') : t('crash.waiting'));
    }
  });
  es.addEventListener('betting', (e) => {
    const s = JSON.parse(e.data);
    setMult(1, '');
    drawCurve(1, false);
    setPhase('betting');
    showHistory(s.history);
    let left = s.msLeft;
    const tick = setInterval(() => {
      left -= 250;
      const node = $('#crashStatus');
      if (!node || left <= 0) { clearInterval(tick); return; }
      node.textContent = t('crash.betting', { s: Math.ceil(left / 1000) });
    }, 250);
  });
  es.addEventListener('running', () => {
    setPhase('running');
    if ($('#crashStatus')) $('#crashStatus').textContent = t('crash.running');
  });
  es.addEventListener('tick', (e) => {
    const { m } = JSON.parse(e.data);
    setMult(m, 'running');
    drawCurve(m, false);
  });
  es.addEventListener('crash', (e) => {
    const s = JSON.parse(e.data);
    setMult(s.crashPoint, 'busted');
    drawCurve(s.crashPoint, true);
    setPhase('ended');
    showHistory(s.history);
    if ($('#crashStatus')) {
      $('#crashStatus').textContent = t('crash.busted', { mult: s.crashPoint.toFixed(2) });
    }
    state.crashBet = null;
    if (state.user) refreshMe();
  });
  es.onerror = () => { /* EventSource retries on its own */ };
}

// ------------------------------------------------------------------- feed
async function loadFeed() {
  const body = $('#feedBody');
  try {
    let rows = [];
    let mine = false;
    if (state.feed === 'mine') {
      if (!state.user) { body.replaceChildren(el('p', { class: 'hint' }, t('err.signin'))); return; }
      rows = (await api('/api/me/bets?limit=40')).bets;
      mine = true;
    } else {
      const s = await api('/api/stats/recent');
      rows = state.feed === 'biggest' ? s.biggest : s.bets;
    }
    if (!rows.length) { body.replaceChildren(el('p', { class: 'hint' }, t('feed.empty'))); return; }
    body.replaceChildren(el('table', { class: 'grid' },
      el('thead', {}, el('tr', {},
        mine ? null : el('th', { 'data-i18n': 'feed.player' }),
        el('th', { 'data-i18n': 'feed.game' }),
        el('th', { 'data-i18n': 'feed.bet' }),
        el('th', { 'data-i18n': 'bet.multiplier' }),
        el('th', { 'data-i18n': 'feed.payout' }))),
      el('tbody', {}, ...rows.map((r) => el('tr', {},
        mine ? null : el('td', { class: 'name' }, r.username),
        el('td', { class: 'name' }, t(`game.${r.game}`)),
        el('td', {}, fmtShort(r.wager)),
        el('td', {}, r.multiplier ? `${r.multiplier.toFixed(2)}×` : '-'),
        el('td', { class: r.profit > 0 ? 'pos' : (r.profit < 0 ? 'neg' : '') },
          (r.profit > 0 ? '+' : '') + fmtShort(r.profit)))))));
    applyAll(body);
  } catch {
    body.replaceChildren(el('p', { class: 'hint' }, t('err.network')));
  }
}

// ----------------------------------------------------------------- wallet
async function walletModal() {
  if (!requireLogin()) return;

  const depositTab = async (body) => {
    body.replaceChildren(el('p', { class: 'hint' }, t('common.loading')));
    try {
      const d = await api('/api/wallet/deposit');
      const kids = [];
      if (d.isMock) kids.push(el('div', { class: 'banner', 'data-i18n': 'wallet.mockWarning' }));
      kids.push(
        el('h3', { 'data-i18n': 'wallet.yourAddress' }),
        el('div', { class: 'addr' }, d.address),
        el('div', { class: 'row', style: 'margin-top:8px' },
          el('button', {
            class: 'tiny',
            onclick: async () => {
              try { await navigator.clipboard.writeText(d.address); toast(t('wallet.copied')); }
              catch { toast(t('common.error'), 'bad'); }
            },
          }, t('wallet.copy'))),
      );
      if (d.memo) {
        kids.push(
          el('h3', { style: 'margin-top:16px', 'data-i18n': 'wallet.memo' }),
          el('div', { class: 'addr' }, d.memo),
        );
      }
      if (d.note) kids.push(el('p', { class: 'hint' }, d.note));
      kids.push(
        el('p', { class: 'hint' }, t('wallet.confirmations', { n: d.minConfirmations })),
        el('div', { class: 'stat-row' },
          el('span', { class: 'k', 'data-i18n': 'wallet.minDeposit' }),
          el('span', { class: 'v' }, state.cfg.wallet.minDeposit <= 1
            ? t('wallet.noMinimum')
            : fmt(state.cfg.wallet.minDeposit))),
      );
      if (d.isMock) {
        const amt = el('input', { class: 'mono', value: '5', inputmode: 'decimal' });
        kids.push(
          el('h3', { style: 'margin-top:16px', 'data-i18n': 'wallet.simulate' }),
          el('div', { class: 'input-row' }, amt,
            el('button', {
              class: 'tiny',
              onclick: async () => {
                try {
                  await api('/api/wallet/simulate-deposit', { method: 'POST', body: { amount: amt.value } });
                  toast('deposit queued, credits after the confirmation delay');
                  refreshMe();
                } catch (e) { toast(e.message, 'bad'); }
              },
            }, '+')),
        );
      }
      body.replaceChildren(...kids);
      applyAll(body);
    } catch (e) {
      body.replaceChildren(el('p', { class: 'hint neg' }, e.message));
    }
  };

  const withdrawTab = (body) => {
    const w = state.cfg.wallet;
    const addr = el('input', { class: 'mono' });
    const amt = el('input', { class: 'mono', value: fmt(Math.max(w.minWithdrawal, 0)), inputmode: 'decimal' });
    const recv = el('span', {});
    const recalc = () => {
      const units = Math.round((Number(amt.value) || 0) * UNIT);
      recv.textContent = fmt(Math.max(0, units - w.withdrawalFee));
    };
    amt.addEventListener('input', recalc);
    body.replaceChildren(
      el('label', { class: 'field' }, el('span', { 'data-i18n': 'wallet.destination' }), addr),
      el('label', { class: 'field' }, el('span', { 'data-i18n': 'bet.amount' }), amt),
      el('div', { class: 'stat-row' },
        el('span', { class: 'k', 'data-i18n': 'wallet.minWithdraw' }),
        el('span', { class: 'v' }, fmt(w.minWithdrawal))),
      el('div', { class: 'stat-row' },
        el('span', { class: 'k', 'data-i18n': 'wallet.fee' }),
        el('span', { class: 'v' }, fmt(w.withdrawalFee))),
      el('div', { class: 'stat-row' },
        el('span', { class: 'k', 'data-i18n': 'wallet.youReceive' }),
        el('span', { class: 'v' }, recv)),
      el('button', {
        class: 'primary big',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const out = await api('/api/wallet/withdraw', {
              method: 'POST', body: { address: addr.value, amount: amt.value },
            });
            toast(`${t('wallet.requestWithdraw')}: ${out.state}`);
            refreshMe();
          } catch (err) { toast(err.message, 'bad'); }
          finally { e.target.disabled = false; }
        },
      }, t('wallet.requestWithdraw')),
    );
    recalc();
    applyAll(body);
  };

  const historyTab = async (body) => {
    body.replaceChildren(el('p', { class: 'hint' }, t('common.loading')));
    try {
      const h = await api('/api/wallet/history');
      const rows = [
        ...h.deposits.map((d) => ({
          kind: t('wallet.deposit'), amount: d.amount_units, at: d.created_at,
          state: d.credited_at ? t('wallet.credited') : `${d.confirmations} conf`,
        })),
        ...h.withdrawals.map((w) => ({
          kind: t('wallet.withdraw'), amount: -w.amount_units, at: w.requested_at, state: w.state,
        })),
      ].sort((a, b) => b.at - a.at);
      if (!rows.length) { body.replaceChildren(el('p', { class: 'hint' }, t('feed.empty'))); return; }
      body.replaceChildren(el('table', { class: 'grid' },
        el('tbody', {}, ...rows.map((r) => el('tr', {},
          el('td', { class: 'name' }, r.kind),
          el('td', { class: r.amount > 0 ? 'pos' : 'neg' }, fmtShort(r.amount)),
          el('td', { class: 'name faint' }, r.state),
          el('td', { class: 'faint' }, new Date(r.at * 1000).toLocaleString()))))));
    } catch (e) {
      body.replaceChildren(el('p', { class: 'hint neg' }, e.message));
    }
  };

  openModal(t('nav.wallet'), null, {
    tabs: [
      { label: t('wallet.deposit'), build: depositTab },
      { label: t('wallet.withdraw'), build: withdrawTab },
      { label: t('wallet.history'), build: historyTab },
    ],
  });
}

// --------------------------------------------------------------- fairness
async function fairModal() {
  if (!requireLogin()) return;
  const body = openModal(t('fair.title'), (b) => b.append(el('p', { class: 'hint' }, t('common.loading'))));
  try {
    const f = await api('/api/fair/seed');
    const seedInput = el('input', { class: 'mono', value: f.clientSeed, maxlength: '64' });
    body.replaceChildren(
      el('p', { class: 'hint', 'data-i18n': 'fair.explain' }),
      el('h3', { 'data-i18n': 'fair.serverHash' }),
      el('div', { class: 'addr' }, f.serverSeedHash),
      el('div', { class: 'stat-row' },
        el('span', { class: 'k', 'data-i18n': 'fair.nonce' }),
        el('span', { class: 'v' }, String(f.nonce))),
      el('h3', { style: 'margin-top:16px', 'data-i18n': 'fair.clientSeed' }),
      el('div', { class: 'input-row' }, seedInput,
        el('button', {
          class: 'tiny',
          onclick: async () => {
            try {
              await api('/api/me/client-seed', { method: 'POST', body: { seed: seedInput.value } });
              toast(t('common.save'));
              fairModal();
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, t('fair.setSeed'))),
      el('p', { class: 'hint', 'data-i18n': 'fair.rotateWarn' }),
      el('button', {
        class: 'big',
        onclick: async () => {
          try {
            const r = await api('/api/me/rotate-seed', { method: 'POST' });
            toast(`${t('fair.revealed')}: ${(r.revealedSeed || '').slice(0, 16)}…`);
            fairModal();
          } catch (e) { toast(e.message, 'bad'); }
        },
      }, t('fair.rotate')),
      f.revealed.length
        ? el('div', {},
          el('h3', { style: 'margin-top:16px', 'data-i18n': 'fair.revealed' }),
          el('div', { class: 'table-wrap' }, el('table', { class: 'grid' },
            el('tbody', {}, ...f.revealed.map((r) => el('tr', {},
              el('td', {}, `${r.seed.slice(0, 20)}…`),
              el('td', { class: 'faint' }, `${r.nonce} bets`)))))))
        : null,
      el('p', { style: 'margin-top:14px' },
        el('a', { href: '/verify', target: '_blank' }, t('fair.verifier'))),
    );
    applyAll(body);
  } catch (e) {
    body.replaceChildren(el('p', { class: 'hint neg' }, e.message));
  }
}

// -------------------------------------------------------------- affiliate
async function affiliateModal() {
  if (!requireLogin()) return;
  const body = openModal(t('nav.affiliate'), (b) => b.append(el('p', { class: 'hint' }, t('common.loading'))));
  try {
    const a = await api('/api/me/affiliate');
    const me = await api('/api/me');
    body.replaceChildren(
      el('h2', { 'data-i18n': 'aff.title' }),
      el('p', { class: 'hint' }, t('aff.explain', { pct: (a.commission * 100).toFixed(0) })),
      el('h3', { 'data-i18n': 'aff.link' }),
      el('div', { class: 'addr' }, a.link),
      el('div', { class: 'row', style: 'margin:8px 0 16px' },
        el('button', {
          class: 'tiny',
          onclick: async () => {
            try { await navigator.clipboard.writeText(a.link); toast(t('wallet.copied')); }
            catch { toast(t('common.error'), 'bad'); }
          },
        }, t('wallet.copy'))),
      el('div', { class: 'stat-grid' },
        el('div', { class: 'stat-card' },
          el('div', { class: 'k', 'data-i18n': 'aff.players' }), el('div', { class: 'v' }, String(a.players))),
        el('div', { class: 'stat-card' },
          el('div', { class: 'k', 'data-i18n': 'aff.earned' }), el('div', { class: 'v' }, fmtShort(a.earned))),
        el('div', { class: 'stat-card' },
          el('div', { class: 'k', 'data-i18n': 'aff.unpaid' }), el('div', { class: 'v pos' }, fmtShort(a.unpaid)))),
      el('button', {
        class: 'big', style: 'margin-top:12px',
        disabled: a.unpaid <= 0 ? 'disabled' : false,
        onclick: async () => {
          try {
            const r = await api('/api/me/affiliate/claim', { method: 'POST' });
            toast(`+${fmtShort(r.claimed)}`);
            setBalance(r.balance, 1);
            affiliateModal();
          } catch (e) { toast(e.message, 'bad'); }
        },
      }, t('aff.claim')),
      el('hr', { style: 'border:none;border-top:1px solid var(--line);margin:18px 0' }),
      el('h2', { 'data-i18n': 'rake.title' }),
      el('p', { class: 'hint' }, t('rake.explain', { pct: (state.cfg.rakeback.rate * 100).toFixed(0) })),
      el('div', { class: 'stat-row' },
        el('span', { class: 'k', 'data-i18n': 'rake.available' }),
        el('span', { class: 'v pos' }, fmtShort(me.user.rakeback))),
      el('button', {
        class: 'big', style: 'margin-top:8px',
        disabled: me.user.rakeback <= 0 ? 'disabled' : false,
        onclick: async () => {
          try {
            const r = await api('/api/me/rakeback/claim', { method: 'POST' });
            toast(`+${fmtShort(r.claimed)}`);
            setBalance(r.balance, 1);
            affiliateModal();
          } catch (e) { toast(e.message, 'bad'); }
        },
      }, t('rake.claim')),
    );
    applyAll(body);
  } catch (e) {
    body.replaceChildren(el('p', { class: 'hint neg' }, e.message));
  }
}

// ----------------------------------------------------------------- limits
async function limitsModal() {
  if (!requireLogin()) return;
  const body = openModal(t('limits.title'), (b) => b.append(el('p', { class: 'hint' }, t('common.loading'))));
  try {
    const me = await api('/api/me');
    const maxBet = el('input', {
      class: 'mono',
      value: me.user.maxBetCap ? fmt(me.user.maxBetCap) : '',
      placeholder: fmt(state.cfg.risk.maxBetUnits),
      inputmode: 'decimal',
    });
    const days = el('input', { type: 'number', min: '1', max: '365', value: '7' });
    body.replaceChildren(
      el('div', { class: 'stat-row' },
        el('span', { class: 'k', 'data-i18n': 'limits.playedToday' }),
        el('span', { class: 'v' }, t('limits.minutes', { n: me.play.minutes, bets: me.play.bets }))),
      el('h3', { style: 'margin-top:16px', 'data-i18n': 'limits.maxBet' }),
      el('div', { class: 'input-row' }, maxBet,
        el('button', {
          class: 'tiny',
          onclick: async () => {
            try {
              const r = await api('/api/me/limits/max-bet', { method: 'POST', body: { amount: maxBet.value } });
              toast(r.queued ? t('limits.maxBetHint') : t('common.save'));
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, t('limits.save'))),
      el('p', { class: 'hint', 'data-i18n': 'limits.maxBetHint' }),
      el('h3', { style: 'margin-top:16px', 'data-i18n': 'limits.selfExclude' }),
      el('div', { class: 'input-row' }, days,
        el('button', {
          class: 'tiny danger',
          onclick: async () => {
            if (!confirm(t('limits.excludeConfirm', { n: days.value }))) return;
            try {
              await api('/api/me/limits/self-exclude', { method: 'POST', body: { days: Number(days.value) } });
              toast(t('limits.selfExclude'));
              signOut();
              closeModal();
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, t('limits.selfExclude'))),
      el('p', { class: 'hint', 'data-i18n': 'limits.excludeHint' }),
    );
    applyAll(body);
  } catch (e) {
    body.replaceChildren(el('p', { class: 'hint neg' }, e.message));
  }
}


// ------------------------------------------------------------------ slots
let slotInfo = null;
let slotBusy = false;

async function renderSlots() {
  ensureSymbolDefs();
  const panel = $('#betPanel');
  const amount = amountControl('0.20');
  const spin = el('button', { class: 'primary big' }, t('slots.spin'));
  const perLine = el('span', {});

  const recalc = () => {
    const amt = Number(amount.get()) || 0;
    perLine.textContent = slotInfo ? (amt / slotInfo.lines).toFixed(8) : '-';
  };
  amount.input.addEventListener('input', recalc);
  spin.addEventListener('click', () => doSpin(amount, spin));

  panel.replaceChildren(
    amount.node,
    statRow('slots.lines', el('span', {}, slotInfo ? String(slotInfo.lines) : '20')),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('slots.perLineBet')),
      el('span', { class: 'v' }, perLine)),
    spin,
    el('button', {
      class: 'big', style: 'margin-top:8px',
      onclick: () => slotPaytableModal(),
    }, t('slots.paytable')),
  );
  applyAll(panel);

  $('#stage').replaceChildren(
    el('div', { class: 'slot-banner', id: 'slotBanner' }, ''),
    el('div', { class: 'slot-cabinet' },
      el('div', { class: 'reels', id: 'reels' })),
  );

  if (!slotInfo) {
    try { slotInfo = await api('/api/bet/slots/info'); } catch { /* offline */ }
  }
  paintReels(blankScreen());
  recalc();
  infoPanel([
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('slots.rtp')),
      el('span', { class: 'v pos' }, slotInfo ? `${(slotInfo.rtp * 100).toFixed(2)}%` : '-')),
  ]);
}

const blankScreen = () => Array.from({ length: 5 }, (_, i) =>
  [['A', 'K', 'Q'], ['GEM', 'J', 'BELL'], ['WILD', 'A', 'T'], ['K', 'CROWN', 'Q'], ['J', 'T', 'A']][i]);

async function doSpin(amount, spin) {
  if (!requireLogin() || slotBusy) return;
  slotBusy = true;
  spin.disabled = true;
  clearPaylines();
  removeBigWin();
  setReelsSpinning(true);

  try {
    const out = await api('/api/bet/slots', { method: 'POST', body: { amount: amount.get() } });
    // Stop the reels left to right. The stagger is what makes a spin feel like a spin
    // rather than a screen swap, and it is the moment the last reel matters.
    await settleReels(out.screen);
    await showSlotResult(out);
    state.user.balance = out.balance;
    setBalance(out.balance, out.profit);
    loadFeed();
  } catch (e) {
    toast(e.message, 'bad');
    setReelsSpinning(false);
  } finally {
    slotBusy = false;
    spin.disabled = false;
  }
}

function setReelsSpinning(on) {
  for (const r of document.querySelectorAll('#reels .reel')) {
    r.classList.toggle('spinning', on);
    if (!on) r.classList.remove('landing');
  }
}

/** Land each reel in turn, showing its final symbols as it stops. */
async function settleReels(screen) {
  const reels = [...document.querySelectorAll('#reels .reel')];
  if (!reels.length) { paintReels(screen); return; }
  await new Promise((r) => setTimeout(r, 260));
  for (const [i, reel] of reels.entries()) {
    reel.classList.remove('spinning');
    reel.classList.add('landing');
    paintReel(reel, screen[i], []);
    await new Promise((r) => setTimeout(r, 130));
  }
}

function paintReel(reelNode, symbols, litRows) {
  reelNode.replaceChildren(...symbols.map((sym, row) => {
    const cell = el('div', { class: `cell sym-${sym} ${litRows.includes(row) ? 'win' : ''}` });
    cell.innerHTML = symbolSvg(sym);
    return cell;
  }));
}

/** Draw the 5x3 window, highlighting the cells that form a winning line. */
function paintReels(screen, wins = []) {
  const box = $('#reels');
  if (!box) return;
  const lit = new Map();
  if (slotInfo) {
    for (const w of wins) {
      const rows = slotInfo.paylines[w.line];
      for (let reel = 0; reel < w.count; reel += 1) {
        if (!lit.has(reel)) lit.set(reel, []);
        lit.get(reel).push(rows[reel]);
      }
    }
  }
  box.replaceChildren(...screen.map((symbols, ri) => {
    const reel = el('div', { class: 'reel' });
    paintReel(reel, symbols, lit.get(ri) || []);
    return reel;
  }));
}

function clearPaylines() {
  const old = document.getElementById('paylineLayer');
  if (old) old.remove();
}

/**
 * Trace each winning line across the reels it actually covers. Cell positions are
 * measured from the DOM rather than recomputed from the grid maths, so the overlay
 * stays correct at any width.
 */
function drawPaylines(wins) {
  clearPaylines();
  const box = $('#reels');
  if (!box || !slotInfo || !wins.length) return;

  const reels = [...box.querySelectorAll('.reel')];
  const base = box.getBoundingClientRect();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', 'paylineLayer');
  svg.setAttribute('class', 'payline-layer');
  svg.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  for (const w of wins.slice(0, 6)) {
    const rows = slotInfo.paylines[w.line];
    const points = [];
    for (let reel = 0; reel < w.count; reel += 1) {
      const cell = reels[reel]?.children[rows[reel]];
      if (!cell) continue;
      const r = cell.getBoundingClientRect();
      points.push(`${(r.left - base.left + r.width / 2).toFixed(1)},${(r.top - base.top + r.height / 2).toFixed(1)}`);
    }
    if (points.length < 2) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${points.join(' L')}`);
    svg.appendChild(path);
  }
  box.appendChild(svg);
}

function removeBigWin() {
  const old = document.getElementById('bigWin');
  if (old) old.remove();
}

function showBigWin(profit, multiplier) {
  const stage = $('#stage');
  if (!stage) return;
  const node = el('div', { class: 'bigwin', id: 'bigWin' },
    el('div', { class: 'label' }, t('slots.bigWinLabel')),
    el('div', { class: 'amount' }, `+${fmtShort(profit)}`),
    el('div', { class: 'label' }, `${multiplier.toFixed(2)}x`));
  node.addEventListener('click', removeBigWin);
  stage.appendChild(node);
  setTimeout(removeBigWin, 2600);
}

async function showSlotResult(out) {
  setReelsSpinning(false);
  paintReels(out.screen, out.wins);
  drawPaylines(out.wins);
  const banner = $('#slotBanner');
  if (!banner) return;

  if (out.freeSpinsAwarded) {
    banner.className = 'slot-banner free';
    banner.textContent = t('slots.freeSpins', { n: out.freeSpinsAwarded });
    // Replay the free spins one at a time so they are visible, not just totalled.
    for (const [i, fs] of out.freeSpins.entries()) {
      await new Promise((r) => setTimeout(r, 520));
      paintReels(fs.screen, fs.wins);
      drawPaylines(fs.wins);
      banner.textContent = t('slots.freeSpinRun', { i: i + 1, n: out.freeSpins.length });
    }
    await new Promise((r) => setTimeout(r, 420));
    // Come back to the triggering spin: the banner reports the whole round, so leaving
    // the last free spin on screen makes the picture disagree with the number.
    paintReels(out.screen, out.wins);
    drawPaylines(out.wins);
  }

  // A payout below the stake is still a net loss. Dressing that up with a green plus
  // sign is the sort of thing that makes a player distrust every number on the page, so
  // the three cases are shown honestly and differently.
  if (out.profit > 0) {
    banner.className = 'slot-banner win';
    banner.textContent = `+${fmtShort(out.profit)}  (${out.multiplier.toFixed(2)}x)`;
    if (out.multiplier >= 10) showBigWin(out.profit, out.multiplier);
  } else if (out.payout > 0) {
    banner.className = 'slot-banner';
    banner.textContent = `${fmtShort(out.payout)} ${t('slots.returned')}  (${out.multiplier.toFixed(2)}x)`;
  } else {
    banner.className = 'slot-banner';
    banner.textContent = '';
  }
}

function slotPaytableModal() {
  ensureSymbolDefs();
  openModal(t('slots.paytable'), (body) => {
    if (!slotInfo) { body.append(el('p', { class: 'hint' }, t('common.loading'))); return; }
    const symCell = (key) => {
      const d = el('div', { class: 'sym' });
      d.innerHTML = symbolSvg(key);
      return d;
    };
    const rows = [el('div', { class: 'sym' }, ''),
      el('div', { class: 'n' }, '3'), el('div', { class: 'n' }, '4'), el('div', { class: 'n' }, '5')];
    for (const [sym, pays] of Object.entries(slotInfo.pays)) {
      rows.push(symCell(sym));
      for (const p of pays) rows.push(el('div', { class: 'n' }, p.toFixed(2)));
    }
    body.append(
      el('p', { class: 'hint' }, t('slots.perLineBet')),
      el('div', { class: 'paytable-grid' }, ...rows),
      el('h3', { style: 'margin-top:18px' }, t('slots.scatterPays')),
      el('div', { class: 'paytable-grid' },
        ...Object.entries(slotInfo.scatter).flatMap(([n, v]) => [
          symCell('SCAT'),
          el('div', { class: 'n' }, `x${n}`),
          el('div', { class: 'n' }, v.toFixed(2)),
          el('div', {}),
        ])),
      el('div', { class: 'stat-row', style: 'margin-top:16px' },
        el('span', { class: 'k' }, t('slots.rtp')),
        el('span', { class: 'v pos' }, `${(slotInfo.rtp * 100).toFixed(2)}%`)),
    );
  });
}

// -------------------------------------------------------------- preferans
const SUIT_GLYPH = { S: '\u2660', C: '\u2663', D: '\u2666', H: '\u2665' };
const RANK_LABEL = { T: '10' };
const isRedSuit = (s) => s === 'D' || s === 'H';
let prefInfo = null;

/**
 * Which cards may legally be played right now. Mirrors the server rule exactly: follow
 * the led suit, and if you are void you are obliged to trump. The server still enforces
 * it, but making illegal cards unclickable is the difference between a card game and a
 * guessing game with error messages.
 */
function legalCards(g) {
  const hand = g.hand || [];
  const trick = g.trick || [];
  if (!trick.length) return hand;
  const ledSuit = trick[0].card[1];
  const following = hand.filter((c) => c[1] === ledSuit);
  if (following.length) return following;
  if (g.trump && g.trump !== 'NT') {
    const trumps = hand.filter((c) => c[1] === g.trump);
    if (trumps.length) return trumps;
  }
  return hand;
}

function cardNode(card, { onclick, selected, disabled, muted } = {}) {
  const rank = card[0];
  const suit = card[1];
  return el('button', {
    class: `card ${isRedSuit(suit) ? 'red' : ''} ${selected ? 'selected' : ''} ${muted ? 'muted' : ''}`,
    disabled: disabled ? 'disabled' : false,
    onclick: onclick || undefined,
  }, el('span', {}, RANK_LABEL[rank] || rank), el('span', { class: 'suit' }, SUIT_GLYPH[suit]));
}

async function renderPreferans() {
  if (!prefInfo) {
    try { prefInfo = await api('/api/bet/preferans/info'); } catch { /* offline */ }
  }
  state.prefSelected = [];
  let game = { state: 'none' };
  if (state.user) {
    try { game = await api('/api/bet/preferans/current'); } catch { /* nothing open */ }
  }
  state.pref = game;
  paintPreferans();
}

function paintPreferans() {
  const g = state.pref || { state: 'none' };
  const panel = $('#betPanel');
  const stage = $('#stage');

  if (g.state === 'none' || g.state === 'done') {
    const amount = amountControl('0.50');
    const deal = el('button', { class: 'primary big' },
      t(g.state === 'done' ? 'pref.newHand' : 'pref.deal'));
    deal.addEventListener('click', async () => {
      if (!requireLogin()) return;
      deal.disabled = true;
      try {
        state.pref = await api('/api/bet/preferans/start',
          { method: 'POST', body: { amount: amount.get() } });
        state.prefSelected = [];
        state.user.balance = state.pref.balance;
        setBalance(state.pref.balance, -1);
        paintPreferans();
      } catch (e) {
        toast(e.message, 'bad');
        deal.disabled = false;
      }
    });
    panel.replaceChildren(amount.node, deal, el('p', { class: 'hint' }, t('pref.rules')));
  } else if (g.state === 'trump') {
    const pick = el('div', { class: 'trump-pick' },
      ...['S', 'C', 'D', 'H'].map((suit) => el('button', {
        style: isRedSuit(suit) ? 'color:#ff6b81' : '',
        onclick: () => chooseTrump(suit),
      }, SUIT_GLYPH[suit])),
      el('button', { onclick: () => chooseTrump('NT') }, t('pref.noTrump')));
    panel.replaceChildren(
      el('h3', {}, t('pref.pickTrump')),
      pick,
      el('p', { class: 'hint' }, t('pref.rules')),
    );
  } else if (g.state === 'discard') {
    const confirm = el('button', {
      class: 'primary big',
      disabled: (state.prefSelected || []).length === 2 ? false : 'disabled',
      onclick: doDiscard,
    }, t('pref.confirmDiscard'));
    panel.replaceChildren(
      el('h3', {}, t('pref.discardTwo')),
      el('div', { class: 'hand' }, ...(g.talon || []).map((c) => cardNode(c, { disabled: true }))),
      el('p', { class: 'hint' }, t('pref.talon')),
      confirm,
    );
  } else {
    panel.replaceChildren(
      el('div', { class: 'score-row' },
        el('span', {}, `${t('pref.you')}: `, el('b', {}, String(g.tricksWon ? g.tricksWon[0] : 0))),
        el('span', {}, `${t('pref.opponents')}: `,
          el('b', {}, String(g.tricksWon ? g.tricksWon[1] + g.tricksWon[2] : 0)))),
      el('p', { class: 'hint' }, t('pref.trick', { n: Math.min(10, (g.trickNumber || 0) + 1) })),
      el('p', { class: 'hint' }, g.yourTurn ? t('pref.yourTurn') : t('pref.waiting')),
      el('div', { class: 'stat-row' },
        el('span', { class: 'k' }, 'Trump'),
        el('span', { class: 'v' }, g.trump === 'NT' ? t('pref.noTrump') : SUIT_GLYPH[g.trump])),
    );
  }
  applyAll(panel);

  const kids = [];
  if (g.state === 'done') {
    const outcome = g.outcome === 'won' ? t('pref.won', { mult: (g.multiplier || 0).toFixed(2) })
      : (g.outcome === 'push' ? t('pref.push') : t('pref.lostHand'));
    kids.push(el('div', {
      class: `crash-status ${g.outcome === 'won' ? 'pos' : (g.outcome === 'lost' ? 'neg' : '')}`,
      style: 'font-size:18px;padding:8px 0',
    }, t('pref.result', { n: g.tricksWon ? g.tricksWon[0] : 0, outcome })));
  }

  if (g.state === 'playing' || g.state === 'done') {
    const trick = g.trick || [];
    kids.push(el('div', { class: 'trick-area' },
      ...[0, 1, 2].map((slot) => {
        const played = trick.find((x) => x.seat === slot);
        const label = slot === 0 ? t('pref.you') : `Bot ${slot}`;
        return el('div', { class: 'trick-slot' },
          el('div', { class: 'who' }, label),
          played ? cardNode(played.card, { disabled: true }) : el('div', { class: 'empty-slot' }));
      })));
  }

  if (g.hand && g.hand.length) {
    const selectable = g.state === 'discard';
    const playable = g.state === 'playing' && g.yourTurn;
    const legal = playable ? new Set(legalCards(g)) : null;
    kids.push(el('div', { class: 'hand' }, ...g.hand.map((c) => {
      const canPlay = playable && legal.has(c);
      return cardNode(c, {
        selected: (state.prefSelected || []).includes(c),
        disabled: !selectable && !canPlay,
        // Cards you are not allowed to play are dimmed rather than silently inert.
        muted: playable && !canPlay,
        onclick: selectable ? () => toggleDiscard(c) : (canPlay ? () => playPrefCard(c) : undefined),
      });
    })));
  }
  if (g.state === 'done' && g.botHands) {
    for (const bh of g.botHands) {
      kids.push(el('div', { class: 'hand' },
        ...bh.map((c) => cardNode(c, { disabled: true, muted: true }))));
    }
  }
  stage.replaceChildren(...kids);

  infoPanel(prefInfo ? [
    el('h3', { style: 'margin-top:10px' }, t('pref.payTable')),
    ...Object.entries(prefInfo.pays).map(([k, v]) => el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, `${k} ${t('pref.tricks').toLowerCase()}`),
      el('span', { class: 'v' }, `${v.toFixed(2)}x`))),
    el('p', { class: 'hint' }, t('pref.skillNote')),
  ] : []);
}

async function chooseTrump(trump) {
  try {
    state.pref = await api('/api/bet/preferans/trump', { method: 'POST', body: { trump } });
    state.prefSelected = [];
    paintPreferans();
  } catch (e) { toast(e.message, 'bad'); }
}

function toggleDiscard(card) {
  const sel = state.prefSelected || [];
  state.prefSelected = sel.includes(card)
    ? sel.filter((c) => c !== card)
    : (sel.length >= 2 ? [sel[1], card] : [...sel, card]);
  paintPreferans();
}

async function doDiscard() {
  try {
    state.pref = await api('/api/bet/preferans/discard',
      { method: 'POST', body: { cards: state.prefSelected } });
    state.prefSelected = [];
    paintPreferans();
  } catch (e) { toast(e.message, 'bad'); }
}

async function playPrefCard(card) {
  try {
    const out = await api('/api/bet/preferans/play', { method: 'POST', body: { card } });
    state.pref = out;
    paintPreferans();
    if (out.finished) {
      state.user.balance = out.balance;
      setBalance(out.balance, out.profit);
      loadFeed();
    }
  } catch (e) { toast(e.message, 'bad'); }
}

// ------------------------------------------------------------------- boot
const GAMES = ['dice', 'limbo', 'mines', 'crash', 'slots', 'preferans'];

function renderGame() {
  if (state.es && state.game !== 'crash') { state.es.close(); state.es = null; }
  const nav = $('#navGames');
  nav.replaceChildren(...GAMES.map((g) => el('button', {
    class: `tiny ${state.game === g ? 'on' : ''}`,
    style: state.game === g ? 'background:var(--panel);border-color:var(--line)' : 'background:transparent;border-color:transparent;color:var(--text-dim)',
    onclick: () => { state.game = g; renderGame(); },
  }, t(`game.${g}`))));

  if (state.game === 'dice') renderDice();
  else if (state.game === 'limbo') renderLimbo();
  else if (state.game === 'mines') { state.mines = null; renderMines(); loadMinesState(); }
  else if (state.game === 'slots') renderSlots();
  else if (state.game === 'preferans') renderPreferans();
  else renderCrash();
}

async function loadMinesState() {
  if (!state.user) return;
  try {
    const g = await api('/api/bet/mines/current');
    if (g.state === 'active') { state.mines = g; paintMines(); }
  } catch { /* nothing active */ }
}

async function refreshMe() {
  if (!state.user) return;
  try {
    const me = await api('/api/me');
    state.user = me.user;
    state.csrf = me.csrf;
    setBalance(me.user.balance);
  } catch { /* session may have expired */ }
}

/** Banners depend on the active language, so they are rebuilt whenever it changes. */
function renderBanners() {
  const box = $('#banners');
  if (!box) return;
  box.replaceChildren();
  if (state.wallet === 'demo') {
    box.append(el('div', { class: 'banner practice' },
      t('demo.banner'), ' ',
      el('button', {
        class: 'tiny', style: 'margin-left:8px',
        onclick: async () => {
          try {
            const r = await api('/api/demo/topup', { method: 'POST' });
            state.demoBalance = r.balance;
            setBalance(r.balance, 1);
            toast(t('demo.toppedUp'));
          } catch (e) { toast(e.message, 'bad'); }
        },
      }, t('demo.topUp'))));
  }
  if (state.cfg?.wallet?.isMock) box.append(el('div', { class: 'banner' }, t('wallet.mockWarning')));
}

async function boot() {
  const sel = $('#langSelect');
  sel.replaceChildren(...LANGS.map((l) => el('option', { value: l.code }, l.label)));

  try {
    state.cfg = await api('/api/config');
  } catch {
    document.body.prepend(el('div', { class: 'banner' }, 'Server unreachable'));
    return;
  }
  $('#siteName').textContent = state.cfg.siteName;
  document.title = state.cfg.siteName;
  $('#currencyLabel').textContent = state.cfg.currency;

  // Server default unless the visitor already chose a language.
  let locale = null;
  try { locale = localStorage.getItem('locale'); } catch { /* private mode */ }
  setLocale(locale || state.cfg.locale || 'en');
  sel.value = getLocale();
  sel.addEventListener('change', () => {
    setLocale(sel.value);
    renderBanners();
    renderGame();
    loadFeed();
  });

  renderBanners();

  try {
    const savedWallet = localStorage.getItem('wallet');
    if (savedWallet === 'demo' && state.cfg?.demo?.enabled) state.wallet = 'demo';
  } catch { /* private mode */ }
  for (const b of document.querySelectorAll('#modeSwitch button')) {
    b.onclick = () => setWallet(b.dataset.wallet);
  }

  $('#btnSignin').onclick = () => authModal('login');
  $('#btnSignup').onclick = () => authModal('register');
  $('#btnSignout').onclick = signOut;
  $('#btnWallet').onclick = walletModal;
  $('#btnFair').onclick = fairModal;
  $('#btnAff').onclick = affiliateModal;
  $('#btnLimits').onclick = limitsModal;

  for (const b of document.querySelectorAll('#feedTabs button')) {
    b.onclick = () => {
      state.feed = b.dataset.feed;
      for (const o of document.querySelectorAll('#feedTabs button')) o.classList.toggle('on', o === b);
      loadFeed();
    };
  }

  try {
    const me = await api('/api/me');
    state.user = me.user;
    state.csrf = me.csrf;
    state.demoBalance = me.demoBalance || 0;
    if (!me.demoEnabled) state.wallet = 'real';
    afterAuth();
  } catch {
    renderGame();
    loadFeed();
    if (new URLSearchParams(location.search).get('ref')) authModal('register');
  }
  setInterval(loadFeed, 15000);
}

boot();
