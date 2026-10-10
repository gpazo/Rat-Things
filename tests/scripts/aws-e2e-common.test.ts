import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AWS E2E OAuth configuration', () => {
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

  it('inherits saved live-provider settings while preserving explicit redeploy overrides', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rat-things-aws-e2e-runtime-'));
    const runtime = join(directory, 'runtime.env');
    writeFileSync(runtime, [
      'export AWS_E2E_OAUTH_APP_SECRET_ARNS=\'{"slack":"saved-arn"}\'',
      'export AWS_E2E_ENABLE_SLACK_WEBHOOK=true',
      'export AWS_E2E_SLACK_SIGNING_SECRET_FILE=/saved/signing-secret',
      'export AWS_E2E_REAL_CODEX=false',
      '',
    ].join('\n'));
    const output = execFileSync('bash', ['--noprofile', '--norc', '-c', `
      set -euo pipefail
      export AWS_E2E_REAL_CODEX=true
      source scripts/aws-e2e-common.sh
      aws_e2e_source_runtime_defaults '${runtime}'
      printf '%s\n%s\n%s\n%s' "$AWS_E2E_OAUTH_APP_SECRET_ARNS" "$AWS_E2E_ENABLE_SLACK_WEBHOOK" "$AWS_E2E_SLACK_SIGNING_SECRET_FILE" "$AWS_E2E_REAL_CODEX"
    `], { encoding: 'utf8' });

    expect(output.split('\n')).toEqual([
      '{"slack":"saved-arn"}',
      'true',
      '/saved/signing-secret',
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
