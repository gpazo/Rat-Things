#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
source scripts/aws-e2e-common.sh
deployment="${1:?Pass the existing deployment ID}"
seconds="${2:-0}"
[[ "$deployment" =~ ^[a-z0-9][a-z0-9-]{2,13}$ && "$seconds" =~ ^(0|[1-9][0-9]{0,4})$ && "$seconds" -le 86400 ]] || { echo 'Invalid deployment or duration (0-86400 seconds).' >&2; exit 1; }
aws_e2e_source_runtime_defaults ".aws-e2e/$deployment/runtime.env"
aws_e2e_configure "$deployment"
[[ "${AWS_E2E_ENABLE_VALIDATION_OBSERVER:-false}" == true ]] || { echo 'Enable and deploy the validation observer first.' >&2; exit 1; }
[[ "$(aws sts get-caller-identity --query Account --output text)" == "${AWS_E2E_CALLER_ACCOUNT:?Missing recorded account}" ]] || { echo 'AWS account does not match the deployment.' >&2; exit 1; }
umask 077
run_id="observer-$(date -u +%Y%m%dT%H%M%S)-$RANDOM"
directory="$run_dir/$run_id"
mkdir "$directory"
aws_e2e_terraform output -state="$state_file" -json validation_observer > "$directory/configuration.json"
jq -e '.task_definition != null' "$directory/configuration.json" >/dev/null || { echo 'No accepted observer task definition is deployed.' >&2; exit 1; }
cluster="$(jq -r .cluster_arn "$directory/configuration.json")"
family="$(jq -r '.task_definition | split("/")[-1] | split(":")[0]' "$directory/configuration.json")"
[[ "$(aws ecs list-tasks --region "$aws_region" --cluster "$cluster" --family "$family" --desired-status RUNNING --query 'length(taskArns)' --output text)" == 0 ]] || { echo 'An observer is already active; inspect it before starting another.' >&2; exit 1; }
jq --arg run "$run_id" --arg seconds "$seconds" --arg deployment "$deployment" '{
  cluster:.cluster_arn, taskDefinition:.task_definition, launchType:"FARGATE", platformVersion:"1.4.0",
  count:1, startedBy:$run, clientToken:$run,
  networkConfiguration:{awsvpcConfiguration:{subnets:.subnet_ids,securityGroups:[.security_group_id],assignPublicIp:"ENABLED"}},
  overrides:{containerOverrides:[{name:"observer",environment:[{name:"AWS_E2E_SOAK_SECONDS",value:$seconds}]}]},
  tags:[{key:"DeploymentId",value:$deployment},{key:"Purpose",value:"live-e2e-validation"},{key:"Ephemeral",value:"true"}]
}' "$directory/configuration.json" > "$directory/request.json"
# Keep the client token before dispatch. An uncertain request can be retried with
# this exact JSON without creating a second observer.
AWS_REGION="$aws_region" node scripts/run-ecs-observer.mjs "$directory/request.json" > "$directory/task.json"
jq -e '(.failures | length) == 0 and (.tasks | length) == 1' "$directory/task.json" >/dev/null
jq '{taskArn:.tasks[0].taskArn,status:.tasks[0].lastStatus}' "$directory/task.json"
echo "Observer evidence: $directory"
