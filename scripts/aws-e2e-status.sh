#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname "$script_dir")"
run_root="$project_root/.aws-e2e"
requested_id="${1:-}"

print_status() {
  local deployment_id="$1"
  local directory="$run_root/$deployment_id"
  local state="missing"
  if [[ -f "$directory/destroyed.txt" ]]; then
    state="destroyed"
  elif [[ -f "$directory/runtime.env" && -f "$directory/terraform.tfstate" ]]; then
    state="ready-local"
  elif [[ -f "$directory/terraform.tfstate" ]]; then
    state="partial-local"
  fi
  local marker=""
  if [[ -n "${latest:-}" && "$latest" == "$deployment_id" ]]; then
    marker=" latest"
  fi
  printf '%s: %s%s\n' "$deployment_id" "$state" "$marker"
}

if [[ -n "$requested_id" ]]; then
  if [[ ! "$requested_id" =~ ^[a-z0-9][a-z0-9-]{2,13}$ ]]; then
    echo "deployment ID must be 3-14 lowercase letters, digits, or hyphens" >&2
    exit 1
  fi
  print_status "$requested_id"
  exit 0
fi

if [[ -f "$run_root/latest" ]]; then
  latest="$(<"$run_root/latest")"
  echo "latest: $latest"
else
  latest=""
  echo "latest: none"
fi

found="false"
if [[ -d "$run_root" ]]; then
  for directory in "$run_root"/*; do
    [[ -d "$directory" ]] || continue
    deployment_id="${directory##*/}"
    [[ "$deployment_id" =~ ^[a-z0-9][a-z0-9-]{2,13}$ ]] || continue
    [[ -f "$directory/terraform.tfstate" || -f "$directory/runtime.env" || -f "$directory/destroyed.txt" ]] || continue
    found="true"
    print_status "$deployment_id"
  done
fi
if [[ "$found" == "false" ]]; then
  echo "deployments: none"
fi
