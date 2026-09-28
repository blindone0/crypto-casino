# What to do next

Written 2026-09-28, after poker went in and a дурак bug turned up that would have left
stakes locked in escrow for ever.

The site plays well. Every game works, 409 tests pass, and the books balance. What is
missing is the difference between something that works and something you can take real
money on and then change afterwards. This is that list, worst risk first.

Three of these were found by reading the code for this plan rather than by anything going
wrong, which is the point: none of them announce themselves until the day they cost you.

---

## Phase 1 — Money that cannot get stuck

**The problem.** A stake goes into escrow the moment a match is created, and only comes
out when the match reaches a result. There are two ways it never does:

- **An open table nobody joins.** You post a challenge for 500 TUG, nothing happens, you
  close the tab. The stake is escrowed. `match.cancel` would give it back, but only if you
  come back and press the button. Nothing expires it. `matches` has no expiry column and
  the server's only timer sweeps rate-limit rows.
- **A game both players walk away from.** `claimTimeout` pays out the player still there —
  but it is a claim, so somebody has to be there to make it. If both sides close the tab,
  the match sits in `playing` with both stakes held, for ever.

Neither needs a schema change: `matches.created_at` and `matches.moved_at_ms` already
carry what a sweeper needs to know.

**The work.**

1. `expireOpen` — an open table older than the configured window is cancelled and every
   stake refunded untouched. No rake: nothing was played.
2. `resolveAbandoned` — a playing match where nobody has moved for well past the clock is
   settled the way `claimTimeout` would have settled it, without needing a claimant. If
   the game cannot name a winner, every stake is refunded.
3. `reconcileEscrow` — the house escrow key's balance must equal the stakes of every open
   and playing match, exactly. Anything else means a stake was taken and not accounted
   for, or paid twice. This is the invariant the other two exist to protect.
4. A sweeper on a timer and on startup, so a server that was down over the window still
   catches up.

**Done when** a test can create an open table, an abandoned game and a finished one, run
the sweeper, and show every tugrik back where it belongs with the chain still verifying —
and `reconcileEscrow` holds after every test in the match suite.

---

## Phase 2 — A schema that can change

**The problem.** `src/db.js` builds the database with `CREATE TABLE IF NOT EXISTS` and
nothing else. There is no `user_version`, no migration table, no ordered steps.

On an empty database that is fine and it is why nobody has noticed. On a database that
already has rows — which is every database that matters, including the one on this machine
holding the token chain — `IF NOT EXISTS` is a no-op. Add a column next month and the code
expects it, the table does not have it, and the failure lands at runtime on a live site.

This blocks every future change that touches storage, which is most of them. It is second
only because Phase 1 needs no schema change and stranded money is worse than a change you
have not made yet.

**The work.**

1. A `migrations` list: ordered, numbered, each a plain function taking the database.
2. `PRAGMA user_version` as the marker. On open, run every step above the stored number,
   in one transaction each, then set it.
3. Baseline honestly. The current schema becomes step 1, and a database that already has
   the `users` table but no version is stamped as being at step 1 rather than having step
   1 run over it.
4. `tools/migrate.js` to run and report without starting the server, because you want to
   see what a migration will do to the live file before it does it.
5. A test that takes a database built by an older schema, migrates it, and finds its rows
   intact — not just that the columns arrived.

**Done when** adding a column is a five-line diff that works on a database with data in
it, and there is a test proving it.

---

## Phase 3 — One command that says whether the site is sound

**The problem.** The pieces exist and nothing puts them together. `ledger.auditBalances`
is reachable only through the admin panel. `tokenchain.verifyChain` is called by tests.
Escrow is never reconciled at all. To know the site is healthy you have to open a browser
and read three different screens, which means in practice nobody checks.

**The work.** `tools/doctor.js`, run as `npm run doctor`, checking in one pass:

- account balances equal the ledger sum (double-entry holds)
- the token chain verifies: every link, every signature, every balance
- the supply cap holds and nothing was minted after genesis
- escrow equals the stakes of live matches (Phase 1's invariant)
- no match has been `playing` longer than any clock allows
- no session, rate-limit or match row is orphaned by a deleted user

It exits non-zero on any failure, so cron can run it hourly and mail you when it trips.
DEPLOY.md's "checks before you take real money" becomes one line.

**Done when** `npm run doctor` passes on a real database, and a test that deliberately
corrupts one balance makes it fail with a message naming the problem.

---

## Phase 4 — Keep the documents true

DEPLOY.md tells you all 88 tests must pass. There are 409. A document that is wrong about
something checkable is worse than no document, because it teaches you not to trust the
rest of it. Along with the count: the new commands from Phases 2 and 3, the match result
reasons a player can now see, and the fact that дурак can end in a draw.

---

## Phase 5 — What is left after that

Smaller, and worth doing only once the above is true:

- **A match clock that survives a restart.** Clocks are wall-clock, so a server restart
  mid-game burns whoever was on the clock. Storing the pause would be fairer.
- **Spectating.** `match.detail` already refuses to send a hand to somebody not at the
  table, so the hard part is done.
- **An admin action log.** The panel can move money. Nothing records who did.
- **Tugrik sums in the header.** The balance shows eight decimal places everywhere,
  which is correct and unreadable at a glance.

---

## Not on this list, and why

**Listing the tugrik on an exchange.** TOKEN.md covers what that actually takes, and none
of it is code in this repo: it is a contract on a chain, liquidity, and somebody to talk
to. Nothing here gets you closer to it, and doing it before the above would be building
on a floor with a hole in it.

**More games.** There are ten. The next one adds less than any phase above.
