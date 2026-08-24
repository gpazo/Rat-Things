import { describe, expect, it } from 'vitest';
import {
  awsQuickstartTerraformConfig,
  awsQuickstartThing,
  managedTerraformAddresses,
  parseAwsQuickstartOptions,
  quickstartRunEvidence,
  recoveredQuickstartDestroyEvidence,
  resolveQuickstartAwsContext,
} from '../../scripts/aws-quickstart.js';

describe('AWS quickstart', () => {
  it('defaults to a real, narrow Codex deployment', () => {
    const options = parseAwsQuickstartOptions([]);
    expect(options).toMatchObject({
      command: 'setup',
      driver: 'codex',
      region: 'us-west-2',
      environment: 'quickstart',
      model: 'openai.gpt-5.6-terra',
    });
    expect(awsQuickstartTerraformConfig(options, '7')).toMatchObject({
      default_agent_driver: 'codex',
      default_sandbox_mode: 'read-only',
      default_agent_network_access: false,
      enable_s3_files: false,
      microvm_base_image_version: '7',
      force_destroy_data: true,
    });
  });

  it('makes mock mode explicit and generates one safe manual Thing', () => {
    const options = parseAwsQuickstartOptions(['--driver', 'mock', '--yes']);
    expect(options).toMatchObject({ driver: 'mock', yes: true });
    expect(awsQuickstartThing('mock', 'RAT-THINGS-READY-TEST')).toMatchObject({
      trigger: { kind: 'manual' },
      agent: {
        driver: 'mock',
        sandbox: 'read-only',
        capabilities: {
          networkAccess: false,
          webSearch: 'disabled',
          computerUse: 'disabled',
        },
      },
      deliver: [{ kind: 'none' }],
    });
  });

  it('rejects ambiguous and unsupported setup choices before AWS changes', () => {
    expect(() => parseAwsQuickstartOptions(['--driver', 'auto'])).toThrow('--driver must be codex or mock');
    for (const region of ['ap-northeast-1', 'eu-west-1']) {
      expect(() => parseAwsQuickstartOptions(['--region', region])).toThrow(
        'default Lambda MicroVM + openai.gpt-5.6-terra quickstart is not supported',
      );
    }
    expect(() => parseAwsQuickstartOptions(['--region', 'eu-central-1'])).toThrow(
      'Lambda MicroVM quickstart is not supported',
    );
    expect(() => parseAwsQuickstartOptions(['--unknown', 'value'])).toThrow('unknown option');
  });

  it('allows a deliberate model or mock diagnostic in the other MicroVM Regions', () => {
    expect(parseAwsQuickstartOptions([
      '--region',
      'eu-west-1',
      '--model',
      'operator.selected-model',
    ])).toMatchObject({ region: 'eu-west-1', driver: 'codex', model: 'operator.selected-model' });
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
    )).toMatchObject({
      teardown: {
        microvmImageResolved: true,
        listedMicrovms: 2,
        activeMicrovms: 0,
        kmsKey: { enabled: false, state: 'PendingDeletion' },
      },
    });
    expect(() => recoveredQuickstartDestroyEvidence(
      context,
      true,
      { listedMicrovms: 1, activeMicrovms: 1 },
    )).toThrow('left 1 active MicroVM');
  });

  it('accepts only successful Runs bound to the exact Thing revision and proof marker', () => {
    const specHash = 'a'.repeat(64);
    const run = {
      runId: 'run-active',
      status: 'succeeded',
      thing: {
        thingId: 'thing-first',
        revision: 1,
        specHash,
        invocation: 'manual',
      },
      result: { preview: 'RAT-THINGS-READY-TEST The Thing is ready.' },
    };
    expect(quickstartRunEvidence(
      run,
      'manual',
      'thing-first',
      1,
      specHash,
      'RAT-THINGS-READY-TEST',
    )).toEqual({
      runId: 'run-active',
      status: 'succeeded',
      invocation: 'manual',
      revision: 1,
      specHash,
      outputPreview: 'RAT-THINGS-READY-TEST The Thing is ready.',
    });
    expect(() => quickstartRunEvidence(
      { ...run, thing: { ...run.thing, specHash: 'b'.repeat(64) } },
      'manual',
      'thing-first',
      1,
      specHash,
      'RAT-THINGS-READY-TEST',
    )).toThrow('did not bind the expected active Thing revision');
    expect(() => quickstartRunEvidence(
      { ...run, result: { preview: 'wrong output' } },
      'manual',
      'thing-first',
      1,
      specHash,
      'RAT-THINGS-READY-TEST',
    )).toThrow('did not contain its proof marker');
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
