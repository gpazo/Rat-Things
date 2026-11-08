import { expect, it } from 'vitest';
import { cleanupActions, liveConfiguration, parseArguments, run } from '../../testing/performance-aws/controller.js';

const liveEnvironment = (model: string) => ({ AWS_E2E: 'true', AWS_E2E_SHARED_SESSIONS: 'true', AWS_E2E_REAL_CODEX: 'true', AWS_REGION: 'us-west-2',
  SHARED_AGENTS_API_BASE_URL: 'https://fixture.a1.lambda-web.us-west-2.on.aws/api/v1', RAT_THINGS_API_URL: 'https://operator.execute-api.us-west-2.amazonaws.com',
  AWS_E2E_CODEX_MODEL_ID: model, TEAM_OIDC_FIXTURE_JSON: '{}' });

it('requires explicit live opt-ins before operations and restricts the matrix', async () => {
  const options = parseArguments(['--output', '/tmp/aws-performance-test.json']);
  expect(options.scenarios).toEqual([{ writers: 1, viewers: 1 }, { writers: 10, viewers: 10 }, { writers: 20, viewers: 20 }, { writers: 20, viewers: 50 }]);
  expect(options.rounds).toBe(1);
  await expect(run(options, {})).rejects.toThrow('AWS_E2E');
  expect(() => liveConfiguration({ AWS_E2E: 'true', AWS_E2E_SHARED_SESSIONS: 'true' })).toThrow('AWS_E2E_REAL_CODEX');
  expect(() => parseArguments(['--output', '/tmp/test', '--scenario', '100x100'])).toThrow('Scenario');
  expect(() => parseArguments(['--output', '/tmp/test', '--rounds', '0'])).toThrow('rounds');
  expect(parseArguments(['--output', '/tmp/test', '--scenario', '20x20', '--stream-mode', 'desktop'])).toMatchObject({ scenarios: [{ writers: 20, viewers: 20 }], streamMode: 'desktop' });
  expect(liveConfiguration(liveEnvironment('openai.gpt-6-luna')).model).toBe('openai.gpt-6-luna');
  expect(liveConfiguration(liveEnvironment('openai.gpt-5.6-luna')).model).toBe('openai.gpt-5.6-luna');
  expect(() => liveConfiguration(liveEnvironment('openai.gpt-6-astra'))).toThrow('prohibited');
  await expect(run(parseArguments(['--output', '/tmp/aws-performance-test.json', '--scenario', '20x20', '--rounds', '4']), liveEnvironment('openai.gpt-6-luna'))).rejects.toThrow('cap is 60');
});

it('attempts all cleanup even when cancel, Session deletion, or identity cleanup fails', async () => {
  const called: string[] = [];
  const actions = ['observers', 'cancel', 'drain', 'session', 'agent', 'identities'].map(name => [name, async () => {
    called.push(name); if (['cancel', 'session', 'identities'].includes(name)) throw new Error('private error is not persisted');
  }] as const);
  expect(await cleanupActions(actions)).toEqual({ observers: 'complete', cancel: 'failed', drain: 'complete', session: 'failed', agent: 'complete', identities: 'failed' });
  expect(called).toEqual(['observers', 'cancel', 'drain', 'session', 'agent', 'identities']);
});
