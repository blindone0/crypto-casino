// Translations. Add a language by adding a third key to each entry and listing it in LANGS.
// Placeholders look like {name} and are filled by t('key', { name: 'x' }).
const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
];

const STRINGS = {
  // ---- chrome
  'nav.games': { en: 'Games', ru: 'Игры' },
  'nav.account': { en: 'Account', ru: 'Аккаунт' },
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
  'pick.title': { en: 'All games', ru: 'Все игры' },
  'pick.kind.brass':  { en: 'Machine', ru: 'Автомат' },
  'pick.kind.tile':   { en: 'Grid', ru: 'Поле' },
  'pick.kind.glass':  { en: 'Multiplier', ru: 'Множитель' },
  'pick.kind.resin':  { en: 'Roll', ru: 'Бросок' },
  'pick.kind.cotton': { en: 'Table', ru: 'Стол' },
  'game.jigsaw': { en: 'Jigsaw', ru: 'Мозаика' },
  'jig.start':  { en: 'Start the jigsaw', ru: 'Начать мозаику' },
  'jig.entry':  { en: 'Entry', ru: 'Взнос' },
  'jig.give':   { en: 'Give up', ru: 'Бросить' },
  'jig.within': { en: 'Under {n}', ru: 'Быстрее {n}' },
  'jig.left':   { en: '{n} left at full rate', ru: 'ещё {n} по полной ставке' },
  'jig.over':   { en: '{n} over', ru: 'превышение {n}' },
  'jig.intro': {
    en: 'Drag the pieces out of the tray, or tap one to send it straight home. The '
      + 'entry is staked and the faster you finish the more it pays — the clock is the '
      + 'server, not your browser, so it is the same clock for everyone.',
    ru: 'Перетащите кусочки из лотка или нажмите на кусочек, чтобы он встал на своё '
      + 'место сам. Взнос ставится, и чем быстрее вы соберёте, тем больше выплата — '
      + 'время считает сервер, одинаково для всех.',
  },
  'jig.tray': {
    en: '{n} {pieces} left',
    ru: 'осталось {n} {pieces}',
  },
  'jig.trayEmpty': { en: 'Every piece is down', ru: 'Все кусочки на месте' },
  'jig.idle': {
    en: 'Set your entry and start. 100 pieces.',
    ru: 'Укажите взнос и начните. 100 кусочков.',
  },
  'jig.won': {
    en: 'Finished in {n} — paid {m}x.',
    ru: 'Собрано за {n} — выплата {m}x.',
  },
  'jig.slow': {
    en: 'Finished in {n}, which was too slow to pay.',
    ru: 'Собрано за {n} — слишком медленно для выплаты.',
  },
  'jig.tooFast': {
    en: 'That was faster than anyone can drag, so it paid nothing.',
    ru: 'Быстрее, чем человек может перетаскивать, — выплаты нет.',
  },
  // Кости is the classic two-d6 game. The threshold game that used to hold this
  // name keeps its module and its route — a bet already in the ledger has to stay
  // verifiable — but it no longer has a screen, so it no longer needs a name.
  'game.bones': { en: 'Dice', ru: 'Кости' },
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
  'risk.label':  { en: 'Risk', ru: 'Риск' },
  'risk.safe':   { en: 'Safe', ru: 'Тихо' },
  'risk.normal': { en: 'Normal', ru: 'Обычно' },
  'risk.risky':  { en: 'Risky', ru: 'Рискованно' },
  'risk.wild':   { en: 'Wild', ru: 'Ва-банк' },
  'bet.chance': { en: 'Win chance', ru: 'Шанс выигрыша' },
  'bet.won': { en: 'Won', ru: 'Выигрыш' },
  'bet.lost': { en: 'Lost', ru: 'Проигрыш' },
  'bet.maxWin': { en: 'Max win per bet', ru: 'Макс. выигрыш за ставку' },
  'bet.edge': { en: 'House edge', ru: 'Преимущество казино' },

  // ---- dice
  'dice.result': { en: 'Roll', ru: 'Результат' },
  // Кости: two d6, call a total or a range of totals.
  'bones.call': { en: 'Your call', ru: 'Ваше число' },
  'bones.range': { en: 'Range', ru: 'Диапазон' },
  'bones.single': { en: 'One number', ru: 'Одно число' },
  'bones.throw': { en: 'Throw', ru: 'Бросать' },
  'bones.throwing': { en: 'Throwing…', ru: 'Бросок…' },
  'bones.paytable': { en: 'What each total pays', ru: 'Сколько платит каждая сумма' },
  'bones.sum': { en: 'Total', ru: 'Сумма' },
  'bones.ways': { en: 'Ways', ru: 'Вариантов' },
  'bones.rolled': { en: '{a} + {b} = {n}', ru: '{a} + {b} = {n}' },
  'bones.pickHigh': { en: 'Now the other end of the range', ru: 'Теперь второй край диапазона' },
  'bones.wholeBoard': {
    en: 'Covering every total wins every throw and still pays the edge — there is nothing to win.',
    ru: 'Ставка на все суммы выигрывает всегда и всё равно платит комиссию — выигрывать нечего.',
  },
  // Said whenever the quote and the payable amount differ. A capped win that looks like
  // a normal win is how a player learns to distrust the site, so it is named both in the
  // panel before the bet and on the result after it.
  'bones.capped': {
    en: 'The house holds {n}, which is all a win can pay right now.',
    ru: 'В кассе {n} — больше выигрыш сейчас не заплатит.',
  },
  'bones.fallbackNote': {
    en: 'Your browser cannot draw the 3D dice, so the throw is shown as numbers. The game is the same.',
    ru: 'Браузер не рисует 3D-кости, бросок показан числами. Игра та же.',
  },

  // ---- limbo
  'limbo.target': { en: 'Target multiplier', ru: 'Целевой множитель' },
  'limbo.drawn': { en: 'Drawn', ru: 'Выпало' },

  // ---- mines
  'mines.count': { en: 'Mines', ru: 'Количество мин' },
  // The Windows Minesweeper boards, as densities: this grid is 5x5, so the proportion
  // carries across and the mine count cannot. Beginner 12.3%, Intermediate 15.6%,
  // Expert 20.6% — 3, 4 and 5 mines of 25.
  'mines.beginner': { en: 'Beginner', ru: 'Новичок' },
  'mines.intermediate': { en: 'Intermediate', ru: 'Любитель' },
  'mines.expert': { en: 'Expert', ru: 'Профессионал' },
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
  'slots.freeSpins': { en: '{n} {freeSpins}!', ru: '{n} {freeSpins}!' },
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
  'slots.theme.rendered': { en: 'Gilded Royale', ru: 'Золотая корона' },

  // ---- puzzle

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
  'pref.nTricks': { en: '{n} {tricks}', ru: '{n} {tricks}' },
  'pref.you': { en: 'You', ru: 'Вы' },
  'pref.opponents': { en: 'Opponents', ru: 'Соперники' },
  'pref.trick': { en: 'Trick {n} of 10', ru: 'Взятка {n} из 10' },
  'pref.result': {
    en: 'You took {n} {tricksTaken}: {outcome}',
    ru: 'Вы взяли {n} {tricksTaken}: {outcome}',
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
  'arc.freeGo': {
    en: 'A free go: not enough tugriks for a token, so this one stays off the board.',
    ru: 'Бесплатная попытка: тугриков на жетон не хватило, в таблицу рекордов не пойдёт.',
  },
  'arc.cost': { en: 'A play costs', ru: 'Игра стоит' },
  'arc.g.pinball': { en: 'Orbit Pinball', ru: 'Орбитальный пинбол' },
  'arc.g.pinball.blurb': {
    en: 'Flippers, bumpers and a plunger. Keep the ball alive.',
    ru: 'Флипперы, бамперы и пружина. Не дайте шару упасть.',
  },
  'arc.g.billiards': { en: 'Russian Billiards', ru: 'Русский бильярд' },
  'arc.g.billiards.blurb': {
    en: 'Free pyramid: play any ball, pot any ball, the cue included. Eight wins.',
    ru: 'Свободная пирамида: бить можно любым шаром и забивать любой, биток тоже. Восемь шаров — победа.',
  },
  'arc.g.invaders': { en: 'Void Raiders', ru: 'Налёт из пустоты' },
  'arc.g.invaders.blurb': {
    en: 'Hold the line against descending waves.',
    ru: 'Держите оборону против наступающих волн.',
  },
  'arc.g.pinball.controls': {
    en: 'Arrow keys or Z / M to flip, SPACE to launch. On a phone, tap left or right.',
    ru: 'Стрелки или Z / M — флипперы, ПРОБЕЛ — запуск. На телефоне касайтесь слева или справа.',
  },
  'arc.g.billiards.controls': {
    en: 'Tap a ball to play it, drag back from it and release. Arrow keys to aim, SPACE to strike.',
    ru: 'Коснитесь шара, чтобы бить им; потяните от него назад и отпустите. Стрелки — прицел, ПРОБЕЛ — удар.',
  },
  'arc.g.invaders.controls': {
    en: 'Arrow keys or A / D to move, SPACE to fire. On a phone, tap the sides to move and the middle to shoot.',
    ru: 'Стрелки или A / D — движение, ПРОБЕЛ — огонь. На телефоне касайтесь краёв для движения и середины для выстрела.',
  },
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
  'arc.g.pong': { en: 'Pong', ru: 'Понг' },
  'arc.g.pong.blurb': {
    en: 'First to eleven against the machine. Every hit makes it faster.',
    ru: 'До одиннадцати против автомата. Каждый удар ускоряет мяч.',
  },
  'arc.g.pong.controls': {
    en: 'Arrow keys or W / S to move. On a phone, drag on the court.',
    ru: 'Стрелки или W / S — движение. На телефоне ведите пальцем по корту.',
  },
  // A cabinet may name its own HUD label through meta.hud; this is Pong's, in place of
  // "Balls left", which Pong does not have.
  'arc.g.pong.hud': { en: 'Points to 11', ru: 'Очков до 11' },
  'arc.g.invaders.hud': { en: 'Lives', ru: 'Жизни' },
  'arc.g.tron': { en: 'Tron: Legacy', ru: 'Трон: Наследие' },
  'arc.g.tron.blurb': {
    en: 'Light cycles against the machines. Outlive them, round after round.',
    ru: 'Светоциклы против машин. Переживите их, раунд за раундом.',
  },
  'arc.g.tron.controls': {
    en: 'Arrow keys or W A S D to turn. On a phone, swipe the way you want to go.',
    ru: 'Стрелки или W A S D — поворот. На телефоне — свайп в нужную сторону.',
  },
  'arc.g.tron.hud': { en: 'Riders left', ru: 'Гонщиков на поле' },

  // ---- site token
  // ---- matches
  'game.match': { en: 'Matches', ru: 'Матчи' },
  'match.title': { en: 'Head to head', ru: 'Игра на двоих' },
  'match.intro': {
    en: 'Play another player for tokens. The board is held by the server and every move is checked against the rules, so nothing here depends on trusting the other side. Both stakes go into escrow on the chain and the winner is paid from it.',
    ru: 'Игра с другим игроком на токены. Доска хранится на сервере, каждый ход проверяется по правилам, поэтому доверять сопернику не требуется. Обе ставки уходят в эскроу на цепочке, оттуда же выплачивается выигрыш.',
  },
  'solo.play':   { en: 'Play the machine', ru: 'Играть с машиной' },
  'solo.note': {
    en: 'Free practice against a bot. Nothing is staked and nothing is paid out — it is '
      + 'here so the games can be played when nobody else is.',
    ru: 'Бесплатная тренировка против бота. Ставок нет и выплат тоже — это чтобы в игры '
      + 'можно было играть, когда больше никого нет.',
  },
  'solo.bot':     { en: 'The machine', ru: 'Машина' },
  'solo.quit':    { en: 'Give up', ru: 'Сдаться' },
  'solo.youWon':  { en: 'You won', ru: 'Вы выиграли' },
  'solo.youLost': { en: 'You lost', ru: 'Вы проиграли' },
  'solo.draw':    { en: 'A draw', ru: 'Ничья' },
  'match.game': { en: 'Game', ru: 'Игра' },
  'match.g.chess': { en: 'Chess', ru: 'Шахматы' },
  'match.g.seabattle': { en: 'Sea Battle', ru: 'Морской бой' },
  'match.g.balda': { en: 'Balda', ru: 'Балда' },
  'match.g.durak': { en: 'Durak', ru: 'Дурак переводной' },
  'match.g.poker': { en: 'Poker', ru: 'Покер' },
  'match.g.tron': { en: 'Tron: Legacy', ru: 'Трон: Наследие' },
  'match.why.last-standing': { en: 'took every chip', ru: 'забрал все фишки' },
  'match.why.fool': { en: 'the fool was found', ru: 'дурак найден' },
  'match.why.no-fool': { en: 'nobody was left holding cards', ru: 'никто не остался с картами' },
  'match.why.no-progress': {
    en: 'the cards would not come out — a draw',
    ru: 'карты перестали выходить — ничья',
  },
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
  'match.why.last-rider': { en: 'last rider on the grid', ru: 'последний на трассе' },
  'match.why.head-on': { en: 'head-on, both derezzed', ru: 'лоб в лоб, выбыли оба' },
  'match.why.time': { en: 'time ran out', ru: 'время вышло' },
  'match.stake': { en: 'Stake', ru: 'Ставка' },
  'match.players': { en: 'Players', ru: 'Игроков' },
  'err.amount': { en: 'That is not an amount.', ru: 'Это не сумма.' },
  'match.nPlayers': { en: '{n} {players}', ru: '{n} {players}' },
  'match.seated': { en: 'Seated. Waiting for {n} of {of}.', ru: 'Вы за столом. Ждём: {n} из {of}.' },
  'match.rake': { en: 'House cut', ru: 'Комиссия' },
  'match.minStake': { en: 'Smallest stake', ru: 'Минимальная ставка' },
  'match.noEdge': {
    en: 'No house edge here: you are playing the other players, not the bankroll. The prize '
      + 'is the stakes everyone escrowed, less the cut above.',
    ru: 'Здесь нет преимущества казино: вы играете против других игроков, а не против банка. '
      + 'Приз — это ставки, которые все внесли в эскроу, за вычетом комиссии выше.',
  },
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
  'acct.frozen': {
    en: 'Your account is under review and nothing can be staked or moved until it is done. Reason: {why}.',
    ru: 'Ваш аккаунт на проверке: пока она идёт, ставки и переводы недоступны. Причина: {why}.',
  },
  'acct.banned': {
    en: 'This account is banned. Reason: {why}.',
    ru: 'Этот аккаунт забанен. Причина: {why}.',
  },
  'acct.frozenBlocks': {
    en: 'The evidence is on the chain in blocks {blocks}.',
    ru: 'Доказательства — в цепочке, блоки {blocks}.',
  },
  'tok.noHouse': {
    en: 'The token wallet is not ready yet. Try again in a moment.',
    ru: 'Токен-кошелёк ещё не готов. Попробуйте через мгновение.',
  },
  'tok.title': { en: 'Token wallet', ru: 'Токен-кошелёк' },
  'tok.nav': { en: 'Token', ru: 'Токен' },
  'tok.balance': { en: 'Token balance', ru: 'Баланс токенов' },
  'tok.create': { en: 'Create a wallet', ru: 'Создать кошелёк' },
  'tok.restore': { en: 'Restore from phrase', ru: 'Восстановить по фразе' },
  'tok.phrase': { en: 'Your recovery phrase', ru: 'Ваша фраза восстановления' },
  'tok.granted': {
    en: 'Your wallet is ready and {n} {c} are in it. They came out of a fixed supply, '
      + 'not out of thin air.',
    ru: 'Кошелёк готов, на нём {n} {c}. Они взяты из ограниченного запаса, '
      + 'а не созданы из воздуха.',
  },
  'tok.phraseLater': {
    en: 'You can read this phrase again any time under Wallet. It is the only way back '
      + 'in from another device, and nobody else has a copy — not even us.',
    ru: 'Эту фразу можно посмотреть в любой момент в разделе «Кошелёк». Только по ней '
      + 'можно войти с другого устройства, и копии нет ни у кого — у нас тоже.',
  },
  'tok.confirmIntro': {
    en: 'Two words back, so we both know it is really written down. Anyone can click '
      + '"saved" — this is the part that makes it true.',
    ru: 'Назовите два слова — чтобы мы оба знали, что фраза действительно записана. '
      + 'Нажать «записал» может каждый; вот это и делает запись настоящей.',
  },
  'tok.confirmWord': { en: 'Word {n}', ru: 'Слово {n}' },
  'tok.confirmGo': { en: 'Confirm', ru: 'Подтвердить' },
  'tok.confirmWrong': {
    en: 'Those do not match. Check the phrase and try again.',
    ru: 'Не совпадает. Проверьте фразу и попробуйте ещё раз.',
  },
  'tok.confirmBack': { en: 'Show me the phrase again', ru: 'Показать фразу ещё раз' },
  'tok.phraseShow': { en: 'Show my phrase', ru: 'Показать фразу' },
  'tok.phraseHide': { en: 'Hide', ru: 'Скрыть' },
  'tok.phraseMissing': {
    en: 'This device does not have the words. The wallet still works here, but to write '
      + 'the phrase down you need the device you created it on.',
    ru: 'На этом устройстве слов нет. Кошелёк здесь работает, но чтобы записать фразу, '
      + 'нужно устройство, на котором вы её создавали.',
  },
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
    ru: 'Проверено блоков: {n}. Связи, подписи и балансы сходятся.',
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

  // ---- wallet
  'wallet.deposit': { en: 'Deposit', ru: 'Пополнение' },
  'wallet.withdraw': { en: 'Withdraw', ru: 'Вывод' },
  'wallet.history': { en: 'History', ru: 'История' },
  'wallet.yourAddress': { en: 'Your deposit address', ru: 'Ваш адрес для пополнения' },
  'wallet.memo': { en: 'Payment memo (include this)', ru: 'Метка платежа (обязательно укажите)' },
  'wallet.copy': { en: 'Copy', ru: 'Копировать' },
  'wallet.copied': { en: 'Copied', ru: 'Скопировано' },
  'wallet.confirmations': {
    en: 'Credited after {n} {confirmations}.',
    ru: 'Зачисление после {n} {confirmations}.',
  },
  'wallet.minDeposit': { en: 'Minimum deposit', ru: 'Минимальное пополнение' },
  'wallet.noMinimum': { en: 'no minimum', ru: 'без минимума' },
  'wallet.minWithdraw': { en: 'Minimum withdrawal', ru: 'Минимальный вывод' },
  'wallet.fee': { en: 'Network fee', ru: 'Сетевой сбор' },
  'wallet.destination': { en: 'Destination address', ru: 'Адрес получателя' },
  'wallet.requestWithdraw': { en: 'Request withdrawal', ru: 'Запросить вывод' },
  'wallet.youReceive': { en: 'You receive', ru: 'Вы получите' },
  'wallet.simulate': { en: 'Simulate a deposit (test mode)', ru: 'Смоделировать пополнение (тест)' },
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
    en: 'Lock the account for {n} {days}? This cannot be undone.',
    ru: 'Заблокировать аккаунт на {n} {days}? Отменить нельзя.',
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

/**
 * Counted nouns.
 *
 * English picks between two forms, Russian between three: 1 игрок, 2 игрока, 5 игроков.
 * Baking one form into a string gets it right for a single number and wrong for the rest,
 * which is how the seat picker came to offer "5 игрока".
 *
 * A string that counts something writes the noun as a placeholder naming a set here --
 * '{n} {players}' -- and t() agrees it with the n it was handed. The set name is the same
 * in both languages, so a translation cannot quietly drift out of step with its English.
 *
 * Two sets name the same noun because Russian also declines for the sentence around it: a
 * bare count takes `tricks` ("6 взяток"), "you took" takes `tricksTaken` ("взяли 1 взятку").
 */
const PLURALS = {
  players: { en: ['player', 'players'], ru: ['игрок', 'игрока', 'игроков'] },
  tricks: { en: ['trick', 'tricks'], ru: ['взятка', 'взятки', 'взяток'] },
  tricksTaken: { en: ['trick', 'tricks'], ru: ['взятку', 'взятки', 'взяток'] },
  freeSpins: { en: ['free spin', 'free spins'], ru: ['фриспин', 'фриспина', 'фриспинов'] },
  days: { en: ['day', 'days'], ru: ['день', 'дня', 'дней'] },
  pieces: {
    en: ['piece', 'pieces'],
    ru: ['кусочек', 'кусочка', 'кусочков'],
  },
  confirmations: {
    en: ['confirmation', 'confirmations'],
    ru: ['подтверждения', 'подтверждений', 'подтверждений'],
  },
};

/**
 * Which form a number takes: 0 for one, 1 for a few, 2 for many.
 *
 * The Russian rule reads the last digit, except that the teens are all "many" -- which is
 * why 21 counts as one and 11 does not.
 */
function pluralIndex(lang, n) {
  const abs = Math.abs(Math.trunc(n));
  if (lang !== 'ru') return abs === 1 ? 0 : 1;
  const tens = abs % 100;
  if (tens >= 11 && tens <= 14) return 2;
  const unit = abs % 10;
  if (unit === 1) return 0;
  if (unit >= 2 && unit <= 4) return 1;
  return 2;
}

/** The right form of a counted noun: plural(5, 'players') is 'игроков' in Russian. */
function plural(n, set, lang = current) {
  const forms = PLURALS[set] && (PLURALS[set][lang] ?? PLURALS[set].en);
  if (!forms) return set;
  return forms[Math.min(pluralIndex(lang, n), forms.length - 1)];
}

/** Translate a key, filling {placeholders}. Falls back to English, then the key itself. */
function t(key, vars) {
  const entry = STRINGS[key];
  let s = entry ? (entry[current] ?? entry.en) : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    // Whatever is left naming a counted noun agrees with n. Explicit vars are filled
    // first, so a caller can still pass its own word under one of these names.
    if (typeof vars.n === 'number') {
      for (const set of Object.keys(PLURALS)) {
        if (s.includes(`{${set}}`)) s = s.split(`{${set}}`).join(plural(vars.n, set));
      }
    }
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

export { LANGS, STRINGS, PLURALS, t, plural, setLocale, getLocale, applyAll };
