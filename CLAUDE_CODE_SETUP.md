# Claude Code: set up and deploy `postal-logs`

You are setting up a small internal web application called **postal-logs**
on behalf of the user. Source is provided as `postal-logs.tar.gz` in the
current directory.

Goal: end up with a Git repository the user can push to a private remote,
and a deployed instance running on a fresh Linux VM with automatic HTTPS,
ready to accept Postal webhooks.

Work through the phases below in order. After each phase, briefly tell the
user what you did and confirm before moving on. Do NOT do everything in one
shot — these are infrastructure steps the user should follow along with.

---

## Phase 0 — Gather inputs from the user

Before doing anything, ask the user for these. If they don't know yet, stop
and let them go get the answers; don't invent values.

1. **Hostname** the app will live at (e.g. `postal-logs.colada.ag`).
   DNS A-record must already point at the VM's public IP.
2. **VM SSH access** — host (IP or DNS), username, key path. Confirm the
   user has sudo on that VM.
3. **Git remote URL** — where the repo will be pushed (GitHub, GitLab, Gitea,
   self-hosted, …). Private repo recommended.
4. **Postal public key** — output of `postal default-dkim-record` on their
   Postal box, or the contents of the Postal server's DKIM public key. They
   can paste it later in the UI, but ask now so they know to fetch it.
5. **Bootstrap admin email + password** — first user who can sign in and
   invite others. Password must be at least 12 chars. These are seeded into
   the DB only on first boot (when the users table is empty); after that you
   can remove `BOOTSTRAP_ADMIN_PASSWORD` from `.env`.
6. **ACME email** for Let's Encrypt notifications.

Store the answers locally for use in later phases; do NOT echo secrets back
in chat output unless the user explicitly asks.

---

## Phase 1 — Unpack and initialize the local repo

Working in the user's current directory:

```bash
tar xzf postal-logs.tar.gz
cd postal-logs
git init -b main
git add -A
git commit -m "Initial commit: postal-logs scaffold"
```

Verify the tree looks right:

```
postal-logs/
  Caddyfile
  Dockerfile
  docker-compose.yml
  .env.example
  package.json
  prisma/schema.prisma
  src/
  web/
  README.md
```

If the user provided a Git remote URL in Phase 0, add it:

```bash
git remote add origin <URL>
```

**Do NOT push yet.** First we'll add deployment automation, then push as one
clean initial commit history.

---

## Phase 2 — Add a deploy script

The scaffold deploys with `docker compose up -d`, but the user wants
something even simpler. Create a `deploy.sh` at the repo root that handles
the common cases.

Create `deploy.sh` with this content:

```bash
#!/usr/bin/env bash
# Deploy / update postal-logs on this host.
# Usage:
#   ./deploy.sh           # pull latest, rebuild, restart
#   ./deploy.sh init      # first-time setup: copy .env.example, prompt to edit
#   ./deploy.sh logs      # tail logs
#   ./deploy.sh status    # show container status + healthcheck
set -euo pipefail
cd "$(dirname "$0")"

cmd="${1:-update}"

require_env() {
  if [[ ! -f .env ]]; then
    echo "error: .env not found. Run: ./deploy.sh init"
    exit 1
  fi
}

case "$cmd" in
  init)
    if [[ -f .env ]]; then
      echo ".env already exists. Edit it with your editor of choice."
      exit 0
    fi
    cp .env.example .env
    SECRET=$(openssl rand -hex 32)
    sed -i.bak "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env && rm -f .env.bak
    echo "Created .env with a fresh SESSION_SECRET."
    echo "Now edit .env to set HOSTNAME, ACME_EMAIL, BOOTSTRAP_ADMIN_EMAIL,"
    echo "and BOOTSTRAP_ADMIN_PASSWORD (>= 12 chars), then run: ./deploy.sh"
    ;;
  update)
    require_env
    git pull --ff-only || true
    docker compose pull || true
    docker compose up -d --build
    sleep 3
    docker compose ps
    ;;
  logs)
    require_env
    docker compose logs -f --tail=200
    ;;
  status)
    require_env
    docker compose ps
    echo
    echo "Health check:"
    docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health || echo "  unreachable"
    ;;
  down)
    require_env
    docker compose down
    ;;
  *)
    echo "Usage: $0 [init|update|logs|status|down]"
    exit 1
    ;;
esac
```

Make it executable:
```bash
chmod +x deploy.sh
git add deploy.sh
git commit -m "Add deploy.sh wrapper for common ops"
```

---

## Phase 3 — Add GitHub Actions for build verification (optional but useful)

If the user's remote is GitHub, add a CI workflow that builds the Docker
image on every push so problems surface before deploy. Skip if the remote
isn't GitHub.

Create `.github/workflows/build.yml`:

```yaml
name: build
on:
  push:
    branches: [main]
  pull_request:
jobs:
  docker-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Build image
        run: docker buildx build --load -t postal-logs:ci .
      - name: Smoke test (boot, hit /api/health)
        run: |
          docker run -d --name pe -p 3000:3000 \
            -e SESSION_SECRET=ci-secret-not-used \
            -e HOSTNAME=ci.local \
            postal-logs:ci
          # Wait for healthcheck
          for i in {1..30}; do
            if curl -fsS http://127.0.0.1:3000/api/health; then
              echo " — healthy"
              exit 0
            fi
            sleep 2
          done
          docker logs pe
          exit 1
```

```bash
git add .github/workflows/build.yml
git commit -m "CI: build image and smoke-test /api/health"
```

---

## Phase 4 — Push to remote

If the user added a remote in Phase 1:

```bash
git push -u origin main
```

Confirm the push succeeded. If CI was set up (Phase 3), tell the user to
check the Actions tab for the first build — they should see a green build
in a few minutes.

---

## Phase 5 — Prepare the VM

Walk the user through SSH-ing into their VM. Then run these commands on the
VM (NOT locally):

```bash
# 1. install docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# log out and back in so the group membership takes effect, or:
newgrp docker

# 2. open firewall (Ubuntu/Debian + ufw — skip if cloud firewall handles it)
sudo ufw allow 22/tcp || true
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable || true

# 3. clone the repo (use the user's remote URL)
git clone <REMOTE_URL> ~/postal-logs
cd ~/postal-logs
```

If the repo is private, the user needs to either:
- set up an SSH deploy key on the VM and add it to the repo, or
- use a personal access token in the HTTPS URL, or
- clone using their own credentials and `chown` to a deploy user.

Help them pick the path that matches their setup. Don't pick for them.

---

## Phase 6 — Configure environment on the VM

Still on the VM:

```bash
./deploy.sh init
```

This copies `.env.example` to `.env` and generates a `SESSION_SECRET`. Then
open `.env` and fill in the rest:

```bash
nano .env
```

The user must set:
- `HOSTNAME` — the domain they pointed at this VM
- `ACME_EMAIL` — for Let's Encrypt
- `BOOTSTRAP_ADMIN_EMAIL` — their own email, becomes the initial admin
- `BOOTSTRAP_ADMIN_PASSWORD` — ≥ 12 chars; only used on first boot

After first successful sign-in, `BOOTSTRAP_ADMIN_PASSWORD` can be removed
from `.env` — it's ignored once the users table is non-empty.

Confirm DNS is correct before continuing:
```bash
dig +short <HOSTNAME>
# should return this VM's public IP
```

If DNS isn't propagated yet, wait. Caddy will keep retrying the cert
provisioning, but the first start is cleaner if DNS already resolves.

---

## Phase 7 — First deploy

On the VM:

```bash
./deploy.sh
```

This builds the image and starts the stack. First build takes ~2–5 minutes.

Watch the logs to confirm Caddy gets a cert and the app reaches steady
state:

```bash
./deploy.sh logs
```

Expect to see:
- Caddy log line: `certificate obtained successfully`
- App log: `postal-logs listening on :3000`
- Then quiet, with periodic healthcheck pings

Stop tailing logs with Ctrl-C.

Check from a browser on a different machine:
```
https://<HOSTNAME>/
```

Should show the email + password sign-in form. The user signs in with
`BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` from `.env` and lands
in the dashboard with admin privileges. They can change that password from
the header menu, and invite more users from **Admin → Users** (admin
sets each user's initial password and hands it over out of band).

---

## Phase 8 — Wire up Postal

In the postal-logs UI:
1. **Admin → Clients** → create a client
2. On that client → add a mail server. The user pastes the public key from
   `postal default-dkim-record` (just the `p=...` part is fine; the app
   normalizes either bare base64 or full PEM).
3. Click **show webhook url & test** on the new mail server. Copy the URL.

Then on the Postal side:
1. Postal admin → the corresponding mail server → Webhooks
2. New webhook, paste the URL, select the events to forward
   (`MessageBounced`, `MessageDeliveryFailed`, `MessageSent`, etc.)
3. Save

Back in postal-logs, send a test message through Postal and click
**refresh** on the test panel — the event should appear.

If it doesn't, on the VM run:
```bash
./deploy.sh logs
```
and look for `webhook signature mismatch` (wrong public key) or
`unknown_webhook` (wrong URL). Report findings to the user.

---

## Phase 9 — Wrap up

Tell the user:
- The instance is at `https://<HOSTNAME>/`
- To update: `cd ~/postal-logs && ./deploy.sh`
- To view logs: `./deploy.sh logs`
- To check status: `./deploy.sh status`
- Backup: the SQLite file lives at `~/postal-logs/data/postal-logs.db`.
  A cron job that copies it elsewhere nightly is a good idea — offer to set
  one up if they want.

Stop here. Don't run a backup setup unless asked. Don't push further code
changes unless asked.

---

## Notes for Claude Code on conduct

- Never paste secrets (bootstrap admin password, session secret, etc.) into chat
  responses. Refer to them by name only.
- Prefer asking the user to copy/paste values themselves rather than having
  you echo them.
- When running commands on the VM, run them one at a time and report
  output. Don't chain destructive commands.
- If `docker compose up -d --build` fails, capture the last 50 lines of
  output and show the user before retrying.
- If the Let's Encrypt cert fails to provision, the two common causes are
  (a) DNS not yet pointing at the VM, (b) port 80 not open / not reachable.
  Diagnose in that order.
- Resist the urge to "improve" the scaffold during setup. If something
  needs changing, finish the deploy first, then propose changes
  afterward as a separate diff for the user to review.
