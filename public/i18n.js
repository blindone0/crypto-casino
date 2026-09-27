// Translations. Add a language by adding a third key to each entry and listing it in LANGS.
// Placeholders look like {name} and are filled by t('key', { name: 'x' }).
const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
];

const STRINGS = {
  // ---- chrome
  'nav.games': { en: 'Games', ru: 'Игры' },
  'nav.wallet': { en: 'Wallet', ru: 'Кошелёк' },
  'nav.fair': { en: 'Fairness', ru: 'Честность' },
  'nav.affiliate': { en: 'Referrals', ru: 'Рефералы' },
  'nav.limits': { en: 'Limits', ru: 'Лимиты' },
  'nav.admin': { en: 'Admin', ru: 'Админка' },
  'nav.signin': { en: 'Sign in', ru: 'Вход' },
  'nav.signup': { en: 'Register', ru: 'Регистрация' },
  'nav.signout': { en: 'Sign out', ru: 'Выйти' },
  'nav.balance': { en: 'Balance', ru: 'Баланс' },

  // ---- auth
  'auth.username': { en: 'Username', ru: 'Имя пользователя' },
  'auth.password': { en: 'Password', ru: 'Пароль' },
  'auth.refcode': { en: 'Referral code (optional)', ru: 'Реферальный код (необязательно)' },
  'auth.login': { en: 'Sign in', ru: 'Войти' },
  'auth.register': { en: 'Create account', ru: 'Создать аккаунт' },
  'auth.haveAccount': { en: 'Already registered?', ru: 'Уже есть аккаунт?' },
  'auth.noAccount': { en: 'Need an account?', ru: 'Нужен аккаунт?' },
  'auth.rules': {
    en: '3-20 characters, letters, digits and underscore. Password at least 8 characters.',
    ru: '3-20 символов: буквы, цифры, подчёркивание. Пароль не менее 8 символов.',
  },
  'auth.welcome': { en: 'Signed in as {name}', ru: 'Вы вошли как {name}' },

  // ---- games, shared
  'game.dice': { en: 'Dice', ru: 'Кости' },
  'game.limbo': { en: 'Limbo', ru: 'Лимбо' },
  'game.mines': { en: 'Mines', ru: 'Мины' },
  'game.crash': { en: 'Crash', ru: 'Краш' },
  'bet.amount': { en: 'Bet amount', ru: 'Сумма ставки' },
  'bet.half': { en: '½', ru: '½' },
  'bet.double': { en: '2×', ru: '2×' },
  'bet.max': { en: 'Max', ru: 'Макс' },
  'bet.place': { en: 'Place bet', ru: 'Сделать ставку' },
  'bet.profit': { en: 'Profit on win', ru: 'Прибыль при выигрыше' },
  'bet.multiplier': { en: 'Multiplier', ru: 'Множитель' },
  'bet.chance': { en: 'Win chance', ru: 'Шанс выигрыша' },
  'bet.won': { en: 'Won', ru: 'Выигрыш' },
  'bet.lost': { en: 'Lost', ru: 'Проигрыш' },
  'bet.maxWin': { en: 'Max win per bet', ru: 'Макс. выигрыш за ставку' },
  'bet.edge': { en: 'House edge', ru: 'Преимущество казино' },

  // ---- dice
  'dice.target': { en: 'Roll under', ru: 'Меньше чем' },
  'dice.targetOver': { en: 'Roll over', ru: 'Больше чем' },
  'dice.mode': { en: 'Direction', ru: 'Направление' },
  'dice.under': { en: 'Under', ru: 'Меньше' },
  'dice.over': { en: 'Over', ru: 'Больше' },
  'dice.result': { en: 'Roll', ru: 'Результат' },

  // ---- limbo
  'limbo.target': { en: 'Target multiplier', ru: 'Целевой множитель' },
  'limbo.drawn': { en: 'Drawn', ru: 'Выпало' },

  // ---- mines
  'mines.count': { en: 'Mines', ru: 'Количество мин' },
  'mines.start': { en: 'Start round', ru: 'Начать раунд' },
  'mines.cashout': { en: 'Cash out {amount}', ru: 'Забрать {amount}' },
  'mines.next': { en: 'Next tile pays', ru: 'Следующая плитка' },
  'mines.boom': { en: 'Mine hit. Round over.', ru: 'Мина. Раунд окончен.' },
  'mines.cashedOut': { en: 'Cashed out at {mult}×', ru: 'Забрали на {mult}×' },
  'mines.pickTile': { en: 'Pick a tile', ru: 'Выберите плитку' },

  // ---- crash
  'crash.betting': { en: 'Betting open: {s}s', ru: 'Приём ставок: {s}с' },
  'crash.running': { en: 'In flight', ru: 'В полёте' },
  'crash.busted': { en: 'Busted at {mult}×', ru: 'Краш на {mult}×' },
  'crash.autoCashout': { en: 'Auto cash out at', ru: 'Авто-вывод на' },
  'crash.cashout': { en: 'Cash out', ru: 'Забрать' },
  'crash.joinNext': { en: 'Bet on next round', ru: 'Ставка на след. раунд' },
  'crash.placed': { en: 'Bet placed for round {id}', ru: 'Ставка принята, раунд {id}' },
  'crash.history': { en: 'Recent rounds', ru: 'Последние раунды' },
  'crash.players': { en: 'Players', ru: 'Игроки' },
  'crash.waiting': { en: 'Waiting for the next round', ru: 'Ожидание следующего раунда' },

  // ---- wallet
  'wallet.deposit': { en: 'Deposit', ru: 'Пополнение' },
  'wallet.withdraw': { en: 'Withdraw', ru: 'Вывод' },
  'wallet.history': { en: 'History', ru: 'История' },
  'wallet.yourAddress': { en: 'Your deposit address', ru: 'Ваш адрес для пополнения' },
  'wallet.memo': { en: 'Payment memo (include this)', ru: 'Метка платежа (обязательно укажите)' },
  'wallet.copy': { en: 'Copy', ru: 'Копировать' },
  'wallet.copied': { en: 'Copied', ru: 'Скопировано' },
  'wallet.confirmations': {
    en: 'Credited after {n} confirmations.',
    ru: 'Зачисление после {n} подтверждений.',
  },
  'wallet.minDeposit': { en: 'Minimum deposit', ru: 'Минимальное пополнение' },
  'wallet.noMinimum': { en: 'no minimum', ru: 'без минимума' },
  'wallet.minWithdraw': { en: 'Minimum withdrawal', ru: 'Минимальный вывод' },
  'wallet.fee': { en: 'Network fee', ru: 'Сетевой сбор' },
  'wallet.destination': { en: 'Destination address', ru: 'Адрес получателя' },
  'wallet.requestWithdraw': { en: 'Request withdrawal', ru: 'Запросить вывод' },
  'wallet.youReceive': { en: 'You receive', ru: 'Вы получите' },
  'wallet.simulate': { en: 'Simulate a deposit (test mode)', ru: 'Смоделировать пополнение (тест)' },
  'wallet.mockWarning': {
    en: 'Test wallet: no real coins move. Switch the driver in config.json for real funds.',
    ru: 'Тестовый кошелёк: реальные монеты не двигаются. Смените драйвер в config.json.',
  },
  'wallet.pending': { en: 'Pending', ru: 'В обработке' },
  'wallet.sent': { en: 'Sent', ru: 'Отправлено' },
  'wallet.rejected': { en: 'Rejected', ru: 'Отклонено' },
  'wallet.credited': { en: 'Credited', ru: 'Зачислено' },

  // ---- fairness
  'fair.title': { en: 'Provably fair', ru: 'Доказуемая честность' },
  'fair.explain': {
    en: 'Every outcome comes from HMAC-SHA256 over a server seed you cannot see, a client seed you choose, and a bet counter. The hash of the server seed is published before you bet, so once it is revealed you can recompute every result yourself.',
    ru: 'Каждый результат вычисляется как HMAC-SHA256 от серверного сида, который вы не видите, вашего клиентского сида и счётчика ставок. Хеш серверного сида публикуется до ставки, поэтому после раскрытия вы можете пересчитать любой результат сами.',
  },
  'fair.serverHash': { en: 'Server seed hash (committed)', ru: 'Хеш серверного сида (обязательство)' },
  'fair.clientSeed': { en: 'Your client seed', ru: 'Ваш клиентский сид' },
  'fair.nonce': { en: 'Bets on this seed', ru: 'Ставок на этом сиде' },
  'fair.setSeed': { en: 'Save seed', ru: 'Сохранить сид' },
  'fair.rotate': { en: 'Reveal and rotate seed', ru: 'Раскрыть и сменить сид' },
  'fair.rotateWarn': {
    en: 'Rotating reveals the current server seed so you can audit past bets, and starts a new one.',
    ru: 'Смена раскрывает текущий серверный сид для проверки прошлых ставок и начинает новый.',
  },
  'fair.revealed': { en: 'Revealed seeds', ru: 'Раскрытые сиды' },
  'fair.verifier': { en: 'Open the verifier', ru: 'Открыть верификатор' },
  'fair.crashCommitment': { en: 'Crash chain commitment', ru: 'Обязательство цепочки Краш' },

  // ---- affiliate
  'aff.title': { en: 'Refer players, earn commission', ru: 'Приводите игроков, получайте комиссию' },
  'aff.explain': {
    en: 'You earn {pct}% of the house edge generated by everyone who signs up through your link, for as long as they play.',
    ru: 'Вы получаете {pct}% от преимущества казино со всех, кто зарегистрируется по вашей ссылке, пока они играют.',
  },
  'aff.link': { en: 'Your referral link', ru: 'Ваша реферальная ссылка' },
  'aff.players': { en: 'Players referred', ru: 'Приглашено игроков' },
  'aff.earned': { en: 'Earned all time', ru: 'Заработано всего' },
  'aff.unpaid': { en: 'Available to claim', ru: 'Доступно к выводу' },
  'aff.claim': { en: 'Claim to balance', ru: 'Забрать на баланс' },
  'rake.title': { en: 'Rakeback', ru: 'Рейкбек' },
  'rake.explain': {
    en: 'You get {pct}% of the house edge on your own bets back as claimable credit.',
    ru: 'Вам возвращается {pct}% преимущества казино с ваших ставок в виде кредита.',
  },
  'rake.available': { en: 'Rakeback available', ru: 'Доступный рейкбек' },
  'rake.claim': { en: 'Claim rakeback', ru: 'Забрать рейкбек' },

  // ---- limits
  'limits.title': { en: 'Play limits', ru: 'Игровые лимиты' },
  'limits.maxBet': { en: 'Your maximum bet', ru: 'Ваша макс. ставка' },
  'limits.maxBetHint': {
    en: 'Lowering it applies at once. Raising it takes 24 hours.',
    ru: 'Снижение действует сразу. Повышение вступает в силу через 24 часа.',
  },
  'limits.save': { en: 'Save limit', ru: 'Сохранить лимит' },
  'limits.selfExclude': { en: 'Take a break', ru: 'Сделать перерыв' },
  'limits.days': { en: 'Days', ru: 'Дней' },
  'limits.excludeHint': {
    en: 'Locks your account for the chosen period. This cannot be undone or shortened.',
    ru: 'Блокирует аккаунт на выбранный срок. Отменить или сократить нельзя.',
  },
  'limits.excludeConfirm': {
    en: 'Lock the account for {n} days? This cannot be undone.',
    ru: 'Заблокировать аккаунт на {n} дней? Отменить нельзя.',
  },
  'limits.playedToday': { en: 'Played today', ru: 'Сегодня в игре' },
  'limits.minutes': { en: '{n} min, {bets} bets', ru: '{n} мин, ставок: {bets}' },

  // ---- feed
  'feed.recent': { en: 'Latest bets', ru: 'Последние ставки' },
  'feed.biggest': { en: 'Biggest wins', ru: 'Крупнейшие выигрыши' },
  'feed.mine': { en: 'My bets', ru: 'Мои ставки' },
  'feed.player': { en: 'Player', ru: 'Игрок' },
  'feed.game': { en: 'Game', ru: 'Игра' },
  'feed.bet': { en: 'Bet', ru: 'Ставка' },
  'feed.payout': { en: 'Payout', ru: 'Выплата' },
  'feed.empty': { en: 'Nothing here yet', ru: 'Пока ничего нет' },

  // ---- misc
  'common.close': { en: 'Close', ru: 'Закрыть' },
  'common.save': { en: 'Save', ru: 'Сохранить' },
  'common.cancel': { en: 'Cancel', ru: 'Отмена' },
  'common.loading': { en: 'Loading…', ru: 'Загрузка…' },
  'common.error': { en: 'Error', ru: 'Ошибка' },
  'common.language': { en: 'Language', ru: 'Язык' },
  'err.signin': { en: 'Sign in to play', ru: 'Войдите, чтобы играть' },
  'err.network': { en: 'Network problem, try again', ru: 'Проблема сети, попробуйте снова' },
};

let current = localStorage.getItem('locale') || 'en';

function setLocale(code) {
  current = LANGS.some((l) => l.code === code) ? code : 'en';
  try { localStorage.setItem('locale', current); } catch { /* private mode */ }
  document.documentElement.lang = current;
  applyAll();
}

const getLocale = () => current;

/** Translate a key, filling {placeholders}. Falls back to English, then the key itself. */
function t(key, vars) {
  const entry = STRINGS[key];
  let s = entry ? (entry[current] ?? entry.en) : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

/** Re-render every element carrying a data-i18n attribute. */
function applyAll(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  document.dispatchEvent(new CustomEvent('localechange', { detail: { locale: current } }));
}

export { LANGS, STRINGS, t, setLocale, getLocale, applyAll };
