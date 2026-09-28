// Operator panel. Reachable with the admin token from config.json, or with an
// admin-role session cookie from the casino itself.
import { LANGS, setLocale, getLocale } from './i18n.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const L = {
  'a.overview': { en: 'Overview', ru: 'Обзор' },
  'a.risk': { en: 'Risk', ru: 'Риск' },
  'a.treasury': { en: 'Treasury', ru: 'Казна' },
  'a.withdrawals': { en: 'Withdrawals', ru: 'Выводы' },
  'a.players': { en: 'Players', ru: 'Игроки' },
  'a.affiliates': { en: 'Affiliates', ru: 'Партнёры' },
  'a.token': { en: 'Token', ru: 'Токен' },
  'a.audit': { en: 'Audit log', ru: 'Журнал' },

  // --- the token economy. Earned in tokens, not in casino currency, so it is counted
  // here rather than folded into GGR where it would be adding up two different things.
  'a.tokSupply': { en: 'Supply', ru: 'Эмиссия' },
  'a.tokMinted': { en: 'Minted, ever', ru: 'Создано всего' },
  'a.tokCirculating': { en: 'In circulation', ru: 'В обращении' },
  'a.tokTreasury': { en: 'Left in the treasury', ru: 'Осталось в казне' },
  'a.tokBurned': { en: 'Burned for good', ru: 'Сожжено навсегда' },
  'a.tokHouse': { en: 'Held by the house', ru: 'У заведения' },
  'a.tokBlocks': { en: 'Blocks', ru: 'Блоков' },
  'a.tokVerifies': { en: 'Chain verifies', ru: 'Цепочка проверена' },
  'a.tokWhy': {
    en: 'Read by replaying the chain, not from a stored total. If this says the chain does not verify, treat every other figure on this page as a guess until you know why.',
    ru: 'Читается повторным проигрыванием цепочки, а не из сохранённой суммы. Если цепочка не проверяется, считайте все остальные цифры на этой странице догадкой, пока не выясните причину.',
  },
  'a.yes': { en: 'yes', ru: 'да' },
  'a.no': { en: 'NO', ru: 'НЕТ' },
  'a.nothingYet': { en: 'Nothing yet.', ru: 'Пока ничего.' },
  'a.arcade': { en: 'Arcade', ru: 'Зал автоматов' },
  'a.arcadePlays': { en: 'Plays', ru: 'Игр' },
  'a.arcadeBurned': { en: 'Tokens burned', ru: 'Сожжено токенов' },
  'a.players2': { en: 'Players', ru: 'Игроков' },
  'a.best': { en: 'Best score', ru: 'Рекорд' },
  'a.matches': { en: 'Head to head', ru: 'Игры на двоих' },
  'a.matchPlayed': { en: 'Settled', ru: 'Сыграно' },
  'a.matchWagered': { en: 'Staked', ru: 'Поставлено' },
  'a.matchRake': { en: 'Rake taken', ru: 'Комиссия' },
  'a.bankroll': { en: 'Bankroll', ru: 'Банкролл' },
  'a.liabilities': { en: 'Owed to players', ru: 'Долг игрокам' },
  'a.free': { en: 'Free capital', ru: 'Свободный капитал' },
  'a.maxWin': { en: 'Max win per bet', ru: 'Макс. выигрыш/ставка' },
  'a.wagered': { en: 'Wagered', ru: 'Оборот' },
  'a.ggr': { en: 'Gross revenue', ru: 'Валовой доход' },
  'a.ggrTheo': { en: 'Expected revenue', ru: 'Ожидаемый доход' },
  'a.hold': { en: 'Hold', ru: 'Удержание' },
  'a.bets': { en: 'Bets', ru: 'Ставок' },
  'a.players2': { en: 'Accounts', ru: 'Аккаунтов' },
  'a.active': { en: 'Active today', ru: 'Активны сегодня' },
  'a.today': { en: 'Today', ru: 'Сегодня' },
  'a.week': { en: '7 days', ru: '7 дней' },
  'a.month': { en: '30 days', ru: '30 дней' },
  'a.all': { en: 'All time', ru: 'Всё время' },
  'a.addFunds': { en: 'Add bankroll', ru: 'Пополнить банкролл' },
  'a.takeProfit': { en: 'Take profit out', ru: 'Вывести прибыль' },
  'a.amount': { en: 'Amount', ru: 'Сумма' },
  'a.note': { en: 'Note', ru: 'Примечание' },
  'a.perGame': { en: 'By game', ru: 'По играм' },
  'a.holdGap': {
    en: 'Actual hold below expected means variance or a bug. It converges with volume.',
    ru: 'Фактическое удержание ниже ожидаемого означает дисперсию или ошибку. Сходится с оборотом.',
  },
  'a.booksOk': { en: 'Books balance', ru: 'Книги сходятся' },
  'a.booksBad': { en: 'BOOKS DO NOT BALANCE', ru: 'КНИГИ НЕ СХОДЯТСЯ' },
  'a.treasuryIntro': {
    en: 'Profit leaves the site to a cold wallet you control. Create the wallet in real wallet software (Sparrow, Electrum, Monero GUI), then whitelist its receive address here. Payouts draw only on free capital, so they can never dip into player balances.',
    ru: 'Прибыль уходит с сайта на холодный кошелёк. Создайте кошелёк в реальном приложении (Sparrow, Electrum, Monero GUI), затем добавьте его адрес в белый список. Выплаты берутся только из свободного капитала и не затрагивают балансы игроков.',
  },
  'a.addAddress': { en: 'Whitelist an address', ru: 'Добавить адрес' },
  'a.label': { en: 'Label', ru: 'Название' },
  'a.address': { en: 'Address', ru: 'Адрес' },
  'a.payout': { en: 'Send to treasury', ru: 'Отправить в казну' },
  'a.exposure': { en: 'Hot wallet exposure', ru: 'Риск горячего кошелька' },
  'a.recommendedHot': { en: 'Keep hot at most', ru: 'Держать горячим не более' },
  'a.sweep': { en: 'Suggested sweep', ru: 'Рекомендуемый вывод' },
  'a.paidOut': { en: 'Paid out all time', ru: 'Выведено всего' },
  'a.noAddresses': { en: 'No treasury addresses yet.', ru: 'Адресов казны пока нет.' },
  'a.approve': { en: 'Approve', ru: 'Одобрить' },
  'a.reject': { en: 'Reject', ru: 'Отклонить' },
  'a.markSent': { en: 'Mark sent', ru: 'Отметить отправленным' },
  'a.retry': { en: 'Retry', ru: 'Повторить' },
  'a.cancel': { en: 'Cancel', ru: 'Отменить' },
  'a.txid': { en: 'Transaction id', ru: 'ID транзакции' },
  'a.empty': { en: 'Nothing here', ru: 'Пусто' },
  'a.search': { en: 'Search username', ru: 'Поиск по имени' },
  'a.freeze': { en: 'Freeze', ru: 'Заморозить' },
  'a.unfreeze': { en: 'Unfreeze', ru: 'Разморозить' },
  'a.adjust': { en: 'Adjust balance', ru: 'Изменить баланс' },
  'a.credit': { en: 'Credit', ru: 'Начислить' },
  'a.debit': { en: 'Debit', ru: 'Списать' },
  'a.creditDeposit': { en: 'Credit a deposit', ru: 'Зачислить депозит' },
  'a.userId': { en: 'User id', ru: 'ID пользователя' },
  'a.balance': { en: 'Balance', ru: 'Баланс' },
  'a.houseNet': { en: 'House net', ru: 'Доход казино' },
  'a.state': { en: 'State', ru: 'Статус' },
  'a.when': { en: 'When', ru: 'Когда' },
  'a.action': { en: 'Action', ru: 'Действие' },
  'a.actor': { en: 'Who', ru: 'Кто' },
  'a.sweepFees': { en: 'Sweep fees into bankroll', ru: 'Перевести сборы в банкролл' },
  'a.walletInfo': { en: 'Wallet node', ru: 'Узел кошелька' },
  'a.gateBad': { en: 'Token rejected', ru: 'Токен отклонён' },
};
const tr = (k) => (L[k] ? (L[k][getLocale()] ?? L[k].en) : k);

const UNIT = 1e8;
const fmt = (u, dp = 4) => (Number(u) / UNIT).toFixed(dp);
const pct = (x) => `${(Number(x) * 100).toFixed(3)}%`;
const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '-');

let TOKEN = null;
let CSRF = null;

function toast(msg, kind = '') {
  const n = el('div', { class: `toast ${kind}` }, msg);
  $('toasts').append(n);
  setTimeout(() => n.remove(), 3800);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (TOKEN) headers['x-admin-token'] = TOKEN;
  if (CSRF && method !== 'GET') headers['x-csrf-token'] = CSRF;
  const res = await fetch(path, {
    method, headers, credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const card = (labelKey, value, cls = '') => el('div', { class: 'stat-card' },
  el('div', { class: 'k' }, tr(labelKey)),
  el('div', { class: `v ${cls}` }, value));

const table = (headers, rows) => el('div', { class: 'table-wrap' },
  el('table', { class: 'grid' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows)));

// ---------------------------------------------------------------- overview
async function viewOverview(root) {
  const o = await api('/api/admin/overview');
  const w = o.windows;
  const audit = o.audit.ok
    ? el('span', { class: 'tag ok' }, tr('a.booksOk'))
    : el('span', { class: 'tag bad' }, tr('a.booksBad'));

  const windowCard = (key, s) => el('div', { class: 'panel' },
    el('h3', {}, tr(key)),
    el('div', { class: 'stat-grid' },
      card('a.bets', String(s.bets)),
      card('a.wagered', fmt(s.wagered)),
      card('a.ggr', fmt(s.ggrActual), s.ggrActual >= 0 ? 'pos' : 'neg'),
      card('a.ggrTheo', fmt(s.ggrTheoretical)),
      card('a.hold', pct(s.holdActual), s.holdActual >= 0 ? 'pos' : 'neg')));

  const amt = el('input', { class: 'mono', value: '10', inputmode: 'decimal' });
  const note = el('input', {});

  root.replaceChildren(
    el('div', { class: 'panel' },
      el('div', { class: 'row wrap', style: 'justify-content:space-between;margin-bottom:12px' },
        el('h2', {}, tr('a.overview')), audit),
      el('div', { class: 'stat-grid' },
        card('a.bankroll', fmt(o.bankroll)),
        card('a.liabilities', fmt(o.liabilities)),
        card('a.free', fmt(o.freeCapital), o.freeCapital >= 0 ? 'pos' : 'neg'),
        card('a.maxWin', fmt(o.maxProfitPerBet)),
        card('a.players2', String(o.users)),
        card('a.active', String(o.activeToday)))),

    el('div', { class: 'panel' },
      el('h3', {}, tr('a.bankroll')),
      el('div', { class: 'row wrap' },
        amt, note,
        el('button', {
          class: 'primary',
          onclick: async () => {
            try {
              await api('/api/admin/bankroll', {
                method: 'POST', body: { action: 'add', amount: amt.value, note: note.value },
              });
              toast(tr('a.addFunds')); render();
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, tr('a.addFunds')),
        el('button', {
          onclick: async () => {
            try {
              await api('/api/admin/bankroll', {
                method: 'POST', body: { action: 'remove', amount: amt.value, note: note.value },
              });
              toast(tr('a.takeProfit')); render();
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, tr('a.takeProfit')),
        el('button', {
          class: 'ghost',
          onclick: async () => {
            try {
              const r = await api('/api/admin/fees/sweep', { method: 'POST' });
              toast(`+${fmt(r.swept)}`); render();
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, tr('a.sweepFees'))),
      el('p', { class: 'hint' }, `${tr('a.free')}: ${fmt(o.freeCapital)}`)),

    windowCard('a.today', w.today),
    windowCard('a.month', w.month),
    windowCard('a.all', w.all),

    el('div', { class: 'panel' },
      el('h3', {}, tr('a.perGame')),
      table(['game', tr('a.bets'), tr('a.wagered'), tr('a.ggr'), tr('a.ggrTheo')],
        w.all.perGame.map((g) => el('tr', {},
          el('td', { class: 'name' }, g.game),
          el('td', {}, String(g.bets)),
          el('td', {}, fmt(g.wagered)),
          el('td', { class: g.ggr >= 0 ? 'pos' : 'neg' }, fmt(g.ggr)),
          el('td', {}, fmt(g.theoretical))))),
      el('p', { class: 'hint' }, tr('a.holdGap'))),
  );
}

// -------------------------------------------------------------------- risk
async function viewRisk(root) {
  const r = await api('/api/admin/risk');
  let wallet = null;
  try { wallet = await api('/api/admin/wallet'); } catch { /* node may be down */ }
  root.replaceChildren(
    el('div', { class: 'panel' },
      el('h2', {}, tr('a.risk')),
      el('div', { class: 'stat-grid' },
        card('a.bankroll', fmt(r.bankroll)),
        card('a.liabilities', fmt(r.liabilities)),
        card('a.free', fmt(r.freeCapital), r.freeCapital >= 0 ? 'pos' : 'neg'),
        card('a.maxWin', fmt(r.maxProfitPerBet)))),
    el('div', { class: 'panel' },
      el('div', { class: 'stat-row' },
        el('span', { class: 'k' }, 'Max-size losses the bankroll absorbs'),
        el('span', { class: 'v' }, String(r.maxLossesAbsorbable ?? '-'))),
      el('div', { class: 'stat-row' },
        el('span', { class: 'k' }, 'Biggest single win paid'),
        el('span', { class: 'v' }, fmt(r.biggestWinPaid))),
      el('div', { class: 'stat-row' },
        el('span', { class: 'k' }, 'Worst day revenue'),
        el('span', { class: `v ${r.worstDayGgr < 0 ? 'neg' : ''}` }, fmt(r.worstDayGgr))),
      el('div', { class: 'stat-row' },
        el('span', { class: 'k' }, `${tr('a.hold')} actual / expected`),
        el('span', { class: 'v' }, `${pct(r.holdActual)} / ${pct(r.holdTheoretical)}`)),
      el('p', { class: 'hint' }, tr('a.holdGap'))),
    wallet ? el('div', { class: 'panel' },
      el('h3', {}, tr('a.walletInfo')),
      el('pre', { class: 'mono', style: 'white-space:pre-wrap;color:var(--text-dim)' },
        JSON.stringify(wallet.info ?? wallet.error, null, 2))) : null,
  );
}

// ---------------------------------------------------------------- treasury
async function viewTreasury(root) {
  const tState = await api('/api/admin/treasury');
  const ex = tState.exposure;

  const label = el('input', { placeholder: 'BTC cold' });
  const address = el('input', { class: 'mono' });
  const payAmount = el('input', { class: 'mono', value: fmt(tState.minPayout), inputmode: 'decimal' });
  const paySelect = el('select', {}, ...tState.addresses.map((a) =>
    el('option', { value: a.label }, `${a.label} (${a.address.slice(0, 14)}…)`)));

  root.replaceChildren(
    el('div', { class: 'panel' },
      el('h2', {}, tr('a.treasury')),
      el('p', { class: 'hint' }, tr('a.treasuryIntro')),
      el('div', { class: 'stat-grid' },
        card('a.free', fmt(ex.freeCapital), ex.freeCapital >= 0 ? 'pos' : 'neg'),
        card('a.recommendedHot', fmt(ex.recommendedHotMax)),
        card('a.sweep', fmt(ex.sweepSuggestion)),
        card('a.paidOut', fmt(tState.totalPaidOut)))),

    el('div', { class: 'panel' },
      el('h3', {}, tr('a.addAddress')),
      el('div', { class: 'row wrap' },
        label, address,
        el('button', {
          class: 'primary',
          onclick: async () => {
            try {
              await api('/api/admin/treasury/addresses', {
                method: 'POST',
                body: { label: label.value, address: address.value, driver: tState.activeDriver },
              });
              toast(tr('a.addAddress')); render();
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, tr('a.addAddress'))),
      tState.addresses.length
        ? table([tr('a.label'), tr('a.address'), ''], tState.addresses.map((a) => el('tr', {},
          el('td', { class: 'name' }, a.label,
            a.valid ? el('span', { class: 'tag ok', style: 'margin-left:6px' }, a.kind || 'ok')
              : el('span', { class: 'tag bad', style: 'margin-left:6px' }, a.problem)),
          el('td', {}, a.address),
          el('td', {}, el('button', {
            class: 'tiny danger',
            onclick: async () => {
              try {
                await api('/api/admin/treasury/addresses/remove', {
                  method: 'POST', body: { address: a.address },
                });
                render();
              } catch (e) { toast(e.message, 'bad'); }
            },
          }, '✕')))))
        : el('p', { class: 'hint' }, tr('a.noAddresses'))),

    tState.addresses.length ? el('div', { class: 'panel' },
      el('h3', {}, tr('a.payout')),
      el('div', { class: 'row wrap' },
        paySelect, payAmount,
        el('button', {
          class: 'primary',
          onclick: async () => {
            try {
              const r = await api('/api/admin/treasury/payout', {
                method: 'POST', body: { label: paySelect.value, amount: payAmount.value },
              });
              toast(r.state === 'sent' ? `sent ${r.txid.slice(0, 16)}…` : r.note || r.state);
              render();
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, tr('a.payout'))),
      el('p', { class: 'hint' }, `min ${fmt(tState.minPayout)}`)) : null,

    tState.history.length ? el('div', { class: 'panel' },
      el('h3', {}, tr('a.paidOut')),
      table([tr('a.label'), tr('a.amount'), tr('a.state'), 'txid', ''],
        tState.history.map((p) => el('tr', {},
          el('td', { class: 'name' }, p.label),
          el('td', {}, fmt(p.amount_units)),
          el('td', { class: 'name' }, p.state),
          el('td', {}, p.txid ? `${p.txid.slice(0, 16)}…` : '-'),
          el('td', {}, p.state === 'reserved' ? el('div', { class: 'row' },
            el('button', {
              class: 'tiny',
              onclick: async () => {
                const txid = prompt(tr('a.txid'));
                if (!txid) return;
                try {
                  await api(`/api/admin/treasury/payout/${p.id}/mark-sent`, { method: 'POST', body: { txid } });
                  render();
                } catch (e) { toast(e.message, 'bad'); }
              },
            }, tr('a.markSent')),
            el('button', {
              class: 'tiny danger',
              onclick: async () => {
                try {
                  await api(`/api/admin/treasury/payout/${p.id}/cancel`, { method: 'POST' });
                  render();
                } catch (e) { toast(e.message, 'bad'); }
              },
            }, tr('a.cancel'))) : null))))) : null,
  );
}

// ------------------------------------------------------------- withdrawals
async function viewWithdrawals(root) {
  const { withdrawals } = await api('/api/admin/withdrawals');
  const act = async (id, path, body) => {
    try { await api(`/api/admin/withdrawals/${id}/${path}`, { method: 'POST', body }); render(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  root.replaceChildren(el('div', { class: 'panel' },
    el('h2', {}, tr('a.withdrawals')),
    withdrawals.length
      ? table(['#', 'player', tr('a.amount'), tr('a.address'), tr('a.state'), tr('a.when'), ''],
        withdrawals.map((w) => el('tr', {},
          el('td', {}, String(w.id)),
          el('td', { class: 'name' }, w.username),
          el('td', {}, fmt(w.amount_units)),
          el('td', {}, `${w.address.slice(0, 18)}…`),
          el('td', { class: 'name' },
            el('span', {
              class: `tag ${w.state === 'sent' ? 'ok' : (w.state === 'failed' ? 'bad' : 'warn')}`,
            }, w.state)),
          el('td', { class: 'faint' }, when(w.requested_at)),
          el('td', {}, el('div', { class: 'row' },
            w.state === 'pending' ? el('button', {
              class: 'tiny primary', onclick: () => act(w.id, 'decide', { approve: true }),
            }, tr('a.approve')) : null,
            w.state === 'pending' ? el('button', {
              class: 'tiny danger', onclick: () => act(w.id, 'decide', { approve: false }),
            }, tr('a.reject')) : null,
            w.state === 'failed' ? el('button', {
              class: 'tiny', onclick: () => act(w.id, 'retry'),
            }, tr('a.retry')) : null,
            (w.state === 'approved' || w.state === 'failed') ? el('button', {
              class: 'tiny',
              onclick: () => {
                const txid = prompt(tr('a.txid'));
                if (txid) act(w.id, 'mark-sent', { txid });
              },
            }, tr('a.markSent')) : null)))))
      : el('p', { class: 'hint' }, tr('a.empty'))));
}

// ----------------------------------------------------------------- players
async function viewPlayers(root) {
  const q = el('input', { placeholder: tr('a.search') });
  const list = el('div');
  const load = async () => {
    const { users, total } = await api(`/api/admin/users?q=${encodeURIComponent(q.value)}`);
    list.replaceChildren(
      el('p', { class: 'hint' }, `${total} ${tr('a.players2').toLowerCase()}`),
      table(['#', 'name', tr('a.balance'), tr('a.wagered'), tr('a.bets'), tr('a.houseNet'), ''],
        users.map((u) => el('tr', {},
          el('td', {}, String(u.id)),
          el('td', { class: 'name' }, u.username,
            u.frozen ? el('span', { class: 'tag bad', style: 'margin-left:6px' }, 'frozen') : null,
            u.role === 'admin' ? el('span', { class: 'tag', style: 'margin-left:6px' }, 'admin') : null),
          el('td', {}, fmt(u.balance)),
          el('td', {}, fmt(u.wagered)),
          el('td', {}, String(u.bets)),
          el('td', { class: u.house_net >= 0 ? 'pos' : 'neg' }, fmt(u.house_net)),
          el('td', {}, el('div', { class: 'row' },
            el('button', {
              class: 'tiny',
              onclick: async () => {
                const raw = prompt(`${tr('a.adjust')} (+/-)`, '1');
                if (!raw) return;
                const negative = raw.trim().startsWith('-');
                try {
                  await api(`/api/admin/users/${u.id}/adjust`, {
                    method: 'POST',
                    body: {
                      amount: raw.replace('-', '').replace('+', ''),
                      direction: negative ? 'debit' : 'credit',
                      note: 'admin panel',
                    },
                  });
                  load();
                } catch (e) { toast(e.message, 'bad'); }
              },
            }, tr('a.adjust')),
            el('button', {
              class: `tiny ${u.frozen ? '' : 'danger'}`,
              onclick: async () => {
                try {
                  await api(`/api/admin/users/${u.id}/freeze`, {
                    method: 'POST', body: { frozen: !u.frozen },
                  });
                  load();
                } catch (e) { toast(e.message, 'bad'); }
              },
            }, u.frozen ? tr('a.unfreeze') : tr('a.freeze'))))))));
  };
  q.addEventListener('input', () => { clearTimeout(q._t); q._t = setTimeout(load, 250); });

  const dUser = el('input', { type: 'number', min: '1', placeholder: '1' });
  const dAmt = el('input', { class: 'mono', placeholder: '0.5' });
  const dTx = el('input', { class: 'mono', placeholder: 'txid' });

  root.replaceChildren(
    el('div', { class: 'panel' }, el('h2', {}, tr('a.players')), q, list),
    el('div', { class: 'panel' },
      el('h3', {}, tr('a.creditDeposit')),
      el('div', { class: 'row wrap' }, dUser, dAmt, dTx,
        el('button', {
          class: 'primary',
          onclick: async () => {
            try {
              const r = await api('/api/admin/deposits/credit', {
                method: 'POST',
                body: { userId: Number(dUser.value), amount: dAmt.value, txid: dTx.value },
              });
              toast(`+${fmt(r.credited)}`);
              load();
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, tr('a.credit'))),
      el('p', { class: 'hint' },
        'Use this with the manual wallet driver: check the transaction in your own wallet, then credit it here.')),
  );
  await load();
}

// -------------------------------------------------------------- affiliates
async function viewAffiliates(root) {
  const { affiliates } = await api('/api/admin/affiliates');
  root.replaceChildren(el('div', { class: 'panel' },
    el('h2', {}, tr('a.affiliates')),
    affiliates.length
      ? table(['#', 'name', 'code', 'players', 'earned', 'unpaid'],
        affiliates.map((a) => el('tr', {},
          el('td', {}, String(a.id)),
          el('td', { class: 'name' }, a.username),
          el('td', {}, a.referral_code),
          el('td', {}, String(a.players)),
          el('td', {}, fmt(a.earned)),
          el('td', {}, fmt(a.unpaid)))))
      : el('p', { class: 'hint' }, tr('a.empty'))));
}

// ------------------------------------------------------------------- audit
async function viewAudit(root) {
  const { entries } = await api('/api/admin/audit?limit=200');
  root.replaceChildren(el('div', { class: 'panel' },
    el('h2', {}, tr('a.audit')),
    table([tr('a.when'), tr('a.actor'), tr('a.action'), 'detail'],
      entries.map((e) => el('tr', {},
        el('td', { class: 'faint' }, when(e.created_at)),
        el('td', { class: 'name' }, e.actor),
        el('td', { class: 'name' }, e.action),
        el('td', { class: 'faint' }, (e.detail || '').slice(0, 90)))))));
}

// -------------------------------------------------------------------- shell

// ------------------------------------------------------------------- token
/**
 * What the token economy is actually doing.
 *
 * Two revenue lines live here and neither is a bet against the bankroll, so neither
 * appears in the overview: tokens burned to play an arcade cabinet, and the rake taken
 * from matches played between two people. Both are earned in tokens rather than in the
 * casino currency, which is why they are counted separately and not folded into GGR.
 */
async function viewToken(root) {
  const [supply, arcade, matches] = await Promise.all([
    api('/api/admin/token'),
    api('/api/admin/arcade'),
    api('/api/admin/matches'),
  ]);

  const stat = (label, value, cls) => el('div', { class: 'stat-row' },
    el('span', { class: 'k' }, label),
    el('span', { class: `v ${cls || ''}` }, value));

  const n = (v) => Number(v || 0).toLocaleString();

  root.replaceChildren(
    el('div', { class: 'panel' },
      el('h3', {}, tr('a.tokSupply')),
      stat(tr('a.tokMinted'), n(supply.minted)),
      stat(tr('a.tokCirculating'), n(supply.circulating)),
      stat(tr('a.tokTreasury'), n(supply.treasury)),
      stat(tr('a.tokBurned'), n(supply.burned), 'neg'),
      stat(tr('a.tokHouse'), n(supply.house), 'pos'),
      stat(tr('a.tokBlocks'), n(supply.blocks)),
      stat(tr('a.tokVerifies'), supply.verifies ? tr('a.yes') : tr('a.no'),
        supply.verifies ? 'pos' : 'neg'),
      el('p', { class: 'hint' }, tr('a.tokWhy'))),

    el('div', { class: 'panel' },
      el('h3', {}, tr('a.arcade')),
      stat(tr('a.arcadePlays'), n(arcade.totalPlays)),
      stat(tr('a.arcadeBurned'), n(arcade.tokensBurned), 'pos'),
      arcade.perGame.length
        ? table(['game', tr('a.arcadePlays'), tr('a.players'), tr('a.arcadeBurned'), tr('a.best')],
          arcade.perGame.map((g) => el('tr', {},
            el('td', { class: 'name' }, g.game),
            el('td', {}, n(g.plays)),
            el('td', {}, n(g.players)),
            el('td', {}, n(g.tokens)),
            el('td', {}, n(g.best)))))
        : el('p', { class: 'hint' }, tr('a.nothingYet'))),

    el('div', { class: 'panel' },
      el('h3', {}, tr('a.matches')),
      stat(tr('a.matchPlayed'), n(matches.played)),
      stat(tr('a.matchWagered'), n(matches.wagered)),
      stat(tr('a.matchRake'), n(matches.rake), 'pos'),
      matches.perGame.length
        ? table(['game', tr('a.matchPlayed'), tr('a.matchWagered'), tr('a.matchRake')],
          matches.perGame.map((g) => el('tr', {},
            el('td', { class: 'name' }, g.game),
            el('td', {}, n(g.played)),
            el('td', {}, n(g.wagered)),
            el('td', { class: 'pos' }, n(g.rake)))))
        : el('p', { class: 'hint' }, tr('a.nothingYet'))),
  );
}

const TABS = [
  { key: 'a.overview', view: viewOverview },
  { key: 'a.risk', view: viewRisk },
  { key: 'a.treasury', view: viewTreasury },
  { key: 'a.withdrawals', view: viewWithdrawals },
  { key: 'a.players', view: viewPlayers },
  { key: 'a.affiliates', view: viewAffiliates },
  { key: 'a.token', view: viewToken },
  { key: 'a.audit', view: viewAudit },
];
let activeTab = 0;

async function render() {
  const tabs = $('tabs');
  tabs.replaceChildren(...TABS.map((tab, i) => el('button', {
    class: i === activeTab ? 'on' : '',
    onclick: () => { activeTab = i; render(); },
  }, tr(tab.key))));
  const view = $('view');
  view.replaceChildren(el('p', { class: 'hint' }, '…'));
  try {
    await TABS[activeTab].view(view);
  } catch (e) {
    view.replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'hint neg' }, e.message)));
  }
}

async function unlock(token) {
  TOKEN = token || null;
  try {
    await api('/api/admin/overview');
    if (token) { try { sessionStorage.setItem('adminToken', token); } catch { /* ignore */ } }
    $('gate').hidden = true;
    $('app').hidden = false;
    render();
    return true;
  } catch (e) {
    TOKEN = null;
    return e.message;
  }
}

async function boot() {
  const sel = $('langSelect');
  sel.replaceChildren(...LANGS.map((l) => el('option', { value: l.code }, l.label)));
  let saved = null;
  try { saved = localStorage.getItem('locale'); } catch { /* ignore */ }
  setLocale(saved || 'en');
  sel.value = getLocale();
  sel.addEventListener('change', () => { setLocale(sel.value); render(); });

  // An admin-role session cookie works without a token; pick up its CSRF if present.
  try {
    const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null));
    if (me?.csrf) CSRF = me.csrf;
  } catch { /* not signed in */ }

  let stored = null;
  try { stored = sessionStorage.getItem('adminToken'); } catch { /* ignore */ }
  if (await unlock(stored) === true) return;
  if (CSRF && await unlock(null) === true) return;

  $('gateGo').onclick = async () => {
    const r = await unlock($('token').value.trim());
    if (r !== true) $('gateErr').textContent = r || tr('a.gateBad');
  };
  $('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gateGo').click(); });
}

boot();
