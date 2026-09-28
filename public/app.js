import { LANGS, t, setLocale, getLocale, applyAll } from './i18n.js';
import { ensureSymbolDefs, symbolSvg, THEME_KEYS } from './symbols.js';
import { pictureSvg } from './pictures.js';
import { createCut } from './jigsaw.js';
import * as audio from './audio.js';
import * as tokenKeys from './tokenkeys.js';
import { verifyChain, compareHeads } from './chainverify.js';

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
    addKids(n, kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

/**
 * replaceChildren that drops null and false, the way el() already does with its children.
 * The native call stringifies them, so a `cond ? el(...) : null` child renders the literal
 * word "null" on the page. It did, in the arcade panel.
 */
/**
 * append that drops null and false, the way el() already does with its children.
 * The native call stringifies them, so `cond ? el(...) : null` rendered the literal word
 * "null" on the page. It did, twice, in the middle of the sign-in form.
 */
const addKids = (node, ...kids) => {
  node.append(...kids.flat().filter((k) => k != null && k !== false));
  return node;
};

const setKids = (node, ...kids) => {
  // This one call stays as node.replaceChildren: it is the DOM method, not this helper.
  // (replaceChildren lives on Element, not on Node, so reaching for it through a prototype
  // is both unnecessary and wrong.)
  node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  return node;
};

/** Same idea as el(), for the SVG namespace. */
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
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
  // Head-to-head matches: the lobby, the one being watched, its board and its poll.
  matchLobby: null, matchId: null, matchView: null, board: null, matchTimer: null,
  // Pictures the operator imported for the puzzle, keyed the same way the drawn ones are.
  puzzlePictures: null,
  // The tugrik wallet, when it is the active one.
  tokenBalance: 0, tokenNonce: 0, tokenPubkey: null, tokenHouse: null,
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
  if (method === 'POST' && state.wallet !== 'real' && STAKE_ROUTES.some((r) => path.startsWith(r))) {
    payload = { ...(body || {}), wallet: state.wallet };
    // A tugrik stake is a transfer, and a transfer needs the player's signature. Done here,
    // in the one place every staking request passes through, so a new game cannot forget
    // it and cannot send an unsigned bet the server would refuse.
    if (state.wallet === 'token') payload.spend = await signStakeFor(payload);
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
  addKids($('#toasts'), node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  }, 3600);
}

/** Put a already-formatted figure in the balance box. Tugriks are whole and not divided. */
function setBalanceRaw(text, direction) {
  const box = $('#balanceBox');
  const v = $('#balanceValue');
  box.hidden = false;
  v.textContent = text;
  if (direction) {
    v.className = `value ${direction > 0 ? 'flash' : 'flash-down'}`;
    setTimeout(() => { v.className = 'value'; }, 320);
  }
}

function setBalance(units, direction) {
  const box = $('#balanceBox');
  const v = $('#balanceValue');
  box.hidden = false;
  if (state.wallet === 'demo') state.demoBalance = units;
  else if (state.wallet === 'token') state.tokenBalance = units;
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
          setKids(body);
          tab.build(body);
          applyAll(body);
        },
      }, tab.label);
      addKids(bar, b);
    });
    addKids(modal, bar);
    tabs[0].build(body);
  } else {
    buildBody(body);
  }
  addKids(modal, body);
  const back = el('div', {
    class: 'modal-back',
    onclick: (e) => { if (e.target === back) closeModal(); },
  }, modal);
  setKids($('#modalRoot'), back);
  applyAll(back);
  document.addEventListener('keydown', escClose);
  return body;
}
const escClose = (e) => { if (e.key === 'Escape') closeModal(); };
function closeModal() {
  setKids($('#modalRoot'));
  document.removeEventListener('keydown', escClose);
}

// ------------------------------------------------------------------ radio
/**
 * The dial.
 *
 * Sound and music are separate switches because wanting the reels to click without a jazz
 * trio behind them is a perfectly normal preference, and a casino that will not shut up is
 * one people close.
 */
function radioModal(onSettingsChange) {
  const body = openModal(t('radio.title'), () => {});
  const nowTitle = el('div', { class: 'v' }, '—');
  const nowStation = el('div', { class: 'k' }, '');
  let stopWatching = null;

  const paint = (info) => {
    const lang = getLocale() === 'ru' ? 'ru' : 'en';
    nowTitle.textContent = info ? info.title[lang] : t('radio.silent');
    nowStation.textContent = info
      ? `${info.stationName[lang]} · ${info.position}/${info.of} · ${info.bpm} BPM`
      : '';
    for (const btn of body.querySelectorAll('[data-station]')) {
      btn.classList.toggle('on', !!info && btn.dataset.station === info.station);
    }
  };

  const toggle = (label, isOn, set) => {
    const b = el('button', { class: isOn() ? 'on' : '' }, label);
    b.onclick = () => {
      set(!isOn());
      b.classList.toggle('on', isOn());
      paint(audio.nowPlaying());
      if (onSettingsChange) onSettingsChange();
    };
    return b;
  };

  setKids(body,
    el('div', { class: 'stat-card' },
      el('div', { class: 'k' }, t('radio.nowPlaying')),
      nowTitle,
      nowStation),
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', { onclick: () => paint(audio.skip(-1)) }, '‹‹'),
      toggle(t('radio.sound'), audio.isEnabled, (on) => audio.setEnabled(on)),
      toggle(t('radio.music'), audio.isMusicOn, (on) => audio.setMusic(on)),
      toggle(t('radio.vinyl'), audio.isVinylOn, (on) => audio.setVinyl(on)),
      el('button', { onclick: () => paint(audio.skip(1)) }, '››')),
    el('h3', { style: 'margin-top:16px' }, t('radio.stations')),
    el('div', { class: 'stations' }, ...audio.stations().map((st) => el('button', {
      'data-station': st.id,
      onclick: () => {
        audio.setEnabled(true);
        audio.setMusic(true);
        paint(audio.setStation(st.id));
        if (onSettingsChange) onSettingsChange();
      },
    },
    el('strong', {}, st.name[getLocale() === 'ru' ? 'ru' : 'en']),
    el('span', {}, st.blurb[getLocale() === 'ru' ? 'ru' : 'en'])))),
    el('p', { class: 'hint', style: 'margin-top:14px' }, t('radio.about')));

  applyAll(body);
  paint(audio.nowPlaying());
  stopWatching = audio.onRadio(paint);
  // The modal is thrown away on close, so the subscription has to go with it or every
  // visit to the dial leaves another listener painting a panel that is no longer on screen.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(body)) { stopWatching?.(); observer.disconnect(); }
  });
  observer.observe($('#modalRoot'), { childList: true, subtree: true });
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

    addKids(body, 
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
/** True while the active wallet is the site token. Same units; a different currency. */
const inTokens = () => state.wallet === 'token';

function applyWallet() {
  const demo = state.wallet === 'demo';
  document.body.classList.toggle('practice', demo);
  document.body.classList.toggle('tokens', inTokens());
  for (const b of document.querySelectorAll('#modeSwitch button')) {
    b.classList.toggle('on', b.dataset.wallet === state.wallet);
  }
  // The currency label follows the wallet, because a tugrik balance shown as "1000.00000000
  // CRD" is not a smaller mistake than showing the wrong number.
  const label = $('#currencyLabel');
  if (label) label.textContent = inTokens() ? (state.cfg?.token?.symbol || 'TUG') : state.cfg?.currency;
  if (inTokens()) setBalance(state.tokenBalance ?? 0);
  else setBalance(demo ? state.demoBalance : (state.user?.balance ?? 0));
  renderBanners();
}

async function setWallet(next) {
  if (state.wallet === next) return;
  if (next === 'token' && !state.cfg?.token?.enabled) return;
  state.wallet = next;
  try { localStorage.setItem('wallet', next); } catch { /* private mode */ }
  if (next === 'demo' && state.user) {
    try { state.demoBalance = (await api('/api/demo')).balance; } catch { /* keep last */ }
  }
  if (next === 'token' && state.user) await refreshTokenBalance();
  if (next === 'token' && state.user && !tokenKey) toast(t('arc.needUnlock'), 'warn');
  // Any half-finished round belongs to the other wallet, so start clean.
  state.mines = null;
  state.pref = null;
  applyWallet();
  renderGame();
}

/**
 * Sign the stake on an outgoing bet.
 *
 * The amount is read from the request rather than passed in, because every game words it
 * the same way and there is exactly one field that means "how much". A round that has
 * already been paid for (revealing a tile, cashing out) has no amount and needs no
 * signature: the stake went in when the round opened.
 */
async function signStakeFor(payload) {
  const amount = payload.amount ?? payload.wager;
  if (amount === undefined || amount === null || amount === '') return undefined;
  const units = Math.round(Number(amount) * UNIT);
  if (!Number.isSafeInteger(units) || units <= 0) return undefined;

  if (!tokenKey) {
    await refreshTokenBalance();
    throw new Error(t('arc.needUnlock'));
  }
  await refreshTokenBalance();
  if (!state.tokenHouse) throw new Error(t('tok.noHouse'));

  const tx = {
    from: tokenKey.publicKey, to: state.tokenHouse, amount: units, nonce: state.tokenNonce,
  };
  const sig = await tokenKeys.signTransfer(tokenKey, tx);
  return { from: tx.from, nonce: tx.nonce, sig };
}

/** The tugrik balance, and the next nonce a stake will have to be signed with. */
async function refreshTokenBalance() {
  try {
    const info = await api('/api/token');
    state.tokenBalance = info.balance || 0;
    state.tokenNonce = info.nextNonce || 0;
    state.tokenPubkey = info.pubkey || null;
    state.tokenHouse = info.houseKey || null;
  } catch { /* keep the last figure rather than blanking it */ }
}

async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  // The wallet belongs to the account that just left, so it does not stay on this device.
  tokenKey = null;
  await tokenKeys.forget();
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

/**
 * The arcade has no house edge and no maximum win, because nothing there is a bet. Showing
 * the betting panel for it printed "NaN%" against a game that cannot pay out at all.
 */
function arcadeInfoPanel() {
  const info = state.arcade || {};
  setKids($('#infoPanel'),
    el('h3', {}, t('arc.title')),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('arc.cost')),
      el('span', { class: 'v' }, `${info.tokenCost ?? '-'} ${info.symbol || ''}`)),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('arc.balance')),
      el('span', { class: 'v' }, `${info.balance ?? 0} ${info.symbol || ''}`)),
    el('p', { class: 'hint' }, t('arc.noPayout')));
}

function infoPanel(extra = []) {
  if (state.game === 'arcade') { arcadeInfoPanel(); return; }
  const p = $('#infoPanel');
  setKids(p, 
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
      audio.sfx(out.won ? 'win' : 'lose');
      state.user.balance = out.balance;
      setBalance(out.balance, out.profit);
      loadFeed();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      go.disabled = false;
    }
  });

  setKids(panel, 
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

  setKids($('#stage'), 
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
      audio.sfx(out.won ? (out.drawn >= 10 ? 'bigWin' : 'win') : 'lose');
      state.user.balance = out.balance;
      setBalance(out.balance, out.profit);
      loadFeed();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      go.disabled = false;
    }
  });

  setKids(panel, 
    amount.node,
    el('label', { class: 'field' }, el('span', { 'data-i18n': 'limbo.target' }), target),
    statRow('bet.chance', chanceOut),
    statRow('bet.profit', profitOut),
    go,
  );
  applyAll(panel);
  setKids($('#stage'), 
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

  setKids(panel, 
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
    addKids(grid, el('button', {
      class: `tile ${isGem ? 'gem' : ''} ${isMine ? 'mine' : ''} ${done && !isGem && !isMine ? 'dim' : ''}`,
      disabled: (!live || isGem) ? 'disabled' : false,
      onclick: () => revealTile(i),
    }, isGem ? '◆' : (isMine ? '✕' : '')));
  }

  const status = g && g.state === 'lost' ? t('mines.boom')
    : (g && g.state === 'cashed' ? t('mines.cashedOut', { mult: (g.multiplier || 0).toFixed(2) })
      : (live ? `${(g.multiplier || 0).toFixed(2)}×` : t('mines.pickTile')));

  setKids($('#stage'), 
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
    audio.sfx(out.safe ? 'tileOpen' : 'crack');
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
      audio.sfx('cashout');
      state.user.balance = out.balance;
      setBalance(out.balance, 1);
      state.crashBet = null;
      loadFeed();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });

  setKids(panel, 
    amount.node,
    el('label', { class: 'field' }, el('span', { 'data-i18n': 'crash.autoCashout' }), auto),
    bet, cash,
  );
  applyAll(panel);
  state.crashUi = { bet, cash };

  setKids($('#stage'), 
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
  addKids(svg, p);
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
    setKids(box, ...hist.map((h) => el('span', {
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
  let lastTickSound = 0;
  es.addEventListener('tick', (e) => {
    const { m } = JSON.parse(e.data);
    setMult(m, 'running');
    drawCurve(m, false);
    // One tick per 0.25x so the pace tracks the climb, not the frame rate.
    if (m - lastTickSound >= 0.25) { audio.sfx('tick'); lastTickSound = m; }
  });
  es.addEventListener('crash', (e) => {
    const s = JSON.parse(e.data);
    setMult(s.crashPoint, 'busted');
    drawCurve(s.crashPoint, true);
    audio.sfx('crack');
    lastTickSound = 0;
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
      if (!state.user) { setKids(body, el('p', { class: 'hint' }, t('err.signin'))); return; }
      rows = (await api('/api/me/bets?limit=40')).bets;
      mine = true;
    } else {
      const s = await api('/api/stats/recent');
      rows = state.feed === 'biggest' ? s.biggest : s.bets;
    }
    if (!rows.length) { setKids(body, el('p', { class: 'hint' }, t('feed.empty'))); return; }
    setKids(body, el('table', { class: 'grid' },
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
    setKids(body, el('p', { class: 'hint' }, t('err.network')));
  }
}

// ----------------------------------------------------------------- wallet
async function walletModal() {
  if (!requireLogin()) return;

  const depositTab = async (body) => {
    setKids(body, el('p', { class: 'hint' }, t('common.loading')));
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
      setKids(body, ...kids);
      applyAll(body);
    } catch (e) {
      setKids(body, el('p', { class: 'hint neg' }, e.message));
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
    setKids(body, 
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
    setKids(body, el('p', { class: 'hint' }, t('common.loading')));
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
      if (!rows.length) { setKids(body, el('p', { class: 'hint' }, t('feed.empty'))); return; }
      setKids(body, el('table', { class: 'grid' },
        el('tbody', {}, ...rows.map((r) => el('tr', {},
          el('td', { class: 'name' }, r.kind),
          el('td', { class: r.amount > 0 ? 'pos' : 'neg' }, fmtShort(r.amount)),
          el('td', { class: 'name faint' }, r.state),
          el('td', { class: 'faint' }, new Date(r.at * 1000).toLocaleString()))))));
    } catch (e) {
      setKids(body, el('p', { class: 'hint neg' }, e.message));
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
  const body = openModal(t('fair.title'), (b) => addKids(b, el('p', { class: 'hint' }, t('common.loading'))));
  try {
    const f = await api('/api/fair/seed');
    const seedInput = el('input', { class: 'mono', value: f.clientSeed, maxlength: '64' });
    setKids(body, 
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
    setKids(body, el('p', { class: 'hint neg' }, e.message));
  }
}

// -------------------------------------------------------------- affiliate
async function affiliateModal() {
  if (!requireLogin()) return;
  const body = openModal(t('nav.affiliate'), (b) => addKids(b, el('p', { class: 'hint' }, t('common.loading'))));
  try {
    const a = await api('/api/me/affiliate');
    const me = await api('/api/me');
    setKids(body, 
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
    setKids(body, el('p', { class: 'hint neg' }, e.message));
  }
}

// ----------------------------------------------------------------- limits
async function limitsModal() {
  if (!requireLogin()) return;
  const body = openModal(t('limits.title'), (b) => addKids(b, el('p', { class: 'hint' }, t('common.loading'))));
  try {
    const me = await api('/api/me');
    const maxBet = el('input', {
      class: 'mono',
      value: me.user.maxBetCap ? fmt(me.user.maxBetCap) : '',
      placeholder: fmt(state.cfg.risk.maxBetUnits),
      inputmode: 'decimal',
    });
    const days = el('input', { type: 'number', min: '1', max: '365', value: '7' });
    setKids(body, 
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
    setKids(body, el('p', { class: 'hint neg' }, e.message));
  }
}


// ------------------------------------------------------------------ slots
let slotInfo = null;
let slotBusy = false;
// Cosmetic only: the reel maths, paytable and RTP are identical across themes.
let slotTheme = (() => {
  try { return localStorage.getItem('slotTheme') || 'classic'; } catch { return 'classic'; }
})();

/** Each theme paints the cabinet through a body class; only one may be on at a time. */
function applySlotTheme() {
  for (const k of THEME_KEYS) document.body.classList.toggle(k, slotTheme === k);
}

async function renderSlots() {
  ensureSymbolDefs();
  applySlotTheme();
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

  setKids(panel, 
    amount.node,
    statRow('slots.lines', el('span', {}, slotInfo ? String(slotInfo.lines) : '20')),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('slots.perLineBet')),
      el('span', { class: 'v' }, perLine)),
    spin,
    el('label', { class: 'field', style: 'margin-top:12px' },
      el('span', {}, t('slots.theme')),
      el('select', {
        onchange: (e) => {
          slotTheme = e.target.value;
          try { localStorage.setItem('slotTheme', slotTheme); } catch { /* private mode */ }
          applySlotTheme();
          renderSlots();
        },
      }, ...THEME_KEYS.map((k) => el('option', {
        value: k, selected: k === slotTheme ? 'selected' : false,
      }, t(`slots.theme.${k}`))))),
    el('button', {
      class: 'big',
      onclick: () => slotPaytableModal(),
    }, t('slots.paytable')),
  );
  applyAll(panel);

  setKids($('#stage'), 
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
  audio.sfx('spin');
  // Keep the whirr going for as long as the reels are actually turning.
  const whirr = setInterval(() => audio.sfx('spin'), 130);

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
    clearInterval(whirr);
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
    audio.sfx('reelStop');
    await new Promise((r) => setTimeout(r, 130));
  }
}

function paintReel(reelNode, symbols, litRows) {
  setKids(reelNode, ...symbols.map((sym, row) => {
    const cell = el('div', { class: `cell sym-${sym} ${litRows.includes(row) ? 'win' : ''}` });
    cell.innerHTML = symbolSvg(sym, slotTheme);
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
  setKids(box, ...screen.map((symbols, ri) => {
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
      audio.sfx(fs.wins.length ? 'win' : 'reelStop');
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
    if (out.multiplier >= 10) { showBigWin(out.profit, out.multiplier); audio.sfx('bigWin'); }
    else audio.sfx('win');
  } else if (out.payout > 0) {
    banner.className = 'slot-banner';
    banner.textContent = `${fmtShort(out.payout)} ${t('slots.returned')}  (${out.multiplier.toFixed(2)}x)`;
  } else {
    banner.className = 'slot-banner';
    banner.textContent = '';
    audio.sfx('lose');
  }
}

function slotPaytableModal() {
  ensureSymbolDefs();
  openModal(t('slots.paytable'), (body) => {
    if (!slotInfo) { addKids(body, el('p', { class: 'hint' }, t('common.loading'))); return; }
    const symCell = (key) => {
      const d = el('div', { class: 'sym' });
      d.innerHTML = symbolSvg(key, slotTheme);
      return d;
    };
    const rows = [el('div', { class: 'sym' }, ''),
      el('div', { class: 'n' }, '3'), el('div', { class: 'n' }, '4'), el('div', { class: 'n' }, '5')];
    for (const [sym, pays] of Object.entries(slotInfo.pays)) {
      rows.push(symCell(sym));
      for (const p of pays) rows.push(el('div', { class: 'n' }, p.toFixed(2)));
    }
    addKids(body, 
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


// ----------------------------------------------------------------- puzzle
let puzzleInfo = null;

async function renderPuzzle() {
  if (!puzzleInfo) {
    try { puzzleInfo = await api('/api/bet/puzzle/info'); } catch { /* offline */ }
  }
  let game = { state: 'none' };
  if (state.user) {
    try { game = await api('/api/bet/puzzle/current'); } catch { /* nothing open */ }
  }
  state.puzzle = game;
  paintPuzzle();
}

function paintPuzzle() {
  const g = state.puzzle || { state: 'none' };
  const live = g.state === 'active';
  const panel = $('#betPanel');

  if (!live) {
    const amount = amountControl('0.10');
    const diff = el('select', {}, ...(puzzleInfo?.tiers || []).map((tier) => el('option', {
      value: tier.key, selected: tier.key === (state.puzzleTier || 'medium') ? 'selected' : false,
    }, `${t(`puzzle.${tier.key}`)} — ${tier.cols}x${tier.rows}, ${tier.broken} broken`)));
    diff.addEventListener('change', () => { state.puzzleTier = diff.value; paintPuzzle(); });

    const tier = (puzzleInfo?.tiers || []).find((x) => x.key === (state.puzzleTier || 'medium'));
    const start = el('button', { class: 'primary big' }, t('puzzle.start'));
    start.addEventListener('click', async () => {
      if (!requireLogin()) return;
      start.disabled = true;
      try {
        state.puzzle = await api('/api/bet/puzzle/start', {
          method: 'POST', body: { amount: amount.get(), difficulty: diff.value },
        });
        setBalance(state.puzzle.balance, -1);
        paintPuzzle();
      } catch (e) {
        toast(e.message, 'bad');
        start.disabled = false;
      }
    });

    setKids(panel, 
      amount.node,
      el('label', { class: 'field' }, el('span', {}, t('puzzle.difficulty')), diff),
      tier ? statRow('puzzle.topPrize', el('span', {}, `${tier.complete.toFixed(2)}x`)) : null,
      tier ? statRow('puzzle.broken', el('span', {}, String(tier.broken))) : null,
      start,
      el('p', { class: 'hint' }, t('puzzle.sameEdge')),
    );
  } else {
    const cash = el('button', { class: 'primary big' },
      t('puzzle.cashout', { amount: fmtShort(g.cashoutValue || 0) }));
    cash.disabled = !g.picks?.length;
    cash.addEventListener('click', async () => {
      cash.disabled = true;
      try {
        const out = await api('/api/bet/puzzle/cashout', { method: 'POST' });
        state.puzzle = out;
        setBalance(out.balance, 1);
        paintPuzzle();
        loadFeed();
      } catch (e) { toast(e.message, 'bad'); cash.disabled = false; }
    });
    setKids(panel, 
      statRow('bet.multiplier', el('span', {}, `${(g.multiplier || 0).toFixed(2)}x`)),
      statRow('puzzle.next', el('span', {}, g.nextMultiplier ? `${g.nextMultiplier.toFixed(2)}x` : '-')),
      statRow('puzzle.pieces', el('span', {}, String(g.remaining ?? 0))),
      cash,
      ladderList(g),
    );
  }
  applyAll(panel);

  // ---- the stage: artwork underneath, covers on top
  const tier = (puzzleInfo?.tiers || []).find((x) => x.key === (g.difficulty || state.puzzleTier || 'medium'))
    || { cols: 4, rows: 3, tiles: 12 };
  const cols = g.cols || tier.cols;
  const rows = g.rows || tier.rows;
  const total = g.tiles || tier.tiles;
  const picks = new Set(g.picks || []);
  const broken = new Set(g.state && g.state !== 'active' ? (g.broken || []) : []);

  const art = el('div', { class: 'puzzle-art' });
  const key = g.picture || 'deco';
  const own = state.puzzlePictures?.[key];
  if (own) {
    // An imported picture. Set as a background rather than written into the markup, so a
    // filename can never become markup on the page.
    art.style.backgroundImage = `url("${own}")`;
    art.style.backgroundSize = 'cover';
    art.style.backgroundPosition = 'center';
  } else {
    art.innerHTML = pictureSvg(key);
  }

  // Real jigsaw pieces rather than a grid of squares: neighbouring pieces share an edge
  // exactly, so a tab on one is the blank on the other. The cut is seeded from the round
  // so it stays put across re-renders; which pieces are broken still comes from the
  // server, never from here.
  const BOARD = 1000;
  const boardH = Math.round((BOARD * rows) / cols);
  const cut = createCut({
    cols, rows, width: BOARD, height: boardH, seed: (g.nonce || 1) * 2654435761,
  });
  const grid = svgEl('svg', {
    class: 'puzzle-pieces',
    viewBox: `0 0 ${BOARD} ${boardH}`,
    preserveAspectRatio: 'none',
  });
  for (let i = 0; i < total; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const open = picks.has(i);
    const cracked = broken.has(i);
    const piece = svgEl('path', {
      d: cut.path(col, row),
      class: `piece ${open ? 'open' : ''} ${cracked ? 'cracked' : ''}`,
    });
    if (g.state === 'active' && !open) {
      piece.addEventListener('click', () => revealPiece(i));
    }
    addKids(grid, piece);
  }

  const status = g.state === 'lost' ? t('puzzle.cracked')
    : (g.state === 'cashed'
      ? t('puzzle.complete', { mult: (g.multiplier || 0).toFixed(2) })
      : (g.state === 'active' ? `${(g.multiplier || 0).toFixed(2)}x` : t('puzzle.pick')));

  const shape = cols / rows >= 1.6 ? 'widest' : (cols / rows > 1.05 ? 'wide' : '');
  setKids($('#stage'), 
    el('div', {
      class: `puzzle-status ${g.state === 'lost' ? 'lost' : (g.state === 'cashed' ? 'won' : '')}`,
    }, status),
    el('div', { class: `puzzle-frame ${shape}` }, art, grid),
  );

  infoPanel(puzzleInfo ? [
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('bet.edge')),
      el('span', { class: 'v' }, `${(puzzleInfo.edge * 100).toFixed(2)}%`)),
  ] : []);
}

/** The payout ladder, with the rung already reached marked. */
function ladderList(g) {
  const rungs = g.ladder || [];
  const at = (g.picks || []).length;
  return el('div', {},
    el('h3', { style: 'margin-top:14px' }, t('puzzle.ladder')),
    el('div', { class: 'ladder-list' }, ...rungs.map((m, i) => el('span', {
      class: i + 1 < at ? 'done' : (i + 1 === at ? 'now' : ''),
    }, `${m.toFixed(2)}x`))));
}

async function revealPiece(tile) {
  try {
    const out = await api('/api/bet/puzzle/reveal', { method: 'POST', body: { tile } });
    state.puzzle = out;
    if (out.balance != null) setBalance(out.balance, out.safe ? 0 : -1);
    paintPuzzle();
    audio.sfx(out.safe ? 'tileOpen' : 'crack');
    if (out.completed) audio.sfx('bigWin');
    if (!out.safe) { toast(t('puzzle.cracked'), 'bad'); loadFeed(); }
    if (out.completed) {
      toast(t('puzzle.complete', { mult: (out.multiplier || 0).toFixed(2) }));
      loadFeed();
    }
  } catch (e) {
    toast(e.message, 'bad');
  }
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
    setKids(panel, amount.node, deal, el('p', { class: 'hint' }, t('pref.rules')));
  } else if (g.state === 'trump') {
    const pick = el('div', { class: 'trump-pick' },
      ...['S', 'C', 'D', 'H'].map((suit) => el('button', {
        style: isRedSuit(suit) ? 'color:#ff6b81' : '',
        onclick: () => chooseTrump(suit),
      }, SUIT_GLYPH[suit])),
      el('button', { onclick: () => chooseTrump('NT') }, t('pref.noTrump')));
    setKids(panel, 
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
    setKids(panel, 
      el('h3', {}, t('pref.discardTwo')),
      el('div', { class: 'hand' }, ...(g.talon || []).map((c) => cardNode(c, { disabled: true }))),
      el('p', { class: 'hint' }, t('pref.talon')),
      confirm,
    );
  } else {
    setKids(panel, 
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
  setKids(stage, ...kids);

  infoPanel(prefInfo ? [
    el('h3', { style: 'margin-top:10px' }, t('pref.payTable')),
    ...Object.entries(prefInfo.pays).map(([k, v]) => el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('pref.nTricks', { n: Number(k) })),
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
    audio.sfx('card');
    if (out.finished) {
      state.user.balance = out.balance;
      setBalance(out.balance, out.profit);
      audio.sfx(out.outcome === 'won' ? 'win' : (out.outcome === 'push' ? 'click' : 'lose'));
      loadFeed();
    }
  } catch (e) { toast(e.message, 'bad'); }
}


// ---------------------------------------------------------------- debertz
// Trick strength, mirrored from the server so illegal cards can be greyed out rather
// than rejected after the click. The trump order is the whole character of the game:
// the Jack is highest and the Nine second, which is true in no other suit.
const DEB_TRUMP_ORDER = ['7', '8', 'Q', 'K', 'T', 'A', '9', 'J'];
const DEB_PLAIN_ORDER = ['7', '8', '9', 'J', 'Q', 'K', 'T', 'A'];
const debStrength = (card, trump) => (card[1] === trump
  ? DEB_TRUMP_ORDER.indexOf(card[0])
  : DEB_PLAIN_ORDER.indexOf(card[0]));

/** Which cards may legally be played now. Mirrors src/games/debertz.js exactly. */
function debLegal(g) {
  const hand = g.hand || [];
  const trick = g.trick || [];
  const trump = g.trump;
  if (!trick.length) return hand;
  const led = trick[0].card[1];

  const following = hand.filter((c) => c[1] === led);
  if (following.length) {
    if (led === trump) {
      const best = Math.max(...trick.filter((p) => p.card[1] === trump)
        .map((p) => debStrength(p.card, trump)), -1);
      const higher = following.filter((c) => debStrength(c, trump) > best);
      return higher.length ? higher : following;
    }
    return following;
  }
  const trumps = hand.filter((c) => c[1] === trump);
  if (!trumps.length) return hand;
  const played = trick.filter((p) => p.card[1] === trump);
  if (!played.length) return trumps;
  const best = Math.max(...played.map((p) => debStrength(p.card, trump)));
  const higher = trumps.filter((c) => debStrength(c, trump) > best);
  return higher.length ? higher : hand;
}

let debInfo = null;

async function renderDebertz() {
  if (!debInfo) {
    try { debInfo = await api('/api/bet/debertz/info'); } catch { /* offline */ }
  }
  let game = { state: 'none' };
  if (state.user) {
    try { game = await api('/api/bet/debertz/current'); } catch { /* nothing open */ }
  }
  state.deb = game;
  paintDebertz();
}

function paintDebertz() {
  const g = state.deb || { state: 'none' };
  const panel = $('#betPanel');
  const stage = $('#stage');

  if (g.state === 'none' || g.state === 'done') {
    const amount = amountControl('0.50');
    const deal = el('button', { class: 'primary big' },
      t(g.state === 'done' ? 'deb.newHand' : 'deb.deal'));
    deal.addEventListener('click', async () => {
      if (!requireLogin()) return;
      deal.disabled = true;
      try {
        state.deb = await api('/api/bet/debertz/start', { method: 'POST', body: { amount: amount.get() } });
        setBalance(state.deb.balance, -1);
        paintDebertz();
      } catch (e) { toast(e.message, 'bad'); deal.disabled = false; }
    });
    setKids(panel, 
      amount.node, deal,
      el('p', { class: 'hint' }, t('deb.rules')),
      el('p', { class: 'hint neg' }, t('deb.beteWarn')),
    );
  } else if (g.state === 'trump') {
    const pick = el('div', { class: 'trump-pick' },
      ...['S', 'C', 'D', 'H'].map((suit) => el('button', {
        style: isRedSuit(suit) ? 'color:#ff6b81' : '',
        onclick: () => debChooseTrump(suit),
      }, SUIT_GLYPH[suit])));
    setKids(panel, 
      el('h3', {}, t('deb.pickTrump')),
      el('p', { class: 'hint' }, `${t('deb.upcard')}: ${g.upcard}`),
      pick,
      el('p', { class: 'hint' }, t('deb.rules')),
    );
  } else {
    setKids(panel, 
      el('div', { class: 'score-row' },
        el('span', {}, `${t('deb.you')}: `, el('b', {}, String(g.cardPoints?.[0] ?? 0))),
        el('span', {}, `${t('deb.opponent')}: `, el('b', {}, String(g.cardPoints?.[1] ?? 0)))),
      el('p', { class: 'hint' }, t('deb.trick', { n: Math.min(9, (g.trickNumber ?? 0) + 1) })),
      el('p', { class: 'hint' }, g.yourTurn ? t('deb.yourTurn') : t('deb.waiting')),
      el('div', { class: 'stat-row' },
        el('span', { class: 'k' }, t('deb.trump')),
        el('span', { class: 'v' }, SUIT_GLYPH[g.trump] || '-')),
      g.meld?.value
        ? statRow('deb.meld', el('span', {}, `${g.meld.value}`))
        : null,
      g.bella ? statRow('deb.bella', el('span', {}, '20')) : null,
    );
  }
  applyAll(panel);

  // ---- stage
  const kids = [];
  if (g.state === 'done') {
    const r = g.result || {};
    const text = r.bete ? t('deb.bete')
      : (g.multiplier > 1
        ? t('deb.won', { margin: r.margin, mult: (g.multiplier || 0).toFixed(2) })
        : t('deb.push'));
    kids.push(el('div', {
      class: `crash-status ${r.bete ? 'neg' : (g.multiplier > 1 ? 'pos' : '')}`,
      style: 'font-size:18px;padding:8px 0',
    }, text));
    if (r.totals) {
      kids.push(el('div', { class: 'score-row', style: 'margin-bottom:10px' },
        el('span', {}, `${t('deb.you')}: `, el('b', {}, String(r.totals[0]))),
        el('span', {}, `${t('deb.opponent')}: `, el('b', {}, String(r.totals[1])))));
    }
  }

  if (g.state === 'trump') {
    kids.push(el('div', { class: 'trick-area' },
      el('div', { class: 'trick-slot' },
        el('div', { class: 'who' }, t('deb.upcard')),
        cardNode(g.upcard, { disabled: true }))));
  }

  if (g.state === 'playing' || g.state === 'done') {
    const trick = g.trick || [];
    kids.push(el('div', { class: 'trick-area' },
      ...[0, 1].map((slot) => {
        const played = trick.find((x) => x.seat === slot);
        return el('div', { class: 'trick-slot' },
          el('div', { class: 'who' }, slot === 0 ? t('deb.you') : t('deb.opponent')),
          played ? cardNode(played.card, { disabled: true }) : el('div', { class: 'empty-slot' }));
      })));
  }

  if (g.hand?.length) {
    const playable = g.state === 'playing' && g.yourTurn;
    const legal = playable ? new Set(debLegal(g)) : null;
    kids.push(el('div', { class: 'hand' }, ...g.hand.map((c) => {
      const canPlay = playable && legal.has(c);
      return cardNode(c, {
        disabled: !canPlay,
        muted: playable && !canPlay,
        onclick: canPlay ? () => debPlay(c) : undefined,
      });
    })));
  }
  if (g.state === 'done' && g.dealtHands) {
    kids.push(el('p', { class: 'hint', style: 'text-align:center' }, t('deb.opponent')));
    kids.push(el('div', { class: 'hand' },
      ...g.dealtHands[1].map((c) => cardNode(c, { disabled: true, muted: true }))));
  }
  setKids(stage, ...kids);

  infoPanel(debInfo ? [
    el('h3', { style: 'margin-top:10px' }, t('deb.payouts')),
    ...debInfo.bands.map((b, i) => el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, `${t('deb.margin')} ≥ ${b}`),
      el('span', { class: 'v' }, `${debInfo.pays[i].toFixed(2)}x`))),
    el('p', { class: 'hint' }, t('deb.skillNote')),
  ] : []);
}

async function debChooseTrump(trump) {
  try {
    state.deb = await api('/api/bet/debertz/trump', { method: 'POST', body: { trump } });
    paintDebertz();
    audio.sfx('card');
  } catch (e) { toast(e.message, 'bad'); }
}

async function debPlay(card) {
  try {
    const out = await api('/api/bet/debertz/play', { method: 'POST', body: { card } });
    state.deb = out;
    paintDebertz();
    audio.sfx('card');
    if (out.finished) {
      setBalance(out.balance, out.profit);
      audio.sfx(out.outcome === 'won' ? 'win' : (out.outcome === 'push' ? 'click' : 'lose'));
      loadFeed();
    }
  } catch (e) { toast(e.message, 'bad'); }
}


// ------------------------------------------------------------- site token
// The unlocked key lives only in this tab, in a module variable. It is deliberately not
// put in localStorage: a phrase written to disk by a web page is a phrase that outlives
// the session and the user's expectations.
let tokenKey = null;

/**
 * Pick up a wallet unlocked on a previous visit.
 *
 * Called once during boot. Until this existed, every reload locked the wallet and the
 * arcade answered a click with "unlock your token wallet first", which reads as the
 * cabinet being broken rather than as a wallet being locked.
 */
async function recallTokenKey() {
  if (tokenKey) return tokenKey;
  const found = await tokenKeys.recall();
  if (found) tokenKey = found;
  return tokenKey;
}

async function tokenModal() {
  if (!requireLogin()) return;
  const body = openModal(t('tok.title'), (b) => addKids(b, el('p', { class: 'hint' }, t('common.loading'))));

  if (!(await tokenKeys.supported())) {
    setKids(body, el('div', { class: 'banner' }, t('tok.unsupported')));
    return;
  }

  let info;
  try { info = await api('/api/token'); } catch (e) {
    setKids(body, el('p', { class: 'hint neg' }, e.message));
    return;
  }
  if (!info.enabled) {
    setKids(body, el('p', { class: 'hint' }, 'The site token is switched off.'));
    return;
  }

  setKids(body);
  addKids(body, el('p', { class: 'hint' }, t('tok.what')));

  if (!info.pubkey) {
    renderTokenSetup(body, info);
  } else {
    renderTokenWallet(body, info);
  }
}

/** First run: make a phrase, or restore one made earlier. */
function renderTokenSetup(body, info) {
  const create = el('button', { class: 'primary big' }, t('tok.create'));
  create.addEventListener('click', async () => {
    const phrase = tokenKeys.generatePhrase();
    const words = phrase.split(' ');
    const box = el('div', { class: 'phrase-box' },
      ...words.map((w, i) => el('span', {}, el('b', {}, String(i + 1)), w)));

    const confirm = el('button', { class: 'primary big' }, t('tok.saved'));
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        tokenKey = await tokenKeys.keyFromPhrase(phrase);
        await api('/api/token/key', { method: 'POST', body: { pubkey: tokenKey.publicKey } });
        await tokenKeys.remember(tokenKey);
        tokenModal();
      } catch (e) { toast(e.message, 'bad'); confirm.disabled = false; }
    });

    setKids(body, 
      el('h3', {}, t('tok.phrase')),
      el('div', { class: 'banner' }, t('tok.phraseWarn')),
      box,
      el('div', { class: 'row' },
        el('button', {
          class: 'tiny',
          onclick: async () => {
            try { await navigator.clipboard.writeText(phrase); toast(t('wallet.copied')); }
            catch { toast(t('common.error'), 'bad'); }
          },
        }, t('wallet.copy'))),
      confirm,
    );
  });

  const restore = el('input', { class: 'mono', placeholder: t('tok.enterPhrase') });
  addKids(body, 
    create,
    el('h3', { style: 'margin-top:18px' }, t('tok.restore')),
    el('div', { class: 'input-row' }, restore,
      el('button', {
        class: 'tiny',
        onclick: async () => {
          try {
            tokenKey = await tokenKeys.keyFromPhrase(restore.value);
            await api('/api/token/key', { method: 'POST', body: { pubkey: tokenKey.publicKey } });
            await tokenKeys.remember(tokenKey);
            tokenModal();
          } catch (e) { toast(e.message, 'bad'); }
        },
      }, t('tok.unlock'))),
  );
}

/**
 * Give up on a wallet whose phrase is gone and start a new one.
 *
 * The tokens in the old one are not recovered and cannot be: they sit on the chain behind
 * a key nobody holds. This only stops a lost phrase from locking the account out of the
 * token forever. There is no second welcome grant, or losing a phrase on purpose would be
 * a way to drain the treasury one wallet at a time.
 */
function abandonWallet(info) {
  const body = openModal(t('tok.lostTitle'), (b) => addKids(b,
    el('p', { class: 'hint' }, t('tok.lostWhat', { n: fmt(info.balance || 0) })),
    el('div', { class: 'banner' }, t('tok.lostWarn'))));

  const go = el('button', { class: 'primary big' }, t('tok.lostGo'));
  go.addEventListener('click', async () => {
    go.disabled = true;
    const phrase = tokenKeys.generatePhrase();
    try {
      const key = await tokenKeys.keyFromPhrase(phrase);
      await api('/api/token/key', { method: 'POST', body: { pubkey: key.publicKey, replace: true } });
      tokenKey = key;
      await tokenKeys.remember(tokenKey);
      // Shown once, and written down this time.
      const words = phrase.split(' ');
      setKids(body,
        el('h3', {}, t('tok.phrase')),
        el('div', { class: 'banner' }, t('tok.phraseWarn')),
        el('div', { class: 'phrase-box' },
          ...words.map((w, i) => el('span', {}, el('b', {}, String(i + 1)), w))),
        el('button', { class: 'primary big', onclick: () => tokenModal() }, t('tok.saved')));
      applyAll(body);
    } catch (e) { toast(e.message, 'bad'); go.disabled = false; }
  });
  addKids(body, el('div', { class: 'row', style: 'margin-top:12px' },
    go, el('button', { onclick: closeModal }, t('common.cancel'))));
  applyAll(body);
}

/** Normal view: balance, address, sending, and the chain verifier. */
function renderTokenWallet(body, info) {
  const unlocked = tokenKey && tokenKey.publicKey === info.pubkey;

  addKids(body, 
    el('div', { class: 'stat-grid' },
      el('div', { class: 'stat-card' },
        el('div', { class: 'k' }, t('tok.balance')),
        el('div', { class: 'v pos' }, `${info.balance} ${info.symbol}`)),
      el('div', { class: 'stat-card' },
        el('div', { class: 'k' }, t('tok.height')),
        el('div', { class: 'v' }, String(info.height)))),
    el('h3', { style: 'margin-top:16px' }, t('tok.supplyTitle')),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('tok.supplyCap')),
      el('span', { class: 'v' }, (info.maxSupply ?? 0).toLocaleString())),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('tok.supplyOut')),
      el('span', { class: 'v' }, (info.supply?.circulating ?? 0).toLocaleString())),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('tok.supplyLeft')),
      el('span', { class: 'v' }, (info.supply?.treasury ?? 0).toLocaleString())),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('tok.supplyBurned')),
      el('span', { class: 'v' }, (info.supply?.burned ?? 0).toLocaleString())),
    el('p', { class: 'hint' }, t('tok.supplyWhy')),
    el('h3', { style: 'margin-top:16px' }, t('tok.address')),
    el('div', { class: 'addr' }, info.pubkey),
  );

  if (!unlocked) {
    addKids(body, el('p', { class: 'hint' },
      el('a', {
        href: '#',
        onclick: (e) => { e.preventDefault(); abandonWallet(info); },
      }, t('tok.lostLink'))));

    const phrase = el('input', { class: 'mono', placeholder: t('tok.enterPhrase') });
    addKids(body, 
      el('p', { class: 'hint' }, t('tok.locked')),
      el('div', { class: 'input-row' }, phrase,
        el('button', {
          class: 'tiny',
          onclick: async () => {
            try {
              const k = await tokenKeys.keyFromPhrase(phrase.value);
              if (k.publicKey !== info.pubkey) throw new Error('that phrase belongs to a different wallet');
              tokenKey = k;
              toast(t('tok.unlocked'));
              tokenModal();
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, t('tok.unlock'))),
    );
  } else {
    const to = el('input', { class: 'mono', placeholder: '64 hex characters' });
    const amount = el('input', { class: 'mono', value: '100', inputmode: 'numeric' });
    addKids(body, 
      el('h3', { style: 'margin-top:16px' }, t('tok.send')),
      el('label', { class: 'field' }, el('span', {}, t('tok.to')), to),
      el('label', { class: 'field' }, el('span', {}, t('tok.amount')), amount),
      el('button', {
        class: 'primary big',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const fresh = await api('/api/token');
            const tx = {
              from: tokenKey.publicKey,
              to: to.value.trim().toLowerCase(),
              amount: Number(amount.value),
              nonce: fresh.nextNonce,
            };
            // Signed here, in the browser. The server can check it and cannot make it.
            const sig = await tokenKeys.signTransfer(tokenKey, tx);
            const out = await api('/api/token/transfer', { method: 'POST', body: { ...tx, sig } });
            toast(t('tok.sent', { n: out.height }));
            audio.sfx('cashout');
            tokenModal();
          } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
        },
      }, t('tok.signSend')),
    );
  }

  // ---- the verifier
  const bar = el('i');
  const progress = el('div', { class: 'verify-bar' }, bar);
  const result = el('div', {});
  const pinNote = el('p', { class: 'hint' });

  let pinned = null;
  try { pinned = JSON.parse(localStorage.getItem('tokenHead') || 'null'); } catch { /* ignore */ }
  if (pinned) {
    const cmp = compareHeads(pinned, { height: info.height, head: info.head });
    pinNote.textContent = t('tok.pinCheck', { msg: cmp.message });
    pinNote.className = `hint ${cmp.status === 'ok' ? 'pos' : 'neg'}`;
  }

  addKids(body, 
    el('h3', { style: 'margin-top:20px' }, t('tok.verify')),
    el('div', { class: 'addr', style: 'font-size:11px' }, info.head || '-'),
    progress,
    result,
    el('div', { class: 'row' },
      el('button', {
        class: 'big',
        onclick: async (e) => {
          e.target.disabled = true;
          result.className = '';
          result.textContent = '';
          try {
            const out = await verifyChain({
              onProgress: (done, total) => {
                bar.style.width = `${total ? (done / total) * 100 : 0}%`;
                result.className = 'hint';
                result.textContent = t('tok.verifying', { n: done, total });
              },
            });
            if (out.ok) {
              result.className = 'verify-result ok';
              result.textContent = t('tok.verifyOk', { n: out.checked });
            } else {
              result.className = 'verify-result bad';
              result.textContent = t('tok.verifyFail', { h: out.height, why: out.reason });
            }
          } catch (err) {
            result.className = 'verify-result bad';
            result.textContent = err.message;
          } finally {
            e.target.disabled = false;
          }
        },
      }, t('tok.verify')),
      el('button', {
        class: 'tiny',
        onclick: () => {
          try {
            localStorage.setItem('tokenHead', JSON.stringify({ height: info.height, head: info.head }));
            toast(t('tok.pinned'));
          } catch { toast(t('common.error'), 'bad'); }
        },
      }, t('tok.pin'))),
    pinNote,
  );
}


// ----------------------------------------------------------------- arcade
// A token-operated game room. Nothing here pays out, deliberately: the games run in the
// browser, so the score arrives from a machine the player controls. Attaching money to an
// unverifiable number would be farmed the same day.
const CABINET_MODULES = {
  pinball: () => import('./games/pinball.js'),
  billiards: () => import('./games/billiards.js'),
  invaders: () => import('./games/invaders.js'),
};

async function renderArcade() {
  if (state.cabinet) { state.cabinet.stop(); state.cabinet = null; }
  let info;
  try { info = await api('/api/arcade'); } catch (e) {
    setKids($('#stage'), el('p', { class: 'hint neg' }, e.message));
    return;
  }
  state.arcade = info;
  paintArcadeFloor();
}

function paintArcadeFloor() {
  const info = state.arcade;
  const panel = $('#betPanel');

  setKids(panel, 
    el('div', { class: 'stat-card' },
      el('div', { class: 'k' }, t('arc.balance')),
      el('div', { class: 'v pos' }, `${info.balance} ${info.symbol}`)),
    el('p', { class: 'hint' }, t('arc.intro')),
    !info.pubkey
      ? el('button', { class: 'big', style: 'margin-top:10px', onclick: tokenModal }, t('tok.nav'))
      : null,
  );
  applyAll(panel);

  setKids($('#stage'), 
    el('h2', { style: 'text-align:center' }, t('arc.title')),
    el('div', { class: 'cabinets' }, ...info.games.map((g) => cabinetCard(g, info))),
  );
  infoPanel();
}

function cabinetCard(game, info) {
  const playable = !!CABINET_MODULES[game.key];
  const card = el('div', {
    class: 'cabinet',
    onclick: () => (playable ? insertToken(game) : toast(t('arc.soon'))),
  },
  el('div', { class: 'marquee' }, game.name.toUpperCase().slice(0, 14)),
  el('h4', {}, game.name),
  el('div', { class: 'blurb' }, playable ? game.blurb : t('arc.soon')),
  el('div', { class: 'stat-row' },
    el('span', { class: 'k' }, t('arc.best')),
    el('span', { class: 'v' }, String(game.mine.best || 0))),
  el('div', { class: 'board' },
    el('div', {}, el('span', {}, t('arc.top')), el('span', {}, '')),
    ...(game.top.length
      ? game.top.map((row, i) => el('div', {},
        el('span', {}, `${i + 1}. ${row.username}`), el('span', {}, String(row.score))))
      : [el('div', {}, el('span', {}, t('arc.noScores')), el('span', {}, ''))])));
  return card;
}

/**
 * Insert a token: sign the spend with the player key, burn it on the chain, then start
 * the cabinet. The signature is the point. Without it the operator could charge accounts
 * for plays nobody started.
 */
async function insertToken(game) {
  if (!requireLogin()) return;
  const info = state.arcade;
  if (!info.pubkey) { toast(t('arc.needTokens'), 'bad'); tokenModal(); return; }
  if (info.balance < info.tokenCost) { toast(t('arc.needTokens'), 'bad'); return; }
  if (!tokenKey || tokenKey.publicKey !== info.pubkey) {
    toast(t('arc.needUnlock'), 'warn');
    tokenModal();
    return;
  }

  try {
    const fresh = await api('/api/arcade');
    const spend = {
      from: tokenKey.publicKey, game: game.key, amount: fresh.tokenCost, nonce: fresh.nextNonce,
    };
    const sig = await tokenKeys.signSpend(tokenKey, spend);
    const play = await api('/api/arcade/play', { method: 'POST', body: { ...spend, sig } });
    audio.sfx('click');
    startCabinet(game, play);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function startCabinet(game, play) {
  const mod = await CABINET_MODULES[game.key]();
  const canvas = el('canvas');
  const scoreOut = el('b', {}, '0');
  const ballsOut = el('b', {}, '3');

  setKids($('#stage'), 
    el('div', { class: 'arcade-screen' },
      el('div', { class: 'arcade-hud' },
        el('span', {}, 'SCORE ', scoreOut),
        el('span', {}, `${t('arc.ballsLeft')} `, ballsOut)),
      canvas,
      el('div', { class: 'arcade-controls' }, mod.meta.controls)),
  );

  setKids($('#betPanel'), 
    el('div', { class: 'stat-card' },
      el('div', { class: 'k' }, game.name),
      el('div', { class: 'v' }, scoreOut.textContent)),
    el('p', { class: 'hint' }, mod.meta.controls),
    el('button', {
      class: 'big', style: 'margin-top:10px',
      onclick: () => { if (state.cabinet) state.cabinet.stop(); renderArcade(); },
    }, t('arc.back')),
  );

  let finished = false;
  const finish = async (score) => {
    if (finished) return;
    finished = true;
    audio.sfx('lose');
    let result = null;
    try {
      result = await api('/api/arcade/score', { method: 'POST', body: { ticket: play.ticket, score } });
    } catch (e) { toast(e.message, 'bad'); }
    showGameOver(game, score, result);
  };

  state.cabinet = mod.start(canvas, {
    onScore: (s) => { scoreOut.textContent = String(s); },
    onBall: (n) => { ballsOut.textContent = String(Math.max(0, n)); },
    onEnd: finish,
    sound: (name) => audio.sfx(name),
  });
  canvas.focus?.();
}

function showGameOver(game, score, result) {
  const best = result ? result.personalBest : 0;
  setKids($('#stage'), 
    el('div', { class: 'arcade-screen' },
      el('div', { class: 'crash-mult busted', style: 'font-size:46px' }, String(score)),
      el('div', { class: 'crash-status' }, t('arc.gameOver', { n: score })),
      score > 0 && score >= best
        ? el('div', { class: 'crash-status pos' }, t('arc.newBest'))
        : null,
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: () => insertToken(game) }, t('arc.again')),
        el('button', { onclick: renderArcade }, t('arc.back')))),
  );
  loadFeed();
}

// ------------------------------------------------------------------- boot
// ------------------------------------------------------------------ matches
// Head-to-head games played for tokens.
//
// Nothing here knows any rules. The server sends the position and the list of moves it
// will accept, and the board offers only those. Two rules engines that have to agree is
// one rules engine too many when there is a stake on the board.

const MATCH_BOARDS = {
  chess: () => import('./games/chessboard.js'),
  seabattle: () => import('./games/seabattleboard.js'),
  balda: () => import('./games/baldaboard.js'),
  durak: () => import('./games/durakboard.js'),
  poker: () => import('./games/pokerboard.js'),
};

/** Poll while a match is live. Matches are turn-based, so a socket would be overkill. */
function matchPoll(fn) {
  stopMatchPoll();
  state.matchTimer = setInterval(fn, 2000);
}
function stopMatchPoll() {
  if (state.matchTimer) { clearInterval(state.matchTimer); state.matchTimer = null; }
}

async function renderMatch() {
  stopMatchPoll();
  state.matchId = null;
  let info;
  try { info = await api('/api/match'); } catch (e) {
    setKids($('#stage'), el('p', { class: 'hint neg' }, e.message));
    return;
  }
  state.matchLobby = info;
  paintLobby();
}

/**
 * A match has no house edge, so it cannot use the ordinary panel: houseEdge has no entry
 * for it and `undefined * 100` printed "NaN%", the same way the arcade once did.
 *
 * The distinction is real and worth showing plainly. In every other game the player is
 * betting against the bankroll, so the edge and the maximum the bankroll will pay both
 * mean something. Here the players bet against each other, the prize is their own escrowed
 * stakes, and the only thing the house takes is a rake off the pot.
 */
function matchInfoPanel(info) {
  const p = $('#infoPanel');
  setKids(p,
    el('h3', {}, t('match.title')),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('match.rake')),
      el('span', { class: 'v' }, `${(info.rake * 100).toFixed(1)}%`)),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('match.minStake')),
      el('span', { class: 'v' }, `${fmt(info.minStake)} ${info.symbol}`)),
    el('p', { class: 'hint' }, t('match.noEdge')));
  applyAll(p);
}

function paintLobby() {
  const info = state.matchLobby;
  const stake = el('input', {
    class: 'mono', inputmode: 'decimal', value: fmt(info.minStake, 2),
  });
  const game = el('select', {}, ...info.games.map(
    (g) => el('option', { value: g.key }, t(`match.g.${g.key}`))));
  const seatCount = el('select', {});
  const paintSeats = () => {
    const chosen = info.games.find((g) => g.key === game.value) || info.games[0];
    const options = [];
    for (let n = chosen.seats.min; n <= chosen.seats.max; n += 1) {
      options.push(el('option', { value: String(n) }, t('match.nPlayers', { n })));
    }
    setKids(seatCount, ...options);
    seatCount.value = String(chosen.seats.default);
    // A game that takes exactly two has nothing to choose, so the control goes away.
    seatCount.parentElement?.classList.toggle('hide', chosen.seats.min === chosen.seats.max);
  };
  game.addEventListener('change', paintSeats);

  setKids($('#betPanel'),
    el('div', { class: 'stat-card' },
      el('div', { class: 'k' }, t('arc.balance')),
      el('div', { class: 'v pos' }, `${fmt(info.balance)} ${info.symbol}`)),
    el('label', { class: 'field' }, el('span', {}, t('match.game')), game),
    el('label', { class: 'field' }, el('span', {}, t('match.players')), seatCount),
    el('label', { class: 'field' }, el('span', {}, t('match.stake')), stake),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('match.rake')),
      el('span', { class: 'v' }, `${(info.rake * 100).toFixed(1)}%`)),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('match.youWin')),
      el('span', { class: 'v pos' }, fmt(winnings(stake.value, info.rake)))),
    el('button', {
      class: 'primary big', style: 'margin-top:10px',
      onclick: () => createChallenge(game.value, stake.value, Number(seatCount.value)),
    }, t('match.challenge')),
    el('p', { class: 'hint' }, t('match.intro')),
    !info.pubkey
      ? el('button', { class: 'big', style: 'margin-top:8px', onclick: tokenModal }, t('tok.nav'))
      : null);

  const repaintPrize = () => {
    const out = $('#betPanel').querySelectorAll('.stat-row .v')[1];
    if (out) {
      out.textContent = fmt(winnings(stake.value, info.rake, Number(seatCount.value) || 2));
    }
  };
  stake.oninput = repaintPrize;
  seatCount.addEventListener('change', repaintPrize);
  paintSeats();
  repaintPrize();
  applyAll($('#betPanel'));

  const row = (m, mine) => el('div', { class: 'challenge' },
    el('div', {},
      el('strong', {}, t(`match.g.${m.game}`)),
      el('span', { class: 'hint' },
        ` ${m.players.map((p) => p.name).join(', ')}`
        + `${m.seats > m.players.length ? `  ${m.players.length}/${m.seats}` : ''}`)),
    el('div', { class: 'v' }, `${fmt(m.stake)} ${state.matchLobby.symbol}`),
    mine && m.status === 'open'
      ? el('button', { class: 'tiny', onclick: () => cancelChallenge(m.id) }, t('match.cancel'))
      : null,
    mine && m.status === 'playing'
      ? el('button', { class: 'tiny primary', onclick: () => openMatch(m.id) }, t('match.resume'))
      : null,
    !mine && m.status === 'open'
      ? el('button', { class: 'tiny primary', onclick: () => joinChallenge(m) }, t('match.accept'))
      : null);

  const mineIds = new Set(info.mine.map((m) => m.id));
  const others = info.open.filter((m) => !mineIds.has(m.id));

  setKids($('#stage'),
    el('h2', { style: 'text-align:center' }, t('match.title')),
    info.mine.length
      ? el('div', {}, el('h3', {}, t('match.yours')),
        el('div', { class: 'challenges' }, ...info.mine.map((m) => row(m, true))))
      : null,
    el('h3', {}, t('match.openTable')),
    others.length
      ? el('div', { class: 'challenges' }, ...others.map((m) => row(m, false)))
      : el('p', { class: 'hint' }, t('match.noneOpen')));
  matchInfoPanel(info);
}

/**
 * What a single winner takes home, after the house cut.
 * The pot is the stake times the number of seats, not times two: a six-handed table is
 * six stakes.
 */
const winnings = (stake, rake, seats = 2) => {
  const pot = Math.round(Number(stake || 0) * UNIT) * seats;
  return pot - Math.floor(pot * rake);
};

/**
 * Sign a stake into escrow.
 *
 * This is an ordinary token transfer to the house key, signed by the player. The operator
 * cannot produce it, which is the point: nobody can enter you into a match you did not
 * agree to, and nobody can take your stake twice.
 */
async function signStake(amount) {
  const info = await api('/api/match');
  state.matchLobby = info;
  if (!info.pubkey) { toast(t('arc.needTokens'), 'bad'); tokenModal(); return null; }
  if (info.balance < amount) { toast(t('match.shortOfTokens'), 'bad'); return null; }
  if (!tokenKey || tokenKey.publicKey !== info.pubkey) {
    toast(t('arc.needUnlock'), 'warn');
    tokenModal();
    return null;
  }
  const tx = {
    from: tokenKey.publicKey, to: info.houseKey, amount, nonce: info.nextNonce,
  };
  const sig = await tokenKeys.signTransfer(tokenKey, tx);
  return { from: tx.from, nonce: tx.nonce, sig };
}

async function createChallenge(game, stakeText, seats) {
  if (!requireLogin()) return;
  try {
    const units = Math.round(Number(stakeText) * UNIT);
    if (!Number.isSafeInteger(units) || units <= 0) throw new Error(t('err.amount'));
    const spend = await signStake(units);
    if (!spend) return;
    await api('/api/match/create', {
      method: 'POST', body: { game, stake: units, seats, spend },
    });
    audio.sfx('click');
    renderMatch();
  } catch (e) { toast(e.message, 'bad'); }
}

async function joinChallenge(m) {
  if (!requireLogin()) return;
  try {
    const spend = await signStake(m.stake);
    if (!spend) return;
    const out = await api('/api/match/join', { method: 'POST', body: { id: m.id, spend } });
    audio.sfx('click');
    // A table that still has empty seats stays in the lobby rather than opening a board
    // nobody can play on yet.
    if (out.started) openMatch(m.id);
    else { toast(t('match.seated', { n: out.seated, of: out.of })); renderMatch(); }
  } catch (e) { toast(e.message, 'bad'); }
}

async function cancelChallenge(id) {
  try {
    await api('/api/match/cancel', { method: 'POST', body: { id } });
    renderMatch();
  } catch (e) { toast(e.message, 'bad'); }
}

// ------------------------------------------------------------- the board
async function openMatch(id) {
  state.matchId = id;
  state.board = null;
  await refreshMatch(true);
  matchPoll(() => refreshMatch(false));
}

async function refreshMatch(rebuild) {
  if (!state.matchId) return;
  let view;
  try { view = await api(`/api/match/one?id=${state.matchId}`); } catch (e) {
    stopMatchPoll();
    toast(e.message, 'bad');
    renderMatch();
    return;
  }
  if (rebuild || !state.board) await buildMatchScreen(view);
  else paintMatch(view);
}

async function buildMatchScreen(view) {
  const mod = await MATCH_BOARDS[view.game]();
  const host = el('div', { class: 'board-host' });
  setKids($('#stage'),
    el('div', { class: 'match-screen' },
      el('div', { class: 'match-bar' },
        el('span', { id: 'mTop' }, ''),
        el('span', { class: 'mono', id: 'mTopClock' }, '')),
      host,
      el('div', { class: 'match-bar' },
        el('span', { id: 'mBottom' }, ''),
        el('span', { class: 'mono', id: 'mBottomClock' }, ''))));

  state.board = mod.board(host, {
    view: view.view,
    seat: view.seat,
    seats: view.seats,
    myTurn: view.status === 'playing' && !!view.seat && view.toMove === view.seat,
    lang: getLocale(),
    onAct: (action) => sendAction(action),
  });
  paintMatch(view);
}

const clockText = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function paintMatch(view) {
  state.matchView = view;
  // Your own seat at the bottom, everyone else above, in seat order from your left.
  const mine = view.seat ?? 0;
  const order = [];
  for (let i = 1; i < view.seats; i += 1) order.push((mine + i) % view.seats);
  const nameOf = (seat) => view.players.find((p) => p.seat === seat)?.name || '?';
  const live = (seat) => (view.toMove === seat && view.status === 'playing' ? ' •' : '');

  $('#mTop').textContent = order.map((s) => `${nameOf(s)}${live(s)}`).join('   ');
  $('#mBottom').textContent = `${nameOf(mine)}${live(mine)}`;
  $('#mTopClock').textContent = order.map((s) => clockText(view.clock[s])).join('   ');
  $('#mBottomClock').textContent = clockText(view.clock[mine]);

  // Setting up is not "your turn", but it is something you may do, so the board is told
  // to accept input for it too. Морской бой needs this; chess never hits the second case.
  const seated = view.seat !== null && view.seat !== undefined;
  const canAct = view.status === 'playing' && seated
    && (view.toMove === view.seat
      || (view.view.phase === 'setup' && !view.view.placed?.[view.seat]));
  if (state.board) {
    state.board.update({ view: view.view, seat: view.seat, seats: view.seats, myTurn: canAct });
  }

  setKids($('#betPanel'),
    el('div', { class: 'stat-card' },
      el('div', { class: 'k' }, t('match.stake')),
      el('div', { class: 'v' }, `${fmt(view.stake)} ${state.matchLobby?.symbol || ''}`)),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('match.status')),
      el('span', { class: 'v' }, matchStatusText(view))),
    view.game === 'chess'
      ? el('div', { class: 'movelist' }, ...pairMoves(view.view.san || []))
      : el('div', { class: 'movelist' }, ...eventLog(view)),
    view.status === 'playing' && seated
      ? el('button', {
        class: 'big', style: 'margin-top:10px',
        onclick: () => confirmResign(view.id),
      }, t('match.resign'))
      : null,
    view.status === 'playing' && seated
      ? el('button', {
        class: 'tiny', style: 'margin-top:6px',
        onclick: () => claimFlag(view.id),
      }, t('match.claimTime'))
      : null,
    el('button', {
      class: 'tiny', style: 'margin-top:6px',
      onclick: () => { stopMatchPoll(); renderMatch(); },
    }, t('match.backToLobby')));
  applyAll($('#betPanel'));

  if (view.status !== 'playing') stopMatchPoll();
}

/** The move list, numbered in pairs the way a scoresheet is written. */
function pairMoves(san) {
  const rows = [];
  for (let i = 0; i < san.length; i += 2) {
    rows.push(el('div', {},
      el('span', { class: 'k' }, `${i / 2 + 1}.`),
      el('span', {}, san[i] || ''),
      el('span', {}, san[i + 1] || '')));
  }
  return rows;
}

function matchStatusText(view) {
  if (view.status === 'open') return t('match.waiting');
  if (view.status === 'cancelled') return t('match.cancelled');
  if (view.status === 'playing') {
    return view.toMove === view.seat ? t('match.yourMove') : t('match.theirMove');
  }
  const winners = view.winners || [];
  // Everyone winning is a draw. Some of them winning is what a table game produces, and
  // from your own seat the only question is whether you are on the list.
  const outcome = winners.length >= view.seats
    ? 'draw'
    : (winners.includes(view.seat) ? 'won' : 'lost');
  return `${t(`match.${outcome}`)} — ${t(`match.why.${view.reason}`, {}) || view.reason}`;
}

/**
 * What happened, newest first, for the games that have events rather than moves.
 *
 * One renderer for both, because a shot and a claimed word are the same shape on screen:
 * who did it, what they did, and what it was worth.
 */
function eventLog(view) {
  const mark = (seat) => (seat === view.seat ? '\u2794' : '\u2190');
  const row = (seat, what, worth, cls) => el('div', {},
    el('span', { class: 'k' }, mark(seat)),
    el('span', {}, what),
    el('span', { class: cls || '' }, worth));

  return (view.view.log || []).slice().reverse().map((entry) => {
    if (entry.pass) return row(entry.seat, t('match.passed'), '');
    if (entry.act) return row(entry.seat, t(`durak.${entry.act}`), entry.card || '');
    if (entry.word) return row(entry.seat, entry.word, `+${entry.score}`, 'pos');
    return row(
      entry.seat,
      cellName(entry.cell, view.view.size || 10),
      t(`match.shot.${entry.outcome}`),
      entry.outcome === 'miss' ? '' : 'pos',
    );
  });
}

const SEA_LETTERS = '\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u041a';
const cellName = (cell, size) => `${SEA_LETTERS[cell % size] || '?'}${Math.floor(cell / size) + 1}`;

/**
 * Which sound a finished move deserves.
 *
 * Decided here rather than in the boards, because only the answer from the server says
 * what actually happened: whether a shot hit, whether a piece was taken, whether the move
 * gave check. A board that guessed would sometimes play the wrong one.
 */
function moveSound(game, before, after) {
  if (game === 'seabattle') {
    const last = after.view.log?.at(-1);
    if (!last || last.cell === undefined) return 'click';
    return { hit: 'strike', sunk: 'sunk', miss: 'splash' }[last.outcome] || 'click';
  }
  if (game === 'balda') {
    const last = after.view.log?.at(-1);
    return last && last.word ? 'word' : 'click';
  }
  // Chess. A capture is a piece leaving the board, which is the one thing the position
  // before and after can be compared on without re-implementing the rules here.
  const count = (fen) => (fen || '').split(' ')[0].replace(/[^a-zA-Z]/g, '').length;
  if (count(after.view.fen) < count(before?.view?.fen)) return 'capture';
  if (after.view.check) return 'check';
  return 'card';
}

/**
 * Send one action. Whatever the board handed back goes straight through: the server is
 * the thing that decides whether it was allowed, and it will say so if it was not.
 */
async function sendAction(action) {
  const before = state.matchView;
  try {
    await api('/api/match/move', { method: 'POST', body: { id: state.matchId, ...action } });
    await refreshMatch(false);
    audio.sfx(moveSound(before?.game, before, state.matchView));
  } catch (e) {
    toast(e.message, 'bad');
    await refreshMatch(false);
  }
}

function confirmResign(id) {
  const body = openModal(t('match.resign'), (b) => b.append(
    el('p', { class: 'hint' }, t('match.resignSure')),
  ));
  addKids(body, el('div', { class: 'row', style: 'margin-top:12px' },
    el('button', {
      class: 'primary',
      onclick: async () => {
        closeModal();
        try {
          await api('/api/match/resign', { method: 'POST', body: { id } });
          await refreshMatch(false);
        } catch (e) { toast(e.message, 'bad'); }
      },
    }, t('match.resign')),
    el('button', { onclick: closeModal }, t('common.cancel'))));
}

async function claimFlag(id) {
  try {
    await api('/api/match/timeout', { method: 'POST', body: { id } });
    await refreshMatch(false);
  } catch (e) { toast(e.message, 'bad'); }
}

const GAMES = ['dice', 'limbo', 'mines', 'crash', 'slots', 'puzzle', 'preferans', 'debertz', 'arcade', 'match'];

function renderGame() {
  if (state.es && state.game !== 'crash') { state.es.close(); state.es = null; }
  if (state.cabinet && state.game !== 'arcade') { state.cabinet.stop(); state.cabinet = null; }
  if (state.game !== 'match') { stopMatchPoll(); state.matchId = null; state.board = null; }
  const nav = $('#navGames');
  setKids(nav, ...GAMES.map((g) => el('button', {
    class: `tiny ${state.game === g ? 'on' : ''}`,
    style: state.game === g ? 'background:var(--panel);border-color:var(--line)' : 'background:transparent;border-color:transparent;color:var(--text-dim)',
    onclick: () => { state.game = g; renderGame(); },
  }, t(`game.${g}`))));

  if (state.game === 'dice') renderDice();
  else if (state.game === 'limbo') renderLimbo();
  else if (state.game === 'mines') { state.mines = null; renderMines(); loadMinesState(); }
  else if (state.game === 'slots') renderSlots();
  else if (state.game === 'puzzle') { loadPuzzlePictures(); renderPuzzle(); }
  else if (state.game === 'preferans') renderPreferans();
  else if (state.game === 'debertz') renderDebertz();
  else if (state.game === 'arcade') renderArcade();
  else if (state.game === 'match') renderMatch();
  else renderCrash();
}

/** Fetch the imported picture pack once. Harmless and empty if none were imported. */
async function loadPuzzlePictures() {
  if (state.puzzlePictures) return;
  state.puzzlePictures = {};
  try {
    const pack = await api('/api/puzzle/pictures');
    state.puzzlePictures = pack.pictures || {};
  } catch { /* the drawn pictures stand alone */ }
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
  setKids(box);
  if (state.wallet === 'demo') {
    addKids(box, el('div', { class: 'banner practice' },
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
  if (state.cfg?.wallet?.isMock) addKids(box, el('div', { class: 'banner' }, t('wallet.mockWarning')));
}

async function boot() {
  const sel = $('#langSelect');
  setKids(sel, ...LANGS.map((l) => el('option', { value: l.code }, l.label)));

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

  // Before anything asks whether the wallet is unlocked.
  await recallTokenKey();

  audio.armOnFirstGesture();
  const soundBtn = $('#btnSound');
  const paintSound = () => {
    const on = audio.isEnabled();
    const music = audio.isMusicOn();
    soundBtn.textContent = on ? (music ? '♫' : '♪') : '✕';
    soundBtn.classList.toggle('muted', !on);
    soundBtn.classList.toggle('music-off', on && !music);
    soundBtn.title = on ? (music ? t('sound.musicOn') : t('sound.musicOff')) : t('sound.off');
  };
  soundBtn.onclick = () => { audio.sfx('click'); radioModal(paintSound); };
  paintSound();
  document.addEventListener('localechange', paintSound);

  $('#btnSignin').onclick = () => authModal('login');
  $('#btnSignup').onclick = () => authModal('register');
  $('#btnSignout').onclick = signOut;
  $('#btnWallet').onclick = walletModal;
  $('#btnFair').onclick = fairModal;
  $('#btnAff').onclick = affiliateModal;
  $('#btnLimits').onclick = limitsModal;
  $('#btnToken').onclick = tokenModal;

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
