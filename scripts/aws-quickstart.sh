#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

journey_started_at_ms="$(node -p 'Date.now()')"

if [[ ! -x node_modules/.bin/tsx ]]; then
  >&2 echo '[0/6] Install pinned dependencies'
  npm ci
  >&2 echo '      ready'
fi

RAT_THINGS_QUICKSTART_STARTED_AT_MS="$journey_started_at_ms" \
  exec node_modules/.bin/tsx scripts/aws-quickstart.ts "$@"
