# Running this on a HomeLab

One box at home — a mini-PC, an old desktop, a NAS, a Proxmox VM or LXC container —
running one shop. That is the shape this software was written for: a single process,
a database on the same machine, a handful of devices on the LAN.

`docs/renter-onboarding.md` is the operator's runbook and covers the same install in
product terms. This file is what that runbook assumes: how to make the app survive a
reboot, be reachable from the counter, and have a backup that somebody would actually
be able to restore. Read both before a shop depends on either.

It does not cover several branches, a second register, or a hosted deployment — see
§10 for what is deliberately out of scope.

---

## 1. What you need on the box

| | |
| --- | --- |
| Linux | Anything systemd-based: Debian/Ubuntu, Fedora, Arch, Proxmox LXC. |
| Node.js 22 or newer | Installed **system-wide** — `apt`/`dnf`, or [NodeSource](https://github.com/nodesource/distributions). Not nvm: the service account has no shell profile, so nvm's node is not on its `PATH`. |
| PostgreSQL 17 | On the same box is the normal case. |
| `postgresql-client` | Provides `pg_dump`, which §7 needs — and it has to be the version that matches the server's major release. Easier to install now than at 02:30. |
| A static LAN address | DHCP is fine but a fixed lease is better, because the till URL ends up in bookmarks and on the customer display. |
| TLS for anything that is not the box itself | This is not optional and not obvious — §4. |

Two cores and a couple of gigabytes is a comfortable shop. The app is one Node
process; PostgreSQL is the part that wants memory.

The deployment target is a Linux server with systemd; the dev machine being Windows
changes nothing about the units below.

### If PostgreSQL is already running on that server

A HomeLab usually has one, and three things follow from it:

- **`pg_dump` must match the server's major version.** The distribution's default
  client is often one release behind, and that fails with `aborting because of server
  version mismatch`. Install the matching one — for a 17 server, `postgresql-client-17`
  from the [PGDG repository](https://www.postgresql.org/download/linux/debian/), not
  the plain `postgresql-client`.
- **A containerised database has no client on the host at all.** Either install one
  (the same version rule, against the container's version) or dump from inside the
  container, which means giving up the timer and the checks in `npm run backup`:

  `docker exec <container> pg_dump -U pos_app -d pos_dev | gzip > pos-$(date +%F).sql.gz`

  That is the pipe whose failure mode `scripts/backup.ts` exists to avoid — the
  compressor's exit code hides a writer that died — so check the file is not empty.
- **`npm run setup` talks to `localhost:5432` and nowhere else.** The host and port are
  constants in `scripts/setup.ts`, so a database on another port — a second instance,
  or a container published as 5433 — means writing `.env` by hand with the right
  `DATABASE_URL` and then `npm run db:generate && npm run db:deploy` instead of the
  installer. The installer also connects as the superuser, and asks for that password
  once.

---

## 2. The checkout, and the account that owns it

The service runs as an ordinary account, and the files belong to that account. Do the
deploying as that same user — a `git pull` run as root leaves root-owned files behind,
and the next `npm ci` fails with a permissions error that has nothing to do with the
change you were pulling.

```bash
sudo useradd --system --create-home --shell /bin/bash pos
sudo -iu pos
cd /opt
git clone https://github.com/TanatPinkeaw/POS.git pos      # or move your checkout
cd /opt/pos
npm ci
npm run setup      # creates the role, pos_dev and pos_test, writes .env, migrates
npm run build
```

Three things about that sequence are worth knowing before you run it:

- **`npm ci`, not `npm ci --omit=dev`.** `tsx` and `cross-env` are in
  `devDependencies`, and `npm run start` runs the server through both of them; `next
  build` needs `typescript` as well. This is not a deployment where the dev
  dependencies can be dropped, and dropping them produces a service that starts and
  instantly fails with `Cannot find module 'tsx'`.
- **`npm run build` is not optional.** `npm run start` runs Next with
  `NODE_ENV=production`, which expects the `.next` directory a build leaves behind.
  `/opt/pos/.next` is part of the deployment, not a cache you can prune.
- **`npm run setup` applies migrations, and so does §8.** The installer also creates
  `pos_test`, which nothing in a shop uses; it is the suite's database (its tables
  are emptied between tests, which is why it is a separate database). Leaving it
  alone is fine.

The app reads `.env` from its working directory (`src/lib/env.ts`), so `.env` stays in
`/opt/pos` and is never copied into `/etc`. Real environment variables win over the
file, which is what lets the units in §3 override the binding without editing it.

The units below say `/opt/pos`. If your checkout lives elsewhere, change every unit at
once and re-read the result:

```bash
grep -rl /opt/pos deploy/systemd | xargs sed -i 's#/opt/pos#/srv/pos#'
```

---

## 3. The units

Four services and a timer, in `deploy/systemd/`. Every one runs as `pos` with
`WorkingDirectory=/opt/pos`, so the app finds its own `.env`.

| Unit | Runs | Enable it? |
| --- | --- | --- |
| `pos.service` | the till server, `npm run start`, on `0.0.0.0:3000` | Always |
| `pos-backup.timer` (+ `pos-backup.service`) | one dump a day, at 02:30 Bangkok, pruning what aged out | Always |
| `pos-notify.service` | `notify:worker --watch` — sends the queued messages | Only with `NOTIFY_CHANNEL` set (runbook §6.2) |
| `pos-bank.service` | `bank:bridge --interval 60` — reads the bank's notification mailbox | Only with `BANK_IMAP_*` and `BANK_AMOUNT_REGEX` set (runbook §6.1) |

```bash
sudo install -d -o pos -g pos /var/backups/pos
sudo install -m 644 deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload

# Let systemd read them before trusting them: a typo in a directive is a service
# that silently never starts. These units have never been loaded by a real systemd
# anywhere, so this is the first time it happens.
sudo systemd-analyze verify /etc/systemd/system/pos*.service /etc/systemd/system/pos-backup.timer

sudo systemctl enable --now pos.service pos-backup.timer

# Only once the matching `.env` keys are in place, or skip them: an unconfigured
# worker idles and an unconfigured bridge refuses to start.
sudo systemctl enable --now pos-notify.service
sudo systemctl enable --now pos-bank.service
```

`pos-backup.service` has no `[Install]` section on purpose — the timer is what you
enable, and enabling both would take a second backup a day.

Watching it:

```bash
systemctl status pos
journalctl -u pos -f              # the app's own log lines
journalctl -u pos-backup --since '2 days ago'
# 200 on a shop that is set up; a 307 to /setup on one that is not.
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```

The bank bridge is the one service that can legitimately end up `failed`: it retries
for half an hour and then stops, so that a misconfigured mailbox leaves one visible
unit rather than a night of identical journal lines. The last line of
`journalctl -u pos-bank` says which happened — the mailbox refused the login, or a
key it needs is not in `.env`.

---

## 4. TLS: the part that bites

In production the session cookie is `Secure` (`src/lib/auth.ts`), and a browser stores
a `Secure` cookie over `https://` only — with one exemption, `localhost`, which
browsers treat as a secure context even over plain http. Two consequences, and both
look like a different bug:

- **On the box itself, `http://localhost:3000` works.** That is enough to finish
  setup, and it is why a fresh install appears to be fine.
- **From the counter tablet, a plain-http login does nothing.** The page loads, the
  password is right, and the next request is signed out again, because the cookie was
  never stored. It reads like a wrong password, and it is not.

So the deployment needs a secure URL before the second device arrives. Three ways, in
the order this project would pick them:

**Tailscale Serve (least work, and the recommendation).** The box joins your tailnet
and Tailscale terminates TLS on a real certificate — `https://<machine>.<tailnet>.ts.net`
— so every device that has joined the tailnet gets a working till with no certificate
to install anywhere:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 3000          # older releases: tailscale serve https / http://127.0.0.1:3000
tailscale serve status                  # the URL to open on the tablet
```

The trade: the till now depends on Tailscale being up, and the shop's URL is a tailnet
name rather than something you chose. **Do not use `tailscale funnel`** — that
publishes the till to the public internet, and nothing in this system is hardened for
that.

**Caddy on the box.** One binary, its own CA, no domain needed:

```
pos.home.lan {
    tls internal
    reverse_proxy 127.0.0.1:3000
}
```

Caddy passes the WebSocket upgrade automatically. The cost is the client side: each
tablet and phone has to trust Caddy's root CA
(`/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`), which on Android
and iOS means installing a certificate profile by hand. Doable once, and irritating
every time you add a device.

**Your own nginx and certificate.** It works, and if the box already runs nginx for
other things it is probably what you will do. The one thing that must not be missed is
the upgrade, because the realtime board and the customer display ride on it:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

`X-Forwarded-For` is honoured by the rate limiter only when the socket's own address is
private, which is exactly the shape of a proxy you run yourself — so the limiter still
counts the real client, not the proxy.

Whichever you choose, two hops are unaffected and should stay pointed at loopback:
`BANK_BRIDGE_BASE_URL` (the bridge posts to the app with a shared secret, not a
cookie) and anything you `curl` from the box itself.

---

## 5. Checking the deployment

```bash
cd /opt/pos
npm run backup -- --list                 # §7, and proves the script can read .env
curl -s http://127.0.0.1:3000/login | head -20
```

Then, in a browser: open the URL from §4. An unconfigured deployment sends `/login`
straight to `/setup` — fill it in, and keep the administrator phone number and
password, because there is no password-reset email (runbook §3, §8).

Sign in **from the till machine first**, then from a second device. If the second one
bounces back to `/login`, that is §4 and not a wrong password.

Three commands from this repo that should **not** be run against this deployment:

- `npm run smoke` drives the demo personas (`0800000001`…) and reserves real stock. It
  is for a throwaway database with the demo seed, not for a shop that is trading.
- `npm run route:audit`, `npm run acceptance` and `npm run limiter:race` each run
  `next build`, which rewrites `.next` underneath the running `pos.service`, and they
  start servers of their own on scratch schemas. They belong on the machine you
  develop on, before the upgrade in §8.
- `npm run db:seed:demo` — the demo seed, on a live shop, by name.

`npm run verify` is safe on the box: it type-checks, audits the source and the command
lists, runs the suite against `pos_test`, and touches no build output.

---

## 6. The two optional always-on pieces

Both are off by default and the app is complete without them. Enabling either means
adding its unit from §3 — the pieces are long-running, so they do not live in the
web process:

- **Messages leaving the shop** (runbook §6.2). Set `NOTIFY_CHANNEL` and its
  destination in `.env`, then `pos-notify.service`. Until that is configured no
  notification is even queued, so the app behaves identically with the unit running.
- **An incoming transfer closing its own bill** (runbook §6.1). Set the mailbox keys,
  `BANK_AMOUNT_REGEX` and `PAYMENT_WEBHOOK_SECRET`, test against a saved notification
  with `npm run bank:bridge -- --file ./notification.eml`, then `pos-bank.service`.

Neither is a customer-facing surface of its own: everything a customer or a cashier
sees is served by `pos.service`.

---

## 7. Backups

One command, in the repo, so that the thing the timer runs and the thing the runbook
tells an operator to run cannot drift:

```bash
npm run backup                       # dump, then prune what aged out
npm run backup -- --list             # what is there, and how big
npm run backup -- --dir /srv/pos-backups --keep 30
```

It writes `pos-YYYYMMDD-HHMMSS.sql.gz` in Bangkok time, refuses an empty dump, refuses
a database whose name looks like a test database (`--force` overrides that), and takes
its own half-written file with it when it fails. `pg_dump`, `psql` and plain `gunzip`
can read the result — the dump is ordinary SQL on purpose, so it is still restorable
on a day this repository is not around.

It is the **database**, and only the database. Product photos are links to the shop's
own file host — the homelab's Nextcloud, for the reference installation — so they are
not in the dump (ADR 0014): whatever backs that host up is what covers them. Point the
operator at both, because a restored shop with a catalogue of placeholders is a
restore that looks like it worked.

`pos-backup.timer` runs it at 02:30 Bangkok with `Persistent=true` and a 14-day
retention (`BACKUP_KEEP_DAYS` in `pos-backup.service`; `--keep 0` never deletes). The files land in
`/var/backups/pos`, which is **the same disk as the database**. That is a copy, not a
backup: point `BACKUP_DIR` at another disk, a NAS mount, or a share that `rclone` or
`rsync` copies nightly. The script prints that reminder itself whenever it is asked to
write inside the checkout.

### Restoring

Do this once before you need it, into a throwaway database, so that the recipe is known
to work and takes minutes rather than an afternoon. The first attempt should never be
the one that matters.

```bash
# Creating a database needs CREATEDB, which the app's role deliberately does not
# have (it is created `WITH LOGIN` and nothing more), so the superuser does it and
# makes pos_app the owner.
sudo -u postgres createdb -O pos_app pos_restore

# These two connect as pos_app over TCP, so they ask for its password: the one in
# /opt/pos/.env, after `pos_app:` in DATABASE_URL.
gunzip -c /var/backups/pos/pos-20260929-023000.sql.gz | psql -h localhost -U pos_app -d pos_restore
psql -h localhost -U pos_app -d pos_restore -c 'select count(*) from orders'
```

To put it back over the shop's own database, replace the name and accept that the row
counts after the fact will be whatever the dump held:

```bash
sudo systemctl stop pos
sudo -u postgres dropdb pos_dev
sudo -u postgres createdb -O pos_app pos_dev
gunzip -c /var/backups/pos/pos-20260929-023000.sql.gz | psql -h localhost -U pos_app -d pos_dev
sudo systemctl start pos
```

Honest state of this: the dump is written by a command with tests around its
configuration parsing, but **the restore is a recipe by hand and nothing in the repo
rehearses it** — no script, no check, no CI job. Treat the drill above as part of the
install, not as documentation.

---

## 8. Upgrades

Backup first, and stop the service before building: `next build` rewrites the `.next`
directory that the running process is serving from.

```bash
sudo systemctl stop pos        # before the build, see above

sudo -iu pos                   # everything else as the account that owns the checkout
cd /opt/pos
npm run backup
git pull
npm ci
npm run db:deploy              # prisma migrate deploy — never `migrate dev`
npm run build
exit

sudo systemctl start pos
```

Once the service is back up, `npm run server:check` is the cheap proof that the restart
took: it reads `.next/BUILD_ID`, asks the running server for that build's manifest, and
names the asset files it cannot serve. A server started *before* the build answers with
pages that have no stylesheet — which looks like a broken update rather than a stale
process, and is why the command exists.

`npm run db:deploy` is not interchangeable with `prisma migrate dev`: parts of the
schema — a generated column, several `CHECK` constraints, the order-number sequence —
exist only in hand-written migration SQL, and `migrate dev` would propose dropping them
(runbook §7 has the same warning).

A shop cannot take sales while `pos` is stopped, so do this after closing. The whole
sequence is a minute or two on a mini-PC, most of it `npm ci`.

---

## 9. When something is wrong

| Symptom | Cause and fix |
| --- | --- |
| `pos` is not `active` right after boot | Usually PostgreSQL is not up yet. Check `systemctl status postgresql`, then `journalctl -u pos -n 30`. The unit keeps retrying — its start limiter is off on purpose — so it comes up on its own once the database answers. |
| Login bounces back to `/login` on a tablet, but works on the box | The `Secure` cookie and no TLS — §4. Not a wrong password. |
| Nothing can reach `:3000` except from the box | `HOSTNAME` is `localhost` — put `Environment=HOSTNAME=0.0.0.0` in `pos.service` (the `.env` default is `localhost`). |
| `Cannot find module 'tsx'` or `'cross-env'` | The install was done with `--omit=dev`. Both are `devDependencies` the production start command needs: `npm ci`. |
| `npm` not found when the service starts | Node was installed with nvm, which the service account cannot see. Install Node system-wide; `command -v npm` as that user should print `/usr/bin/npm` or `/usr/local/bin/npm`. |
| Run by hand works, `systemctl start` fails | Read `journalctl -u pos -n 50`. Usual causes: the account cannot write `/opt/pos` (root-owned files from a root `git pull`), or `.env` is missing or unreadable. |
| `pos-bank` failed with `BANK_AMOUNT_REGEX is not set` | Exactly what it says; enable it only after runbook §6.1 is configured. |
| `pos-backup` failed with `pg_dump is not installed` | `apt install postgresql-client-17` for a 17 server (or `dnf install postgresql17`); the version has to match, and a mismatch reads as `aborting because of server version mismatch`. |
| A backup wrote nothing | `npm run backup` refuses an empty dump and says so; the journal line names the database it targeted, so a `DATABASE_URL` pointing at the wrong one is visible there. |
| The timer never ran | `systemctl list-timers pos-backup.timer` (is it enabled?), and `timedatectl` (is the host's clock sane? `Persistent=true` will catch up a missed run, but not a clock three years behind). |
| `/display` will not pair | The customer display needs the same reachable URL as the till — it is a second device, so §4 applies to it too. Generate the code at `/admin/settings`. |

---

## 10. What this does not cover

- **A second register.** One process, one shop: receipt numbering serialises on the
  shop row, which is correct for one till (ADR 0002 §4). A second till is a change to
  the money path, not a second unit file — it is listed in README's *Not built yet*.
- **Several branches.** One shop per deployment; a second branch is a second box.
- **High availability.** No failover, no load balancer, no read replica. A reboot is
  downtime, and the app is built accordingly.
- **Docker.** Nothing here prevents a container, but nothing in this repo tests one,
  and the units above are the path that is maintained.
- **Monitoring and alerting.** A failed unit is only visible to somebody who runs
  `systemctl status`, or to whatever the host already does with the journal.
- **A rehearsed restore.** §7 is a recipe. The repo has no drill, and that is a real
  gap rather than a stylistic one.
- **Hardening the box.** Firewall, SSH keys, unattended upgrades, and who else can log
  in are the host's business; this document assumes a machine only you can reach, which
  is also the assumption Tailscale Serve in §4 keeps.
