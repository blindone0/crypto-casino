import { LANGS, t, setLocale, getLocale, applyAll } from './i18n.js';
import {
  ensureSymbolDefs, symbolSvg, symbolSvgStandalone, symbolImage, THEME_KEYS,
} from './symbols.js';
import { pictureSvg } from './pictures.js';
import { createCut } from './jigsaw.js';
import { board as jigsawBoard } from './jigsawboard.js';
import * as audio from './audio.js';
import * as tokenKeys from './tokenkeys.js';
import { verifyChain, compareHeads } from './chainverify.js';
import { createSparks } from './slotfx.js';
import { createReels as createGlReels } from './slot3d.js';
import { startParallax } from './parallax.js';

// ---------------------------------------------------------------- plumbing
const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Apply a style string one declaration at a time.
 *
 * The page is served under `style-src 'self'` with no 'unsafe-inline', so the browser
 * ignores a style attribute completely — and silently, which is why it looked like it
 * worked. Every `style:` in this file was doing nothing at all until this was written.
 *
 * Going through the CSSOM is not inline CSS and is allowed, so the policy stays exactly
 * as strict as it was. Splitting on ';' is enough for what this file writes; a value
 * containing one, such as a data: URI inside url(), would need a real parser, and those
 * belong in a class anyway.
 */
function applyStyle(node, css) {
  for (const decl of String(css).split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim();
    if (prop) node.style.setProperty(prop, decl.slice(at + 1).trim());
  }
}

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'style') applyStyle(n, v);
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
  game: 'slots', feed: 'recent',
  mines: null, crash: null, es: null, parallax: null, solo: null, jigsaw: null,
  // Head-to-head matches: the lobby, the one being watched, its board and its poll.
  matchLobby: null, matchId: null, matchView: null, board: null, matchTimer: null,
  // Pictures the operator imported for the puzzle, keyed the same way the drawn ones are.
  puzzlePictures: null,
  // The tugrik wallet. There is no other kind: `balance` below is the only balance the
  // site has. `nonce` is the next one this key may sign with, `house` is who a stake is
  // signed to.
  tokenBalance: 0, tokenNonce: 0, tokenHouse: null, tokenMaxWin: 0,
};

const UNIT = 1e8;
const fmt = (units, dp = 8) => (Number(units) / UNIT).toFixed(dp);
/**
 * Truncate to two places, the way the server does.
 *
 * The epsilon matters: `0.99 / 0.05` is exactly 19.8 in arithmetic but 19.799999999999997
 * in a double, and a plain floor turns that into 19.79. This has to match src/fair.js
 * `floor2` character for character, because a panel that quotes a different multiplier
 * from the one the server pays is worse than one that quotes nothing.
 */
const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
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
  if (method === 'POST' && STAKE_ROUTES.some((r) => path.startsWith(r))) {
    // A stake is a transfer, and a transfer needs the player's signature. Done here, in
    // the one place every staking request passes through, so a new game cannot forget it
    // and cannot send an unsigned bet the server would refuse. There is no longer a
    // currency to name alongside it — there is only one.
    payload = { ...(body || {}), spend: await signStakeFor(body) };
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

function setBalance(units, direction) {
  const box = $('#balanceBox');
  const v = $('#balanceValue');
  box.hidden = false;
  state.tokenBalance = units;
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
/**
 * Make this account's tugrik wallet, then show the phrase.
 *
 * The key is generated in the browser and the server only ever sees the public half, so
 * registering it is also what pays the welcome grant out of the treasury. That is why
 * this runs before the player reaches a game: it is the difference between an account
 * that can play and one that is told to go and set something up first.
 *
 * The phrase is shown, not demanded. Nobody wants to copy sixteen words before their
 * first spin, and it stays in Wallet for whenever they do. What is not softened is the
 * consequence: lose the device without it and those tugriks are unreachable, by design.
 */
async function newWalletStep() {
  const body = openModal(t('tok.title'), (b) => addKids(b,
    el('p', { class: 'hint' }, t('common.loading'))));
  if (!(await tokenKeys.supported())) {
    // Nothing can be held without Ed25519, so say so plainly rather than handing over an
    // account that silently cannot have money.
    setKids(body, el('div', { class: 'banner' }, t('tok.unsupported')));
    return;
  }
  const phrase = tokenKeys.generatePhrase();
  try {
    // PBKDF2 at 210k rounds: about a second on a phone, and it blocks. The line above is
    // there so the box does not look like it missed the tap.
    const key = await tokenKeys.keyFromPhrase(phrase);
    const res = await api('/api/token/key', { method: 'POST', body: { pubkey: key.publicKey } });
    // The phrase goes in with the key, so it can be read back later instead of existing
    // only for as long as this dialog does.
    await tokenKeys.remember(key, phrase);
    tokenKey = key;
    await refreshTokenBalance();

    setKids(body,
      el('p', {}, t('tok.granted', { n: fmt(res.balance ?? 0), c: state.cfg?.token?.symbol || 'TUG' })),
      el('div', { class: 'banner' }, t('tok.phraseWarn')),
      el('div', { class: 'phrase-box mono' }, phrase),
      el('div', { class: 'row wrap' },
        el('button', {
          class: 'tiny',
          onclick: async () => {
            try { await navigator.clipboard.writeText(phrase); toast(t('wallet.copied')); }
            catch { toast(t('tok.phrase'), 'warn'); }
          },
        }, t('wallet.copy')),
        el('button', { class: 'primary', onclick: () => confirmPhraseStep(body, phrase) },
          t('tok.saved'))),
      el('p', { class: 'hint' }, t('tok.phraseLater')));
  } catch (e) {
    setKids(body, el('div', { class: 'banner' }, e.message));
  }
}

/**
 * Check two words before letting the phrase go.
 *
 * Not a gate — the wallet already exists and the tugriks are already granted, and the
 * words can be read back from Wallet at any time. It is there because clicking "I have
 * written it down" is free, and the only moment anyone finds out they did not is the
 * moment it is too late. Asking for two specific words costs seconds and turns a claim
 * into a fact.
 *
 * Two random positions rather than the whole phrase: enough that you cannot pass without
 * the words in front of you, short enough that nobody retypes sixteen and gives up.
 */
function confirmPhraseStep(body, phrase) {
  const words = phrase.split(' ');
  // Two distinct positions, drawn with the same generator the phrase came from.
  const pick = new Set();
  while (pick.size < 2) pick.add(crypto.getRandomValues(new Uint32Array(1))[0] % words.length);
  const [a, b] = [...pick].sort((x, y) => x - y);

  const err = el('p', { class: 'hint neg' });
  const fieldFor = (i) => el('label', { class: 'field' },
    el('span', {}, t('tok.confirmWord', { n: i + 1 })),
    el('input', { class: 'mono', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false' }));
  const fa = fieldFor(a);
  const fb = fieldFor(b);
  const inputs = [fa.querySelector('input'), fb.querySelector('input')];

  const done = el('button', { class: 'primary big' }, t('tok.confirmGo'));
  done.onclick = () => {
    const want = [words[a], words[b]];
    const got = inputs.map((i) => i.value.trim().toLowerCase());
    if (got[0] === want[0] && got[1] === want[1]) { closeModal(); return; }
    err.textContent = t('tok.confirmWrong');
  };
  inputs.forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') done.click(); }));

  setKids(body,
    el('p', {}, t('tok.confirmIntro')),
    fa, fb, err, done,
    // Never trap anyone here. The phrase is stored and readable from Wallet, so a way
    // back to it is honest rather than a loophole.
    el('button', { class: 'ghost', onclick: () => newWalletPhraseAgain(body, phrase) },
      t('tok.confirmBack')));
  inputs[0].focus();
}

/** Show the words again, for someone who closed the box too early. */
function newWalletPhraseAgain(body, phrase) {
  setKids(body,
    el('div', { class: 'banner' }, t('tok.phraseWarn')),
    el('div', { class: 'phrase-box mono' }, phrase),
    el('button', { class: 'primary big', onclick: () => confirmPhraseStep(body, phrase) },
      t('tok.saved')));
}

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
        if (mode === 'register') {
          // A new account has no wallet, and tugriks live on a key the player holds. So
          // the wallet is made here, before anything else: register, and you are funded
          // and playing. Nothing anywhere else has to check whether a wallet exists.
          await newWalletStep();
        } else {
          closeModal();
        }
        await afterAuth();
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

async function afterAuth() {
  $('#authButtons').classList.add('hide');
  $('#accountMenu').classList.remove('hide');
  $('#btnAdmin').classList.toggle('hide', state.user.role !== 'admin');
  // Fetch the balance before painting it. This used to be the wallet switch's job, and
  // when that went the balance stopped being fetched at all: a signed-in player reloaded
  // the page, saw 0.00000000 with a thousand tugriks sitting on the chain, and could not
  // place a bet — the stake was clamped against a balance of zero. The chain is the only
  // source of the number, so it has to be asked.
  await refreshTokenBalance();
  // Signed in with no wallet: an account made before wallets existed at sign-up, or one
  // whose chain was reset in development. Make it now rather than letting them reach a
  // game and be told they cannot play. The grant pays here, so they arrive funded.
  if (!state.tokenPubkey && await tokenKeys.supported()) {
    await newWalletStep();
    await refreshTokenBalance();
  }
  applyWallet();
  renderGame();
  loadFeed();
}

/**
 * Paint the balance box.
 *
 * This used to be the three-way switch between credits, play money and tugriks. There is
 * one currency now, so all it does is put the tugrik figure and its ticker on screen.
 */
function applyWallet() {
  const label = $('#currencyLabel');
  if (label) label.textContent = state.cfg?.token?.symbol || 'TUG';
  setBalance(state.tokenBalance ?? 0);
  renderBanners();
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
  // A bodyless POST is a continuation, not a stake: revealing a tile and cashing out both
  // belong to a round that was already paid for when it opened. They arrive here because
  // they sit under /api/bet/, and reading `.amount` off `undefined` threw
  // "Cannot read properties of undefined" instead of quietly signing nothing — which is
  // what cashing out of mines or the puzzle did after the wallet gate became
  // unconditional.
  if (!payload) return undefined;
  const amount = payload.amount ?? payload.wager;
  if (amount === undefined || amount === null || amount === '') return undefined;
  const units = Math.round(Number(amount) * UNIT);
  if (!Number.isSafeInteger(units) || units <= 0) return undefined;

  // No key on this device — which, with a wallet made at registration, means somebody
  // signing in somewhere new. Ask for the phrase here and carry on with the bet they
  // already pressed, rather than refusing it and telling them to go and unlock something.
  if (!tokenKey && !(await ensureWallet())) {
    // They closed the box. That is an answer, not an error: say nothing and do nothing.
    return undefined;
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
    state.tokenMaxWin = info.maxWin ?? 0;
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
  $('#accountMenu').classList.add('hide');
  $('#balanceBox').hidden = true;
  state.tokenBalance = 0;
  state.tokenNonce = 0;
  renderBanners();
  renderGame();
}

const requireLogin = () => {
  if (!state.user) { authModal('login'); return false; }
  return true;
};

// ------------------------------------------------------- shared bet controls
/** Amount input with ½ / 2× / max helpers. Returns { node, get, set }. */
/**
 * What a legal stake looks like right now.
 *
 * The limits come from the server's config and the balance from the chain, so this is the
 * same arithmetic the server will do — which is the point. If the field cannot express an
 * illegal bet, the server's two refusals stop being reachable through the interface.
 */
function betBounds() {
  const min = state.cfg?.risk?.minBetUnits ?? UNIT;
  const max = state.cfg?.risk?.maxBetUnits ?? 1000 * UNIT;
  const balance = state.tokenBalance ?? 0;
  // A tenth of the minimum is the step: fine enough to be worth adjusting, coarse enough
  // that the field never shows something like 0.28374651.
  const step = Math.max(Math.round(min / 10), 1);
  return { min, max, step, balance, ceiling: Math.min(max, balance), playable: balance >= min };
}

/** Round to the step and hold inside the bounds. Every path through the control uses it. */
function clampStake(units) {
  const { min, step, ceiling } = betBounds();
  const snapped = Math.round((Number(units) || 0) / step) * step;
  if (snapped <= min) return min;
  if (snapped >= ceiling) return Math.max(min, Math.floor(ceiling / step) * step);
  return snapped;
}

/** A stake as the field should show it: no trailing noise, no more places than the step. */
function fmtStake(units) {
  const { step } = betBounds();
  const places = Math.max(0, Math.min(8, Math.ceil(Math.log10(UNIT / step))));
  return (units / UNIT).toFixed(places).replace(/\.?0+$/, '') || '0';
}

/**
 * The stake field, shared by every game.
 *
 * It used to accept any number at all and let the server say no — which is how a new
 * player's very first spin met "minimum stake is 1.00000000 TUG", because the field
 * opened at 0.20. Nothing here validates: the value is corrected as it is set, so there
 * is never a wrong one to report. `Макс` means the largest legal bet you can afford,
 * which is what people mean by it — it used to mean the whole balance, ignoring the table
 * maximum entirely.
 */
function amountControl(initial) {
  const start = clampStake(initial === undefined ? betBounds().min : Number(initial) * UNIT);
  const input = el('input', { class: 'mono', value: fmtStake(start), inputmode: 'decimal' });

  const put = (units) => {
    input.value = fmtStake(clampStake(units));
    input.dispatchEvent(new Event('input'));
  };
  const units = () => clampStake(Math.round((Number(input.value) || 0) * UNIT));
  // Correct on blur rather than on every keystroke: rewriting the field mid-type fights
  // the person using it.
  input.addEventListener('blur', () => put(units()));

  const node = el('label', { class: 'field' },
    el('span', { 'data-i18n': 'bet.amount' }),
    el('div', { class: 'input-row' },
      input,
      el('button', { class: 'tiny', type: 'button', onclick: () => put(units() / 2) }, '½'),
      el('button', { class: 'tiny', type: 'button', onclick: () => put(units() * 2) }, '2×'),
      el('button', {
        class: 'tiny',
        type: 'button',
        onclick: () => put(betBounds().ceiling),
      }, t('bet.max'))));

  return {
    node,
    input,
    get: () => fmtStake(units()),
    units,
    set: (v) => put(Number(v) * UNIT),
    /** False when the balance cannot cover even the minimum: the action should say so. */
    playable: () => betBounds().playable,
  };
}

const statRow = (key, valueNode) => el('div', { class: 'stat-row' },
  el('span', { class: 'k', 'data-i18n': key }), el('span', { class: 'v' }, valueNode));

/**
 * The arcade has no house edge and no maximum win, because nothing there is a bet. Showing
 * the betting panel for it printed "NaN%" against a game that cannot pay out at all.
 */
function arcadeInfoPanel() {
  const info = state.arcade || {};
  // Both figures go through fmt(). They did not before, and since everything here is in
  // hundred-millionths the panel was printing a ten-tugrik play as "1000000000".
  setKids($('#infoPanel'),
    el('h3', {}, t('arc.title')),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('arc.cost')),
      el('span', { class: 'v' }, `${fmt(info.tokenCost ?? 0)} ${info.symbol || ''}`)),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('arc.balance')),
      el('span', { class: 'v' }, `${fmt(info.balance ?? 0)} ${info.symbol || ''}`)),
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
      // What the house holds, because that is the most it can pay. This used to read
      // `cfg.risk.maxProfitPerBet`, a slice of the credit bankroll — a number that stopped
      // existing with credits and printed NaN.
      el('span', { class: 'v' }, fmtShort(state.tokenMaxWin ?? 0))),
    ...extra,
  );
  applyAll(p);
}

// ------------------------------------------------------------------- dice
function renderDice() {
  const panel = $('#betPanel');
  const amount = amountControl();

  // Four levels instead of a free slider.
  //
  // Not a fairness fix — the edge is identical at every win chance, because the multiplier
  // is (1 - edge) / chance and so the expected return is (1 - edge) wherever the dial sits.
  // It is a better control: a choice between four named risks is something a person can
  // make, and a number between 1.00 and 95.00 is something they have to work out.
  //
  // `chance` is still the value the rest of the panel reads, so nothing downstream had to
  // learn about levels. The server is unchanged and still refuses anything outside its own
  // 1%-95% range, because the interface must never be the only thing enforcing a rule.
  const chance = el('input', { type: 'hidden', value: '5000' });
  const levels = [
    { key: 'safe', chance: 7500 },
    { key: 'normal', chance: 5000 },
    { key: 'risky', chance: 2500 },
    { key: 'wild', chance: 500 },
  ];
  const levelRow = el('div', { class: 'risk-row' });
  const paintLevels = () => {
    for (const b of levelRow.children) {
      b.classList.toggle('on', b.dataset.chance === chance.value);
    }
  };
  setKids(levelRow, ...levels.map((lv) => el('button', {
    class: 'tiny risk',
    type: 'button',
    'data-chance': String(lv.chance),
    onclick: () => { chance.value = String(lv.chance); paintLevels(); recalc(); },
  }, t(`risk.${lv.key}`))));

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
    const mult = floor2((1 - state.cfg.houseEdge.dice) / c);
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
      el('span', { 'data-i18n': 'risk.label' }), levelRow),
    // The threshold and the chance are shown, not set: they are what the level means.
    el('label', { class: 'field' },
      el('span', { id: 'diceThresholdLabel' }, t('dice.target')), thresholdOut),
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
  paintLevels();
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
    const tg = Math.max(1.01, floor2(Number(target.value)) || 1.01);
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
  const amount = amountControl();
  const spin = el('button', { class: 'primary big' }, t('slots.spin'));
  const perLine = el('span', {});

  const recalc = () => {
    const amt = Number(amount.get()) || 0;
    perLine.textContent = slotInfo ? (amt / slotInfo.lines).toFixed(8) : '-';
  };
  amount.input.addEventListener('input', recalc);
  spin.addEventListener('click', () => doSpin(amount, spin));
  // The arm is drawn later, with the cabinet. Wiring it here keeps one code path: it
  // presses the same button rather than having its own idea of what a spin costs.
  setTimeout(() => {
    const lever = $('#slotLever');
    if (lever) lever.addEventListener('click', () => { if (!spin.disabled) spin.click(); });
  }, 0);

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
    el('div', { class: 'slot-stage' },
      el('div', { class: 'slot-cabinet' },
      el('div', { class: 'cab-top' }),
      el('div', { class: 'cab-side l' }),
      el('div', { class: 'cab-side r' }),
      el('div', { class: 'slot-marquee' },
        el('span', { class: 'mq-top' }, 'CASINO'),
        el('span', { class: 'mq-main' }, (state.cfg?.siteName || 'NULLSTAKE').toUpperCase()),
        el('span', { class: 'mq-sub' }, 'BAR · 7 · WINS')),
      el('div', { class: 'slot-body' },
        el('div', { class: 'slot-window' },
          el('div', { class: 'reels', id: 'reels' })),
        slotLever()),
      el('div', { class: 'slot-base' },
        el('div', { class: 'slot-tray' })))),
  );

  // The viewer's position, published onto the stage. Every layer that wants to move —
  // the cabinet, the glass, the light on the wall, the shadow on the floor — reads the
  // same two properties and takes its own fraction of them.
  if (state.parallax) state.parallax.stop();
  state.parallax = startParallax($('.slot-stage'));

  if (!slotInfo) {
    try { slotInfo = await api('/api/bet/slots/info'); } catch { /* offline */ }
  }
  paintReels(blankScreen());

  // Real cylinders if the hardware will draw them, the DOM drums if not.
  const win = $('.slot-window');
  if (win) {
    glReels = await buildGlReels(win);
    win.classList.toggle('gl', !!glReels);
    if (glReels) {
      glShow(null);
      // Size it again once layout has actually happened. Measuring during the build gets
      // whatever the box was mid-construction — it came out 543px wide inside a 634px
      // window — and a viewport that size gives the wrong aspect, the wrong number of
      // rows, and a gap down each side of the machine.
      requestAnimationFrame(() => { if (glReels) glReels.resize(); });
      if (typeof ResizeObserver === 'function') {
        if (glWatch) glWatch.disconnect();
        glWatch = new ResizeObserver(() => { if (glReels) glReels.resize(); });
        glWatch.observe(win);
      }
    }
  }
  recalc();
  infoPanel([
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('slots.rtp')),
      el('span', { class: 'v pos' }, slotInfo ? `${(slotInfo.rtp * 100).toFixed(2)}%` : '-')),
  ]);
}

/**
 * The arm.
 *
 * The thing every photograph of a slot machine has and every web slot leaves out, which
 * is most of why they look like spreadsheets that pay money. It swings when the reels go,
 * and it is a real control: pulling it spins.
 */
function slotLever() {
  const box = el('div', { class: 'slot-lever', id: 'slotLever' });
  box.innerHTML = `
    <svg viewBox="0 0 40 200" aria-hidden="true">
      <defs>
        <linearGradient id="lvGold" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#8a6a24"/>
          <stop offset=".35" stop-color="#f0d68a"/>
          <stop offset=".6" stop-color="#d9b45a"/>
          <stop offset="1" stop-color="#6d5119"/>
        </linearGradient>
        <radialGradient id="lvBall" cx=".34" cy=".3">
          <stop offset="0" stop-color="#ff9a8f"/>
          <stop offset=".45" stop-color="#d92d20"/>
          <stop offset="1" stop-color="#5e0f08"/>
        </radialGradient>
        <radialGradient id="lvPivot" cx=".35" cy=".32">
          <stop offset="0" stop-color="#f4e6b4"/>
          <stop offset="1" stop-color="#7a5c1f"/>
        </radialGradient>
      </defs>
      <g class="lever-arm">
        <rect x="16" y="30" width="8" height="120" rx="4" fill="url(#lvGold)"/>
        <circle cx="20" cy="26" r="13" fill="url(#lvBall)"/>
        <ellipse cx="16" cy="21" rx="4" ry="3" fill="#fff" fill-opacity=".45"/>
      </g>
      <circle cx="20" cy="152" r="11" fill="url(#lvPivot)"/>
      <circle cx="20" cy="152" r="4" fill="#2a1f08"/>
    </svg>`;
  box.title = 'Pull';
  return box;
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
  const started = Date.now();
  // Keep the whirr going for as long as the reels are actually turning.
  const whirr = setInterval(() => audio.sfx('spin'), 130);

  try {
    const out = await api('/api/bet/slots', { method: 'POST', body: { amount: amount.get() } });
    // Stop the reels left to right. The stagger is what makes a spin feel like a spin
    // rather than a screen swap, and it is the moment the last reel matters.
    await settleReels(out.screen, out.stops, started);
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
  const lever = $('#slotLever');
  if (lever) lever.classList.toggle('pulled', on);
  if (glReels) {
    if (on) { glReels.clearWins(); glReels.start(); } else glReels.stop();
  }
}

/** Land each reel in turn, showing its final symbols as it stops. */
/**
 * How long the drums turn before the first one is allowed to stop.
 *
 * Not a delay for its own sake. The server answers in a few milliseconds on the same
 * machine, and a cylinder that starts and stops inside a fifth of a second reads as a
 * flicker rather than as something turning. The result is already decided and sitting in
 * hand either way; this is how long it takes to show it.
 */
const MIN_SPIN_MS = 780;

async function settleReels(screen, stops = null, started = 0) {
  const reels = [...document.querySelectorAll('#reels .reel')];
  if (!reels.length) { paintReels(screen, [], stops); return; }
  const spun = started ? Date.now() - started : 0;
  await new Promise((r) => setTimeout(r, Math.max(120, MIN_SPIN_MS - spun)));
  for (const [i, reel] of reels.entries()) {
    reel.classList.remove('spinning');
    // Rebuilt with the real stop, so the symbols that swing past as it settles are the
    // ones actually beside the result on the strip.
    paintReel(reel, screen[i], [], i, stops ? stops[i] : null);
    // The class goes on after the rebuild, or the browser keeps the old animation.
    reel.classList.add('landing');
    if (glReels) {
      const stop = stops && Number.isInteger(stops[i]) ? stops[i] : 0;
      glStops[i] = stop % GL_PER_DRUM;
      glReels.stopAt(i, stop % GL_PER_DRUM);
    }
    audio.sfx('reelStop');
    const foot = reelFoot(reel);
    if (slotFx && foot) {
      slotFx.burst(foot[0], foot[1], { count: 14, speed: 0.2, spread: 2.1, flash: 30 });
    }
    await new Promise((r) => setTimeout(r, 130));
  }
}

// ------------------------------------------------------------------ the drums
//
// A reel is a cylinder of FACES symbols turned about a horizontal axis, with a window
// showing three of them. Face k sits at rotateX(k * 24deg), so k = +1 is the top row,
// k = 0 the middle and k = -1 the bottom.
//
// The other twelve are not filler. screenFrom() reads the visible rows as
// strip[stop], strip[stop + 1], strip[stop + 2], so face k is strip[stop + 1 - k] and the
// symbols coming into view are the ones genuinely next to the result on that reel.
// Without a stop to work from -- the very first paint, before any spin -- it falls back
// to repeating what is on screen, which is the only honest thing it can draw.
const FACES = 15;
const HALF_FACES = (FACES - 1) / 2;

function faceSymbols(reelIndex, symbols, stop) {
  const strip = slotInfo && slotInfo.strips && slotInfo.strips[reelIndex];
  const out = [];
  for (let k = HALF_FACES; k >= -HALF_FACES; k -= 1) {
    if (strip && Number.isInteger(stop)) {
      const at = (((stop + 1 - k) % strip.length) + strip.length) % strip.length;
      out.push({ k, sym: strip[at] });
    } else {
      // Row for k=+1,0,-1 is 0,1,2; anything further round repeats the window.
      const row = ((1 - k) % symbols.length + symbols.length) % symbols.length;
      out.push({ k, sym: symbols[row] });
    }
  }
  return out;
}

/**
 * Build one drum.
 *
 * The three faces in the window carry data-row, because that is how the win highlight and
 * the payline overlay find them: indexing children stopped meaning anything once a reel
 * held fifteen faces in a circle instead of three boxes in a column.
 */
function paintReel(reelNode, symbols, litRows, reelIndex = 0, stop = null) {
  const drum = el('div', { class: 'drum' });
  for (const { k, sym } of faceSymbols(reelIndex, symbols, stop)) {
    const row = 1 - k;                       // 0, 1, 2 for the three in the window
    const visible = row >= 0 && row <= 2;
    // How far round the barrel this face sits decides how much light reaches it. CSS
    // cannot work that out from --i without abs(), which is too new to rely on, and the
    // index is right here anyway.
    const shade = Math.min(1, Math.max(0, (Math.abs(k) - 0.4) / 5)) * 0.72;
    const face = el('div', {
      class: `face sym-${sym} ${visible && litRows.includes(row) ? 'win' : ''}`,
      style: `--i:${k};--shade:${shade.toFixed(3)}`,
    });
    if (visible) face.dataset.row = String(row);
    const rendered = symbolImage(sym, slotTheme);
    if (rendered) face.innerHTML = `<img class="sym-img" src="${rendered}" alt="">`;
    else face.innerHTML = symbolSvg(sym, slotTheme);
    drum.appendChild(face);
  }

  const mount = el('div', { class: 'drum-mount' });
  mount.appendChild(drum);
  setKids(reelNode,
    mount,
    el('div', { class: 'reel-glass' }),
    el('div', { class: 'reel-cap l' }),
    el('div', { class: 'reel-cap r' }));
}

/**
 * translateZ cannot take a percentage, so the drum radius has to be a real length. This
 * measures one reel and publishes the symbol size; the CSS does the trigonometry.
 */
function sizeDrums() {
  const box = $('#reels');
  const reel = box && box.querySelector('.reel');
  if (!reel) return;
  const w = reel.getBoundingClientRect().width;
  if (w > 0) box.style.setProperty('--cell', `${w.toFixed(2)}px`);
}

let drumResize = null;
function watchDrums() {
  if (drumResize || typeof ResizeObserver !== 'function') return;
  drumResize = new ResizeObserver(() => {
    sizeDrums();
    if (slotFx) slotFx.resize();
    if (glReels) glReels.resize();
  });
  const box = $('#reels');
  if (box) drumResize.observe(box);
}

/** Draw the 5x3 window, highlighting the cells that form a winning line. */
function paintReels(screen, wins = [], stops = null) {
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
    paintReel(reel, symbols, lit.get(ri) || [], ri, stops ? stops[ri] : null);
    return reel;
  }));
  sizeDrums();
  watchDrums();
  // setKids emptied the box, so the effects canvas went with it.
  if (slotFx) slotFx.stop();
  slotFx = createSparks(box);
}

let slotFx = null;

// ---------------------------------------------------------------- the drums
//
// When WebGL is available the reels are real cylinders drawn by slot3d.js, and the DOM
// drums behind them are hidden. When it is not — old hardware, a refused context — the
// DOM drums stay and everything works as before. The game logic does not know which it
// got, which is the point: the renderer is a skin over the same screen and stops.
let glReels = null;
let glWatch = null;

/** How many symbols go round one drum. Twelve reads well and keeps the texture small. */
const GL_PER_DRUM = 12;

/**
 * Paint one symbol into the strip texture.
 *
 * The panel behind it matters. The drum is dark and the artwork is mostly line work, so
 * without a lit panel the symbols come out as outlines floating on a black barrel. The
 * panel is flat rather than graded for the same reason the DOM faces are: the cylinder
 * does the shading, and a gradient per cell fights it.
 */
function glDrawSymbol(ctx, sym, y, cell, width) {
  return new Promise((resolve) => {
    // The band the symbols are printed on.
    //
    // A flat dark fill was most of why the wheels looked cheap: the renders carry their
    // own black ground, so between symbols there was nothing but black and the drum read
    // as an empty tube. A real reel band is a material — this one is brushed brass, lit
    // down its length, with a darker lip at each seam.
    const band = ctx.createLinearGradient(0, y, width, y + cell);
    band.addColorStop(0, '#241b09');
    band.addColorStop(0.3, '#46371a');
    band.addColorStop(0.5, '#5d4a22');
    band.addColorStop(0.7, '#3c2f15');
    band.addColorStop(1, '#1b1406');
    ctx.fillStyle = band;
    ctx.fillRect(0, y, width, cell);

    const img = new Image();
    const rendered = symbolImage(sym, slotTheme);
    const pad = rendered ? 0 : cell * 0.12;
    img.onload = () => {
      if (rendered) {
        // 'screen', not 'lighter'.
        //
        // Both drop the pure black the renders sit on, so the object lifts off the brass
        // either way. The difference is what happens at the bright end: 'lighter' simply
        // adds, so a gold highlight plus a lit brass band goes past 1.0 and clips to white
        // **inside the texture** — before a single line of the shader has run. Every
        // symbol was losing its detail to that, and no amount of lighting could bring it
        // back, because the pixels were already gone. 'screen' approaches 1.0 without ever
        // reaching it, so the highlight survives as a highlight.
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.drawImage(img, 0, y, width, cell);
        ctx.restore();
      } else {
        ctx.drawImage(img, pad, y + pad, width - pad * 2, cell - pad * 2);
      }
      resolve();
    };
    // A symbol that will not load should not stall the whole strip.
    img.onerror = () => resolve();
    img.src = rendered
      // Standalone: an <img> is its own document and cannot see the page's shared defs.
      || `data:image/svg+xml;charset=utf-8,${encodeURIComponent(symbolSvgStandalone(sym, slotTheme))}`;
  });
}

/** The twelve symbols on one drum, taken from that reel's real strip. */
function glStripFor(reel) {
  const strip = slotInfo && slotInfo.strips && slotInfo.strips[reel];
  if (!strip || !strip.length) return ['A', 'K', 'Q', 'J', 'T', 'BELL', 'GEM', 'CROWN', 'WILD', 'SCAT', 'A', 'K'];
  return Array.from({ length: GL_PER_DRUM }, (_, i) => strip[i % strip.length]);
}

/** Park the drums on a screen, using the real stops when the server sent them. */
let glStops = [0, 0, 0, 0, 0];

function glShow(stops) {
  if (!glReels) return;
  glStops = Array.from({ length: 5 }, (_, i) => (
    stops && Number.isInteger(stops[i]) ? stops[i] % GL_PER_DRUM : 0));
  for (let reel = 0; reel < 5; reel += 1) {
    const stop = stops && Number.isInteger(stops[reel]) ? stops[reel] : 0;
    glReels.setStop(reel, stop % GL_PER_DRUM);
  }
}

async function buildGlReels(window_) {
  if (glReels) { glReels.dispose(); glReels = null; }
  const made = createGlReels(window_, { reels: 5, rows: 3, perDrum: GL_PER_DRUM });
  if (!made) return null;
  for (let reel = 0; reel < 5; reel += 1) {
    // eslint-disable-next-line no-await-in-loop
    await made.setStrip(reel, glStripFor(reel), glDrawSymbol);
  }
  return made;
}

/** Where a reel meets the deck, in the effects canvas's own coordinates. */
function reelFoot(reel) {
  const box = $('#reels');
  if (!box || !reel) return null;
  const b = box.getBoundingClientRect();
  const r = reel.getBoundingClientRect();
  return [r.left - b.left + r.width / 2, r.top - b.top + r.height * 0.86];
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
      if (glReels) {
        // The DOM faces are hidden and laid out by other rules when the drums are drawn
        // in WebGL, so their boxes are not where the symbols are. Ask the renderer.
        const pt = glReels.symbolPoint(reel, rows[reel]);
        if (!pt) continue;
        const gl = glReels.element.getBoundingClientRect();
        points.push(`${(gl.left - base.left + pt[0]).toFixed(1)},${(gl.top - base.top + pt[1]).toFixed(1)}`);
        glReels.setWin(reel, glStops[reel], rows[reel]);
        continue;
      }
      const cell = reels[reel]?.querySelector(`.face[data-row="${rows[reel]}"]`);
      if (!cell) continue;
      const r = cell.getBoundingClientRect();
      points.push(`${(r.left - base.left + r.width / 2).toFixed(1)},${(r.top - base.top + r.height / 2).toFixed(1)}`);
    }
    if (points.length < 2) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${points.join(' L')}`);
    svg.appendChild(path);
    if (slotFx) slotFx.line(points.map((pt) => pt.split(',').map(Number)));
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
  if (slotFx) slotFx.bigWin();
  setTimeout(removeBigWin, 2600);
}

async function showSlotResult(out) {
  setReelsSpinning(false);
  paintReels(out.screen, out.wins, out.stops);
  drawPaylines(out.wins);
  const banner = $('#slotBanner');
  if (!banner) return;

  if (out.freeSpinsAwarded) {
    banner.className = 'slot-banner free';
    banner.textContent = t('slots.freeSpins', { n: out.freeSpinsAwarded });
    // Replay the free spins one at a time so they are visible, not just totalled.
    for (const [i, fs] of out.freeSpins.entries()) {
      await new Promise((r) => setTimeout(r, 520));
      paintReels(fs.screen, fs.wins, fs.stops);
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


// ----------------------------------------------------------------- jigsaw
let jigBoard = null;
let jigClock = null;

/**
 * The timed jigsaw.
 *
 * The clock on screen is read from the server's `elapsed` and ticked locally for display.
 * It is not what decides the payout — the server measures the round itself — so a tampered
 * display changes nothing but itself, which is why it can be ticked here at all.
 */
async function renderJigsaw() {
  stopJigClock();
  let game = null;
  if (state.user) {
    try { game = await api('/api/bet/jigsaw/current'); } catch { /* nothing open */ }
  }
  state.jigsaw = game;
  paintJigsaw();
}

function stopJigClock() {
  if (jigClock) { clearInterval(jigClock); jigClock = null; }
}

const jigTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function paintJigsaw() {
  const g = state.jigsaw;
  const panel = $('#betPanel');
  const amount = amountControl();
  const boardSel = el('select', {},
    ...['easy', 'medium', 'hard', 'expert'].map((k) => el('option', { value: k }, t(`jig.${k}`))));

  const go = el('button', { class: 'primary big' }, t('jig.start'));
  go.onclick = async () => {
    if (!requireLogin()) return;
    go.disabled = true;
    try {
      state.jigsaw = await api('/api/bet/jigsaw/start', {
        method: 'POST', body: { amount: amount.get(), board: boardSel.value },
      });
      paintJigsaw();
    } catch (e) { toast(e.message, 'bad'); go.disabled = false; }
  };

  if (!g || g.state !== 'active') {
    setKids(panel,
      amount.node,
      el('label', { class: 'field' }, el('span', {}, t('jig.board')), boardSel),
      go,
      el('p', { class: 'hint' }, t('jig.intro')));
    applyAll(panel);
    setKids($('#stage'), el('p', { class: 'hint' }, t('jig.idle')));
    if (g && g.state === 'done') showJigResult(g);
    return;
  }

  // A round is open: the panel becomes the clock and a way out.
  const clock = el('span', { class: 'jig-clock' }, jigTime(g.elapsed || 0));
  const pace = el('span', { class: 'jig-pace' }, '');
  let shown = g.elapsed || 0;
  const tick = () => {
    shown += 1;
    clock.textContent = jigTime(shown);
    const over = shown > g.par;
    pace.textContent = over
      ? t('jig.over', { n: jigTime(shown - g.par) })
      : t('jig.left', { n: jigTime(g.par - shown) });
    pace.classList.toggle('over', over);
  };
  tick();
  stopJigClock();
  jigClock = setInterval(tick, 1000);

  setKids(panel,
    el('div', { class: 'jig-bar' }, clock, pace),
    el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('jig.entry')),
      el('span', { class: 'v' }, `${fmt(g.wager)} ${state.cfg?.token?.symbol || 'TUG'}`)),
    ...(g.payTable || []).map((row) => el('div', { class: 'stat-row' },
      el('span', { class: 'k' }, t('jig.within', { n: jigTime(row.within) })),
      el('span', { class: 'v' }, `${row.multiplier.toFixed(2)}x`))),
    el('button', { class: 'ghost', onclick: giveUpJigsaw }, t('jig.give')));
  applyAll(panel);

  // The board.
  const host = el('div');
  setKids($('#stage'), host);
  jigBoard = jigsawBoard(host, {
    cols: g.cols,
    rows: g.rows,
    scramble: g.scramble,
    cutSeed: g.cutSeed,
    picture: state.puzzlePictures?.[g.picture] || null,
    onSolve: (arrangement) => submitJigsaw(arrangement),
  });
}

async function submitJigsaw(arrangement) {
  stopJigClock();
  jigBoard?.freeze();
  try {
    const out = await api('/api/bet/jigsaw/solve', { method: 'POST', body: { arrangement } });
    state.jigsaw = out;
    audio.sfx(out.payout > 0 ? 'win' : 'lose');
    await refreshTokenBalance();
    setBalance(state.tokenBalance);
    showJigResult(out);
  } catch (e) { toast(e.message, 'bad'); }
}

function showJigResult(out) {
  const won = (out.payout || 0) > 0;
  const line = out.tooFast
    ? t('jig.tooFast')
    : (won
      ? t('jig.won', { n: jigTime(out.seconds || 0), m: (out.multiplier || 0).toFixed(2) })
      : t('jig.slow', { n: jigTime(out.seconds || 0) }));
  addKids($('#stage'), el('p', { class: `hint ${won ? 'pos' : 'neg'}` }, line));
}

async function giveUpJigsaw() {
  stopJigClock();
  try { await api('/api/bet/jigsaw/give', { method: 'POST' }); } catch { /* gone either way */ }
  state.jigsaw = null;
  renderJigsaw();
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
    const amount = amountControl();
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
    const amount = amountControl();
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

/**
 * Make sure this device can sign, and if it cannot, ask right here.
 *
 * The rule is that no step leads to an error. Telling someone to go and unlock a wallet
 * before they can press the thing they just pressed is exactly that kind of dead end, so
 * this asks for the one thing it needs — the phrase — in place, and the caller carries on
 * as though nothing happened.
 *
 * A wallet is created at registration, so the only person who ever sees this is one
 * signing in on a second device, where the key genuinely is not on this machine.
 *
 * Resolves true when a key is ready, false when the player closed the box.
 */
async function ensureWallet() {
  await recallTokenKey();
  await refreshTokenBalance();
  if (tokenKey && (!state.tokenPubkey || tokenKey.publicKey === state.tokenPubkey)) return true;
  if (!(await tokenKeys.supported())) { toast(t('tok.unsupported'), 'bad'); return false; }

  // The account has no wallet on the server at all. Asking for a phrase would be asking
  // for something that has never existed, so make one instead — the same step registration
  // runs. This is the path an account takes when it was created before wallets were made
  // at sign-up, and after a development chain reset, which wipes every key.
  if (!state.tokenPubkey) {
    await newWalletStep();
    return !!tokenKey;
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const err = el('p', { class: 'err' });
    const phrase = el('input', { class: 'mono', placeholder: t('tok.enterPhrase') });
    const go = el('button', { class: 'primary' }, t('tok.unlock'));
    go.onclick = async () => {
      err.textContent = '';
      go.disabled = true;
      const was = go.textContent;
      go.textContent = t('common.loading');
      try {
        // Deriving the key is PBKDF2 at 210k rounds and takes about a second on a phone,
        // which is why the button says so rather than appearing to have missed the tap.
        const key = await tokenKeys.keyFromPhrase(phrase.value);
        await tokenKeys.remember(key, phrase.value);
        tokenKey = key;
        await refreshTokenBalance();
        closeModal();
        done(true);
      } catch (e) {
        err.textContent = e.message;
        go.disabled = false;
        go.textContent = was;
      }
    };
    openModal(t('tok.unlock'), (b) => addKids(b,
      el('p', { class: 'hint' }, t('tok.locked')),
      el('div', { class: 'input-row' }, phrase, go),
      err,
      el('button', { class: 'ghost', onclick: () => { closeModal(); done(false); } }, t('common.cancel'))));
    phrase.focus();
  });
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
        await tokenKeys.remember(tokenKey, phrase);
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
            await tokenKeys.remember(tokenKey, restore.value);
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
      await tokenKeys.remember(tokenKey, phrase);
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
        el('div', { class: 'v pos' }, `${fmt(info.balance ?? 0)} ${info.symbol || ''}`)),
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

  // The phrase, readable whenever you want it.
  //
  // It used to be shown exactly once, at creation, and then never again — so switching
  // apps mid-copy destroyed it permanently even though the wallet on this device kept
  // working. A backup you get one glance at is not a backup.
  addKids(body, el('h3', { style: 'margin-top:16px' }, t('tok.phrase')));
  const phraseSlot = el('div');
  addKids(body, phraseSlot, el('p', { class: 'hint' }, t('tok.phraseLater')));
  tokenKeys.recallPhrase().then((phrase) => {
    if (!phrase) {
      // A wallet restored on a device that never stored the words. It signs perfectly
      // well; there is simply nothing here to read back, and saying so is better than
      // an empty box.
      setKids(phraseSlot, el('p', { class: 'hint' }, t('tok.phraseMissing')));
      return;
    }
    const box = el('div', { class: 'phrase-box mono', hidden: true }, phrase);
    const reveal = el('button', { class: 'tiny' }, t('tok.phraseShow'));
    reveal.onclick = () => {
      box.hidden = !box.hidden;
      reveal.textContent = t(box.hidden ? 'tok.phraseShow' : 'tok.phraseHide');
    };
    setKids(phraseSlot,
      el('div', { class: 'row wrap' }, reveal,
        el('button', {
          class: 'tiny',
          onclick: async () => {
            try { await navigator.clipboard.writeText(phrase); toast(t('wallet.copied')); }
            catch { box.hidden = false; reveal.textContent = t('tok.phraseHide'); }
          },
        }, t('wallet.copy'))),
      box);
  });

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
      el('div', { class: 'v pos' }, `${fmt(info.balance ?? 0)} ${info.symbol || ''}`)),
    el('p', { class: 'hint' }, t('arc.intro')),
  );
  applyAll(panel);

  setKids($('#stage'), 
    el('h2', { style: 'text-align:center' }, t('arc.title')),
    el('div', { class: 'cabinets' }, ...info.games.map((g) => cabinetCard(g, info))),
  );
  infoPanel();
}

/**
 * A cabinet's name and description come from the translation table, not from the server.
 *
 * The server knows the cabinets by key and describes them in English, which was fine
 * while it was the only language and wrong on the Russian floor. It still sends the
 * English as a fallback, so a cabinet added server-side shows up named rather than blank.
 */
const cabinetName = (game) => {
  const key = `arc.g.${game.key}`;
  const out = t(key);
  return out === key ? game.name : out;
};
const cabinetBlurb = (game) => {
  const key = `arc.g.${game.key}.blurb`;
  const out = t(key);
  return out === key ? game.blurb : out;
};
/** The same for the control hint, which the cabinet module carries in English. */
const cabinetControls = (game, mod) => {
  const key = `arc.g.${game.key}.controls`;
  const out = t(key);
  return out === key ? mod.meta.controls : out;
};

function cabinetCard(game, info) {
  const playable = !!CABINET_MODULES[game.key];
  const title = cabinetName(game);
  const card = el('div', {
    class: 'cabinet',
    onclick: () => (playable ? insertToken(game) : toast(t('arc.soon'))),
  },
  // The marquee keeps the English: it is the name painted on the machine, and a
  // Cyrillic name in a fourteen-character slot of that font is not the same object.
  el('div', { class: 'marquee' }, game.name.toUpperCase().slice(0, 14)),
  el('h4', {}, title),
  el('div', { class: 'blurb' }, playable ? cabinetBlurb(game) : t('arc.soon')),
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
  // Short of tugriks: the one case where the answer really is "not now". Play free
  // instead rather than refusing outright — the arcade pays nothing out in any case, so a
  // free play costs nobody anything except a place on the board, which the server keeps
  // practice scores off.
  if (info.balance < info.tokenCost) return practicePlay(game);
  if (!(await ensureWallet())) return;

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

/** A free go. No tugrik, no leaderboard place — the server keeps these off the board. */
async function practicePlay(game) {
  try {
    const play = await api('/api/arcade/practice', { method: 'POST', body: { game: game.key } });
    audio.sfx('click');
    toast(t('arc.freeGo'));
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
      el('div', { class: 'arcade-controls' }, cabinetControls(game, mod))),
  );

  setKids($('#betPanel'), 
    el('div', { class: 'stat-card' },
      el('div', { class: 'k' }, cabinetName(game)),
      el('div', { class: 'v' }, scoreOut.textContent)),
    el('p', { class: 'hint' }, cabinetControls(game, mod)),
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
    // Playing on your own, right beside the staked table rather than hidden elsewhere.
    // A lobby with nobody in it is the first thing a new arrival sees, and "there is
    // nobody here" is a worse answer than "play a hand against the machine".
    el('div', { class: 'solo-box' },
      el('button', {
        class: 'big solo-start',
        onclick: () => startSolo(game.value),
      }, t('solo.play')),
      el('p', { class: 'hint' }, t('solo.note'))),
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

/**
 * Playing on your own.
 *
 * The boards are the multiplayer ones, untouched. They render from `view` and `seat` and
 * report through `onAct`, which is exactly the shape `/api/solo/*` returns — so this is
 * almost entirely plumbing, and a board fixed for a match is fixed here too.
 */
async function startSolo(game) {
  if (!requireLogin()) return;
  try {
    const out = await api('/api/solo/start', { method: 'POST', body: { game } });
    state.solo = out;
    state.matchId = null;
    stopMatchPoll();
    await buildSoloScreen(out);
  } catch (e) { toast(e.message, 'bad'); }
}

async function soloAct(payload) {
  if (!state.solo) return;
  try {
    // One request carries the player's move and comes back with the opponents' replies
    // already made, so there is nothing to poll for: nobody else is going to move while
    // this page sits idle.
    const out = await api('/api/solo/move', { method: 'POST', body: { game: state.solo.game, ...payload } });
    state.solo = out;
    paintSolo(out);
  } catch (e) { toast(e.message, 'bad'); }
}

async function buildSoloScreen(out) {
  const mod = await MATCH_BOARDS[out.game]();
  const host = el('div', { class: 'board-host' });
  setKids($('#stage'),
    el('div', { class: 'match-screen' },
      el('div', { class: 'match-bar' },
        el('span', { id: 'sTop' }, t('solo.bot')),
        el('span', {}, '')),
      host,
      el('div', { class: 'match-bar' },
        el('span', { id: 'sBottom' }, state.user?.username || ''),
        el('button', { class: 'ghost tiny', onclick: quitSolo }, t('solo.quit')))));

  state.board = mod.board(host, {
    view: out.view,
    seat: out.seat,
    seats: out.seats,
    myTurn: out.status === 'playing' && out.toMove === out.seat,
    lang: getLocale(),
    onAct: (action) => soloAct(action),
  });
  paintSolo(out);
}

function paintSolo(out) {
  if (state.board) {
    state.board.update({
      view: out.view,
      seat: out.seat,
      myTurn: out.status === 'playing' && out.toMove === out.seat,
    });
  }
  const top = $('#sTop');
  if (top) {
    top.textContent = out.status === 'done'
      ? soloResult(out)
      : `${t('solo.bot')}${out.toMove !== out.seat ? ' •' : ''}`;
  }
}

/** Who won, in the player's own terms rather than a list of seat numbers. */
function soloResult(out) {
  const won = (out.winners || []).includes(out.seat);
  const drawn = (out.winners || []).length > 1;
  if (drawn) return t('solo.draw');
  return won ? t('solo.youWon') : t('solo.youLost');
}

async function quitSolo() {
  if (!state.solo) return;
  const game = state.solo.game;
  try { await api('/api/solo/quit', { method: 'POST', body: { game } }); } catch { /* it is gone either way */ }
  state.solo = null;
  state.board = null;
  renderMatch();
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

// Slots first: it is the game the site is built around and the one a new arrival should
// land on. The rest follow in the order they were built.
const GAMES = ['slots', 'dice', 'limbo', 'mines', 'crash', 'jigsaw', 'preferans', 'debertz', 'arcade', 'match'];

/**
 * What each game is made of.
 *
 * `m` is one of five materials defined in buttons.css and `hue` is the single number every
 * one of them derives its tints from. Adding a game is a line here, not a new shadow
 * stack — which is the whole reason there are five materials rather than ten designs.
 *
 * See the header of public/buttons.css for the depth scale and why the cotton ones press
 * differently from the rest.
 */
const GAME_SKIN = {
  slots:     { m: 'brass',  hue: 42 },   // the cabinet's own lacquer and brass
  arcade:    { m: 'brass',  hue: 14 },   // moulded plastic over a dark bezel
  mines:     { m: 'tile',   hue: 210 },  // a pressed tile that actually depresses
  jigsaw:    { m: 'tile',   hue: 268 },  // cut card stock
  crash:     { m: 'glass',  hue: 152 },  // a line on a chart, lit from within
  limbo:     { m: 'glass',  hue: 190 },
  dice:      { m: 'resin',  hue: 8 },    // moulded, rounded, heavy
  preferans: { m: 'cotton', hue: 158 },  // felt table
  debertz:   { m: 'cotton', hue: 128 },
  match:     { m: 'cotton', hue: 32 },
};
const skinOf = (g) => GAME_SKIN[g] || { m: 'tile', hue: 42 };

/**
 * The game picker.
 *
 * The header can hold ten names; it cannot hold ten objects, and it should not try — that
 * bar was reclaimed from the games. This is where the materials live, at a size where the
 * work is visible, and it is the right first screen on a phone, where a strip of ten tiny
 * pills is the weakest thing on the page.
 *
 * Slots stays the default landing, so this is somewhere you go rather than a gate you
 * pass through.
 */
function renderPicker() {
  setKids($('#betPanel'));
  setKids($('#infoPanel'));
  const tiles = GAMES.map((g) => {
    const skin = skinOf(g);
    return el('button', {
      class: `gbtn m-${skin.m} ${state.game === g ? 'on' : ''}`,
      style: `--g-hue:${skin.hue}`,
      onclick: () => { state.game = g; renderGame(); },
    },
    // Cotton is the only material with a sewn seam, so it is the only one that gets the
    // element for it rather than every button carrying a node it never shows.
    skin.m === 'cotton' ? el('span', { class: 'g-seam' }) : null,
    el('span', { class: 'g-kind' }, t(`pick.kind.${skin.m}`)),
    el('span', { class: 'g-name' }, t(`game.${g}`)));
  });
  setKids($('#stage'),
    el('h3', { style: 'margin-bottom:14px' }, t('pick.title')),
    el('div', { class: 'picker' }, ...tiles));

  // The picker tilts with the device too, so the buttons catch the light as it moves.
  if (state.parallax) state.parallax.stop();
  state.parallax = startParallax($('.picker'));
}

function renderGame() {
  if (state.es && state.game !== 'crash') { state.es.close(); state.es = null; }
  if (state.cabinet && state.game !== 'arcade') { state.cabinet.stop(); state.cabinet = null; }
  // The stage it was publishing onto is about to be replaced, so the loop has nothing
  // left to drive.
  if (state.parallax && !['slots', 'games'].includes(state.game)) { state.parallax.stop(); state.parallax = null; }
  if (state.game !== 'match') { stopMatchPoll(); state.matchId = null; state.board = null; }
  const nav = $('#navGames');
  // Only the hue travels up here. The bar is 45px and staying that way, so the pills get
  // their game's colour and its underline and nothing else — no depth, no texture, no
  // height. The material lives in the picker, where it can actually be seen.
  // A way into the picker, at the head of the nav where a home button belongs.
  const home = el('button', {
    class: `tiny nav-home ${state.game === 'games' ? 'on' : ''}`,
    'data-i18n-title': 'pick.title',
    onclick: () => { state.game = 'games'; renderGame(); },
  }, el('span', { class: 'nav-home-grid', 'aria-hidden': 'true' }));

  setKids(nav, home, ...GAMES.map((g) => el('button', {
    class: `tiny ${state.game === g ? 'on' : ''}`,
    style: `--g-hue:${skinOf(g).hue}`,
    onclick: () => { state.game = g; renderGame(); },
  }, t(`game.${g}`))));

  if (state.game === 'games') renderPicker();
  else if (state.game === 'dice') renderDice();
  else if (state.game === 'limbo') renderLimbo();
  else if (state.game === 'mines') { state.mines = null; renderMines(); loadMinesState(); }
  else if (state.game === 'slots') renderSlots();
  else if (state.game === 'jigsaw') { loadPuzzlePictures(); renderJigsaw(); }
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

/**
 * The banner strip.
 *
 * It used to carry two: one saying you were in practice mode, one saying the crypto
 * wallet driver was a test one. Both described a split that no longer exists, so the
 * strip is empty — but the function stays, because it is called on every language change
 * and is where anything genuinely site-wide would go.
 */
function renderBanners() {
  const box = $('#banners');
  if (box) setKids(box);
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

  // A leftover from when there were three wallets to choose between. Cleared rather than
  // read, so a device that remembers "demo" does not carry a dead preference forever.
  try { localStorage.removeItem('wallet'); } catch { /* private mode */ }

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

  // The account menu. Closing on any outside pointerdown and on Escape is the whole of
  // it — the buttons inside keep the ids they always had, so their wiring below is
  // untouched by having moved into a panel.
  const accountMenu = $('#accountMenu');
  const accountTrigger = $('#btnAccount');
  const accountPanel = $('#userButtons');
  const closeAccount = () => {
    accountPanel.hidden = true;
    accountTrigger.setAttribute('aria-expanded', 'false');
  };
  accountTrigger.onclick = (e) => {
    e.stopPropagation();
    const open = accountPanel.hidden;
    accountPanel.hidden = !open;
    accountTrigger.setAttribute('aria-expanded', String(open));
  };
  document.addEventListener('pointerdown', (e) => {
    if (!accountPanel.hidden && !accountMenu.contains(e.target)) closeAccount();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccount(); });
  accountPanel.addEventListener('click', closeAccount);

  $('#btnSignin').onclick = () => authModal('login');
  $('#btnSignup').onclick = () => authModal('register');
  $('#btnSignout').onclick = signOut;
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
    await afterAuth();
  } catch {
    renderGame();
    loadFeed();
    if (new URLSearchParams(location.search).get('ref')) authModal('register');
  }
  setInterval(loadFeed, 15000);
}

boot();
