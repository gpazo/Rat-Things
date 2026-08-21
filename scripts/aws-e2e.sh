#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deployment_id="${AWS_E2E_DEPLOYMENT_ID:-e2e-$(date -u +%y%m%d%H%M)}"
started_at="$(date +%s)"
test_status=0
destroy_status=0

cleanup() {
  local exit_status="$?"
  trap - EXIT INT TERM
  set +e
  if [[ "$exit_status" -ne 0 ]]; then
    aws_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"
    microvm_log_group="/rat-things-${deployment_id}/microvms"
    if aws logs describe-log-groups \
      --region "$aws_region" \
      --log-group-name-prefix "$microvm_log_group" \
      --query 'logGroups[?logGroupName==`'"$microvm_log_group"'`].logGroupName | [0]' \
      --output text 2>/dev/null | rg -qx "$microvm_log_group"; then
      echo "MicroVM diagnostics captured before teardown:"
      aws logs tail "$microvm_log_group" \
        --region "$aws_region" \
        --since 30m \
        --format short 2>&1 || true
    fi
  fi
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
