import { expect, it, vi } from 'vitest';
import { createLocalPiModels, localPiCatalog } from '../../src/runner/local-pi-models.js';
import { createPiModels, piCatalog } from '../../src/runner/pi/provider.js';
import { resolveRuntime } from '../../src/domain/session-runtime.js';

it('keeps local Pi subscription inference and AWS Bedrock catalogs separate', async () => {
  const catalog = localPiCatalog();
  const pin = resolveRuntime({ rat_things_runtime: 'pi' }, null, [catalog[0]!]);
  if (pin.kind !== 'pi') throw new Error('Expected Pi');
  const token = vi.fn(async () => 'private-subscription-token');
  const models = createLocalPiModels(pin, token);
  expect(models.getProviders().map(provider => provider.id)).toEqual(['openai-codex']);
  expect(models.getModels().map(model => model.id)).toEqual([catalog[0]!.id]);
  expect(await models.getAuth('openai-codex')).toMatchObject({ auth: { apiKey: 'private-subscription-token' } });
  expect(token).toHaveBeenCalledTimes(1);
  expect(() => createPiModels(pin, async () => 'aws-token')).toThrow('only Amazon Bedrock');
  const cloud = resolveRuntime({ rat_things_runtime: 'pi' }, null, piCatalog(['amazon.nova-micro-v1:0'], 'us-east-1'));
  if (cloud.kind !== 'pi') throw new Error('Expected Pi');
  expect(() => createLocalPiModels(cloud, token)).toThrow('subscription catalog');
  const failing = createLocalPiModels(pin, async () => { throw new Error('Sign in required'); });
  await expect(failing.getAuth('openai-codex')).rejects.toThrow();
  await expect(createLocalPiModels(pin, async () => '').getAuth('openai-codex')).rejects.toThrow('subscription token');
});
