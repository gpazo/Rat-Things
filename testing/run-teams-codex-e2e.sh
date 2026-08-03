#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname "$script_dir")"

cleanup() {
  if [[ "${LOCALSTACK_KEEP_RUNNING:-false}" != "true" ]]; then
    "$script_dir/bootstrap.sh" --down || true
  fi
}

trap cleanup EXIT
cd "$project_root"

if ! npm exec -- codex login status; then
  echo "A local ChatGPT-backed Codex session is required. Run: npm exec -- codex login" >&2
  exit 1
fi

"$script_dir/bootstrap.sh" --reset

set -a
# shellcheck disable=SC1091
source "$script_dir/localstack.env"
set +a

export CODEX_AUTH_MODE=chatgpt
export CODEX_TOOL_NETWORK_ACCESS=false
export DEFAULT_AGENT_DRIVER=codex
export LOCALSTACK_REAL_CODEX=true
export TEAMS_DELIVERY_MODE=threaded-gateway

npm exec -- vitest run tests/localstack/workflow.test.ts \
  --no-file-parallelism \
  -t "runs a signed Teams request through durable state, events, and Teams delivery"
