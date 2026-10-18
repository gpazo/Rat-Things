import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AWS E2E configuration', () => {
  it('preserves a configured OAuth application secret map as valid JSON', () => {
    const output = execFileSync('bash', ['--noprofile', '--norc', '-c', `
      set -euo pipefail
      export AWS_REGION=us-west-2
      export AWS_E2E_OAUTH_APP_SECRET_ARNS='{"slack":"arn:aws:secretsmanager:us-west-2:123456789012:secret:test"}'
      source scripts/aws-e2e-common.sh
      aws_e2e_configure oauth-test
      printf '%s' "$oauth_app_secret_arns"
    `], { encoding: 'utf8' });

    expect(JSON.parse(output)).toEqual({
      slack: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:test',
    });
  });

  it('uses an empty JSON object when no OAuth application secret map is configured', () => {
    const output = execFileSync('bash', ['--noprofile', '--norc', '-c', `
      set -euo pipefail
      export AWS_REGION=us-west-2
      unset AWS_E2E_OAUTH_APP_SECRET_ARNS
      source scripts/aws-e2e-common.sh
      aws_e2e_configure oauth-test
      printf '%s' "$oauth_app_secret_arns"
    `], { encoding: 'utf8' });

    expect(JSON.parse(output)).toEqual({});
  });

  it('defaults Pi Bedrock model and inference resource lists to empty arrays', () => {
    const output = execFileSync('bash', ['--noprofile', '--norc', '-c', `
      set -euo pipefail
      export AWS_REGION=us-west-2
      unset AWS_E2E_PI_BEDROCK_MODEL_IDS_JSON AWS_E2E_PI_BEDROCK_INFERENCE_RESOURCE_ARNS_JSON AWS_E2E_PI_PROOF
      source scripts/aws-e2e-common.sh
      aws_e2e_configure pi-defaults
      printf 'MODEL=%s\\nARN=%s\\nPROOF=%s\\n' "$pi_bedrock_model_ids" "$pi_bedrock_inference_resource_arns" "$pi_proof_enabled"
      printf 'VAR=%s\\n' "\${tf_vars[@]}"
    `], { encoding: 'utf8' });

    const lines = output.trimEnd().split('\n');
    expect(lines).toContain('MODEL=[]');
    expect(lines).toContain('ARN=[]');
    expect(lines).toContain('PROOF=false');
    expect(lines).toContain('VAR=-var=pi_bedrock_model_ids=[]');
    expect(lines).toContain('VAR=-var=pi_bedrock_inference_resource_arns=[]');
  });

  it('passes configured Pi models and inference resource ARNs through Terraform', () => {
    const output = execFileSync('bash', ['--noprofile', '--norc', '-c', `
      set -euo pipefail
      export AWS_REGION=us-west-2
      export AWS_E2E_PI_BEDROCK_MODEL_IDS_JSON='["us.amazon.nova-micro-v1:0","us.anthropic.claude-haiku-4-5-20251001-v1:0"]'
      export AWS_E2E_PI_BEDROCK_INFERENCE_RESOURCE_ARNS_JSON='["arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.amazon.nova-micro-v1:0","arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0"]'
      source scripts/aws-e2e-common.sh
      aws_e2e_configure pi-configured
      printf '%s\\n' "\${tf_vars[@]}"
    `], { encoding: 'utf8' });

    expect(output.split('\n')).toEqual(expect.arrayContaining([
      '-var=pi_bedrock_model_ids=["us.amazon.nova-micro-v1:0","us.anthropic.claude-haiku-4-5-20251001-v1:0"]',
      '-var=pi_bedrock_inference_resource_arns=["arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.amazon.nova-micro-v1:0","arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0"]',
    ]));
  });

  it('inherits saved live-provider settings while preserving explicit redeploy overrides', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rat-things-aws-e2e-runtime-'));
    const runtime = join(directory, 'runtime.env');
    writeFileSync(runtime, [
      'export AWS_E2E_OAUTH_APP_SECRET_ARNS=\'{"slack":"saved-arn"}\'',
      'export AWS_E2E_ENABLE_SLACK_WEBHOOK=true',
      'export AWS_E2E_SLACK_SIGNING_SECRET_FILE=/saved/signing-secret',
      'export AWS_E2E_REAL_CODEX=false',
      `export AWS_E2E_PI_BEDROCK_MODEL_IDS_JSON='["saved-model"]'`,
      `export AWS_E2E_PI_BEDROCK_INFERENCE_RESOURCE_ARNS_JSON='["saved-arn"]'`,
      'export AWS_E2E_PI_PROOF=false',
      '',
    ].join('\n'));
    const output = execFileSync('bash', ['--noprofile', '--norc', '-c', `
      set -euo pipefail
      export AWS_E2E_REAL_CODEX=true
      export AWS_E2E_PI_BEDROCK_MODEL_IDS_JSON='["override-model"]'
      export AWS_E2E_PI_PROOF=true
      source scripts/aws-e2e-common.sh
      aws_e2e_source_runtime_defaults '${runtime}'
      printf '%s\n%s\n%s\n%s\n%s\n%s\n%s' "$AWS_E2E_OAUTH_APP_SECRET_ARNS" "$AWS_E2E_ENABLE_SLACK_WEBHOOK" "$AWS_E2E_SLACK_SIGNING_SECRET_FILE" "$AWS_E2E_REAL_CODEX" "$AWS_E2E_PI_BEDROCK_MODEL_IDS_JSON" "$AWS_E2E_PI_BEDROCK_INFERENCE_RESOURCE_ARNS_JSON" "$AWS_E2E_PI_PROOF"
    `], { encoding: 'utf8' });

    expect(output.split('\n')).toEqual([
      '{"slack":"saved-arn"}',
      'true',
      '/saved/signing-secret',
      'true',
      '["override-model"]',
      '["saved-arn"]',
      'true',
    ]);
  });
});


it('passes explicit EC2 workloads to Terraform without changing the MicroVM default', () => {
  const output = execFileSync('bash', ['--noprofile', '--norc', '-c', `
    set -euo pipefail
    export AWS_REGION=us-west-2
    export AWS_E2E_EC2_SESSION_WORKLOADS_JSON='[{"owner_id":"alice","agent_id":"agent_long"}]'
    source scripts/aws-e2e-common.sh
    aws_e2e_configure placement-test
    printf '%s\n' "\${tf_vars[@]}"
  `], { encoding: 'utf8' });
  expect(output.split('\n')).toEqual(expect.arrayContaining([
    '-var=enable_microvm=true',
    '-var=ec2_session_workloads=[{"owner_id":"alice","agent_id":"agent_long"}]',
  ]));
});


it('retains prepared-image settings across a redeploy while accepting a newly built AMI', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rat-things-prepared-e2e-'));
  const runtime = join(directory, 'runtime.env');
  writeFileSync(runtime, [
    'export AWS_E2E_ENABLE_EC2_WORKER=true',
    'export AWS_E2E_EC2_WORKER_AMI_ID=ami-111',
    'export AWS_E2E_EC2_WORKER_IMAGE=registry/worker@sha256:fixture',
    'export AWS_E2E_ENABLE_EC2_WORKER_AMI_PIPELINE=true',
    'export AWS_E2E_EC2_WORKER_AMI_BASE_ID=ami-111',
    'export AWS_E2E_EC2_WORKER_AMI_COMPONENT_VERSION=1.2.3',
    'export AWS_E2E_EC2_WORKER_AMI_RECIPE_VERSION=2.3.4',
    'export AWS_E2E_EC2_WORKER_PREPARED_AMI=false',
  ].join('\n'));
  const output = execFileSync('bash', ['--noprofile', '--norc', '-c', `
    set -euo pipefail
    export AWS_REGION=us-west-2 AWS_E2E_EC2_WORKER_AMI_ID=ami-222 AWS_E2E_EC2_WORKER_PREPARED_AMI=true
    source scripts/aws-e2e-common.sh
    aws_e2e_source_runtime_defaults '${runtime}'
    aws_e2e_configure prepared-test
    printf '%s\n' "\${tf_vars[@]}"
  `], { encoding: 'utf8' });
  expect(output.split('\n')).toEqual(expect.arrayContaining([
    '-var=ec2_worker_ami_id=ami-222', '-var=ec2_worker_prepared_ami=true',
    '-var=enable_ec2_worker_ami_pipeline=true', '-var=ec2_worker_ami_base_id=ami-111',
    '-var=ec2_worker_ami_component_version=1.2.3', '-var=ec2_worker_ami_recipe_version=2.3.4',
  ]));
});
