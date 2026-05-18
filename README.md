# postal-logs

A small multi-tenant app that receives webhooks from one or more Postal mail
servers, stores the events, and lets internal staff (and optionally clients)
browse, filter, and export them as CSV.

- Webhook receiver with RSA signature verification (one URL per mail server)
- Multi-tenant: clients → mail servers → events
- Built-in email + password login. Bootstrap admin is seeded from env on
  first boot; further users are invited by an admin who sets their initial
  password and hands it out of band.
- 90/120-day retention on raw events, forever-retained daily stats + suppression list
- Single Node.js container, SQLite on disk, Caddy in front for automatic HTTPS

## Quick deploy (fresh VM)

You need a small Linux VM with a public IP, ports 80 and 443 open, and a
DNS A-record pointing your hostname at it (e.g.
`postal-logs.colada.ag → <vm-ip>`).

```bash
# 1. install docker + compose plugin (Debian/Ubuntu)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. clone and configure
git clone <this-repo> postal-logs
cd postal-logs
cp .env.example .env
nano .env   # set HOSTNAME, ACME_EMAIL, SESSION_SECRET, BOOTSTRAP_ADMIN_*

# 3. start
docker compose up -d
docker compose logs -f
```

That's it. Caddy will provision a Let's Encrypt cert automatically the first
time someone hits the hostname. Open `https://<your-hostname>/` and sign in
with the bootstrap admin email + password from `.env`.

## What you set in `.env`

| Variable | Meaning |
|---|---|
| `HOSTNAME` | e.g. `postal-logs.colada.ag` — Caddy uses this for SSL |
| `ACME_EMAIL` | contact email for Let's Encrypt |
| `SESSION_SECRET` | a long random string (`openssl rand -hex 32`) |
| `BOOTSTRAP_ADMIN_EMAIL` | seeded as the first internal-staff admin on first boot |
| `BOOTSTRAP_ADMIN_PASSWORD` | initial password for the bootstrap admin (≥ 12 chars). Remove from `.env` after first sign-in. |

The bootstrap pair is only used when the users table is empty. After that,
new users are created from **Admin → Users** with an initial password set
by the admin; users can change their own password from the header menu.

## First-time setup in the UI

1. Sign in at `https://<HOSTNAME>/` with `BOOTSTRAP_ADMIN_EMAIL` and
   `BOOTSTRAP_ADMIN_PASSWORD`.
2. Go to **Admin → Clients**, create a client.
3. Go to **Admin → Mail Servers** under that client, create a mail server.
   The app generates a unique webhook URL and asks for the Postal server's
   public key (paste from your Postal server's
   `/api/v1/dkim` endpoint, or upload).
4. Click **show webhook url & test** on the mail server. Copy the URL.
5. In Postal, configure a webhook on that mail server pointing at the
   copied URL, subscribing to whichever events you want
   (`MessageBounced`, `MessageDeliveryFailed`, `MessageSent`, etc.).
6. Send a test message from Postal, then click **refresh** on the test
   panel — the event should appear within a couple of seconds. The
   "Events in last 24h" counter will tick up.

If "Last event received" stays empty after a test send:
- Check `docker compose logs -f app` for `webhook signature mismatch` or
  `unknown_webhook`. Mismatch = wrong public key. Unknown = wrong URL.
- Verify Postal can reach the public hostname from its host.
- Confirm the public key matches `postal default-dkim-record` output.

## Schema migrations

The container runs `prisma migrate deploy` on every start; if no migration
files exist (e.g. very first run before you've committed any), it falls
back to `prisma db push` which creates the schema directly from
`schema.prisma`. Both are idempotent.

If you ever change the schema, generate a migration on your dev box:
```bash
cd postal-logs
DATABASE_URL=file:./data/dev.db npx prisma migrate dev --name <description>
```
Commit the resulting `prisma/migrations/` folder and rebuild.

## Data and retention

- **events table**: full JSON per event. Visible in UI and CSV export for the
  last 90 days. Rows older than 120 days are deleted nightly by the retention
  job. The 30-day gap is intentional — exports still work right up to the
  edge, and you have a buffer to notice if something's wrong.
- **stats_daily table**: per-day counts per client per mail server per event
  type. Never deleted. Powers the dashboard's long-term charts.
- **suppression table**: every hard-bounced recipient, deduped per client.
  Never deleted. Powers the suppression CSV export which survives the
  retention window.

## Backups

Just back up `./data/postal-logs.db`. It's a single SQLite file. A
nightly `sqlite3 postal-logs.db ".backup '/backup/...'"` to another
volume or to GCS is enough.

## Updating

```bash
git pull && docker compose up -d --build
```

Schema migrations run automatically at startup.

## Local development

```bash
cp .env.example .env.dev
# point HOSTNAME at localhost, skip Caddy
cd web && npm install && npm run dev   # frontend at :5173
# in another shell
npm install && npm run dev             # backend at :3000
```
