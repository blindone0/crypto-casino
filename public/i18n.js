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

  // ---- slots
  'game.slots': { en: 'Slots', ru: 'Слоты' },
  'slots.spin': { en: 'Spin', ru: 'Крутить' },
  'slots.paytable': { en: 'Paytable', ru: 'Таблица выплат' },
  'slots.lines': { en: 'Paylines', ru: 'Линий' },
  'slots.rtp': { en: 'Return to player', ru: 'Возврат игроку' },
  'slots.freeSpins': { en: '{n} free spins!', ru: '{n} фриспинов!' },
  'slots.freeSpinRun': { en: 'Free spin {i} of {n}', ru: 'Фриспин {i} из {n}' },
  'slots.scatterPays': { en: 'Scatter pays (x total bet)', ru: 'Скаттер (x общей ставки)' },
  'slots.ofAKind': { en: '3 / 4 / 5 of a kind', ru: '3 / 4 / 5 подряд' },
  'slots.perLineBet': { en: 'Payouts are multiples of the line bet', ru: 'Выплаты кратны ставке на линию' },
  'slots.bigWin': { en: 'Big win! {mult}x', ru: 'Крупный выигрыш! {mult}x' },
  'slots.bigWinLabel': { en: 'Big win', ru: 'Крупный выигрыш' },
  'slots.returned': { en: 'returned', ru: 'возврат' },
  'slots.theme': { en: 'Machine', ru: 'Автомат' },
  'slots.theme.classic': { en: 'Golden Vault', ru: 'Золотой сейф' },
  'slots.theme.afterdark': { en: 'After Dark', ru: 'После полуночи' },
  'slots.theme.russian': { en: 'Golden Ring', ru: 'Золотое кольцо' },
  'slots.theme.noir': { en: 'Knife and Smoke', ru: 'Нож и дым' },
  'slots.theme.couch': { en: 'The Couch', ru: 'Кушетка' },

  // ---- puzzle
  'game.puzzle': { en: 'Puzzle', ru: 'Пазл' },
  'puzzle.difficulty': { en: 'Difficulty', ru: 'Сложность' },
  'puzzle.easy': { en: 'Easy', ru: 'Лёгкий' },
  'puzzle.medium': { en: 'Medium', ru: 'Средний' },
  'puzzle.hard': { en: 'Hard', ru: 'Сложный' },
  'puzzle.expert': { en: 'Expert', ru: 'Эксперт' },
  'puzzle.start': { en: 'Start puzzle', ru: 'Начать пазл' },
  'puzzle.cashout': { en: 'Collect {amount}', ru: 'Забрать {amount}' },
  'puzzle.next': { en: 'Next piece pays', ru: 'Следующий фрагмент' },
  'puzzle.broken': { en: 'Broken pieces', ru: 'Битых фрагментов' },
  'puzzle.pieces': { en: 'Pieces to complete', ru: 'Фрагментов до конца' },
  'puzzle.complete': { en: 'Completed! {mult}x', ru: 'Собран! {mult}x' },
  'puzzle.cracked': { en: 'Broken piece. Round over.', ru: 'Битый фрагмент. Раунд окончен.' },
  'puzzle.pick': { en: 'Uncover a piece', ru: 'Откройте фрагмент' },
  'puzzle.ladder': { en: 'Payout ladder', ru: 'Лестница выплат' },
  'puzzle.sameEdge': {
    en: 'Every difficulty carries the same house edge. Harder grids buy variance, not worse odds.',
    ru: 'У всех уровней одинаковое преимущество казино. Сложность меняет разброс, а не шансы.',
  },
  'puzzle.topPrize': { en: 'Complete the picture', ru: 'Собрать всю картину' },

  // ---- debertz
  'game.debertz': { en: 'Debertz', ru: 'Деберц' },
  'deb.deal': { en: 'Deal', ru: 'Раздать' },
  'deb.newHand': { en: 'New hand', ru: 'Новая раздача' },
  'deb.upcard': { en: 'Turned up', ru: 'Открытая карта' },
  'deb.pickTrump': { en: 'Name trumps', ru: 'Назовите козырь' },
  'deb.trump': { en: 'Trumps', ru: 'Козырь' },
  'deb.you': { en: 'You', ru: 'Вы' },
  'deb.opponent': { en: 'Opponent', ru: 'Соперник' },
  'deb.yourTurn': { en: 'Your turn', ru: 'Ваш ход' },
  'deb.waiting': { en: 'Opponent playing…', ru: 'Ходит соперник…' },
  'deb.trick': { en: 'Trick {n} of 9', ru: 'Взятка {n} из 9' },
  'deb.points': { en: 'Points', ru: 'Очки' },
  'deb.meld': { en: 'Your run', ru: 'Ваша последовательность' },
  'deb.bella': { en: 'Bella (K+Q of trumps)', ru: 'Белла (К+Д козыря)' },
  'deb.won': { en: 'Won by {margin} — {mult}x', ru: 'Выигрыш на {margin} — {mult}x' },
  'deb.push': { en: 'Won narrowly — stake returned', ru: 'Выигрыш впритык — ставка возвращена' },
  'deb.bete': { en: 'Bete! You named trumps and fell short.', ru: 'Бете! Вы назвали козырь и не добрали.' },
  'deb.payouts': { en: 'Payout by margin', ru: 'Выплата по разнице' },
  'deb.margin': { en: 'Margin', ru: 'Разница' },
  'deb.rules': {
    en: 'You name trumps, so you must finish ahead. In trumps the Jack is highest and the Nine second; elsewhere the Ace leads. Follow suit, trump if you cannot, and overtrump if the trick is already trumped.',
    ru: 'Вы называете козырь, поэтому обязаны выйти вперёд. В козырях старший — валет, затем девятка; в остальных мастях старший — туз. Ходите в масть, иначе козыряйте, а если взятка уже бита — перебивайте.',
  },
  'deb.beteWarn': {
    en: 'Fall short of the opponent and you lose everything, not just the difference.',
    ru: 'Не обгоните соперника — потеряете всё, а не только разницу.',
  },
  'deb.skillNote': {
    en: 'Payouts are calibrated against the bot, so playing better than it improves your return.',
    ru: 'Выплаты рассчитаны по игре бота, поэтому играя лучше него, вы повышаете свой возврат.',
  },

  // ---- preferans
  'game.preferans': { en: 'Preferans', ru: 'Преферанс' },
  'pref.deal': { en: 'Deal', ru: 'Раздать' },
  'pref.pickTrump': { en: 'Choose trump', ru: 'Выберите козырь' },
  'pref.noTrump': { en: 'No trump', ru: 'Без козыря' },
  'pref.talon': { en: 'Talon', ru: 'Прикуп' },
  'pref.discardTwo': { en: 'Discard two cards', ru: 'Сбросьте две карты' },
  'pref.confirmDiscard': { en: 'Discard selected', ru: 'Сбросить выбранные' },
  'pref.yourTurn': { en: 'Your turn', ru: 'Ваш ход' },
  'pref.waiting': { en: 'Opponents playing…', ru: 'Ходят соперники…' },
  'pref.tricks': { en: 'Tricks', ru: 'Взятки' },
  'pref.you': { en: 'You', ru: 'Вы' },
  'pref.opponents': { en: 'Opponents', ru: 'Соперники' },
  'pref.trick': { en: 'Trick {n} of 10', ru: 'Взятка {n} из 10' },
  'pref.result': {
    en: 'You took {n} tricks: {outcome}',
    ru: 'Вы взяли {n} взяток: {outcome}',
  },
  'pref.won': { en: 'paid {mult}x', ru: 'выплата {mult}x' },
  'pref.push': { en: 'stake returned', ru: 'ставка возвращена' },
  'pref.lostHand': { en: 'stake lost', ru: 'ставка проиграна' },
  'pref.rules': {
    en: 'You declare and play alone against two bots. Follow suit if you can; if you cannot you must trump. Take six tricks to get your stake back, seven or more to profit.',
    ru: 'Вы играете один против двух ботов. Ходить надо в масть; если её нет, обязаны козырять. Шесть взяток возвращают ставку, семь и больше приносят прибыль.',
  },
  'pref.payTable': { en: 'Tricks and payouts', ru: 'Взятки и выплаты' },
  'pref.skillNote': {
    en: 'Skill matters here: the payouts are calibrated against the bot, so playing better than it improves your return.',
    ru: 'Здесь важно умение: выплаты рассчитаны по игре бота, поэтому играя лучше него, вы повышаете свой возврат.',
  },
  'pref.newHand': { en: 'New hand', ru: 'Новая раздача' },

  // ---- arcade
  'game.arcade': { en: 'Arcade', ru: 'Аркада' },
  'arc.title': { en: 'The arcade', ru: 'Зал автоматов' },
  'arc.intro': {
    en: 'A token-operated game room. Plays cost tokens and pay nothing back: the games run in your browser, so a score could be edited and can never be worth money. The leaderboard is the prize.',
    ru: 'Зал игровых автоматов на жетонах. Игра стоит токены и ничего не приносит: игры работают в вашем браузере, счёт можно подделать, поэтому на него нельзя ставить деньги. Приз — таблица рекордов.',
  },
  'arc.insert': { en: 'Insert token ({n} {sym})', ru: 'Бросить жетон ({n} {sym})' },
  'arc.balance': { en: 'Tokens', ru: 'Жетоны' },
  'arc.cost': { en: 'A play costs', ru: 'Игра стоит' },
  'arc.noPayout': {
    en: 'Cabinets pay nothing. The token is the price of admission and the score is the prize.',
    ru: 'Автоматы ничего не выплачивают. Жетон — это плата за вход, а приз — место в таблице.',
  },
  'arc.best': { en: 'Your best', ru: 'Ваш рекорд' },
  'arc.plays': { en: 'Plays', ru: 'Игр' },
  'arc.top': { en: 'High scores', ru: 'Рекорды' },
  'arc.noScores': { en: 'No scores yet. Be first.', ru: 'Рекордов пока нет. Будьте первым.' },
  'arc.gameOver': { en: 'Game over — {n}', ru: 'Игра окончена — {n}' },
  'arc.newBest': { en: 'New personal best!', ru: 'Новый личный рекорд!' },
  'arc.again': { en: 'Play again', ru: 'Ещё раз' },
  'arc.back': { en: 'Back to the floor', ru: 'Назад в зал' },
  'arc.needTokens': {
    en: 'You need tokens to play. Open the token wallet to create a wallet and claim your grant.',
    ru: 'Нужны токены. Откройте токен-кошелёк, создайте его и получите стартовые токены.',
  },
  'arc.needUnlock': {
    en: 'Unlock your token wallet first: inserting a token is signed by your key, not by us.',
    ru: 'Сначала разблокируйте токен-кошелёк: жетон подписывается вашим ключом, а не нами.',
  },
  'arc.soon': { en: 'Cabinet under construction', ru: 'Автомат в разработке' },
  'arc.ballsLeft': { en: 'Balls left', ru: 'Осталось шаров' },

  // ---- site token
  // ---- matches
  'game.match': { en: 'Matches', ru: 'Матчи' },
  'match.title': { en: 'Head to head', ru: 'Игра на двоих' },
  'match.intro': {
    en: 'Play another player for tokens. The board is held by the server and every move is checked against the rules, so nothing here depends on trusting the other side. Both stakes go into escrow on the chain and the winner is paid from it.',
    ru: 'Игра с другим игроком на токены. Доска хранится на сервере, каждый ход проверяется по правилам, поэтому доверять сопернику не требуется. Обе ставки уходят в эскроу на цепочке, оттуда же выплачивается выигрыш.',
  },
  'match.game': { en: 'Game', ru: 'Игра' },
  'match.g.chess': { en: 'Chess', ru: 'Шахматы' },
  'match.g.seabattle': { en: 'Sea Battle', ru: 'Морской бой' },
  'match.g.balda': { en: 'Balda', ru: 'Балда' },
  'match.g.durak': { en: 'Durak', ru: 'Дурак переводной' },
  'match.why.fool': { en: 'the fool was found', ru: 'дурак найден' },
  'match.why.no-fool': { en: 'nobody was left holding cards', ru: 'никто не остался с картами' },
  'durak.attack': { en: 'led', ru: 'ходит' },
  'durak.defend': { en: 'beat it', ru: 'отбил' },
  'durak.pass-on': { en: 'passed it on', ru: 'перевёл' },
  'durak.take': { en: 'took it', ru: 'взял' },
  'durak.done': { en: 'done', ru: 'бито' },
  'match.passed': { en: 'passed', ru: 'пропустил' },
  'match.why.higher-score': { en: 'on points', ru: 'по очкам' },
  'match.why.tied': { en: 'level on points', ru: 'поровну очков' },
  'match.shot.hit': { en: 'hit', ru: 'ранил' },
  'match.shot.sunk': { en: 'sunk', ru: 'убил' },
  'match.shot.miss': { en: 'miss', ru: 'мимо' },
  'match.shot.fleet': { en: 'fleet placed', ru: 'флот расставлен' },
  'match.why.fleet-sunk': { en: 'fleet sunk', ru: 'флот потоплен' },
  'match.why.no-setup': { en: 'never set up', ru: 'не расставил флот' },
  'match.why.abandoned': { en: 'abandoned by both', ru: 'брошена обоими' },
  'match.why.result': { en: 'result', ru: 'результат' },
  'match.stake': { en: 'Stake', ru: 'Ставка' },
  'match.players': { en: 'Players', ru: 'Игроков' },
  'err.amount': { en: 'That is not an amount.', ru: 'Это не сумма.' },
  'match.nPlayers': { en: '{n} players', ru: '{n} игрока' },
  'match.seated': { en: 'Seated. Waiting for {n} of {of}.', ru: 'Вы за столом. Ждём: {n} из {of}.' },
  'match.rake': { en: 'House cut', ru: 'Комиссия' },
  'match.youWin': { en: 'Winner takes', ru: 'Победитель получает' },
  'match.challenge': { en: 'Post a challenge', ru: 'Бросить вызов' },
  'match.yours': { en: 'Your games', ru: 'Ваши игры' },
  'match.openTable': { en: 'Open challenges', ru: 'Открытые вызовы' },
  'match.noneOpen': { en: 'Nobody is waiting. Post a challenge and be first.', ru: 'Никто не ждёт. Бросьте вызов первым.' },
  'match.accept': { en: 'Accept', ru: 'Принять' },
  'match.cancel': { en: 'Withdraw', ru: 'Отозвать' },
  'match.resume': { en: 'Resume', ru: 'Продолжить' },
  'match.status': { en: 'Status', ru: 'Статус' },
  'match.waiting': { en: 'Waiting for an opponent', ru: 'Ждём соперника' },
  'match.cancelled': { en: 'Withdrawn', ru: 'Отозван' },
  'match.yourMove': { en: 'Your move', ru: 'Ваш ход' },
  'match.theirMove': { en: 'Their move', ru: 'Ход соперника' },
  'match.won': { en: 'You won', ru: 'Вы выиграли' },
  'match.lost': { en: 'You lost', ru: 'Вы проиграли' },
  'match.draw': { en: 'Drawn', ru: 'Ничья' },
  'match.why.checkmate': { en: 'checkmate', ru: 'мат' },
  'match.why.stalemate': { en: 'stalemate', ru: 'пат' },
  'match.why.resignation': { en: 'resignation', ru: 'сдался' },
  'match.why.timeout': { en: 'on time', ru: 'по времени' },
  'match.why.threefold': { en: 'threefold repetition', ru: 'троекратное повторение' },
  'match.why.fifty-move': { en: 'fifty-move rule', ru: 'правило 50 ходов' },
  'match.why.insufficient-material': { en: 'not enough material', ru: 'не хватает фигур' },
  'match.resign': { en: 'Resign', ru: 'Сдаться' },
  'match.resignSure': {
    en: 'Resigning hands the pot to your opponent. There is no taking it back.',
    ru: 'Сдача отдаёт банк сопернику. Отменить это нельзя.',
  },
  'match.claimTime': { en: 'Claim on time', ru: 'Выиграть по времени' },
  'match.backToLobby': { en: 'Back to the lobby', ru: 'Назад в лобби' },
  'match.shortOfTokens': { en: 'Not enough tokens for that stake.', ru: 'Не хватает токенов на такую ставку.' },

  // ---- radio
  'radio.title': { en: 'Noir radio', ru: 'Нуар-радио' },
  'radio.nowPlaying': { en: 'Now playing', ru: 'Сейчас играет' },
  'radio.silent': { en: 'Off the air', ru: 'Не в эфире' },
  'radio.sound': { en: 'Sound', ru: 'Звук' },
  'radio.music': { en: 'Music', ru: 'Музыка' },
  'radio.vinyl': { en: 'Hiss', ru: 'Шум' },
  'radio.stations': { en: 'Stations', ru: 'Станции' },
  'radio.about': {
    en: 'Every piece is played live in your browser from oscillators and filtered noise. There are no audio files to download and nothing is streamed from anywhere.',
    ru: 'Каждая вещь играется вживую в вашем браузере из осцилляторов и фильтрованного шума. Никаких аудиофайлов и никаких внешних потоков.',
  },

  'tok.coin': { en: 'Tugrik', ru: 'Тугрик' },
  'tok.wallet': { en: 'Tugriks', ru: 'Тугрики' },
  'tok.lostLink': { en: 'Lost your phrase?', ru: 'Потеряли фразу?' },
  'tok.lostTitle': { en: 'Start a new wallet', ru: 'Завести новый кошелёк' },
  'tok.lostWhat': {
    en: 'The wallet on this account holds {n}. Without the phrase nobody can sign for it, including us, so those tugriks stay on the chain and can never be spent again.',
    ru: 'На кошельке этого аккаунта {n}. Без фразы за него никто не может подписать, включая нас, поэтому эти тугрики останутся в цепочке и никогда больше не будут потрачены.',
  },
  'tok.lostWarn': {
    en: 'A new wallet starts empty. The welcome grant is paid once per account and has already been paid, so there is no second one. Write the new phrase down.',
    ru: 'Новый кошелёк начинается с нуля. Стартовые токены выдаются раз на аккаунт и уже выданы, второй раз их не будет. Запишите новую фразу.',
  },
  'tok.lostGo': { en: 'I understand, start a new wallet', ru: 'Понимаю, завести новый' },
  'tok.noHouse': {
    en: 'The token wallet is not ready yet. Try again in a moment.',
    ru: 'Токен-кошелёк ещё не готов. Попробуйте через мгновение.',
  },
  'tok.betHint': {
    en: 'Staking tugriks signs a transfer with your key. The operator cannot place a bet for you.',
    ru: 'Ставка в тугриках подписывается вашим ключом. Оператор не может сделать ставку за вас.',
  },
  'tok.coins': { en: 'tugriks', ru: 'тугриков' },
  'tok.title': { en: 'Token wallet', ru: 'Токен-кошелёк' },
  'tok.nav': { en: 'Token', ru: 'Токен' },
  'tok.balance': { en: 'Token balance', ru: 'Баланс токенов' },
  'tok.create': { en: 'Create a wallet', ru: 'Создать кошелёк' },
  'tok.restore': { en: 'Restore from phrase', ru: 'Восстановить по фразе' },
  'tok.phrase': { en: 'Your recovery phrase', ru: 'Ваша фраза восстановления' },
  'tok.phraseWarn': {
    en: 'Write these 16 words down now. They are the only way to reach this balance. Nobody can recover them for you, including us, and anyone who reads them owns the tokens.',
    ru: 'Запишите эти 16 слов прямо сейчас. Это единственный доступ к балансу. Восстановить их не может никто, включая нас, а любой, кто их увидит, получит ваши токены.',
  },
  'tok.saved': { en: 'I have written it down', ru: 'Я записал фразу' },
  'tok.enterPhrase': { en: 'Enter your 16-word phrase', ru: 'Введите фразу из 16 слов' },
  'tok.address': { en: 'Your token address', ru: 'Ваш адрес токена' },
  'tok.send': { en: 'Send tokens', ru: 'Отправить токены' },
  'tok.to': { en: 'Recipient address', ru: 'Адрес получателя' },
  'tok.amount': { en: 'Amount', ru: 'Количество' },
  'tok.signSend': { en: 'Sign and send', ru: 'Подписать и отправить' },
  'tok.sent': { en: 'Sent, recorded in block {n}', ru: 'Отправлено, блок {n}' },
  'tok.locked': { en: 'Unlock with your phrase to sign', ru: 'Разблокируйте фразой, чтобы подписать' },
  'tok.unlock': { en: 'Unlock', ru: 'Разблокировать' },
  'tok.unlocked': { en: 'Wallet unlocked for this tab', ru: 'Кошелёк разблокирован в этой вкладке' },
  'tok.verify': { en: 'Verify the whole chain', ru: 'Проверить всю цепочку' },
  'tok.verifying': { en: 'Checking block {n} of {total}…', ru: 'Проверка блока {n} из {total}…' },
  'tok.verifyOk': {
    en: 'All {n} blocks check out: every link, every signature, every balance.',
    ru: 'Все {n} блоков проверены: связи, подписи и балансы сходятся.',
  },
  'tok.verifyFail': { en: 'Verification failed at block {h}: {why}', ru: 'Проверка не прошла на блоке {h}: {why}' },
  'tok.height': { en: 'Chain height', ru: 'Высота цепочки' },
  'tok.supplyTitle': { en: 'Supply', ru: 'Эмиссия' },
  'tok.supplyCap': { en: 'Ever created', ru: 'Создано всего' },
  'tok.supplyOut': { en: 'In circulation', ru: 'В обращении' },
  'tok.supplyLeft': { en: 'Still in the treasury', ru: 'Осталось в казне' },
  'tok.supplyBurned': { en: 'Burned for good', ru: 'Сожжено навсегда' },
  'tok.supplyWhy': {
    en: 'Every tugrik that will ever exist was created in the first block of the chain. Nothing afterwards can create another: a verifier rejects any chain that mints outside that block, so the cap is something you can check rather than something we promise. Tokens burned in the arcade are gone and are never reissued.',
    ru: 'Все тугрики, которые когда-либо будут существовать, созданы в первом блоке цепочки. После него создать новые нельзя: проверяющий отвергает любую цепочку с эмиссией вне этого блока, поэтому предел можно проверить самому, а не поверить нам на слово. Сожжённые в зале автоматов токены исчезают навсегда.',
  },
  'tok.head': { en: 'Current head', ru: 'Текущая вершина' },
  'tok.pin': { en: 'Pin this head', ru: 'Запомнить вершину' },
  'tok.pinned': { en: 'Head pinned. Compare it next time you visit.', ru: 'Вершина сохранена. Сравните её при следующем визите.' },
  'tok.pinCheck': { en: 'Against your pinned head: {msg}', ru: 'Против сохранённой вершины: {msg}' },
  'tok.unsupported': {
    en: 'This browser cannot do Ed25519 signing, so the token wallet is unavailable here. Try a current Chrome, Edge or Safari.',
    ru: 'Этот браузер не поддерживает подписи Ed25519, поэтому токен-кошелёк недоступен. Попробуйте свежий Chrome, Edge или Safari.',
  },
  'tok.what': {
    en: 'Balances are controlled by a key only you hold, so the operator cannot move your tokens. Every block is hash-linked and signed, so history cannot be rewritten without every earlier copy disagreeing. It is not decentralised: one server still decides what goes in a block.',
    ru: 'Балансом управляет ключ, который есть только у вас, поэтому оператор не может тронуть ваши токены. Каждый блок связан хешем и подписан, поэтому историю нельзя переписать незаметно. Это не децентрализация: сервер по-прежнему решает, что попадёт в блок.',
  },

  // ---- sound
  'sound.toggle': { en: 'Sound', ru: 'Звук' },
  'sound.on': { en: 'Sound on', ru: 'Звук включён' },
  'sound.off': { en: 'Sound off', ru: 'Звук выключен' },
  'sound.musicOn': { en: 'Music on', ru: 'Музыка включена' },
  'sound.musicOff': { en: 'Music off', ru: 'Музыка выключена' },

  // ---- free play
  'demo.real': { en: 'Real', ru: 'На деньги' },
  'demo.practice': { en: 'Practice', ru: 'Тренировка' },
  'demo.mode': { en: 'Play mode', ru: 'Режим игры' },
  'demo.banner': {
    en: 'Practice mode: play money only. Nothing here can be won or lost, and nothing can be withdrawn.',
    ru: 'Режим тренировки: только игровые фишки. Здесь ничего нельзя выиграть, проиграть или вывести.',
  },
  'demo.topUp': { en: 'Refill play balance', ru: 'Пополнить игровой баланс' },
  'demo.toppedUp': { en: 'Play balance refilled', ru: 'Игровой баланс пополнен' },
  'demo.switchHint': {
    en: 'No deposit needed. Switch to Practice and learn the games for free.',
    ru: 'Депозит не нужен. Переключитесь на Тренировку и изучайте игры бесплатно.',
  },

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
