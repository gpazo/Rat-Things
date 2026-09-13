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
    expect(() => quickstartModel(parseAwsQuickstartOptions([]))).toThrow('Select an admitted model');
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

  it('defaults to a real Codex deployment through a connected ChatGPT workspace', () => {
    const options = parseAwsQuickstartOptions([]);
    expect(options).toMatchObject({
      command: 'setup',
      driver: 'codex',
      auth: 'chatgpt',
      region: 'us-west-2',
      environment: 'quickstart',
      codexAuthFile: expect.stringMatching(/\/\.codex\/auth\.json$/),
      acceptCodexCredentialRisk: false,
    });
    expect(awsQuickstartTerraformConfig(options, '7')).toMatchObject({
      codex_auth_mode: 'chatgpt',
      codex_bedrock_model_ids: [],
      default_sandbox_mode: 'read-only',
      default_agent_network_access: false,
      enable_s3_files: false,
      microvm_base_image_version: '7',
      force_destroy_data: true,
    });
  });

  it('accepts deliberate file-credential consent and an existing secret ARN', () => {
    const secretArn = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:rat/codex-auth';
    const options = parseAwsQuickstartOptions([
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

  it('allows ChatGPT by default or a deliberate Bedrock model in every MicroVM Region', () => {
    expect(parseAwsQuickstartOptions([
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
