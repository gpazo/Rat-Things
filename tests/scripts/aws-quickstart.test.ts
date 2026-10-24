import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  awsQuickstartTerraformConfig,
  quickstartModel,
  assertSupportedNodeVersion,
  managedTerraformAddresses,
  parseAwsQuickstartOptions,
  recoveredQuickstartDestroyEvidence,
  resolveQuickstartAwsContext,
} from '../../scripts/aws-quickstart.js';

describe('AWS quickstart', () => {
  it('rejects a mock Agents deployment before any credential transfer or AWS changes', async () => {
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/aws-quickstart.ts', '--driver', 'mock', '--yes'], {
      env: { PATH: process.env.PATH, AWS_REGION: 'us-west-2' },
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Agents quickstart requires Codex') });
  });
  it('requires an explicit admitted model for ChatGPT while keeping recovery independent', () => {
    expect(() => quickstartModel(parseAwsQuickstartOptions(['--auth', 'chatgpt', '--https-egress-cidrs', '203.0.113.0/24']))).toThrow('Select an admitted model');
    expect(quickstartModel(parseAwsQuickstartOptions(['--model', 'configured-model']))).toBe('configured-model');
    expect(quickstartModel(parseAwsQuickstartOptions(['--auth', 'bedrock']))).toBe('openai.gpt-5.6-terra');
  });
  it('requires the repository Node 22.20 baseline', () => {
    expect(() => assertSupportedNodeVersion('v20.19.5')).toThrow('Node.js 22.20.0 or newer');
    expect(() => assertSupportedNodeVersion('22.19.0')).toThrow('Node.js 22.20.0 or newer');
    expect(() => assertSupportedNodeVersion('not-a-version')).toThrow('Node.js 22.20.0 or newer');
    expect(() => assertSupportedNodeVersion('v22.20.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('24.1.0')).not.toThrow();
  });

  it('defaults to private Bedrock inference with no public egress', () => {
    const options = parseAwsQuickstartOptions([]);
    expect(options).toMatchObject({
      command: 'setup',
      driver: 'codex',
      auth: 'bedrock',
      region: 'us-west-2',
      environment: 'quickstart',
      codexAuthFile: expect.stringMatching(/\/\.codex\/auth\.json$/),
      acceptCodexCredentialRisk: false,
    });
    expect(awsQuickstartTerraformConfig(options, '7')).toMatchObject({
      codex_auth_mode: 'bedrock',
      codex_bedrock_model_ids: ['openai.gpt-5.6-terra'],
      runtime_https_egress_cidrs: [],
      default_sandbox_mode: 'read-only',
      default_agent_network_access: false,
      enable_s3_files: false,
      microvm_base_image_version: '7',
      force_destroy_data: true,
    });
    expect(options.budgetAlert).toBeUndefined();
    expect(awsQuickstartTerraformConfig(options, '7')).not.toHaveProperty('budget_alert');
  });

  it('configures an optional monthly USD email alert before deployment', () => {
    const options = parseAwsQuickstartOptions(['--budget-usd', '19.99', '--budget-alert-emails', 'owner@example.com, team@example.com,owner@example.com']);
    expect(options.budgetAlert).toEqual({ monthlyUsd: 19.99, emails: ['owner@example.com', 'team@example.com'] });
    expect(awsQuickstartTerraformConfig(options, '7')).toMatchObject({
      budget_alert: { monthly_usd: 19.99, email_addresses: ['owner@example.com', 'team@example.com'] },
    });
  });

  it('rejects incomplete or invalid alerts before any AWS calls', () => {
    expect(() => parseAwsQuickstartOptions(['--budget-usd', '50'])).toThrow('require both');
    expect(() => parseAwsQuickstartOptions(['--budget-alert-emails', 'owner@example.com'])).toThrow('require both');
    for (const amount of ['0', '-1', 'NaN', 'Infinity', '1e2', '0.001', '1.001', '1000000001', '1 USD']) {
      expect(() => parseAwsQuickstartOptions(['--budget-usd', amount, '--budget-alert-emails', 'owner@example.com'])).toThrow('monthly USD amount');
    }
    for (const emails of ['owner', 'owner@example.com,', 'a b@example.com', 'a@b@example.com', 'a@b.com\nBcc:x@y.com', Array.from({ length: 11 }, (_, i) => `owner${i}@example.com`).join(',')]) {
      expect(() => parseAwsQuickstartOptions(['--budget-usd', '50', '--budget-alert-emails', emails])).toThrow('1-10');
    }
  });

  it('accepts cent amounts and ten recipients without requiring an alert for other commands', () => {
    const emails = Array.from({ length: 10 }, (_, i) => `owner${i}@example.com`);
    expect(parseAwsQuickstartOptions(['--budget-usd', '0.01', '--budget-alert-emails', emails.join(',')]).budgetAlert).toEqual({ monthlyUsd: 0.01, emails });
    for (const command of ['preflight', 'status', 'sync-auth', 'destroy']) {
      expect(parseAwsQuickstartOptions([command]).budgetAlert).toBeUndefined();
    }
  });

  it('previews a configured alert without AWS credentials or deployment tools', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/aws-quickstart.ts',
      '--dry-run', '--json', '--budget-usd', '50', '--budget-alert-emails', 'owner@example.com'], { env: { PATH: '' } });
    expect(JSON.parse(stdout)).toMatchObject({ changesExternalState: false,
      terraform: { budget_alert: { monthly_usd: 50, email_addresses: ['owner@example.com'] } },
    });
  });

  it('accepts deliberate file-credential consent and an existing secret ARN', () => {
    const secretArn = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:rat/codex-auth';
    const options = parseAwsQuickstartOptions([
      '--auth', 'chatgpt', '--https-egress-cidrs', '203.0.113.0/24',
      '--codex-auth-file',
      './fixtures/auth.json',
      '--codex-auth-secret-arn',
      secretArn,
      '--accept-codex-credential-risk',
      '--yes',
    ]);

    expect(options).toMatchObject({
      codexAuthFile: expect.stringMatching(/\/fixtures\/auth\.json$/),
      codexAuthSecretArn: secretArn,
      acceptCodexCredentialRisk: true,
      yes: true,
    });
    expect(awsQuickstartTerraformConfig(options, '7')).toMatchObject({
      codex_auth_file_secret_arn: secretArn,
    });
  });

  it('rejects ambiguous and unsupported setup choices before AWS changes', () => {
    expect(() => parseAwsQuickstartOptions(['--driver', 'auto'])).toThrow('--driver must be codex or mock');
    expect(() => parseAwsQuickstartOptions(['--auth', 'auto'])).toThrow('--auth must be chatgpt or bedrock');
    for (const region of ['ap-northeast-1', 'eu-west-1']) {
      expect(() => parseAwsQuickstartOptions(['--auth', 'bedrock', '--region', region])).toThrow(
        'default Lambda MicroVM + openai.gpt-5.6-terra quickstart is not supported',
      );
    }
    expect(() => parseAwsQuickstartOptions(['--region', 'eu-central-1'])).toThrow(
      'Lambda MicroVM quickstart is not supported',
    );
    expect(() => parseAwsQuickstartOptions(['--unknown', 'value'])).toThrow('unknown option');
    expect(() => parseAwsQuickstartOptions([
      '--codex-auth-secret-arn',
      'not-an-arn',
    ])).toThrow('--codex-auth-secret-arn must be a Secrets Manager ARN');
  });

  it('allows explicit ChatGPT destinations or a deliberate Bedrock model in every MicroVM Region', () => {
    expect(parseAwsQuickstartOptions([
      '--auth', 'chatgpt', '--https-egress-cidrs', '203.0.113.0/24',
      '--region',
      'eu-west-1',
    ])).toMatchObject({ region: 'eu-west-1', driver: 'codex', auth: 'chatgpt' });
    expect(parseAwsQuickstartOptions([
      '--region',
      'eu-west-1',
      '--auth',
      'bedrock',
      '--model',
      'operator.selected-model',
    ])).toMatchObject({
      region: 'eu-west-1',
      driver: 'codex',
      auth: 'bedrock',
      model: 'operator.selected-model',
    });
    expect(parseAwsQuickstartOptions([
      '--region',
      'ap-northeast-1',
      '--driver',
      'mock',
    ])).toMatchObject({ region: 'ap-northeast-1', driver: 'mock' });
  });

  it('requires explicit public destinations for ChatGPT and rejects open or malformed egress', () => {
    expect(() => parseAwsQuickstartOptions(['--auth', 'chatgpt'])).toThrow('requires --https-egress-cidrs');
    for (const cidr of ['0.0.0.0/0', '::/0', 'invalid', '203.0.113.1/33']) {
      expect(() => parseAwsQuickstartOptions(['--https-egress-cidrs', cidr])).toThrow('IPv4 CIDRs');
    }
  });

  it('uses stored deployment context rather than rejecting recovery from the shell Region', () => {
    expect(parseAwsQuickstartOptions(['status', '--region', 'eu-central-1'])).toMatchObject({
      command: 'status',
      region: 'eu-central-1',
    });
    expect(parseAwsQuickstartOptions(['destroy', '--region', 'eu-central-1'])).toMatchObject({
      command: 'destroy',
      region: 'eu-central-1',
    });
  });

  it('offers a non-mutating readiness command in every default-model Region', () => {
    for (const region of ['us-east-1', 'us-east-2', 'us-west-2']) {
      expect(parseAwsQuickstartOptions([
        'preflight',
        '--profile',
        'sandbox',
        '--region',
        region,
      ])).toMatchObject({
        command: 'preflight',
        profile: 'sandbox',
        driver: 'codex',
        region,
      });
    }
  });

  it('reuses the stored setup identity for status and teardown unless explicitly overridden', () => {
    expect(resolveQuickstartAwsContext(
      {},
      { region: 'us-west-2', profile: 'rat-things-sandbox' },
    )).toEqual({ region: 'us-west-2', profile: 'rat-things-sandbox' });
    expect(resolveQuickstartAwsContext(
      { profile: 'recovery-admin' },
      { region: 'us-west-2', profile: 'rat-things-sandbox' },
    )).toEqual({ region: 'us-west-2', profile: 'recovery-admin' });
    expect(resolveQuickstartAwsContext({}, { region: 'us-east-1' })).toEqual({ region: 'us-east-1' });
  });

  it('records a verifiable recovery result for setup interrupted before or after deployment', () => {
    const context = {
      region: 'us-west-2',
      profile: 'rat-things-sandbox',
      environment: 'quickstart',
    };
    expect(recoveredQuickstartDestroyEvidence(
      context,
      false,
      { listedMicrovms: 0, activeMicrovms: 0 },
    )).toMatchObject({
      version: 3,
      status: 'destroyed',
      recoveredFrom: 'interrupted-setup',
      region: 'us-west-2',
      profile: 'rat-things-sandbox',
      teardown: {
        terraformStateEntries: 0,
        microvmImageResolved: false,
        activeMicrovms: 0,
      },
    });
    expect(recoveredQuickstartDestroyEvidence(
      context,
      true,
      { listedMicrovms: 2, activeMicrovms: 0 },
      { enabled: false, state: 'PendingDeletion', deletionDate: '2026-09-23T00:00:00Z' },
      true,
    )).toMatchObject({
      teardown: {
        microvmImageResolved: true,
        listedMicrovms: 2,
        activeMicrovms: 0,
        credentialSecretDeleted: true,
        kmsKey: { enabled: false, state: 'PendingDeletion' },
      },
    });
    expect(() => recoveredQuickstartDestroyEvidence(
      context,
      true,
      { listedMicrovms: 1, activeMicrovms: 1 },
    )).toThrow('left 1 active MicroVM');
  });

  it('reports managed Terraform resources separately from data-source state entries', () => {
    expect(managedTerraformAddresses([
      'data.aws_caller_identity.current',
      'aws_s3_bucket.artifacts',
      'module.agent_runner.data.aws_partition.current',
      'module.agent_runner.aws_lambda_function.this["control"]',
    ])).toEqual([
      'aws_s3_bucket.artifacts',
      'module.agent_runner.aws_lambda_function.this["control"]',
    ]);
  });
});
