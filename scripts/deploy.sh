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
docker compose -p sol up -d --no-build --remove-orphans
git rev-parse HEAD
docker compose -p sol ps
