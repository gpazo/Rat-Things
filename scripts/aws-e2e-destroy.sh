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
  echo "provide the deployment ID to destroy" >&2
  exit 1
fi

aws_e2e_configure "$requested_id"
aws_e2e_require aws jq node terraform

if [[ ! -f "$state_file" ]]; then
  echo "No Terraform state exists for $deployment_id; there is nothing to destroy."
  exit 0
fi

echo "Stopping any running ECS tasks for $deployment_id..."
cluster_arn="$(aws_e2e_output ecs_cluster_arn 2>/dev/null || true)"
task_definition_arn="$(aws_e2e_output ecs_task_definition_arn 2>/dev/null || true)"
microvm_image_arn="$(aws_e2e_terraform output -state="$state_file" -json microvm 2>/dev/null | jq -r '.image_arn // empty' 2>/dev/null || true)"
if [[ -n "$microvm_image_arn" ]]; then
  echo "Stopping any running Lambda MicroVMs for $deployment_id..."
  node "$script_dir/terminate-microvms.mjs" "$aws_region" "$microvm_image_arn"
fi
if [[ -n "$cluster_arn" ]]; then
  task_arns="$(aws ecs list-tasks \
    --region "$aws_region" \
    --cluster "$cluster_arn" \
    --desired-status RUNNING \
    --query 'taskArns[]' \
    --output text 2>/dev/null || true)"
  if [[ -n "$task_arns" && "$task_arns" != "None" ]]; then
    for task_arn in $task_arns; do
      aws ecs stop-task \
        --region "$aws_region" \
        --cluster "$cluster_arn" \
        --task "$task_arn" \
        --reason "ephemeral live E2E teardown" >/dev/null || true
    done
    for task_arn in $task_arns; do
      aws ecs wait tasks-stopped \
        --region "$aws_region" \
        --cluster "$cluster_arn" \
        --tasks "$task_arn" || true
    done
  fi
fi

echo "Destroying Terraform resources for $deployment_id..."
aws_e2e_terraform destroy \
  -state="$state_file" \
  -input=false \
  -auto-approve \
  "${tf_vars[@]}"

# Terraform deregisters ECS task definitions, but AWS retains the inactive
# revisions until DeleteTaskDefinitions is called explicitly.
if [[ -n "$task_definition_arn" ]]; then
  task_definition_status="$(aws ecs describe-task-definition \
    --region "$aws_region" \
    --task-definition "$task_definition_arn" \
    --query 'taskDefinition.status' \
    --output text 2>/dev/null || true)"
  if [[ "$task_definition_status" == "INACTIVE" ]]; then
    aws ecs delete-task-definitions \
      --region "$aws_region" \
      --task-definitions "$task_definition_arn" >/dev/null
  fi
fi

if [[ -f "$runtime_env" ]]; then
  : >"$runtime_env"
  find "$runtime_env" -type f -delete
fi

unexpected=1
remaining_arns=""

resource_is_gone_or_deleting() {
  local resource_arn="$1"
  local resource_id status
  case "$resource_arn" in
    arn:aws:kms:*)
      status="$(aws kms describe-key --region "$aws_region" --key-id "$resource_arn" --query 'KeyMetadata.KeyState' --output text 2>/dev/null || true)"
      [[ "$status" == "PendingDeletion" ]]
      ;;
    arn:aws:ecs:*:cluster/*)
      status="$(aws ecs describe-clusters --region "$aws_region" --clusters "$resource_arn" --query 'clusters[0].status' --output text 2>/dev/null || true)"
      [[ -z "$status" || "$status" == "None" || "$status" == "INACTIVE" ]]
      ;;
    arn:aws:ecs:*:task/*)
      # ECS retains stopped task metadata for a while after task and cluster
      # deletion. STOPPED tasks no longer consume Fargate capacity.
      resource_id="${resource_arn#*:task/}"
      resource_id="${resource_id%/*}"
      status="$(aws ecs describe-tasks --region "$aws_region" --cluster "$resource_id" --tasks "$resource_arn" --query 'tasks[0].lastStatus' --output text 2>/dev/null || true)"
      [[ -z "$status" || "$status" == "None" || "$status" == "STOPPED" ]]
      ;;
    arn:aws:ecs:*:task-definition/*)
      status="$(aws ecs describe-task-definition --region "$aws_region" --task-definition "$resource_arn" --query 'taskDefinition.status' --output text 2>/dev/null || true)"
      if [[ "$status" == "INACTIVE" ]]; then
        aws ecs delete-task-definitions --region "$aws_region" --task-definitions "$resource_arn" >/dev/null 2>&1 || true
        status="DELETE_IN_PROGRESS"
      fi
      [[ -z "$status" || "$status" == "None" || "$status" == "DELETE_IN_PROGRESS" ]]
      ;;
    arn:aws:ec2:*:subnet/*)
      resource_id="${resource_arn##*/}"
      ! aws ec2 describe-subnets --region "$aws_region" --subnet-ids "$resource_id" >/dev/null 2>&1
      ;;
    arn:aws:ec2:*:vpc-endpoint/*)
      resource_id="${resource_arn##*/}"
      ! aws ec2 describe-vpc-endpoints --region "$aws_region" --vpc-endpoint-ids "$resource_id" >/dev/null 2>&1
      ;;
    arn:aws:ec2:*:natgateway/*)
      resource_id="${resource_arn##*/}"
      status="$(aws ec2 describe-nat-gateways --region "$aws_region" --nat-gateway-ids "$resource_id" --query 'NatGateways[0].State' --output text 2>/dev/null || true)"
      [[ -z "$status" || "$status" == "None" || "$status" == "deleting" || "$status" == "deleted" ]]
      ;;
    arn:aws:ec2:*:elastic-ip/*)
      resource_id="${resource_arn##*/}"
      ! aws ec2 describe-addresses --region "$aws_region" --allocation-ids "$resource_id" >/dev/null 2>&1
      ;;
    arn:aws:lambda:*:microvm-image:*)
      ! aws cloudcontrol get-resource --region "$aws_region" --type-name AWS::Lambda::MicrovmImage --identifier "$resource_arn" >/dev/null 2>&1
      ;;
    arn:aws:lambda:*:network-connector:*)
      ! aws cloudcontrol get-resource --region "$aws_region" --type-name AWS::Lambda::NetworkConnector --identifier "$resource_arn" >/dev/null 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

for audit_attempt in 1 2 3 4 5 6; do
  remaining_arns="$(aws resourcegroupstaggingapi get-resources \
    --region "$aws_region" \
    --tag-filters "Key=DeploymentId,Values=$deployment_id" \
    --query 'ResourceTagMappingList[].ResourceARN' \
    --output text)"
  unexpected=0
  for resource_arn in $remaining_arns; do
    if [[ "$resource_arn" == "None" ]]; then
      continue
    fi
    if resource_is_gone_or_deleting "$resource_arn"; then
      continue
    fi
    unexpected=1
  done
  if [[ "$unexpected" -eq 0 ]]; then
    break
  fi
  if [[ "$audit_attempt" -lt 6 ]]; then
    echo "Waiting for AWS resource deletion to become visible in the tag audit (attempt $audit_attempt/6)..."
    sleep 10
  fi
done

if [[ -n "$remaining_arns" && "$remaining_arns" != "None" ]]; then
  echo "Post-destroy tagged-resource audit:"
  for resource_arn in $remaining_arns; do
    if [[ "$resource_arn" == "None" ]]; then
      continue
    fi
    if resource_is_gone_or_deleting "$resource_arn"; then
      echo "  confirmed gone, terminal, or deleting: $resource_arn"
      continue
    fi
    echo "  unexpected remaining resource: $resource_arn" >&2
  done
fi

if [[ "$unexpected" -ne 0 ]]; then
  echo "teardown completed but the tagged-resource audit found unexpected resources" >&2
  exit 1
fi

printf 'destroyed %s in %s at %s\n' "$deployment_id" "$aws_region" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$run_dir/destroyed.txt"
echo "Ephemeral stack $deployment_id was destroyed."
echo "The customer-managed KMS key is disabled and scheduled for deletion because AWS does not permit immediate KMS key deletion."
