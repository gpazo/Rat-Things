import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AWS E2E OAuth configuration', () => {
  it('preserves a configured OAuth application secret map as valid JSON', () => {
    const output = execFileSync('bash', ['-lc', `
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
    const output = execFileSync('bash', ['-lc', `
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
      'export AWS_E2E_DEFAULT_AGENT_DRIVER=codex',
      '',
    ].join('\n'));
    const output = execFileSync('bash', ['-lc', `
      set -euo pipefail
      export AWS_E2E_DEFAULT_AGENT_DRIVER=mock
      source scripts/aws-e2e-common.sh
      aws_e2e_source_runtime_defaults '${runtime}'
      printf '%s\n%s\n%s\n%s' "$AWS_E2E_OAUTH_APP_SECRET_ARNS" "$AWS_E2E_ENABLE_SLACK_WEBHOOK" "$AWS_E2E_SLACK_SIGNING_SECRET_FILE" "$AWS_E2E_DEFAULT_AGENT_DRIVER"
    `], { encoding: 'utf8' });

    expect(output.split('\n')).toEqual([
      '{"slack":"saved-arn"}',
      'true',
      '/saved/signing-secret',
      'mock',
    ]);
  });
});
