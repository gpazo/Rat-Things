#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/aws-e2e-common.sh"

requested_id="${1:-${AWS_E2E_DEPLOYMENT_ID:-}}"
if [[ -z "$requested_id" ]]; then
  project_root="$(dirname "$script_dir")"
  if [[ -f "$project_root/.aws-e2e/latest" ]]; then
    requested_id="$(<"$project_root/.aws-e2e/latest")"
  fi
fi
if [[ -z "$requested_id" ]]; then
  echo "provide a deployment ID or run aws-e2e-deploy.sh first" >&2
  exit 1
fi

aws_e2e_configure "$requested_id"
aws_e2e_require aws node npm
if [[ ! -f "$runtime_env" ]]; then
  echo "runtime environment does not exist: $runtime_env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$runtime_env"
set +a

current_account="$(aws sts get-caller-identity --query Account --output text)"
current_arn="$(aws sts get-caller-identity --query Arn --output text)"
if [[ -z "${AWS_E2E_CALLER_ACCOUNT:-}" || -z "${AWS_E2E_CALLER_ARN:-}" ]]; then
  echo "runtime environment predates AWS caller pinning; redeploy with the current harness before running the focused console test" >&2
  exit 1
fi
if [[ "$current_account" != "$AWS_E2E_CALLER_ACCOUNT" ]]; then
  echo "AWS account mismatch: deployment uses $AWS_E2E_CALLER_ACCOUNT but current credentials use $current_account" >&2
  exit 1
fi
if [[ "$current_arn" != "$AWS_E2E_CALLER_ARN" ]]; then
  echo "AWS principal mismatch: deployment uses $AWS_E2E_CALLER_ARN but current credentials use $current_arn" >&2
  exit 1
fi
echo "Running console E2E against $deployment_id as $current_arn in $aws_region"

cd "$project_root"
umask 077
AWS_E2E_CONSOLE=true npm exec -- playwright test \
  --config=playwright.config.ts \
  e2e/console.live.aws.e2e.ts
