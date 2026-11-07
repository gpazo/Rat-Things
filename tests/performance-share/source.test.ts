import { access } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createSource, generatedWorkspace, sha256, shareMetric } from '../../testing/performance-share/source.js';
import { parseArguments } from '../../testing/performance-share/controller.js';

it('uses a real hosted template/environment with a completed deterministic source and no model usage', async () => {
  const source = await createSource('fixture-model');
  try {
    expect(source.history.turns).toHaveLength(1);
    expect(source.history.turns[0]).toMatchObject({ status: 'completed', usage: null });
    expect(source.session.environment).toMatchObject({ type: 'openai_hosted', network: { access: 'disabled' } });
    if (source.session.environment.type !== 'openai_hosted') throw new Error('Expected hosted source fixture');
    expect((await source.environments.managedLaunch(source.owner, source.session.environment.id)).hostedConfiguration?.env).toEqual({});
    expect(source.executorClosed()).toBe(false);
  } finally { await source.close(); }
  await expect(access(source.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('generates bounded random payloads before timing and exposes only safe numeric telemetry', () => {
  const workspace = generatedWorkspace(1);
  const bytes = Buffer.from(workspace.files[0]!.data, 'base64');
  expect(bytes.length).toBe(1024 * 1024);
  expect(sha256(bytes)).toBe(workspace.evidence.sha256);
  expect(() => generatedWorkspace(100)).toThrow();
  expect(shareMetric({ event: 'rat.performance', Operation: 'share-transfer', Outcome: 'success', RequestDuration: 10, ShareArchiveBytes: 100, secret: 'private', ShareUploadDuration: -1 })).toEqual({ outcome: 'success', metrics: { RequestDuration: 10, ShareArchiveBytes: 100 } });
  expect(shareMetric({ event: 'other', token: 'private' })).toBeUndefined();
  expect(parseArguments(['--output', '/tmp/share.json']).sizesMiB).toEqual([1, 10, 40]);
  expect(() => parseArguments(['--output', '/tmp/share.json', '--sizes-mib', '40,40'])).toThrow();
});
