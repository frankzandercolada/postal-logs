# postal-logs

A small multi-tenant web app that receives webhooks from one or more
[Postal](https://docs.postalserver.io/) mail servers, persists the events,
and lets staff and (optionally scoped) client users browse, filter, and
export them.

Self-contained Node.js + Caddy stack on a single VM. SQLite on disk, no
external services required beyond Postal itself.

## Highlights

- **Webhook receiver** with RSA signature verification against Postal's
  server-wide signing key. One unique webhook URL per mail server.
- **Multi-tenant**: clients → mail servers → events. Postal's signing key
  is set at the client level by default; individual mail servers can
  override.
- **Built-in email + password auth**, bcrypt-hashed. Bootstrap admin is
  seeded from env on first boot; admins invite further users from the UI
  by setting an initial password and handing it over out of band. Users
  change their own password from the header.
- **Granular permissions**: a non-staff user gets a Membership on a client
  (role = viewer / admin / owner), and can optionally be restricted to a
  subset of that client's mail servers.
- **Live dashboard** with ranges from "last hour" to "last 30 days",
  per-event-type chip filters, count / percentage toggle. Delayed
  retries are deduplicated by message token so the chart counts distinct
  delayed messages, not retry attempts.
- **Events list** with search by recipient, sender, and subject; date
  range; per-event-type filter; per-mail-server filter; CSV export. A
  `× N` chip on each delayed message drills into its retry history.
- **Hardening**: TLS via Caddy with auto-Let's-Encrypt, HSTS, CSP, login
  rate-limiting, session idle-timeout, log rotation, online SQLite
  backups via `./deploy.sh backup`.
- **Retention**: raw events for 120 days; daily stats aggregates and
  suppression list kept indefinitely.

## Stack

| | |
|---|---|
| Backend | Fastify, Prisma, SQLite, bcryptjs |
| Frontend | Vite + React, Tailwind, Recharts |
| Reverse proxy | Caddy 2 (auto-HTTPS) |
| Packaging | Docker Compose, single Node container + Caddy container |

## Quick deploy on a fresh VM

You need a Linux VM with a public IP, ports 80 and 443 open to the
internet (cloud firewall + host firewall both), and a DNS A-record
pointing your hostname at the VM (e.g.
`postal-logs.example.com → <vm-ip>`).

```bash
# 1. install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. clone and configure
git clone <this-repo> postal-logs
cd postal-logs
./deploy.sh init
nano .env

# 3. first start
./deploy.sh
./deploy.sh logs
```

`./deploy.sh init` copies `.env.example` to `.env` and seeds a fresh
`SESSION_SECRET`. You then fill in `HOSTNAME`, `ACME_EMAIL`,
`BOOTSTRAP_ADMIN_EMAIL`, and `BOOTSTRAP_ADMIN_PASSWORD`.

`./deploy.sh` itself pulls latest, makes sure `./data` is owned by the
container's runtime user, builds, and starts the stack. Caddy provisions
a Let's Encrypt cert on the first request to the hostname.

Open `https://<HOSTNAME>/` and sign in with the bootstrap admin email
and password from `.env`. **After signing in, remove
`BOOTSTRAP_ADMIN_PASSWORD` from `.env`** — leaving it there is harmless
to the app's behavior (it's ignored once any users exist), but it
shouldn't sit on disk longer than necessary. The app prints a startup
warning if it's still present.

## `deploy.sh` commands

| | |
|---|---|
| `./deploy.sh init` | First-time setup: copy `.env.example` to `.env`, seed `SESSION_SECRET`. |
| `./deploy.sh` | Pull, rebuild, restart. Fixes data-dir ownership for the `node` user (UID 1000). |
| `./deploy.sh logs` | Tail the last 200 lines of both containers, follow new output. |
| `./deploy.sh status` | Show container state + `/api/health` from inside the app container. |
| `./deploy.sh backup` | Run `./backup.sh` to take an online SQLite snapshot. |
| `./deploy.sh down` | Stop the stack. |

## `.env` reference

| Variable | Meaning |
|---|---|
| `HOSTNAME` | e.g. `postal-logs.example.com`. Caddy uses this for SSL. |
| `ACME_EMAIL` | Contact email for Let's Encrypt. |
| `SESSION_SECRET` | Long random string. `openssl rand -hex 32` — `./deploy.sh init` writes one for you. |
| `BOOTSTRAP_ADMIN_EMAIL` | Seeded as the first internal-staff admin on first boot. Ignored once any user exists. |
| `BOOTSTRAP_ADMIN_PASSWORD` | Initial password for the bootstrap admin (≥ 12 chars). Remove after first sign-in. |
| `SESSION_IDLE_DAYS` | (optional) idle-timeout for sessions, default 7. |
| `RETAIN_RAW_DAYS` | (optional) default 120. Raw events older than this are deleted nightly. |
| `SHOW_RAW_DAYS` | (optional) default 90. UI/CSV never look further back than this even if data is still on disk. |
| `NODE_ENV` | leave as `production` for normal use. |
| `PORT` | leave as `3000`; Caddy proxies to this. |

## First-time setup in the UI

1. Sign in at `https://<HOSTNAME>/` with the bootstrap credentials.
2. **Admin → Clients** → create a client. Optionally paste Postal's
   server-wide signing key now (set key); see below.
3. On the client, **+ mail server**. If the client already has a
   signing key set, you can leave the mail server's key blank — it will
   inherit. Otherwise, paste the key here.
4. The app reveals a unique webhook URL for the mail server. Copy it.
5. In Postal: that mail server → Webhooks → New webhook → paste the URL,
   tick the events you want (`MessageBounced`, `MessageDeliveryFailed`,
   `MessageSent`, `MessageDelayed`, `MessageHeld`, …), save.
6. Send a test message from Postal, click **refresh** in the mail server's
   info panel — the event should appear and the "Events in last 24h"
   counter ticks up.

### Where to get Postal's signing key

The signing key for webhooks is Postal's **server-wide** key (not a
per-domain DKIM record). On the Postal server:

```bash
postal default-dkim-record
```

Use the long base64 string after `p=`. The app accepts either that bare
base64 or a full PEM block. If verification fails ("bad_signature"),
the most common cause is using a per-domain DKIM record instead of
`default-dkim-record`.

## Permissions

- **Staff** (`isStaff = true`) see and manage everything.
- **Non-staff** users get **Memberships** on specific clients. Within a
  membership, you can optionally restrict the user to a subset of that
  client's mail servers ("scope"). Default is "all mail servers in this
  client, including ones added later".
- Scopes apply to the dashboard, events list, event detail, and CSV
  export. The suppression list is per-client (it deduplicates hard
  bounces across mail servers) and is not sub-scoped.

## Data and retention

- **`Event`**: full webhook payload as JSON, plus extracted columns
  (recipient, sender, subject, status, bounce type, message token, …).
  Visible in the UI for `SHOW_RAW_DAYS` (default 90); deleted by the
  nightly retention job after `RETAIN_RAW_DAYS` (default 120). The gap
  is deliberate: exports still work to the edge of the window.
- **`StatDaily`**: per-day counts per client per mail server per event
  type. Populated by the nightly retention job; kept indefinitely.
  Reserved for future long-range views (the dashboard itself reads
  live from `Event`).
- **`Suppression`**: every hard-bounced recipient, deduped per client,
  with first-seen / last-seen / count. Kept indefinitely. Powers the
  suppression CSV export, which survives the raw-event retention
  window.

## Dashboard behavior

- Ranges: last 1h, 6h, 24h, 7d, 30d. The bucket size (minute / hour /
  day) is chosen automatically.
- Chips above the chart let you hide or show individual event types
  for both the counter cards and the chart series.
- The count / % toggle switches the chart Y-axis between absolute
  counts and percentage of bucket total.
- `MessageDelayed` events are deduplicated by `messageToken` — one
  delayed *message* counts as one occurrence, no matter how many times
  Postal retried it. The events list has a separate toggle to see
  every retry attempt.

## Events list behavior

- Filters: client, mail server, event type, recipient (LIKE), sender
  (LIKE), subject (LIKE), date range.
- **Group Delayed retries by message** (default on): collapses
  `MessageDelayed` events with the same `messageToken` to a single
  row carrying a `× N` chip with the retry count. Click the chip to
  drill into the message and see every individual attempt; a clear
  button at the top resets the view.
- CSV export uses the un-grouped view so the file is one row per
  webhook event.

## Backups

`./deploy.sh backup` (or `./backup.sh`) runs `sqlite3 .backup` inside
the app container to take a consistent online snapshot, gzips it into
`./backups/`, and rotates to keep the last 14 days. SQLite is safe to
back up this way while the app is writing.

Suggested root crontab:

```
15 3 * * *  cd /root/postal-logs && ./backup.sh >> backups/cron.log 2>&1
```

For offsite copies, sync `./backups/` to object storage after the
script runs, e.g.:

```
gsutil rsync -d ./backups gs://your-bucket/postal-logs/
```

## Hardening notes

What the app and stack do out of the box:

- TLS-only via Caddy with HSTS, CSP (`default-src 'self'`),
  `Permissions-Policy`, `frame-ancestors 'none'`. The `Server`
  response header is stripped.
- Container runs as the `node` user (UID 1000), not root.
- Login (`POST /auth/login`) is rate-limited (10 attempts / 15 min / IP,
  429 on overflow). Login responses use a constant-time compare against
  a fake hash for non-existent users so timing can't leak which emails
  exist.
- Session cookies are `HttpOnly`, `Secure` (in production), `SameSite=Strict`,
  max age 14 days, with a separate idle-timeout (default 7 days, tunable
  via `SESSION_IDLE_DAYS`).
- Webhook signatures are verified against the configured Postal signing
  key. Duplicate deliveries are deduped by Postal's per-delivery UUID.
- Docker JSON-file log rotation is pinned at 10 MB × 5 files per
  container.

What you still own:

- **DNS** and **cloud firewall** must allow inbound 80/443.
- **SSH hardening** on the VM (key-only, fail2ban, etc.).
- **Offsite backup destination** (the script writes locally; you sync).
- **Postal-side firewalling** if you want to restrict who can call your
  webhook URL beyond the random per-mail-server token.

## Updating

```bash
cd postal-logs
git pull
./deploy.sh
```

Schema migrations run automatically at startup: `prisma migrate deploy`
if migrations exist on disk, otherwise `prisma db push` which
syncs the schema directly. Both are idempotent.

## Local development

```bash
# backend
cp .env.example .env.dev
# point HOSTNAME at localhost:3000, skip Caddy
npm install
DATABASE_URL=file:./data/dev.db npm run dev   # backend at :3000

# frontend (in another shell)
cd web && npm install && npm run dev          # Vite dev server at :5173
```

The Vite dev server proxies API calls to the backend; see
`web/vite.config.js`.

Generating a new schema migration:

```bash
DATABASE_URL=file:./data/dev.db npx prisma migrate dev --name <description>
```

Commit the resulting `prisma/migrations/` folder.
