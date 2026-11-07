import { expect, it } from 'vitest';
import { cleanupActions, liveConfiguration, parseArguments, run } from '../../testing/performance-aws/controller.js';

it('requires explicit live opt-ins before operations and restricts the matrix', async () => {
  const options = parseArguments(['--output', '/tmp/aws-performance-test.json']);
  expect(options.scenarios).toEqual([{ writers: 1, viewers: 1 }, { writers: 10, viewers: 10 }, { writers: 20, viewers: 20 }, { writers: 20, viewers: 50 }]);
  expect(options.rounds).toBe(1);
  await expect(run(options, {})).rejects.toThrow('AWS_E2E');
  expect(() => liveConfiguration({ AWS_E2E: 'true', AWS_E2E_SHARED_SESSIONS: 'true' })).toThrow('AWS_E2E_REAL_CODEX');
  expect(() => parseArguments(['--output', '/tmp/test', '--scenario', '100x100'])).toThrow('Scenario');
  expect(() => parseArguments(['--output', '/tmp/test', '--rounds', '0'])).toThrow('rounds');
  expect(parseArguments(['--output', '/tmp/test', '--scenario', '20x20', '--stream-mode', 'desktop'])).toMatchObject({ scenarios: [{ writers: 20, viewers: 20 }], streamMode: 'desktop' });
});

it('attempts all cleanup even when cancel, Session deletion, or identity cleanup fails', async () => {
  const called: string[] = [];
  const actions = ['observers', 'cancel', 'drain', 'session', 'agent', 'identities'].map(name => [name, async () => {
    called.push(name); if (['cancel', 'session', 'identities'].includes(name)) throw new Error('private error is not persisted');
  }] as const);
  expect(await cleanupActions(actions)).toEqual({ observers: 'complete', cancel: 'failed', drain: 'complete', session: 'failed', agent: 'complete', identities: 'failed' });
  expect(called).toEqual(['observers', 'cancel', 'drain', 'session', 'agent', 'identities']);
});
