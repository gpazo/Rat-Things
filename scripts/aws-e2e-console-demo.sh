#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname "$script_dir")"
requested_id="${1:-${AWS_E2E_DEPLOYMENT_ID:-}}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required to export the live console demo as H.264 MP4" >&2
  exit 1
fi

export RAT_THINGS_CONSOLE_VIDEO=on
if [[ -n "$requested_id" ]]; then
  "$script_dir/aws-e2e-console-test.sh" "$requested_id"
else
  "$script_dir/aws-e2e-console-test.sh"
fi

cd "$project_root"
export RAT_THINGS_CONSOLE_DEMO_PATH="${RAT_THINGS_CONSOLE_DEMO_PATH:-$project_root/test-results/rat-things-console-live-demo.mp4}"
node scripts/export-console-demo.mjs
