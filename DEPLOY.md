# Deployment

Taking this from a laptop to a server that takes real money. Follow it in order; each
step assumes the one before it.

---

## 0. What you need

| Thing | Spec | Notes |
|---|---|---|
| Server | 2 vCPU, 4 GB RAM, 40 GB SSD | Node and SQLite are light. The wallet node is what needs disk. |
| Bitcoin Core | +600 GB (or 10 GB pruned) | Only if using the `bitcoind` driver. Pruned works fine. |
| Monero node | +200 GB | Or point `monero-wallet-rpc` at a remote node you trust. |
| Domain | any registrar | |
| TLS | free via Caddy or certbot | |

A single 4 GB box runs the casino plus a pruned Bitcoin node comfortably at small scale.
SQLite in WAL mode handles thousands of bets per second; you will hit player-acquisition
limits long before database limits.

---

## 1. Base server

```bash
# Debian 12 / Ubuntu 24.04
adduser --disabled-password --gecos "" casino
apt update && apt install -y curl ufw fail2ban

# Node 22+ (24 LTS shown)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node --version        # must be >= 22.5 for node:sqlite

ufw default deny incoming
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable
```

Do **not** open the casino port (8787) or any wallet RPC port to the internet. They are
reached only over loopback, through the reverse proxy.

---

## 2. Install the app

```bash
su - casino
git clone <your repo> ~/casino
cd ~/casino
node src/server.js        # first run writes config.json, prints the admin token
# Ctrl-C once you have the token
```

Edit `config.json`:

```jsonc
{
  "siteName": "Your Site",
  "publicUrl": "https://example.com",
  "host": "127.0.0.1",
  "port": 8787,
  "trustProxy": true,        // REQUIRED behind a proxy, for real IPs and geo
  "secureCookies": true,     // REQUIRED over HTTPS
  "defaultLocale": "ru",
  "faucetUnits": 0,          // turn the signup bonus off in production
  "houseEdge": { "dice": 0.01, "limbo": 0.01, "crash": 0.01, "mines": 0.01,
                 "slots": 0.03, "preferans": 0.05 },
  "risk": { "bankrollRiskFraction": 0.01, "maxBetUnits": 5000000000 }
}
```

`trustProxy` and `secureCookies` are the two people forget. Without the first, every
player looks like `127.0.0.1`, so rate limiting and geo filtering collapse. Without the
second, session cookies are sent over plain HTTP.

---

## 3. Run it as a service

`/etc/systemd/system/casino.service`:

```ini
[Unit]
Description=Crypto casino
After=network.target

[Service]
Type=simple
User=casino
WorkingDirectory=/home/casino/casino
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3

# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/casino/casino/data /home/casino/casino/logs /home/casino/casino/config.json
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now casino
journalctl -u casino -f
```

`NODE_ENV=production` matters: the geo filter stays inert without it when
`geo.productionOnly` is true.

---

## 4. TLS and reverse proxy

**Caddy** is the shortest path; it gets and renews certificates by itself.

`/etc/caddy/Caddyfile`:

```
example.com {
    encode gzip

    # Server-sent events for crash must not be buffered.
    @sse path /api/crash/stream
    reverse_proxy @sse 127.0.0.1:8787 {
        flush_interval -1
    }

    reverse_proxy 127.0.0.1:8787

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        Referrer-Policy same-origin
        -Server
    }
}
```

**nginx** equivalent, if you prefer it:

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;
    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location /api/crash/stream {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;          # required, or the crash feed stalls
        proxy_read_timeout 3600s;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The SSE block is not optional. With default buffering the crash multiplier freezes and
only updates when the round ends.

---

## 5. Wallet node

### Bitcoin family

```bash
# bitcoin.conf
server=1
rpcuser=casino
rpcpassword=<long random>
rpcbind=127.0.0.1
prune=10000
txindex=0
```

```bash
bitcoin-cli createwallet casino
```

```jsonc
"wallet": {
  "driver": "bitcoind",
  "minConfirmations": 2,
  "bitcoind": {
    "url": "http://127.0.0.1:8332",
    "user": "casino", "pass": "<long random>",
    "walletName": "casino", "addressType": "bech32"
  }
}
```

### Monero

```bash
monerod --detach
monero-wallet-rpc --wallet-file casino --password '' \
  --rpc-bind-port 18082 --disable-rpc-login \
  --daemon-address 127.0.0.1:18081
```

```jsonc
"wallet": { "driver": "monero", "minConfirmations": 10,
            "monero": { "url": "http://127.0.0.1:18082/json_rpc" } }
```

Keep the RPC on loopback. This client does not implement digest auth, so either use
`--disable-rpc-login` locally or front it with a proxy that adds basic auth.

### Or start with no node at all

`"wallet": { "driver": "manual" }` plus `wallet.manual.depositAddress`. Players pay one
address with a memo, you check the chain yourself and credit from **Admin → Players →
Credit a deposit**. Payouts queue and you send them by hand, then mark them sent. It is
manual work, but you can be live today with any coin and move to a node later.

---

## 6. Bankroll and treasury

```bash
node tools/simulate.js --bankroll 1000 --players 50 --bets 400
```

Size the bankroll so that the "runs that went broke" column reads zero, then:

1. **Admin → Overview → Add bankroll** for the capital that backs the games.
2. `node tools/treasury-setup.js` to whitelist your cold wallet.
3. Take profit through **Admin → Treasury**, never from the hot wallet directly.

Keep the hot wallet at roughly what you owe players plus a buffer. **Admin → Treasury**
shows the recommended ceiling and a suggested sweep. Everything above it is money sitting
exposed to a server compromise for no reason.

---

## 7. Backups

The whole site is one SQLite file. Back it up with the online backup API so you never
copy a torn page:

`/home/casino/backup.sh`:

```bash
#!/bin/bash
set -euo pipefail
cd /home/casino/casino
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p /home/casino/backups
sqlite3 data/casino.db ".backup '/home/casino/backups/casino-$STAMP.db'"
cp config.json "/home/casino/backups/config-$STAMP.json"
find /home/casino/backups -name '*.db' -mtime +14 -delete
```

```
# crontab -e
0 * * * * /home/casino/backup.sh
```

Copy `backups/` off the machine on a schedule. `config.json` holds the admin token and
the treasury whitelist, so treat it as a secret.

Restoring is `systemctl stop casino`, copy the file to `data/casino.db`, start again.
Because the ledger is append-only, the admin panel will tell you immediately whether the
restored books balance.

---

## 8. Checks before you take real money

```bash
npm test                      # all 88 must pass
curl -sI https://example.com  # HSTS present, no Server header
```

- [ ] `trustProxy: true` and `secureCookies: true`
- [ ] `NODE_ENV=production` in the unit file
- [ ] `faucetUnits: 0`
- [ ] Admin token rotated after setup: `node tools/admin-token.js --rotate`
- [ ] Casino port and wallet RPC not reachable from outside (`nmap` from elsewhere)
- [ ] Crash multiplier animates smoothly through the proxy (SSE not buffered)
- [ ] A test deposit credits, and a test withdrawal actually arrives
- [ ] Backups running and a restore rehearsed at least once
- [ ] Books-balance indicator green in the admin panel
- [ ] Preferans calibration current: `node tools/calibrate-preferans.js` if the bot changed
- [ ] Treasury whitelist set, hot wallet holding only what it needs

---

## 8b. Launch and promotion

Once the checklist above is green, the next step is getting people through the door.
That is its own document: see **[GROWTH.md](GROWTH.md)**.

The short version, because the order matters more than the channels:

1. **Prove payouts first.** Twenty real withdrawals paid without incident.
2. **Prove retention.** Players returning on day seven.
3. **Prove economics.** A player worth more than they cost to acquire.
4. **Only then spend.** Buying traffic before step three converts your bankroll into
   other people's entertainment.

The cheapest channel is already in the product: the referral system pays commission out
of the house edge, so an affiliate can never cost you money. The differentiator is also
already in the product, and it is the one a larger competitor cannot copy: every bet here
is verifiable by the player, and the source is public under AGPL.

---

## 9. Running it day to day

**Daily:** withdrawal queue, books-balance indicator, failed withdrawals.

**Weekly:** actual vs theoretical hold. They should converge as volume grows. A
persistent gap on high volume is variance or a bug, and the per-game breakdown tells you
which game to look at.

**Monthly:** sweep the hot wallet down to the recommended ceiling, move profit to the
treasury, rehearse a restore.

**Watch for:** one account with an unusual win rate at high volume (either variance or a
problem), a hold far below the configured edge on one game only, and the bankroll
drifting down while volume is flat.

---

## 10. Scaling later

This design is deliberately single-process. That is what makes the synchronous
transactions safe and the whole thing auditable.

- **More traffic on one box:** it goes a long way. SQLite in WAL mode is not the limit.
- **Multiple processes:** you would need to move the crash loop to one leader process and
  swap SQLite for Postgres, because the transaction model assumes a single writer. Do not
  simply run two copies against one database file.
- **CDN:** you can put one in front of static assets, but the crash stream must bypass it.

Before any of that, check whether you are actually limited by the server. Most small
sites are not.

---

## Practical notes on payments and hosting

Two operational facts that shape deployment more than the code does:

**Hosting and registrars have acceptable-use policies.** Many mainstream providers
prohibit gambling services outright and will suspend without warning. Check the AUP
before you put a bankroll behind a host, and keep backups off that provider.

**Licensing determines your payment rails.** Card processors, and increasingly crypto
on-ramps, require a gaming licence before they will onboard you. Common low-cost options
are Anjouan and Curaçao (the Curaçao Gaming Authority replaced the old master-licence
system in 2024); Malta and the Isle of Man cost far more and carry more weight. A licence
also fixes which markets you may serve, which is what the `geo` config in `config.json`
is there to enforce. Pure crypto-in, crypto-out (which is what this codebase does by
default) avoids the card networks entirely and is why most small crypto casinos start
that way.
