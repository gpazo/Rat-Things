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

if [[ "$publication_enabled" == "true" ]]; then
  # Deployment intentionally removes its temporary PEM files. Terraform still
  # evaluates the CloudFront public-key resource during destroy, so recover the
  # non-secret encoded public key from state instead of requiring operators to
  # retain deployment-time material solely for teardown.
  publication_public_key_pem="$(
    aws_e2e_terraform show -json "$state_file" |
      jq -r '[.. | objects | select(.address? == "module.agent_runner.aws_cloudfront_public_key.publications[0]") | (.values.encoded_key // empty)][0] // empty'
  )"
  if [[ -z "$publication_public_key_pem" ]]; then
    echo "could not recover the publication public key from Terraform state" >&2
    exit 1
  fi
  tf_vars+=("-var=publication_public_key_pem=$publication_public_key_pem")
fi

microvm_image_arn="$(aws_e2e_terraform output -state="$state_file" -json microvm 2>/dev/null | jq -r '.image_arn // empty' 2>/dev/null || true)"

# Connection credentials are runtime-created resources rather than Terraform
# resources. Remove the exact deployment prefix before destroying its KMS key.
credential_prefix="rat-things-${deployment_id}/connections/"
connection_secret_arns="$(aws secretsmanager list-secrets \
  --region "$aws_region" \
  --include-planned-deletion \
  --filters "Key=name,Values=$credential_prefix" \
  --output json | jq -r --arg prefix "$credential_prefix" \
    '.SecretList[] | select(.Name | startswith($prefix)) | .ARN')"
for connection_secret_arn in $connection_secret_arns; do
  aws secretsmanager delete-secret \
    --region "$aws_region" \
    --secret-id "$connection_secret_arn" \
    --force-delete-without-recovery >/dev/null
done
if [[ -n "$connection_secret_arns" ]]; then
  echo "Removed runtime-created connection credentials for $deployment_id."
fi

echo "Destroying Terraform resources for $deployment_id..."
destroy_status=1
for destroy_attempt in 1 2 3; do
  # A test can fail after enqueueing work but before its replacement MicroVM
  # starts. Re-scan before every destroy attempt so a late instance cannot
  # keep the image, execution role, and source bucket alive.
  if [[ -n "$microvm_image_arn" ]]; then
    echo "Stopping any running Lambda MicroVMs for $deployment_id..."
    node "$script_dir/terminate-microvms.mjs" "$aws_region" "$microvm_image_arn"
  fi
  set +e
  aws_e2e_terraform destroy \
    -state="$state_file" \
    -input=false \
    -auto-approve \
    "${tf_vars[@]}"
  destroy_status=$?
  set -e
  if [[ "$destroy_status" -eq 0 ]]; then
    break
  fi
  if [[ "$destroy_attempt" -lt 3 ]]; then
    echo "Terraform destroy is waiting on AWS eventual consistency; retrying in 10 seconds (attempt $destroy_attempt/3)..." >&2
    sleep 10
  fi
done
if [[ "$destroy_status" -ne 0 ]]; then
  exit "$destroy_status"
fi

if [[ -f "$runtime_env" ]]; then
  : >"$runtime_env"
  find "$runtime_env" -type f -delete
fi

unexpected=1
remaining_arns=""

resource_is_gone_or_deleting() {
  local resource_arn="$1"
  local resource_id resource_path cluster_name status
  case "$resource_arn" in
    arn:aws:kms:*)
      status="$(aws kms describe-key --region "$aws_region" --key-id "$resource_arn" --query 'KeyMetadata.KeyState' --output text 2>/dev/null || true)"
      [[ "$status" == "PendingDeletion" ]]
      ;;
    arn:aws:lambda:*:microvm-image:*)
      ! aws cloudcontrol get-resource --region "$aws_region" --type-name AWS::Lambda::MicrovmImage --identifier "$resource_arn" >/dev/null 2>&1
      ;;
    arn:aws:lambda:*:network-connector:*)
      ! aws cloudcontrol get-resource --region "$aws_region" --type-name AWS::Lambda::NetworkConnector --identifier "$resource_arn" >/dev/null 2>&1
      ;;
    # The AWS tag index can retain terminal records from a prior version of
    # the harness after their billable resources have been removed. Resolve
    # those exact ARNs through their owning APIs instead of treating a tag
    # tombstone as live infrastructure.
    arn:aws:ecs:*:cluster/*)
      status="$(aws ecs describe-clusters --region "$aws_region" --clusters "$resource_arn" --query 'clusters[0].status' --output text 2>/dev/null || true)"
      [[ -z "$status" || "$status" == "None" || "$status" == "INACTIVE" ]]
      ;;
    arn:aws:ecs:*:task/*)
      resource_path="${resource_arn##*:task/}"
      cluster_name="${resource_path%%/*}"
      status="$(aws ecs describe-tasks --region "$aws_region" --cluster "$cluster_name" --tasks "$resource_arn" --query 'tasks[0].lastStatus' --output text 2>/dev/null || true)"
      [[ -z "$status" || "$status" == "None" || "$status" == "STOPPED" ]]
      ;;
    arn:aws:ecs:*:task-definition/*)
      status="$(aws ecs describe-task-definition --region "$aws_region" --task-definition "$resource_arn" --query 'taskDefinition.status' --output text 2>/dev/null || true)"
      [[ -z "$status" || "$status" == "None" || "$status" == "INACTIVE" || "$status" == "DELETE_IN_PROGRESS" ]]
      ;;
    arn:aws:ec2:*:natgateway/*)
      resource_id="${resource_arn##*/}"
      status="$(aws ec2 describe-nat-gateways --region "$aws_region" --nat-gateway-ids "$resource_id" --query 'NatGateways[0].State' --output text 2>/dev/null || true)"
      [[ -z "$status" || "$status" == "None" || "$status" == "deleted" ]]
      ;;
    arn:aws:ec2:*:vpc-endpoint/*)
      resource_id="${resource_arn##*/}"
      status="$(aws ec2 describe-vpc-endpoints --region "$aws_region" --vpc-endpoint-ids "$resource_id" --query 'VpcEndpoints[0].State' --output text 2>/dev/null || true)"
      [[ -z "$status" || "$status" == "None" || "$status" == "deleted" ]]
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
if [[ -f "$run_root/latest" && "$(<"$run_root/latest")" == "$deployment_id" ]]; then
  : >"$run_root/latest"
  find "$run_root/latest" -type f -delete
fi
echo "Ephemeral stack $deployment_id was destroyed."
echo "The customer-managed KMS key is disabled and scheduled for deletion because AWS does not permit immediate KMS key deletion."
