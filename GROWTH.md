# Launch and promotion

Revenue is volume times house edge. Everything here exists to raise volume, because the
edge is already fixed in `config.json` and cannot be raised much without players noticing.

Read `DEPLOY.md` first: this assumes the site is live, funded and paying withdrawals
reliably. Promoting a casino that cannot pay out is how you buy a reputation you cannot
fix later.

---

## 0. The order that actually works

Most small casinos fail in the same order: they buy traffic before they can convert it,
then run out of money before they learn why. Do it the other way round.

| Stage | Goal | Stop condition |
|---|---|---|
| 1. Prove payouts | Deposits credit, withdrawals arrive, books balance | 20 real withdrawals paid without incident |
| 2. Prove retention | Players come back a second and third day | Day-7 return rate above ~15% |
| 3. Prove economics | A player is worth more than they cost to acquire | Lifetime value above acquisition cost |
| 4. Then scale | Spend on whatever channel survived stage 3 | — |

Spending on acquisition before stage 3 is just converting your bankroll into other
people's entertainment.

---

## 1. What the licence unlocks

Which channels are even available is decided by the licence, not by the marketing budget.
Without one, most of this list is closed:

| Channel | Needs a licence? |
|---|---|
| Affiliate networks (the serious ones) | Yes, always |
| Google / Meta advertising | Yes, plus certification per market |
| Twitch and YouTube sponsorships | Yes in practice; both enforce gambling policy |
| Casino review and comparison sites | Almost always |
| Crypto communities and forums | Often not, but read each forum's rules |
| Your own SEO and content | No |
| Your own referral programme | No |

Anjouan and Curaçao are the usual low-cost entry licences; Malta and the Isle of Man cost
far more and open far more doors. `DEPLOY.md` covers this in more detail. The `geo`
settings in `config.json` are what enforce the markets your licence actually covers.

---

## 2. Your one real differentiator

You are a small site competing with operators who outspend you a thousand to one. You
cannot win on bonus size or game count. You can win on something they structurally
cannot copy:

**Everything here is verifiable and the source is public.**

- Every bet can be recomputed by the player from a seed the site committed to *before*
  the bet, in a page that never talks to the server.
- Crash rounds are fixed by a published hash chain before anyone bets, so the operator
  demonstrably cannot react to the money on the table.
- The slot RTP is not a marketing claim, it is solved in the code and asserted by tests.
- The licence is AGPL, so a player can read the code that is actually running and demand
  the source of any modified version.
- The token supply is capped in a way anyone can check. Every tugrik was created in the
  first block of the chain and the verifier rejects a chain that mints anywhere else, so
  "we cannot print more" is a thing a player confirms rather than a thing you claim.

Most "provably fair" sites publish a hash and hope nobody checks. Make checking the
product. Put the verifier in the footer, link the repository, and write the one honest
paragraph competitors cannot: *here is exactly how we make money, and here is how to
confirm we are not doing anything else.*

That message reaches a specific audience: people who already distrust casinos. It is a
small audience, but it is the one you can actually reach for free.

### The rooms that are not gambling

Three parts of the site take no bet against the house, and they are worth more to you than
their revenue suggests.

**The arcade** sells tokens and pays nothing back. The cabinets are pinball, billiards and
a wave shooter, and the prize is a leaderboard. That is the honest design, since the games
run in the player's browser and a score can be edited, but it is also the part of the site
you can talk about anywhere. It is not a gambling product, so it does not trip the
advertising policy that closes most of the list in section 1, and it gives someone a reason
to be on the site on a day they do not want to bet.

**Head to head** is chess, Морской бой and Балда played between two people for tokens with
a rake. The house is not the counterparty and cannot lose, which makes it the only revenue
line here with no variance in it at all. It is also the one thing on the site with a
natural reason to invite somebody: you cannot play alone.

**Practice mode** costs nothing and is a complete, separate play-money ledger. Do not treat
it as a funnel to be optimised. The people who use it are frequently people who should not
be depositing, and pushing them is both wrong and, in the markets that matter, the fastest
route to losing a licence.

### The one number to put in front of people

The house edge, written as a percentage, on the page, for every game. Almost nobody does
this and the reason is that most operators cannot: their RTP is a supplier's number they
have never verified. Yours is solved in the code and asserted by a test. Say so.

---

## 3. Channels, cheapest first

### Your own referral programme (already built)

The affiliate system in the product pays 20% of the house edge generated by everyone a
player brings, for as long as they play. It is configured by `referralCommission` and
tracked under **Admin → Affiliates**.

This is the cheapest channel you have because it costs nothing until it works: commission
comes out of the edge those players generate, never out of the stake, so an affiliate can
never cost you money.

Practical notes:
- Give affiliates their numbers. The panel already tracks players referred, lifetime
  earnings and unpaid balance.
- 20% is low against the market (25-40% is common). Raise it for people who actually
  deliver rather than advertising a high rate to everyone.
- Watch for self-referral: one account funnelling to itself is fraud, not marketing. The
  admin panel shows referrer and referred side by side.

### Communities

Crypto gambling has a handful of places where small honest operators still get a hearing:
Bitcointalk's gambling section, a few subreddits, and the Discord and Telegram groups
around specific coins. Each has its own rules and most ban outright advertising.

What works there is not an advert. It is showing up with the verifier, the repository and
a straight answer about your edge, and being the operator who answers the awkward
questions. What fails is a launch post with a bonus code.

### Content and search

Slow, free, and compounds. Write the things you already know from building this: how
provably fair actually works, why a published RTP means nothing without a way to check it,
how to verify a crash round by hand. That content ranks because almost nobody writes it
honestly, and it attracts exactly the sceptical player who will then check your site and
find it holds up.

### Streamers

Effective and expensive, and the segment with the worst fraud problem in the industry.
If you go there: pay per verified depositing player, never a flat fee up front, and use a
dedicated referral code so the panel attributes it. Expect most of the market to be
inflated numbers.

---

## 4. Retention, which is where the money is

An acquired player who plays once is a loss. Volume comes from the same people returning.

Already built into the product:

- **Rakeback.** 5% of the edge on their own bets, claimable. Configured by
  `rakeback.rate`. Claimable rather than automatic on purpose: it brings people back.
- **Practice mode.** Free play money with no deposit. It costs nothing, and it lets
  someone learn the games before risking anything, which is both decent and effective.
- **Seed rotation.** Players who care about fairness come back to audit. Let them.

Worth adding when you have traffic: a weekly leaderboard on wagered volume, a small daily
bonus for consecutive days, and an email or Telegram notification when rakeback is
claimable. All of these raise return rate rather than acquisition, which is the cheaper
half of the equation.

---

## 5. The numbers to watch

The operator panel already reports everything on this list except acquisition cost, which
only you know.

| Number | Where | What it means |
|---|---|---|
| Wagered volume | Admin → Overview | The thing revenue is a fixed percentage of |
| Actual vs theoretical hold | Admin → Overview | They converge with volume; a persistent gap is variance or a bug |
| Active players today | Admin → Overview | Retention, roughly |
| Per-game hold | Admin → Overview | Which game is carrying, and whether the skill games are being beaten |
| Free capital | Admin → Overview | What is actually yours after what you owe players |
| Affiliate earnings | Admin → Affiliates | Which partners are real |

Two derived numbers you must track yourself:

**Lifetime value.** Total wagered by a player times your edge. A player who wagers 1000
credits at a 1% edge is worth 10 credits to you, minus rakeback and commission. That is
the honest number, and it is smaller than most operators admit.

**Acquisition cost.** Everything spent on a channel divided by the depositing players it
produced. If this exceeds lifetime value, the channel is losing money no matter how good
the traffic looks.

Run `node tools/simulate.js` with your real volume figures before committing to any spend.
It reports the distribution of outcomes including how often the bankroll goes broke, and
a marketing push that triples volume also triples the variance you have to survive.

---

## 6. What not to do

- **Do not promote into markets your licence does not cover.** That is what the `geo`
  config is for, and the exposure lands on you personally, not on the company.
- **Do not advertise a bonus you have not modelled.** A wagering-requirement bonus is a
  liability with a probability attached. Work out the cost before you announce it.
- **Do not buy traffic before stage 3.** See section 0.
- **Do not spam.** In the communities that matter, one spam post ends your access
  permanently, and those communities are the cheapest channel you have.
- **Do not claim "provably fair" without shipping the verifier.** You have a real one.
  Sites that claim it without one are the reason the phrase is treated as noise, and being
  lumped in with them costs you the only advantage you have.
