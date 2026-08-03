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
if [[ ! -f "$runtime_env" ]]; then
  echo "runtime environment does not exist: $runtime_env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$runtime_env"
set +a

cd "$project_root"
npm exec -- vitest run tests/aws/workflow.test.ts --no-file-parallelism
