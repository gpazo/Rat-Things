import { expect, it } from 'vitest';
import { analyzeProbeLogs, parseArguments, parseConfiguration, planProbeWindow, planProbes, planReconciliationDeadline, runHookPayload, validateConfiguration } from '../../testing/performance-aws/storage.js';

const config = {
  deploymentId: 'st1108a',
  region: 'us-west-2',
  account: '731841023867',
  imageIdentifier: 'arn:aws:lambda:us-west-2:731841023867:microvm-image:rat-things-st1108a-agent',
  baselineVersion: '1.0',
  candidateVersion: '2.0',
  executionRoleArn: 'arn:aws:iam::731841023867:role/rat-things-st1108a-microvm-execution',
  connectorArn: 'arn:aws:lambda:us-west-2:731841023867:network-connector:nc-9fe7d5ac-56bd-49b8-8369-2a267eed9076',
  logGroupName: '/rat-things-st1108a/microvms',
  runsTableName: 'rat-things-st1108a-runs',
  integrationsTableName: 'rat-things-st1108a-integrations',
  artifactBucket: 'rat-things-st1108a-artifacts-ac2245ef2368',
  filesystem: 'fs-0686baee18ef250e6',
  accesspoint: 'fsap-020483c8545a5fc29',
  targetIP: '10.0.0.7',
} as const;

const runId = '19645f4f-8383-4173-92ec-521ad8ae4e36';
const microvmId = 'mvm-1234';
const args = (...extra: string[]) => parseArguments(['--config', '/tmp/probe-config.json', '--output', '/tmp/probe.json', ...extra]);
const event = (timestamp: number, value: unknown) => ({ timestamp, message: JSON.stringify(value) });
function baseLogs(mode: 'storage' | 'control') {
  return [
    ...(mode === 'storage' ? [event(1_000, { level: 'info', message: 'S3 Files Session state mounted', durationMs: 18 })] : []),
    event(1_010, { level: 'info', message: 'agent runner started', runId, microvmId, startupDurationMs: 30,
      storageMountDurationMs: mode === 'storage' ? 18 : 0, storagePreparationDurationMs: mode === 'storage' ? 7 : 0, storageAlreadyMounted: false }),
    event(1_020, { level: 'error', message: 'agent worker failed', error: { name: 'Error', message: `run ${runId} does not exist` } }),
    event(1_030, { level: 'error', message: 'agent runner exited', runId, code: 1, signal: null }),
  ];
}

it('accepts the exact disposable config and permits a single-version diagnostic only', () => {
  expect(validateConfiguration(parseConfiguration(config))).toEqual(config);
  expect(() => validateConfiguration({ ...config, candidateVersion: '1.0' })).toThrow('must differ');
  expect(validateConfiguration({ ...config, candidateVersion: '1.0' }, true)).toEqual({ ...config, candidateVersion: '1.0' });
  expect(() => parseConfiguration({ ...config, extra: 'ignored' })).toThrow('15 documented string fields');
  expect(() => validateConfiguration({ ...config, region: 'us-east-1' })).toThrow('MicroVM image must belong');
  expect(() => validateConfiguration({ ...config, connectorArn: config.connectorArn.replace('us-west-2', 'us-east-1') })).toThrow('S3 Files network connector');
  expect(() => validateConfiguration({ ...config, deploymentId: 'prod' })).toThrow('disposable deployment ID');
});

it('caps probe plans and alternates baseline and candidate images across five pairs', () => {
  const plan = planProbes(args());
  expect(plan).toHaveLength(10);
  expect(plan.map(probe => [probe.pair, probe.side])).toEqual([
    [1, 'baseline'], [1, 'candidate'], [2, 'candidate'], [2, 'baseline'], [3, 'baseline'], [3, 'candidate'],
    [4, 'candidate'], [4, 'baseline'], [5, 'baseline'], [5, 'candidate'],
  ]);
  expect(args('--pairs', '1')).toMatchObject({ pairs: 1 });
  expect(planProbes(args('--pairs', '6'))).toHaveLength(12);
  expect(() => args('--pairs', '7')).toThrow('--pairs');
  expect(() => args('--pairs', '1', '--diagnostic', 'storage', '--version', 'baseline')).toThrow('cannot be combined');
  expect(planProbes(args('--diagnostic', 'control', '--version', 'candidate'))).toEqual([
    { index: 1, pair: null, side: 'candidate', mode: 'control' },
  ]);
  expect(() => args('--diagnostic', 'storage')).toThrow('requires --diagnostic');
  expect(() => args('--expect-profile')).toThrow('requires one storage diagnostic');
  expect(() => args('--diagnostic', 'control', '--version', 'baseline', '--expect-profile')).toThrow('requires one storage diagnostic');
  expect(args('--diagnostic', 'storage', '--version', 'baseline', '--expect-profile').expectProfile).toBe(true);
  expect(() => args('--unknown', 'value')).toThrow('Invalid or duplicate');
});

it('reserves 60 seconds for cleanup after a 120-second work window', () => {
  const window = planProbeWindow(1_000, 500_000);
  expect(window).toEqual({ workDeadline: 121_000, cleanupDeadline: 181_000 });
  expect(planReconciliationDeadline(window, 30_000)).toBe(40_000);
  expect(planReconciliationDeadline(window, 120_000)).toBe(window.workDeadline);
  expect(() => planProbeWindow(1_000, 180_999)).toThrow('At least 180 seconds');
});

it('builds a valid storage hook and a no-storage control without Session or model payload fields', () => {
  const common = { runId, generation: 'a'.repeat(64), storageKey: 'b'.repeat(64) };
  const storageHook = JSON.parse(runHookPayload(config, { ...common, mode: 'storage' }));
  expect(storageHook).toMatchObject({ version: 1, runId, executionGeneration: 'a'.repeat(64), persistentSession: true,
    sessionStorageKey: 'b'.repeat(64), s3FilesFileSystemId: config.filesystem, s3FilesAccessPointId: config.accesspoint,
    s3FilesMountTargetIp: config.targetIP, defaultAgentNetworkAccess: false, defaultSandboxMode: 'read-only', allowAgentAwsCredentialChain: false });
  expect(storageHook.defaultModel).toBeUndefined();
  expect(storageHook.codexAuthFileSecretArn).toBeUndefined();
  const controlHook = JSON.parse(runHookPayload(config, { ...common, mode: 'control' }));
  expect(controlHook.persistentSession).toBe(true);
  expect(controlHook.sessionStorageKey).toBeUndefined();
  expect(controlHook.s3FilesFileSystemId).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(storageHook))).toBeLessThan(4_096);
});

it('requires mount, runner-start, missing-Run, and runner-exit evidence for one matching MicroVM', () => {
  const storage = analyzeProbeLogs(baseLogs('storage'), { runId, microvmId, mode: 'storage', region: config.region, expectProfile: false });
  expect(storage).toMatchObject({
    storageMount: { durationMs: 18 },
    runnerStarted: { startupDurationMs: 30, storageMountDurationMs: 18, storagePreparationDurationMs: 7, storageAlreadyMounted: false },
    missingRunFailure: { message: `run ${runId} does not exist` }, runnerExited: { code: 1, signal: null }, profile: null,
  });
  const control = analyzeProbeLogs(baseLogs('control'), { runId, microvmId, mode: 'control', region: config.region, expectProfile: false });
  expect(control.storageMount).toBeNull();
  expect(control.runnerStarted.storageMountDurationMs).toBe(0);
  expect(() => analyzeProbeLogs(baseLogs('control'), { runId, microvmId, mode: 'storage', region: config.region, expectProfile: false }))
    .toThrow('Missing or duplicate S3 Files mount log');
  expect(() => analyzeProbeLogs(baseLogs('storage').filter((_, index) => index !== 2), { runId, microvmId, mode: 'storage', region: config.region, expectProfile: false }))
    .toThrow('Missing expected runner failure');
});

it('validates an expected fixed profile marker and retains only its allowlisted fields', () => {
  const profile = {
    schema: 'rat-things.storage-mount-profile.v1', outcome: 'success', durationMs: 120, exitCode: 0,
    rootEnv: { awsRegionPresent: false, awsDefaultRegionPresent: false }, validatedRegion: config.region,
    usage: { userMs: 1, systemMs: 2, majorFaults: 3, minorFaults: 4 },
    trace: { scope: 'mount-launcher-only', available: true, totalSeconds: 0.5, calls: 3,
      syscalls: [{ name: 'connect', calls: 2, seconds: 0.4, raw: 'discarded' }] },
    phases: [{ id: 'helper_configured', timestamp: '2026-11-08 12:00:00 UTC', raw: 'discarded' }],
    importTimings: [{ module: 'mount_s3files', selfUs: 5, cumulativeUs: 8, raw: 'discarded' }],
    secret: 'never persist this field',
  };
  const events = [...baseLogs('storage'), { timestamp: 1_015, message: `storage-mount-profile ${JSON.stringify(profile)}` }];
  const result = analyzeProbeLogs(events, { runId, microvmId, mode: 'storage', region: config.region, expectProfile: true });
  expect(result.profile).toMatchObject({ schema: 'rat-things.storage-mount-profile.v1', trace: { syscalls: [{ name: 'connect', calls: 2, seconds: 0.4 }] },
    phases: [{ id: 'helper_configured' }], importTimings: [{ module: 'mount_s3files' }] });
  expect(result.profile).not.toHaveProperty('secret');
  expect((result.profile?.trace as { syscalls: Array<Record<string, unknown>> }).syscalls[0]).not.toHaveProperty('raw');
  expect(() => analyzeProbeLogs(baseLogs('storage'), { runId, microvmId, mode: 'storage', region: config.region, expectProfile: true }))
    .toThrow('Missing or duplicate expected storage mount profile');
  expect(() => analyzeProbeLogs(events, { runId, microvmId, mode: 'storage', region: config.region, expectProfile: false }))
    .toThrow('Unexpected storage mount profile');
});
