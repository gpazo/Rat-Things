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
"$script_dir/bootstrap.sh" --reset

set -a
# shellcheck disable=SC1091
source "$script_dir/localstack.env"
set +a

cd "$project_root"
npm exec -- vitest run tests/localstack/workflow.test.ts --no-file-parallelism
