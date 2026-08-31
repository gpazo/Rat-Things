#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/aws-e2e-common.sh"

requested_id="${1:-${AWS_E2E_DEPLOYMENT_ID:-}}"
if [[ -z "$requested_id" ]]; then
  echo "provide the retained AWS deployment ID" >&2
  exit 1
fi

aws_e2e_configure "$requested_id"
if [[ ! -f "$runtime_env" ]]; then
  echo "runtime environment does not exist: $runtime_env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$runtime_env"
set +a

export AWS_E2E_LINEAR_DEMO=true
export RAT_THINGS_CONSOLE_VIDEO=on
export AWS_E2E_LINEAR_SCREENSHOT_DIR="${AWS_E2E_LINEAR_SCREENSHOT_DIR:-$project_root/assets}"
: "${AWS_E2E_LINEAR_CONNECTION_ALIAS:?set AWS_E2E_LINEAR_CONNECTION_ALIAS}"
: "${AWS_E2E_LINEAR_MARKER:?set AWS_E2E_LINEAR_MARKER}"

cd "$project_root"
npm exec -- playwright test --config=playwright.config.ts e2e/linear.live.aws.demo.e2e.ts

export RAT_THINGS_CONSOLE_DEMO_PATH="${RAT_THINGS_CONSOLE_DEMO_PATH:-$project_root/assets/linear-live-aws-console.mp4}"
node scripts/export-console-demo.mjs
