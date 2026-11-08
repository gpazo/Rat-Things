import { expect, it } from 'vitest';
import { liveConfiguration, parseArguments, run } from '../../testing/performance-aws/progress.js';

const argumentsFor = (...rest: string[]) => parseArguments([
  '--before-url', 'https://before.lambda-web.us-west-2.on.aws/api/v1',
  '--after-url', 'https://after.lambda-web.us-west-2.on.aws/api/v1',
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
});
