#!/usr/bin/env bash

aws_e2e_configure() {
  local requested_id="$1"

  if [[ ! "$requested_id" =~ ^[a-z0-9][a-z0-9-]{2,13}$ ]]; then
    echo "deployment ID must be 3-14 lowercase letters, digits, or hyphens" >&2
    return 1
  fi

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  project_root="$(dirname "$script_dir")"
  terraform_root="$project_root/testing/aws"
  deployment_id="$requested_id"
  aws_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  if [[ -z "$aws_region" ]]; then
    aws_region="$(aws configure get region 2>/dev/null || true)"
  fi
  aws_region="${aws_region:-us-west-2}"
  aws_profile="${AWS_PROFILE:-}"
  microvm_enabled="${AWS_E2E_ENABLE_MICROVM:-true}"
  microvm_base_image_version="${AWS_E2E_MICROVM_BASE_IMAGE_VERSION:-}"
  real_codex_enabled="${AWS_E2E_REAL_CODEX:-false}"
  codex_model_id="${AWS_E2E_CODEX_MODEL_ID:-openai.gpt-5.6-terra}"
  run_root="$project_root/.aws-e2e"
  run_dir="$run_root/$deployment_id"
  state_file="$run_dir/terraform.tfstate"
  runtime_env="$run_dir/runtime.env"
  tf_data_dir="$run_dir/terraform-data"
  terraform_plugin_cache="${TF_PLUGIN_CACHE_DIR:-$run_root/plugin-cache}"

  tf_vars=(
    "-var=aws_region=$aws_region"
    "-var=deployment_id=$deployment_id"
    "-var=enable_microvm=$microvm_enabled"
    "-var=codex_model_id=$codex_model_id"
  )
  if [[ -n "$microvm_base_image_version" ]]; then
    tf_vars+=("-var=microvm_base_image_version=$microvm_base_image_version")
  fi
  if [[ -n "$aws_profile" ]]; then
    tf_vars+=("-var=aws_profile=$aws_profile")
  fi
}

aws_e2e_require() {
  local command_name
  for command_name in "$@"; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "required command not found: $command_name" >&2
      return 1
    fi
  done
}

aws_e2e_terraform() {
  mkdir -p "$terraform_plugin_cache"
  TF_DATA_DIR="$tf_data_dir" TF_PLUGIN_CACHE_DIR="$terraform_plugin_cache" \
    terraform -chdir="$terraform_root" "$@"
}

aws_e2e_output() {
  local output_name="$1"
  aws_e2e_terraform output -state="$state_file" -json |
    jq -r --arg output_name "$output_name" '.[$output_name].value // empty'
}

aws_e2e_export() {
  local name="$1"
  local value="$2"
  printf 'export %s=%q\n' "$name" "$value" >>"$runtime_env"
}
