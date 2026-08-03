#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deployment_id="${AWS_E2E_DEPLOYMENT_ID:-e2e-$(date -u +%y%m%d%H%M%S)}"
started_at="$(date +%s)"
test_status=0
destroy_status=0

cleanup() {
  local exit_status="$?"
  trap - EXIT INT TERM
  set +e
  "$script_dir/aws-e2e-destroy.sh" "$deployment_id"
  destroy_status=$?
  set -e
  elapsed_seconds="$(( $(date +%s) - started_at ))"
  echo "AWS live E2E elapsed time: ${elapsed_seconds}s"
  if [[ "$destroy_status" -ne 0 ]]; then
    echo "AWS live E2E teardown failed; rerun: $script_dir/aws-e2e-destroy.sh $deployment_id" >&2
    exit "$destroy_status"
  fi
  if [[ "$test_status" -ne 0 ]]; then
    exit "$test_status"
  fi
  exit "$exit_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$script_dir/aws-e2e-deploy.sh" "$deployment_id"
set +e
"$script_dir/aws-e2e-test.sh" "$deployment_id"
test_status=$?
set -e
if [[ "$test_status" -ne 0 ]]; then
  exit "$test_status"
fi
