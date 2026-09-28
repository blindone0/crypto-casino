# The tugrik: what it is, and what it would take to trade it

Two questions came up and they have the same answer underneath, so they are together here.

> Which chain is the token registered on?

**None.** Not Ethereum, not BSC, not Solana, not TON, not Tron. It is on its own chain,
which lives in this site's database.

> How do we list it on an exchange and convert it to Bitcoin?

**You cannot, as it stands.** Not because of paperwork. Because there is nothing for an
exchange to connect to.

The rest of this file is what that actually means and what the routes out of it are, with
the costs and the risks stated rather than skipped.

---

## What the tugrik actually is

It is a real ledger with real cryptography, and it is worth being precise about which
properties it has, because it has more than most "casino points" and fewer than a coin.

What it genuinely does:

- **Blocks, hash-linked.** Each one carries the hash of the one before it. Rewriting any
  past transaction changes that block's hash and breaks every link after it.
- **Signatures you control.** Balances move on an Ed25519 signature from a key derived
  from your sixteen-word phrase. The private half never reaches the server. The operator
  can check a signature and cannot produce one.
- **A fixed supply, provably.** All 21,000,000 were created in the first block. The
  verifier rejects any chain that mints outside it. Nobody can print more, including you.
- **Auditable by anyone, in the browser.** The verify page replays every block, checks
  every signature, and recomputes every balance from zero without trusting the server.

What it is not:

- **Not decentralised.** One server decides what goes into a block and in what order. It
  cannot forge your signature, but it can refuse to include you, and it can stop.
- **Not on a public network.** No node anywhere else has a copy. If this server and its
  backups are gone, the chain is gone, and every tugrik with it.
- **Not an asset anyone outside this site recognises.** There is no address format another
  wallet understands, no RPC endpoint, no block explorer, no contract.

That last point is the whole answer to the exchange question. An exchange does not list a
"token" — it integrates a **contract on a chain it already runs nodes for**. There is
nothing here for it to integrate.

---

## What it would take to be a tradable coin

Four steps, in order. Each one is a real project and the later ones cost money.

### 1. Deploy an actual contract

Pick a chain and deploy a standard token on it:

| Chain | Standard | Rough deploy cost | Notes |
|---|---|---|---|
| Ethereum mainnet | ERC-20 | high gas | most credible, most expensive |
| Base / Arbitrum / Optimism | ERC-20 | low | Ethereum security, cheap |
| BSC | BEP-20 | low | easy listings, weaker reputation |
| Solana | SPL | very low | fast, large retail audience |
| TON | Jetton | low | best fit for a Telegram-first audience |
| Tron | TRC-20 | low | heavily used for stablecoins in RU/CIS |

The contract is maybe forty lines and is not the hard part. Fix the supply in the contract
and renounce the mint, or the "fixed supply" claim this project makes on-chain becomes a
claim only you can verify, which is worse than the honest version you have now.

### 2. Bridge it to the site

The site's chain and the public one need to agree on who holds what. In practice that
means a **custodial bridge you operate**: a player sends tugriks to an address you control
and you credit their site balance, and the reverse on the way out.

Be clear-eyed about this. A custodial bridge means you are holding other people's tokens.
Every bridge hack you have read about was this, done badly. You would need withdrawal
limits, a hot/cold split like the one already in `DEPLOY.md` for Bitcoin, and an operator
who does not lose the keys.

### 3. Give it a price

A token with no market has no price, and no exchange will list something with no market.
Two ways to get one:

- **A liquidity pool** on a decentralised exchange (Uniswap, PancakeSwap, Ston.fi). You
  deposit tugriks *and* real value — say 1 ETH and 1,000,000 TUG — and the pool prices it.
  **The real value is yours and it is at risk.** Anyone can sell into that pool, and if
  they sell more than they buy, they are taking your ETH and leaving you tugriks.
- **A centralised listing.** Realistically $5,000 to $500,000 depending on the exchange,
  plus a legal entity, KYC on the founders, a contract audit, and usually a market maker
  on retainer. Tier-1 exchanges do not list casino tokens from unlicensed operators.

### 4. Converting to Bitcoin

Once a pool or a listing exists, this part is ordinary: sell TUG for USDT or ETH, then buy
BTC, then withdraw. The site already has a Bitcoin withdrawal path for operator profit
(`tools/treasury-setup.js`, and the hot/cold split in `DEPLOY.md`). Nothing new is needed
at this end. Steps 1 to 3 are the entire problem.

---

## The part you will not want to read

I would be doing you a disservice to write the four steps above and stop, so:

**The free grant and a tradable token cannot both be true.** Every new wallet is given
1,000 tugriks. If a tugrik is worth anything at all, that is free money, and within a day
of listing there will be scripts registering accounts to farm it. The supply cap limits the
damage to 21,000 grants, but 21,000 free grants hitting a thin liquidity pool is the pool
gone. If you list, **turn the faucet off first** (`token.welcomeGrant: 0`) and let the
tokens already out stand as the airdrop.

**You would be the counterparty to your own currency.** The house edge is paid in tugriks,
so you accumulate them, and you would also be the one providing the pool the price comes
from. That is not illegal but it is the exact shape that gets a project called a scam, and
it is unanswerable: you can always sell into your own pool.

**It is probably a security in most places that matter.** A token sold to people who expect
its value to rise, issued by a company whose efforts determine whether it does, is the
textbook description. This is not a technicality that gets waved through; it is the thing
that ends projects.

**A casino token is a red flag by default.** Exchanges and payment providers treat "our own
coin, issued by our own casino, that you can bet with" as high risk before they look at any
of the detail, because most of the ones they have seen were exit scams.

---

## What is actually worth doing

The honest recommendation, given all of the above.

**Leave it as it is, and say what it is.** Right now the tugrik is a site credit with an
unusually good ledger behind it: fixed supply, your own key, fully auditable. That is a
genuinely better version of what every other casino calls "points", and you can say so
without any of the risk above. Nobody can accuse you of running an unregistered offering
when you are not offering anything.

**If you want it tradable, do it in the right order.** Licence first, then a legal entity,
then a lawyer's opinion on the token, then a contract, then liquidity. Doing it the other
way round is how the project becomes unfixable rather than unfinished.

**And if you only want people to be able to cash out,** you do not need a listing at all.
Let players swap tugriks for casino balance at a rate you set, and withdraw that in Bitcoin
through the path that already exists. That gives a tugrik real value, needs no contract, no
pool and no exchange, and you keep control of the rate. It is a tenth of the work and most
of the benefit.
