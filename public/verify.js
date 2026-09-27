// Offline fairness verifier. Every calculation happens here in the browser via Web Crypto,
// so verifying a bet never involves asking the server to confirm its own work.
// The algorithm mirrors src/fair.js exactly; if the two ever disagree, the site is wrong.
import { LANGS, t, setLocale, getLocale, applyAll } from './i18n.js';

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

const LOCAL = {
  'v.title': { en: 'Recompute any bet yourself', ru: 'Пересчитайте любую ставку сами' },
  'v.intro': {
    en: 'This page does the maths in your browser using the Web Crypto API. Nothing is sent to the server, so you are not trusting it. Paste a revealed server seed, your client seed and the bet nonce, and compare the result with what you were paid.',
    ru: 'Все вычисления происходят в вашем браузере через Web Crypto API. На сервер ничего не отправляется, поэтому доверять ему не нужно. Вставьте раскрытый серверный сид, ваш клиентский сид и номер ставки, затем сравните результат с выплатой.',
  },
  'v.game': { en: 'Game', ru: 'Игра' },
  'v.server': { en: 'Server seed (revealed, hex)', ru: 'Серверный сид (раскрытый, hex)' },
  'v.client': { en: 'Client seed', ru: 'Клиентский сид' },
  'v.nonce': { en: 'Nonce (bet number, or round id for crash)', ru: 'Nonce (номер ставки или id раунда для Краш)' },
  'v.edge': { en: 'House edge', ru: 'Преимущество казино' },
  'v.run': { en: 'Verify', ru: 'Проверить' },
  'v.target': { en: 'Threshold (hundredths, 5000 = 50.00)', ru: 'Порог (сотые, 5000 = 50.00)' },
  'v.mode': { en: 'Direction', ru: 'Направление' },
  'v.mines': { en: 'Mine count', ru: 'Количество мин' },
  'v.picks': { en: 'Safe tiles revealed', ru: 'Открыто безопасных плиток' },
  'v.result': { en: 'Result', ru: 'Результат' },
  'v.hashOf': { en: 'sha256 of that server seed', ru: 'sha256 этого серверного сида' },
  'v.hashNote': {
    en: 'Compare this with the hash the site published before you bet. If it matches, the seed was not swapped.',
    ru: 'Сравните с хешем, опубликованным до вашей ставки. Совпадение означает, что сид не подменяли.',
  },
  'v.chain': { en: 'Check a published commitment', ru: 'Проверить опубликованное обязательство' },
  'v.chainNote': {
    en: 'Crash uses a reverse hash chain. Paste the seed a round revealed and the value it should hash to (the commitment for round 1, otherwise the seed revealed by the round before it).',
    ru: 'Краш использует обратную хеш-цепочку. Вставьте сид раунда и значение, в которое он должен хешироваться (обязательство для раунда 1, иначе сид предыдущего раунда).',
  },
  'v.seedA': { en: 'Revealed seed', ru: 'Раскрытый сид' },
  'v.seedB': { en: 'Should hash to', ru: 'Должен хешироваться в' },
  'v.checkHash': { en: 'Check hash', ru: 'Проверить хеш' },
  'v.match': { en: 'MATCH: the chain is intact.', ru: 'СОВПАДЕНИЕ: цепочка не нарушена.' },
  'v.noMatch': { en: 'NO MATCH: these values do not belong to the same chain.', ru: 'НЕ СОВПАДАЕТ: значения не принадлежат одной цепочке.' },
  'v.needBoth': { en: 'Fill both fields.', ru: 'Заполните оба поля.' },
  'v.badSeed': { en: 'Server seed must be hex characters.', ru: 'Серверный сид должен быть в hex.' },
  'v.under': { en: 'Under', ru: 'Меньше' },
  'v.over': { en: 'Over', ru: 'Больше' },
  'v.win': { en: 'winning bet', ru: 'ставка выиграла' },
  'v.lose': { en: 'losing bet', ru: 'ставка проиграла' },
};

// ------------------------------------------------------------------ crypto
async function hmacBytes(serverSeed, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256hex(s) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

const bytesToFloat = (b, o) => b[o] / 256 + b[o + 1] / 256 ** 2 + b[o + 2] / 256 ** 3 + b[o + 3] / 256 ** 4;

/** Same stream as the server: 8 floats per HMAC round, cursor advancing as needed. */
async function floats(serverSeed, clientSeed, nonce, count) {
  const out = [];
  let cursor = 0;
  while (out.length < count) {
    const bytes = await hmacBytes(serverSeed, `${clientSeed}:${nonce}:${cursor}`);
    for (let i = 0; i + 4 <= bytes.length && out.length < count; i += 4) out.push(bytesToFloat(bytes, i));
    cursor += 1;
  }
  return out;
}

const floor2 = (x) => Math.floor(x * 100) / 100;

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

// ------------------------------------------------------------------- games
async function verify({ game, serverSeed, clientSeed, nonce, edge, target, mode, mineCount, picks }) {
  if (game === 'dice') {
    const [f] = await floats(serverSeed, clientSeed, nonce, 1);
    const roll = Math.floor(f * 10000);
    const winCount = mode === 'over' ? 10000 - 1 - target : target;
    const chance = winCount / 10000;
    const won = mode === 'over' ? roll > target : roll < target;
    return {
      rows: [
        ['float', f.toFixed(12)],
        [t('v.result'), (roll / 100).toFixed(2)],
        ['win chance', `${(chance * 100).toFixed(2)}%`],
        ['multiplier', `${floor2((1 - edge) / chance).toFixed(2)}x`],
        ['verdict', won ? t('v.win') : t('v.lose')],
      ],
      won,
    };
  }
  if (game === 'limbo' || game === 'crash') {
    const salt = game === 'crash' ? (clientSeed || 'crash') : clientSeed;
    const [f] = await floats(serverSeed, salt, nonce, 1);
    const raw = 1 / (1 - f);
    const m = Math.max(1, floor2(raw * (1 - edge)));
    return {
      rows: [
        ['float', f.toFixed(12)],
        ['raw 1/(1-f)', raw.toFixed(6)],
        [game === 'crash' ? 'crash point' : t('v.result'), `${m.toFixed(2)}x`],
      ],
      won: null,
    };
  }
  // mines: replay the shuffle
  const fs = await floats(serverSeed, clientSeed, nonce, 24);
  const tiles = Array.from({ length: 25 }, (_, i) => i);
  for (let i = 0; i < 24; i += 1) {
    const j = i + Math.floor(fs[i] * (25 - i));
    const tmp = tiles[i]; tiles[i] = tiles[j]; tiles[j] = tmp;
  }
  const mines = tiles.slice(0, mineCount).sort((a, b) => a - b);
  const p = picks > 0 ? choose(25 - mineCount, picks) / choose(25, picks) : 1;
  return {
    rows: [
      ['mine positions (0-24)', mines.join(', ')],
      ['safe probability', picks > 0 ? p.toFixed(8) : '1'],
      ['multiplier', picks > 0 ? `${floor2((1 - edge) / p).toFixed(2)}x` : '-'],
    ],
    won: null,
  };
}

// --------------------------------------------------------------------- ui
function localise() {
  const L = (id, key) => { const n = $(id); if (n) n.textContent = LOCAL[key][getLocale()] ?? LOCAL[key].en; };
  L('hTitle', 'v.title'); L('hIntro', 'v.intro'); L('lGame', 'v.game');
  L('lServer', 'v.server'); L('lClient', 'v.client'); L('lNonce', 'v.nonce');
  L('lEdge', 'v.edge'); L('run', 'v.run'); L('lChain', 'v.chain');
  L('hChain', 'v.chainNote'); L('lSeedA', 'v.seedA'); L('lSeedB', 'v.seedB');
  L('runChain', 'v.checkHash');
  buildOpts();
}

function buildOpts() {
  const box = $('gameOpts');
  const g = $('game').value;
  const lang = getLocale();
  const lbl = (key) => LOCAL[key][lang] ?? LOCAL[key].en;
  box.innerHTML = '';
  const field = (labelKey, inputHtml) => {
    const w = document.createElement('label');
    w.className = 'field';
    const s = document.createElement('span');
    s.textContent = lbl(labelKey);
    w.append(s);
    w.insertAdjacentHTML('beforeend', inputHtml);
    return w;
  };
  if (g === 'dice') {
    box.append(field('v.target', '<input id="target" type="number" min="0" max="9999" value="5000">'));
    box.append(field('v.mode', `<select id="mode"><option value="under">${lbl('v.under')}</option><option value="over">${lbl('v.over')}</option></select>`));
  } else if (g === 'mines') {
    box.append(field('v.mines', '<input id="mineCount" type="number" min="1" max="24" value="3">'));
    box.append(field('v.picks', '<input id="picks" type="number" min="0" max="24" value="3">'));
  }
}

async function run() {
  const serverSeed = $('serverSeed').value.trim();
  const out = $('out');
  out.hidden = false;
  if (!/^[0-9a-fA-F]+$/.test(serverSeed)) {
    out.innerHTML = `<p class="hint neg">${LOCAL['v.badSeed'][getLocale()] ?? LOCAL['v.badSeed'].en}</p>`;
    return;
  }
  const game = $('game').value;
  const res = await verify({
    game,
    serverSeed,
    clientSeed: $('clientSeed').value,
    nonce: Number($('nonce').value) || 0,
    edge: Number($('edge').value) || 0,
    target: Number($('target')?.value ?? 5000),
    mode: $('mode')?.value ?? 'under',
    mineCount: Number($('mineCount')?.value ?? 3),
    picks: Number($('picks')?.value ?? 0),
  });
  const hash = await sha256hex(serverSeed);
  const lang = getLocale();
  const rows = res.rows.map(([k, v]) =>
    `<div class="stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  out.innerHTML = `
    <h3>${LOCAL['v.result'][lang] ?? LOCAL['v.result'].en}</h3>
    ${rows}
    <h3 style="margin-top:16px">${LOCAL['v.hashOf'][lang] ?? LOCAL['v.hashOf'].en}</h3>
    <div class="addr">${hash}</div>
    <p class="hint">${LOCAL['v.hashNote'][lang] ?? LOCAL['v.hashNote'].en}</p>`;
}

async function runChain() {
  const lang = getLocale();
  const seed = $('chainSeed').value.trim();
  const expect = $('chainExpect').value.trim().toLowerCase();
  const out = $('chainOut');
  if (!seed || !expect) {
    out.textContent = LOCAL['v.needBoth'][lang] ?? LOCAL['v.needBoth'].en;
    out.className = 'hint';
    return;
  }
  const h = await sha256hex(seed);
  const ok = h === expect;
  out.textContent = `${h} -> ${ok
    ? (LOCAL['v.match'][lang] ?? LOCAL['v.match'].en)
    : (LOCAL['v.noMatch'][lang] ?? LOCAL['v.noMatch'].en)}`;
  out.className = `hint ${ok ? 'pos' : 'neg'}`;
}

function boot() {
  const sel = $('langSelect');
  sel.innerHTML = LANGS.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
  let saved = null;
  try { saved = localStorage.getItem('locale'); } catch { /* private mode */ }
  setLocale(saved || 'en');
  sel.value = getLocale();
  sel.addEventListener('change', () => { setLocale(sel.value); localise(); });
  $('game').addEventListener('change', buildOpts);
  $('run').addEventListener('click', run);
  $('runChain').addEventListener('click', runChain);
  localise();
  applyAll();

  // Prefill from a link like /verify?seed=..&client=..&nonce=..&game=dice
  const q = new URLSearchParams(location.search);
  if (q.get('seed')) $('serverSeed').value = q.get('seed');
  if (q.get('client')) $('clientSeed').value = q.get('client');
  if (q.get('nonce')) $('nonce').value = q.get('nonce');
  if (q.get('game')) { $('game').value = q.get('game'); buildOpts(); }
}

boot();
