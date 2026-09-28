# Crypto casino

A self-hosted, provably-fair crypto casino. Six games, a real double-entry ledger,
crypto deposits and withdrawals, an operator panel, and English/Russian interfaces.

**Zero npm dependencies.** It runs on Node 22.5+ using only built-in modules:
`node:http`, `node:sqlite`, `node:crypto`. Nothing to install, nothing to audit but the
code in this folder.

```
git clone <this folder>  &&  cd crypto-casino
node src/server.js
```

Then open <http://127.0.0.1:8787>. On Windows, double-click `START-CASINO.bat` (a desktop
shortcut is created by `tools/make-shortcut.ps1`).

The first account you register becomes the operator. The admin token is printed on first
start and saved to `config.json`.

---

## The five-minute version

```bash
node src/server.js                  # start; first run writes config.json
node tools/admin-token.js           # show the operator token
npm test                            # the whole suite
node tools/simulate.js              # will this actually make money?
```

1. Open `/admin`, paste the token.
2. **Fund the bankroll.** No bets are accepted while it is zero: the bankroll is the
   capital that pays winners.
3. Register a player account on `/`, press the test-deposit button, and play.
4. When you want real money, switch `wallet.driver` in `config.json` from `mock` to
   `bitcoind`, `monero` or `manual`.

---

## How it makes money

Every game is priced at a configurable house edge (`houseEdge` in `config.json`,
default 1%). Expected revenue is:

```
gross revenue  =  total wagered  x  house edge
```

Note what that does *not* depend on: whether players win or lose today. Revenue tracks
**volume**, so 1000 small bets are worth far more than one big one. The operator panel
shows actual revenue next to theoretical revenue; over enough volume they converge, and a
large persistent gap means either extreme variance or a bug.

Three things decide whether the edge ever reaches your pocket:

**Bankroll survival.** The edge only pays out in the long run, and a site that busts
never gets to collect its long run. `risk.bankrollRiskFraction` (default 1%) caps the
largest possible win on any single bet at a fraction of the bankroll. Games without a
fixed ceiling (mines, crash) accept the bet and cap the *payout* instead, the way
commercial sites publish a max-profit-per-bet.

**What you give back.** `referralCommission` (20%) and `rakeback.rate` (5%) are both paid
out of the theoretical edge, never out of the stake, so they shrink the margin but can
never invert it. Config validation refuses a combination that would give away the whole
edge.

**Liquidity discipline.** Player balances are a liability, not revenue. The panel shows
*free capital* = bankroll − what you owe players, and the treasury refuses any payout
that would eat into it.

Run the numbers before committing capital:

```bash
node tools/simulate.js --bankroll 1000 --players 50 --bets 400 --risk 0.01
```

It runs the real fairness engine against the real risk caps and reports the distribution
of outcomes, including how many simulated runs went broke. If that column is not zero,
raise the bankroll or lower the risk fraction.

---

## Provably fair

Players can verify every result without trusting the server.

**Dice, limbo, mines** use a per-player seed chain:

1. The server generates a 32-byte seed and publishes `sha256(seed)` **before** you bet.
2. You choose a client seed. A nonce counts your bets.
3. `HMAC-SHA256(serverSeed, "clientSeed:nonce:cursor")` produces the outcome bytes.
4. Rotating the seed reveals the old one, so every past bet can be recomputed and checked
   against the hash that was published first.

**Crash** uses a pre-committed reverse hash chain, which is stronger: `c[0]` is secret,
`c[i] = sha256(c[i-1])`, and `c[n]` is published as the commitment. Round 1 reveals
`c[n-1]`, round 2 reveals `c[n-2]`, and each revealed seed hashes to the previous one.
Every future outcome is fixed before anyone bets, so the operator cannot react to how
much money is on the table.

`/verify` recomputes any bet in the browser with the Web Crypto API. It sends nothing to
the server, so verification never depends on the server agreeing.

---

## Games

| Game      | Type        | Player choice            | How the edge is applied |
|-----------|-------------|--------------------------|-------------------------|
| Dice      | instant     | threshold + direction    | `(1-edge)/chance` |
| Limbo     | instant     | target multiplier        | Pareto draw scaled by `1-edge` |
| Mines     | interactive | mine count, when to stop | `(1-edge) x C(25,k)/C(25-M,k)` |
| Crash     | multiplayer | stake + cashout point    | shared round, scaled by `1-edge` |
| Slots     | instant     | stake only               | paytable solved to hit the target RTP |
| Preferans | interactive | trump, then how to play  | payouts calibrated against bot play |
| Puzzle    | interactive | difficulty, when to stop | `(1-edge) x C(N,k)/C(N-M,k)` |
| Debertz   | interactive | trumps, then how to play | payouts calibrated against bot play |

Crash runs a real shared round loop and pushes updates over Server-Sent Events. No
WebSocket library needed.

Three more rooms sit outside that table, because they do not take a bet against the house
and so do not have a house edge at all.

### The arcade

A room of cabinets that cost a token to play and pay nothing back. That is not meanness,
it is the only honest design: the games run in the player's browser, so a score arrives
from a machine they control and could have edited. Attaching money to an unverifiable
number gets farmed the same day. A play costs one token, the score buys a place on a
leaderboard, and the token sale is the revenue, which is how the arcades this imitates
actually earned.

Three cabinets: *Orbit Pinball*, *Billiards* and *Void Raiders*. All three are canvas
physics games with no assets, and all three are tested headlessly against a fake browser
that advances time only when told to (`test/cabinet-harness.js`). That harness has found
every physics bug in this project: a plunger whose full power was below escape velocity for
its own launch lane, a drain counted once per substep so the last ball ended the game six
times, flippers whose resting tips formed a floor the ball simply sat on. None of those
were visible on screen.

Inserting a token is signed by the player and burned on the chain, so the operator cannot
charge an account for plays nobody started.

### Head to head

Chess, Морской бой and Балда, played between two people for tokens, with a rake to the
house. Unlike the arcade these **can** pay out, because the server holds the board and
checks every move against the rules before it changes anything. The result is not a number
a client reported.

| Game        | Held by the server | What is hidden |
|-------------|--------------------|----------------|
| Chess       | the position, legal moves, both clocks | nothing; it is a game of perfect information |
| Морской бой | both fleets, every shot | each fleet, from the other player |
| Балда       | the grid, the words already spent | nothing |

The chess rules are a complete engine verified with perft against the six standard
positions. Those counts catch what spot-checks do not: a castling right that survives its
rook being taken, an en-passant capture taking the wrong square, a pinned piece allowed to
move.

Морской бой validates a fleet on arrival, because "the client would not send that" stops
being true the moment there is money on the board, and it never sends a fleet to the
opponent. The test asserts that by searching the serialised response for the actual ship
coordinates rather than by trusting that the right fields were picked.

Балда needs a dictionary, which ships in this repository like everything else. It is about
seventeen hundred common nouns, hand-kept, and that is a real limit rather than something
to gloss over: enough to play with, not enough to satisfy a serious player. Drop a bigger
list in `data/balda-ru.txt` and it is merged with the built-in one rather than replacing
it.

Stakes are escrowed on the token chain. Joining a match means signing a transfer only the
player can produce; settling means the house signing the pot back out. Both are ordinary
blocks, so an operator who pays the wrong person leaves the evidence on the chain.

### Slots

Five reels, three rows, twenty fixed paylines, wilds, scatters and free spins. What makes
it unusual is that its RTP is **computed exactly, not sampled**. A payline draws one
symbol from each reel, and a uniform reel stop makes that symbol uniform over the strip,
so the line return is an exact sum over all 11^5 symbol combinations. Scatters need the
visible three-row window, so their distribution is enumerated per reel and convolved.

The paytable is then *solved*: a single scale factor is searched for until the finished
machine lands on the configured edge, and the solver **throws rather than ship a machine
that misses its target**. That guard is not theoretical. An early version had a fixed
search ceiling, silently clamped, and produced a 35% RTP machine that looked perfectly
normal. A test now asserts the closed-form RTP agrees with simulated play.

**Five machines, one engine.** The Machine selector switches between *Golden Vault*,
*After Dark*, *Golden Ring*, *Knife and Smoke* and *The Couch*. Only the artwork and the
cabinet palette change: the reel strips, the paytable and the published RTP are identical,
so a theme is never secretly a different game.

#### Why none of this was taken from an existing project

This was built rather than imported, and that was not for want of looking. What is out
there falls into two piles.

The first is animation. The most popular open-source slot machines are front-ends: reels
that spin nicely and a paytable that is decorative. The best-known of them is explicit
about it in its own description, offering to generate "an extremely biased" machine. There
is no RTP in any of them to speak of, which means there is nothing to reuse for the part
that actually matters here.

The second is one project that does the maths properly, and cannot be used for a different
reason. It is MIT-licensed and well built, and what it contains is a reimplementation of
specific commercial machines from named providers, with scanned reel sets for each. The
licence on the code says nothing about the games it reproduces. Shipping those would be
the same mistake as calling the pinball table by the name of the one it is a nod to: the
mechanics of a slot machine belong to nobody, and a named machine with its reel strips and
its artwork very much belongs to somebody.

So the symbols here are drawn as SVG in this repository, the reel strips are ours, and the
paytable is solved rather than copied. That is more work than importing something, and it
is the only version of this that is both correct and safe to publish.

### Preferans

The simplest form of the card game: 32 cards, ten each to you and two bots, two in the
talon. You choose trump, take the talon, discard two, and play ten tricks alone against
both bots. Follow suit if you can; if you are void you must trump.

Six tricks returns your stake, seven or more pays, and the curve steepens sharply toward
ten. **This is the one game whose edge is not guaranteed by arithmetic.** There is no
closed-form probability of taking N tricks: it depends on how well the hand is played. So
the payouts are *measured*, by simulating the bot playing all three seats 40,000 times,
and then priced at `(1 - edge) / P(tricks)`.

That has a consequence worth being clear about: the edge holds against a player who plays
about as well as the bot. A stronger player erodes it; a weaker one loses more. It ships
with a wider default edge (5%) to absorb that, and the per-game hold in the operator panel
is what tells you whether real players are beating the calibration. If you change the
bot's play, re-run `node tools/calibrate-preferans.js` — a test fails if the stored table
has drifted from how the bot actually plays.

---

## The site token

A second, separate currency on a hash-linked ledger that any player can verify in their
own browser. Balances are controlled by an Ed25519 key derived from a sixteen-word phrase
the player holds, and the private half never reaches the server.

### The supply is fixed, and you can check that it is

Every tugrik that will ever exist is created once, in the first block of the chain, and
paid into a treasury. Nothing afterwards creates any. A welcome grant is a transfer out of
that treasury, not new money, and when the treasury is empty the grants stop rather than
resuming from nothing.

This matters because the obvious version does not work. If registering a wallet minted its
own grant, then unlimited accounts would mean unlimited tokens, and a tugrik would be worth
whatever it costs to sign up again.

The cap is enforced where it can be checked rather than where it must be believed: the
chain verifier **rejects any chain that mints outside block zero**. Anyone replaying the
ledger sees a single creation event and its amount. An operator who quietly minted itself a
fortune in block nine hundred would produce a chain that fails verification in every
browser that looks at it.

It also cannot be revised later. `token.maxSupply` in the config decides the number the
first time the server starts and never again: the genesis block is signed and hashed, and
every later block links to it. Changing the config on a running system does nothing at all.
That is deliberate, and it is why `npm run token-reset` exists for development, where you
may genuinely want to start over. It destroys every token, block and wallet, and refuses to
do anything without `--yes`.

Tokens burned to play an arcade cabinet are gone. Nothing reissues them, so the circulating
supply only ever falls.

What the ledger buys you, stated precisely:

1. **The operator cannot move your tokens.** A transfer needs your signature, and the
   server can check one without being able to produce one. A test signs a theft with the
   operator's own key and asserts it is refused.
2. **History cannot be quietly rewritten.** Each block carries the hash of the one before
   it and is signed. Altering any past transaction changes that block's hash and breaks
   every link after it.
3. **Anyone can audit the whole ledger**, in the browser, without trusting a word the
   server says about itself. Open the token wallet and press verify: it recomputes every
   hash, checks every signature, and replays every balance from zero.

What it is **not**, equally precisely:

- **Not decentralised.** One server decides what goes into a block and in what order. It
  cannot forge your signature, but it can refuse to include you.
- **Not a consensus network.** Browsers cannot do consensus: they are offline most of the
  time, hold no stake, and anyone can run ten thousand of them.
- **Not unhackable.** Nothing is. Someone who steals the server key can sign new blocks.
  What they still cannot do is move tokens out of an account whose phrase they lack, or
  change history without every saved copy of the head disagreeing.

That last point has a practical answer: the wallet lets you **pin the current head**.
If the chain is ever rebuilt from scratch, the height will match but the head will not,
and two validly signed heads at the same height are proof of exactly what happened.

The word list is deliberately **not** BIP-39, so a phrase from here will not restore in
Electrum and a real wallet phrase will not work here. Using the real list would invite
somebody to type their actual savings phrase into a casino.

---

## Free play

Anyone can practise without depositing. Every account gets a separate play balance that
can be refilled for free once it runs low, and the Real / Practice switch in the header
changes which money the games use.

The separation is absolute, and deliberately so. Play money lives in its own tables and
never enters `accounts` or `ledger`, which means a practice win is **not** paid out of
the bankroll, practice balances are **not** counted as money owed to players, and the
books-balance check is not measuring fiction. Practice bets are excluded from revenue
reporting and from the public bet feed, though the operator can still see engagement
under Admin. A round opened with play money settles with play money even if a later
request claims otherwise, since the round itself records which bank it belongs to.

What practice players still get is everything that matters for learning: the same games,
the same maths, the same provably-fair seed chain. Self-imposed limits and self-exclusion
apply here too, because someone who asked to be kept away from the games asked to be kept
away from all of them.

Turn it off with `demo.enabled: false`.

### Debertz

The Odessa card game (Klaberjass), nine cards each against one opponent. Its whole
character is that **trumps rank differently from every other suit**: in trumps the Jack
is highest and the Nine second, while everywhere else the Ace leads and the Jack is worth
almost nothing. Getting that wrong turns it into a different game, so it is the first
thing the tests check.

You name trumps, which means you carry the bete risk: finish level or behind and you lose
the whole hand rather than the difference. That happens about one hand in five. Scoring is
card points plus the best run, plus bella (king and queen of trumps), plus ten for the
last trick.

Because the chooser wins roughly four hands in five, the pricing is tight: at a 1% edge
the average winning hand can only be worth about 1.23x. Left to a free solve, a narrow win
would price *below* the stake, so "you won" would quietly mean "you lost money". The
narrowest band is therefore pinned to exactly 1.00 and only the wider margins are solved,
so every win returns at least what was staked. A test enforces that.

---

## Money and the ledger

Balances are **integers** in units of 1e-8 (satoshi-style). No floats touch a balance.
Rounding always truncates downward, which favours the house, never the player.

Every mutation writes to an append-only `ledger` table inside the same transaction that
moves the balance. Internal transfers write two rows summing to zero; external flows
(a deposit arriving, a withdrawal broadcast) write one, because the counterparty is the
blockchain. So `sum(accounts.balance) == sum(ledger.delta)` always holds, and the admin
panel shows a live **books balance** check. A test asserts it after real traffic.

Withdrawals move money to a `pending` account on request, so reserved funds cannot be bet
with, and a rejection refunds exactly what was taken.

---

## Crypto wallets

Set `wallet.driver` in `config.json`.

| Driver     | What it needs                | Good for |
|------------|------------------------------|----------|
| `mock`     | nothing                      | development; fake deposits, no chain |
| `manual`   | nothing but your own wallet  | launching today with any coin |
| `bitcoind` | Bitcoin Core (or LTC/DOGE/BCH) | automatic BTC-family deposits and payouts |
| `monero`   | `monero-wallet-rpc`          | automatic Monero with per-player subaddresses |

Each driver has its setup instructions in the comment header of its file under
`src/wallet/`.

**Minimum deposit is 1 unit, i.e. effectively none.** Anything that arrives on-chain is
credited in full. A higher floor would only reject money you already hold: the chain has
its own dust limit and a transaction below it never confirms anyway.

**Minimum withdrawal** must stay above the network fee or small cashouts lose money.
Per-coin values live in `wallet.assets` (Monero 0.00002, Bitcoin 0.0005, manual 0.0001)
and override the generic setting automatically.

### Hot wallet vs treasury

The hot wallet is online and holds only enough to pay players. Your profit does not
belong there. Create a cold wallet in real wallet software and whitelist its address:

```bash
node tools/treasury-setup.js
```

This tool does not generate keys, on purpose. Seed generation belongs in audited wallet
software you can restore anywhere else: Sparrow or Electrum for Bitcoin, Monero GUI or
Feather for Monero. Paste a receive address and it is checksum-verified (real BIP-173 and
BIP-350 validation) before being saved, so a typo cannot send profit into nowhere.

Then use **Admin → Treasury → Send to treasury**. Payouts draw only on free capital, so
taking profit can never leave you unable to pay a winner.

---

## Jurisdiction control

`config.json → geo` restricts which countries can reach the site.

```jsonc
"geo": {
  "enabled": true,
  "productionOnly": true,      // never filters in development or tests
  "mode": "allow",             // "allow" | "deny" | "off"
  "countries": [],             // ISO-3166 alpha-2 codes
  "countryHeader": "cf-ipcountry",
  "rangesFile": "data/geo-ranges.txt",
  "onUnknown": "allow",        // set "deny" if the restriction must actually hold
  "bypassPrivate": true
}
```

`allow` mode admits only the listed countries; `deny` mode refuses them. Loopback and
private addresses are never filtered, so local development and health checks keep working.

Country detection needs one of:

- **A trusted proxy header.** Cloudflare sets `CF-IPCountry`; nginx with the GeoIP2 module
  can set anything. Requires `trustProxy: true`, because a header is only meaningful if a
  proxy *you* control sets it. Without that, a client can simply send the header itself.
- **A local CIDR table** at `data/geo-ranges.txt`, lines of `<cidr> <CC>`. Works offline;
  populate it from the RIPE or ARIN delegated-extended files.

With neither, no country resolves and every request falls through to `onUnknown`. Set it
to `deny` if the filter is meant to hold, since an unplaceable address (a VPN, a proxy) is
the easiest way around one.

---

## Responsible play controls

Players can cap their own maximum bet (lowering applies instantly, raising takes 24
hours) and self-exclude for up to a year (cannot be shortened or undone). Operators get
per-account freeze, a full audit log, and optional daily deposit caps. Beyond being the
right thing, these reduce chargebacks and complaints, and every payment provider asks
about them.

---

## Security

- Passwords hashed with scrypt (N=16384). Login runs a comparison even for a missing user
  so timing cannot reveal who exists.
- Session tokens stored as `sha256(token)`, so a stolen database grants no live sessions.
- CSRF double-submit token required on every mutating cookie-authenticated request.
- Strict CSP: `script-src 'self'`, no inline script, no CDN, no external fonts.
- Rate limiting per IP per route prefix.
- Path traversal blocked; oversized bodies get a clean 413.
- Admin access via a token or an admin-role session.

---

## Layout

```
src/
  server.js        HTTP server, router, every endpoint
  config.js        all tuning: edge, risk, referrals, wallet, geo, treasury
  db.js            SQLite schema and the synchronous transaction helper
  util.js          integer money math, crypto helpers, HTTP plumbing
  fair.js          provably-fair engine (the one source of outcome truth)
  ledger.js        accounts, transfers, risk caps, settlement, reporting
  auth.js          accounts, sessions, seed chains
  limits.js        rate limiting and player self-limits
  admin.js         P&L, risk posture, player management
  treasury.js      operator profit withdrawal to cold storage
  addrcheck.js     bech32 / base58check address validation
  geo.js           jurisdiction filter
  tokenchain.js    the site token: signed, hash-linked, fixed supply
  arcade.js        token-operated cabinets; scores, never money
  match.js         staked head-to-head games: lobby, escrow, clocks, settlement
  chess.js         a complete rules engine, verified with perft
  seabattle.js     Морской бой: fleet validation and shooting
  balda.js         Балда: the grid, and the search for a word's path
  words-ru.js      the Russian dictionary, plus the optional operator override
  games/           dice, limbo, mines, crash, slots, puzzle, preferans, debertz
  wallet/          mock, manual, bitcoind, monero drivers
public/            the site: casino, /admin panel, /verify verifier, i18n
  audio.js         the noir radio: instruments, patterns, the scheduler
  radio.js         its programme: four stations, twelve pieces
  symbols.js       slot artwork, five themes, drawn as SVG
  games/           canvas cabinets and the match boards
test/              the suite; run it with `npm test`
tools/             simulator, calibration, treasury setup, admin token, token reset
```

See `DEPLOY.md` for putting this on a real server, and `GROWTH.md` for launching and promoting it.

---

## Licence

**GNU AGPL-3.0.** See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

Free to run, modify and operate commercially. In return, your version stays open, the
attribution travels with it, and because AGPL section 13 treats *running a network
service* as distribution, players on your site can ask you for the source you are
actually running. Plain GPL would not require that, which is precisely the loophole that
covers most online casinos.

If you operate a modified copy, link your public repository from the site footer.
