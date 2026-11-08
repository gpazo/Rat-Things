import { expect, it } from 'vitest';
import { cellCleanupHealthy, liveConfiguration, mapBounded, observersHealthy, parseArguments, receiptValidationAfter, sampleStatus, terminalRunStatus, run, type InputSample } from '../../testing/performance-aws/progress.js';

const argumentsFor = (...rest: string[]) => parseArguments([
  '--before-url', 'https://before.lambda-web.us-west-2.on.aws/v1',
  '--after-url', 'https://after.lambda-web.us-west-2.on.aws/v1',
  '--operator-url', 'https://operator.execute-api.us-west-2.amazonaws.com/v1',
  '--output', '/tmp/aws-peer-progress.json',
  ...rest,
]);
const environment = {
  AWS_E2E_PROGRESS: 'true', AWS_E2E_SHARED_SESSIONS: 'true', AWS_REGION: 'us-west-2',
  AWS_E2E_CODEX_MODEL_ID: 'openai.gpt-6-luna',
  TEAM_OIDC_FIXTURE_JSON: JSON.stringify({ user_pool_id: 'us-west-2_fixture', issuer: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_fixture',
    client_id: 'fixture', login_origin: 'https://login.fixture.invalid', redirect_uri: 'rat-things://callback' }),
};

it('bounds alternating endpoints, modes, pairs, and optional bundle provenance', () => {
  expect(argumentsFor('--mode', 'both', '--pairs', '5', '--before-bundle-sha256', 'a'.repeat(64), '--after-bundle-sha256', 'B'.repeat(64)))
    .toMatchObject({ mode: 'both', pairs: 5, beforeBundleSha256: 'a'.repeat(64), afterBundleSha256: 'b'.repeat(64) });
  expect(argumentsFor()).toMatchObject({ mode: 'persistent', pairs: 5, beforeBundleSha256: null, afterBundleSha256: null });
  expect(() => argumentsFor('--pairs', '6')).toThrow('--pairs');
  expect(() => argumentsFor('--pairs', '1', '--pairs', '2')).toThrow('duplicate');
  expect(() => argumentsFor('--mode', 'inference')).toThrow('--mode');
  expect(() => argumentsFor('--before-bundle-sha256', 'not-a-hash')).toThrow('--before-bundle-sha256');
});

it('requires the explicit zero-inference opt-in and validates deployed endpoint regions', async () => {
  const options = argumentsFor();
  await expect(run(options, {})).rejects.toThrow('AWS_E2E_PROGRESS=true');
  expect(liveConfiguration(environment, options)).toMatchObject({ region: 'us-west-2', model: 'openai.gpt-6-luna' });
  expect(() => liveConfiguration({ ...environment, AWS_E2E_PROGRESS: 'false' }, options)).toThrow('AWS_E2E_PROGRESS=true');
  expect(() => liveConfiguration({ ...environment, AWS_E2E_CODEX_MODEL_ID: 'openai.gpt-6-astra' }, options)).toThrow('Luna');
  expect(() => liveConfiguration({ ...environment, AWS_REGION: 'us-east-1' }, options)).toThrow('identity pool must belong');
  expect(() => liveConfiguration({ ...environment, TEAM_OIDC_FIXTURE_JSON: '{bad' }, options)).toThrow('TEAM_OIDC_FIXTURE_JSON');
});

it('rejects unsafe URL forms, same-side endpoints, and endpoint query strings', () => {
  const options = argumentsFor();
  expect(() => liveConfiguration(environment, { ...options, afterUrl: options.beforeUrl })).toThrow('different');
  expect(() => liveConfiguration(environment, { ...options, beforeUrl: 'https://user:pass@before.lambda-web.us-west-2.on.aws/api/v1' })).toThrow('endpoint URL');
  expect(() => liveConfiguration(environment, { ...options, afterUrl: `${options.afterUrl}?token=private` })).toThrow('endpoint URL');
  expect(() => liveConfiguration(environment, { ...options, beforeUrl: 'https://before.lambda-web.us-west-2.on.aws/api/v1' })).toThrow('/v1 endpoint');
  expect(() => liveConfiguration(environment, { ...options, operatorUrl: 'https://operator.lambda-web.us-west-2.on.aws/v1' })).toThrow('control API Gateway');
  expect(liveConfiguration(environment, { ...options, beforeUrl: 'https://lm2trh10396zdh82.32l.lambda-web.us-west-2.on.aws/v1' }).beforeUrl)
    .toBe('https://lm2trh10396zdh82.32l.lambda-web.us-west-2.on.aws/v1');
});

it('stops scheduling bounded setup work after an error and drains already-started requests', async () => {
  const started: number[] = [];
  let secondFinished = false;
  await expect(mapBounded([0, 1, 2, 3], 2, async value => {
    started.push(value);
    if (value === 0) throw new Error('setup failure');
    if (value === 1) { await new Promise(resolve => setTimeout(resolve, 10)); secondFinished = true; }
  })).rejects.toThrow('setup failure');
  expect(started).toEqual([0, 1]);
  expect(secondFinished).toBe(true);
});

it('attributes observer failures to that viewer and makes auxiliary failures terminal', () => {
  const sample: InputSample = { id: 'input', writer: 'writer-0', textSha256: 'hash', payloadBytes: 1, startedMs: 10, deadlineMs: 40,
    acknowledgement: { state: 'accepted', httpStatus: 204, latencyMs: 1, acknowledgedAtMs: 11 }, receiptMatches: 1, receiptValidation: 'valid',
    peers: ['viewer-0', 'viewer-1'].map(peer => ({ peer, observation: { state: 'pending' } })) };
  const observers = [
    { peer: 'viewer-0', mode: 'desktop' as const, connections: [], initialSnapshotBytes: 10, activityFrames: 1, errors: [], auxiliaryErrors: ['runtime_snapshot_failed'] },
    { peer: 'viewer-1', mode: 'desktop' as const, connections: [], initialSnapshotBytes: 10, activityFrames: 1, errors: [], auxiliaryErrors: [] },
  ];
  const finished = sampleStatus(sample, 50, observers);
  expect(finished.peers.map(peer => peer.observation.state)).toEqual(['error', 'censored']);
  expect(finished.peers[0]?.observation).toMatchObject({ reason: 'observer_error' });
  expect(observersHealthy(observers)).toBe(false);
});

it('keeps exact-receipt validation failures sticky across later snapshots', () => {
  expect(receiptValidationAfter('pending', 2)).toBe('failed');
  expect(receiptValidationAfter('failed', 1, true)).toBe('failed');
  expect(receiptValidationAfter('pending', 1, false)).toBe('failed');
  expect(receiptValidationAfter('pending', 1, true)).toBe('valid');
});

it('sets a terminal run status from completed cells and identity cleanup', () => {
  expect(terminalRunStatus({ cells: [{ status: 'passed' }, { status: 'passed' }], plannedCells: 2, identities: 'complete' })).toBe('passed');
  expect(terminalRunStatus({ cells: [{ status: 'running' }], plannedCells: 1, identities: 'complete' })).toBe('failed');
  expect(terminalRunStatus({ cells: [{ status: 'passed' }], plannedCells: 2, identities: 'complete' })).toBe('failed');
  expect(terminalRunStatus({ cells: [{ status: 'passed' }], plannedCells: 1, identities: 'failed' })).toBe('failed');
  expect(terminalRunStatus({ cells: [{ status: 'passed' }], plannedCells: 1, identities: 'complete', priorFailure: true })).toBe('failed');
});

it('fails a cell when created resources could not be deleted', () => {
  expect(cellCleanupHealthy({ sessionCreated: true, sessionStatus: 'complete', agentCreated: true, agentStatus: 'complete' })).toBe(true);
  expect(cellCleanupHealthy({ sessionCreated: true, sessionStatus: 'http_409', agentCreated: true, agentStatus: 'complete' })).toBe(false);
  expect(cellCleanupHealthy({ sessionCreated: false, sessionStatus: undefined, agentCreated: false, agentStatus: undefined })).toBe(true);
});
