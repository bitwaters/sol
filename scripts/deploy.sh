#!/usr/bin/env bash
# Execute only from a clean checkout of a GitHub-published revision.
set -euo pipefail
cd "$(dirname "$0")/.."
export SOL_ENV_FILE="${SOL_ENV_FILE:-/etc/sol/sol.env}"
export SOL_DATA_DIR="${SOL_DATA_DIR:-/var/lib/sol}"
if [[ "$(id -u)" != 0 ]]; then
  echo 'Deployment requires root for runtime-directory ownership.' >&2
  exit 1
fi
if ! git diff --quiet HEAD --; then
  echo 'Tracked server files changed; stop and resolve changes locally through GitHub.' >&2
  exit 1
fi
if [[ ! -s "$SOL_ENV_FILE" ]]; then
  echo 'Transfer the locally prepared credentials file over SSH before deployment.' >&2
  exit 1
fi
chmod 600 "$SOL_ENV_FILE"
install -d -m 700 -o 1000 -g 1000 "$SOL_DATA_DIR"
# The blacklist is a versioned asset; only its checked-out contents are deployed.
install -m 644 -o 1000 -g 1000 data/cex-blacklist.json "$SOL_DATA_DIR/cex-blacklist.json"
docker compose -p sol config --quiet
docker compose -p sol build
# Mark a planned restart in runtime state; data-gap accounting remains enabled.
if [[ -n "$(docker compose -p sol ps --status running -q bot)" ]]; then
  docker compose -p sol exec -T bot node --input-type=module <<'JS'
import Database from 'better-sqlite3';
const db=new Database('/app/data/meme.sqlite');db.pragma('busy_timeout=5000');
const now=Math.floor(Date.now()/1000);
db.prepare("INSERT INTO kv(key,value,updated_at) VALUES ('planned_restart',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
  .run(JSON.stringify({requestedAt:now,expiresAt:now+600}),now);db.close();
JS
fi
docker compose -p sol up -d --no-build --remove-orphans
git rev-parse HEAD
docker compose -p sol ps
