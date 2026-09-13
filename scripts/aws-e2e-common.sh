#!/usr/bin/env bash

aws_e2e_source_runtime_defaults() {
  local env_file="$1"
  if [[ ! -f "$env_file" ]]; then
    return 0
  fi

  local tracked_names=(
    AWS_PROFILE
    AWS_REGION
    AWS_DEFAULT_REGION
    AWS_E2E_ENABLE_MICROVM
    AWS_E2E_ENABLE_EC2_WORKER
    AWS_E2E_EC2_WORKER_AMI_ID
    AWS_E2E_EC2_WORKER_IMAGE
    AWS_E2E_ENVIRONMENT_RELAY_IMAGE
    AWS_E2E_ENVIRONMENT_RELAY_ORIGIN_HOSTNAME
    AWS_E2E_ENVIRONMENT_RELAY_ORIGIN_CERTIFICATE_ARN
    AWS_E2E_MICROVM_BASE_IMAGE_VERSION
    AWS_E2E_REAL_CODEX
    AWS_E2E_CODEX_MODEL_ID
    AWS_E2E_OAUTH_APP_SECRET_ARNS
    AWS_E2E_PUBLICATION_DOMAIN
    AWS_E2E_PUBLICATION_ROUTE53_ZONE_ID
    AWS_E2E_ENABLE_SLACK_WEBHOOK
    AWS_E2E_SLACK_SIGNING_SECRET_FILE
    TF_PLUGIN_CACHE_DIR
  )
  local override_names=()
  local override_values=()
  local name
  for name in "${tracked_names[@]}"; do
    if declare -p "$name" >/dev/null 2>&1; then
      override_names+=("$name")
      override_values+=("${!name}")
    fi
  done

  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a

  local index
  for index in "${!override_names[@]}"; do
    printf -v "${override_names[$index]}" '%s' "${override_values[$index]}"
    export "${override_names[$index]}"
  done
}

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
  ec2_worker_enabled="${AWS_E2E_ENABLE_EC2_WORKER:-false}"
  ec2_worker_ami_id="${AWS_E2E_EC2_WORKER_AMI_ID:-}"
  ec2_worker_image="${AWS_E2E_EC2_WORKER_IMAGE:-}"
  environment_relay_image="${AWS_E2E_ENVIRONMENT_RELAY_IMAGE:-}"
  environment_relay_origin_hostname="${AWS_E2E_ENVIRONMENT_RELAY_ORIGIN_HOSTNAME:-}"
  environment_relay_origin_certificate_arn="${AWS_E2E_ENVIRONMENT_RELAY_ORIGIN_CERTIFICATE_ARN:-}"
  if [[ -n "$environment_relay_image$environment_relay_origin_hostname$environment_relay_origin_certificate_arn" && ( -z "$environment_relay_image" || -z "$environment_relay_origin_hostname" || -z "$environment_relay_origin_certificate_arn" ) ]]; then
    echo "Dedicated HTTPS e2e requires its pinned relay image, origin hostname and regional certificate ARN together" >&2
    return 1
  fi
  if [[ "$ec2_worker_enabled" == "true" && ( -z "$ec2_worker_ami_id" || -z "$ec2_worker_image" ) ]]; then
    echo "EC2 e2e requires AWS_E2E_EC2_WORKER_AMI_ID and AWS_E2E_EC2_WORKER_IMAGE pinned inputs" >&2
    return 1
  fi
  microvm_base_image_version="${AWS_E2E_MICROVM_BASE_IMAGE_VERSION:-}"
  real_codex_enabled="${AWS_E2E_REAL_CODEX:-false}"
  codex_model_id="${AWS_E2E_CODEX_MODEL_ID:-openai.gpt-5.6-terra}"
  oauth_app_secret_arns="${AWS_E2E_OAUTH_APP_SECRET_ARNS:-}"
  slack_webhook_enabled="${AWS_E2E_ENABLE_SLACK_WEBHOOK:-false}"
  if [[ "$slack_webhook_enabled" != "true" && "$slack_webhook_enabled" != "false" ]]; then
    echo "AWS_E2E_ENABLE_SLACK_WEBHOOK must be true or false" >&2
    return 1
  fi
  if [[ -z "$oauth_app_secret_arns" ]]; then
    oauth_app_secret_arns='{}'
  fi
  if ! jq -e '
    type == "object" and
    all(to_entries[]; (.key | test("^[a-z][a-z0-9-]{0,63}$")) and (.value | type == "string" and test("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$")))
  ' >/dev/null <<<"$oauth_app_secret_arns"; then
    echo "AWS_E2E_OAUTH_APP_SECRET_ARNS must be a JSON object mapping plugin IDs to Secrets Manager ARNs" >&2
    return 1
  fi
  publication_domain="${AWS_E2E_PUBLICATION_DOMAIN:-}"
  publication_zone_id="${AWS_E2E_PUBLICATION_ROUTE53_ZONE_ID:-}"
  publication_enabled="false"
  if [[ -n "$publication_domain" || -n "$publication_zone_id" ]]; then
    if [[ -z "$publication_domain" || -z "$publication_zone_id" ]]; then
      echo "AWS_E2E_PUBLICATION_DOMAIN and AWS_E2E_PUBLICATION_ROUTE53_ZONE_ID must be set together" >&2
      return 1
    fi
    publication_enabled="true"
  fi
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
    "-var=enable_ec2_worker=$ec2_worker_enabled"
    "-var=codex_model_id=$codex_model_id"
    "-var=integration_oauth_app_secret_arns=$oauth_app_secret_arns"
    "-var=enable_slack_webhook=$slack_webhook_enabled"
    "-var=enable_publication_delivery=$publication_enabled"
  )
  if [[ "$ec2_worker_enabled" == "true" ]]; then
    tf_vars+=("-var=ec2_worker_ami_id=$ec2_worker_ami_id" "-var=ec2_worker_image=$ec2_worker_image")
  fi
  if [[ -n "$environment_relay_image" ]]; then
    tf_vars+=("-var=environment_relay_image=$environment_relay_image"
      "-var=environment_relay_origin_hostname=$environment_relay_origin_hostname"
      "-var=environment_relay_origin_certificate_arn=$environment_relay_origin_certificate_arn")
  fi
  if [[ "$publication_enabled" == "true" ]]; then
    tf_vars+=(
      "-var=publication_base_domain=$publication_domain"
      "-var=publication_route53_zone_id=$publication_zone_id"
    )
  fi
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
