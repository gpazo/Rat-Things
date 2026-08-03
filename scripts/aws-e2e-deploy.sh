#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/aws-e2e-common.sh"

requested_id="${1:-${AWS_E2E_DEPLOYMENT_ID:-e2e-$(date -u +%y%m%d%H%M%S)}}"
aws_e2e_configure "$requested_id"
aws_e2e_require aws git jq node npm openssl terraform

umask 077
mkdir -p "$run_dir"
printf '%s\n' "$deployment_id" >"$run_root/latest"

account_id="$(aws sts get-caller-identity --query Account --output text)"
caller_arn="$(aws sts get-caller-identity --query Arn --output text)"
echo "Deploying ephemeral AWS validation stack $deployment_id"
echo "AWS account: $account_id ($caller_arn)"
echo "AWS region:  $aws_region"

cd "$project_root"
npm run package

aws_e2e_terraform init -input=false

echo "Applying the complete ephemeral stack..."
aws_e2e_terraform apply \
  -state="$state_file" \
  -input=false \
  -auto-approve \
  "${tf_vars[@]}"

github_secret="aws-e2e-${deployment_id}-$(openssl rand -hex 32)"
gitlab_secret="whsec_$(openssl rand -base64 32 | tr -d '\n')"
teams_secret="$(openssl rand -base64 32 | tr -d '\n')"
github_secret_file="$run_dir/github-webhook-secret"
gitlab_secret_file="$run_dir/gitlab-webhook-secret"
teams_secret_file="$run_dir/teams-webhook-secret"
teams_workflow_file="$run_dir/teams-workflow-url"

cleanup_secret_files() {
  local secret_file
  for secret_file in "$github_secret_file" "$gitlab_secret_file" "$teams_secret_file" "$teams_workflow_file"; do
    if [[ -f "$secret_file" ]]; then
      : >"$secret_file"
      rm -f -- "$secret_file"
    fi
  done
}
trap cleanup_secret_files EXIT

printf '%s' "$github_secret" >"$github_secret_file"
printf '%s' "$gitlab_secret" >"$gitlab_secret_file"
printf '%s' "$teams_secret" >"$teams_secret_file"
printf '%s' "$(aws_e2e_output delivery_capture_url)" >"$teams_workflow_file"

aws secretsmanager put-secret-value \
  --region "$aws_region" \
  --secret-id "$(aws_e2e_output github_webhook_secret_arn)" \
  --secret-string "file://$github_secret_file" >/dev/null
aws secretsmanager put-secret-value \
  --region "$aws_region" \
  --secret-id "$(aws_e2e_output gitlab_webhook_secret_arn)" \
  --secret-string "file://$gitlab_secret_file" >/dev/null
aws secretsmanager put-secret-value \
  --region "$aws_region" \
  --secret-id "$(aws_e2e_output teams_webhook_secret_arn)" \
  --secret-string "file://$teams_secret_file" >/dev/null
aws secretsmanager put-secret-value \
  --region "$aws_region" \
  --secret-id "$(aws_e2e_output teams_workflow_secret_arn)" \
  --secret-string "file://$teams_workflow_file" >/dev/null

github_repository_url="https://github.com/octocat/Hello-World.git"
gitlab_repository_url="https://gitlab.com/gitlab-org/gitlab-test.git"
github_sha="$(git ls-remote "$github_repository_url" HEAD | awk 'NR == 1 { print $1 }')"
gitlab_sha="$(git ls-remote "$gitlab_repository_url" HEAD | awk 'NR == 1 { print $1 }')"
if [[ -z "$github_sha" || -z "$gitlab_sha" ]]; then
  echo "could not resolve public repository HEAD revisions" >&2
  exit 1
fi

: >"$runtime_env"
chmod 600 "$runtime_env"
webhook_urls="$(aws_e2e_terraform output -state="$state_file" -json webhook_urls)"
aws_e2e_export AWS_E2E "true"
aws_e2e_export AWS_E2E_DEPLOYMENT_ID "$deployment_id"
aws_e2e_export AWS_E2E_ENABLE_MICROVM "$microvm_enabled"
aws_e2e_export AWS_E2E_REAL_CODEX "$real_codex_enabled"
aws_e2e_export AWS_E2E_CODEX_MODEL_ID "$codex_model_id"
aws_e2e_export AWS_REGION "$aws_region"
aws_e2e_export AWS_DEFAULT_REGION "$aws_region"
aws_e2e_export AGENT_RUNTIME_API_URL "$(aws_e2e_output api_endpoint)"
aws_e2e_export ARTIFACT_BUCKET "$(aws_e2e_output artifact_bucket_name)"
aws_e2e_export RUNS_TABLE_NAME "$(aws_e2e_output runs_table_name)"
aws_e2e_export RUN_QUEUE_URL "$(aws_e2e_output run_queue_url)"
aws_e2e_export RUN_FAILURE_QUEUE_URL "$(aws_e2e_output run_failure_queue_url)"
aws_e2e_export STATE_STREAM_FAILURE_QUEUE_URL "$(aws_e2e_output state_stream_failure_queue_url)"
aws_e2e_export NOTIFIER_DELIVERY_FAILURE_QUEUE_URL "$(aws_e2e_output notifier_delivery_failure_queue_url)"
aws_e2e_export TERMINAL_EVENTS_QUEUE_URL "$(aws_e2e_output terminal_events_queue_url)"
aws_e2e_export DELIVERY_CAPTURE_QUEUE_URL "$(aws_e2e_output delivery_capture_queue_url)"
aws_e2e_export GITHUB_WEBHOOK_URL "$(jq -r '.github' <<<"$webhook_urls")"
aws_e2e_export GITLAB_WEBHOOK_URL "$(jq -r '.gitlab' <<<"$webhook_urls")"
aws_e2e_export TEAMS_WEBHOOK_URL "$(jq -r '.teams' <<<"$webhook_urls")"
aws_e2e_export GITHUB_WEBHOOK_SIGNING_SECRET "$github_secret"
aws_e2e_export GITLAB_WEBHOOK_SIGNING_TOKEN "$gitlab_secret"
aws_e2e_export TEAMS_WEBHOOK_SIGNING_SECRET "$teams_secret"
aws_e2e_export AWS_E2E_GITHUB_REPOSITORY_URL "$github_repository_url"
aws_e2e_export AWS_E2E_GITHUB_REPOSITORY "octocat/Hello-World"
aws_e2e_export AWS_E2E_GITHUB_SHA "$github_sha"
aws_e2e_export AWS_E2E_GITLAB_REPOSITORY_URL "$gitlab_repository_url"
aws_e2e_export AWS_E2E_GITLAB_REPOSITORY "gitlab-org/gitlab-test"
aws_e2e_export AWS_E2E_GITLAB_SHA "$gitlab_sha"
aws_e2e_export AWS_E2E_TIMEOUT_MS "420000"

cleanup_secret_files
trap - EXIT

echo "Ephemeral stack is ready."
echo "Runtime environment: $runtime_env"
echo "Run tests: $script_dir/aws-e2e-test.sh $deployment_id"
echo "Teardown:  $script_dir/aws-e2e-destroy.sh $deployment_id"
