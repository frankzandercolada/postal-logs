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
