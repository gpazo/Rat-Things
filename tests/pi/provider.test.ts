import { describe, expect, it } from 'vitest';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import { createPiModels, piCatalog } from '../../src/runner/pi/provider.js';
import { resolveRuntime } from '../../src/domain/session-runtime.js';

const model = amazonBedrockProvider().getModels()[0]!;
const pin = resolveRuntime({ rat_things_runtime: 'pi' }, null, piCatalog([model.id], 'us-east-1'));
if (pin.kind !== 'pi') throw new Error('Pi fixture');
describe('Pi Bedrock provider boundary', () => {
  it('resolves a new host bearer per request without ambient credential lookup', async () => {
    let reads = 0;
    const models = createPiModels(pin, async () => `host-token-${++reads}`);
    expect(models.getProviders().map(provider => provider.id)).toEqual(['amazon-bedrock']);
    expect((await models.getAuth('amazon-bedrock'))?.auth).toEqual({ apiKey: 'host-token-1' });
    expect((await models.getAuth('amazon-bedrock'))?.auth).toEqual({ apiKey: 'host-token-2' });
    expect(models.getModels().map(entry => entry.id)).toEqual([model.id]);
  });
  it('fails closed when the host returns no bearer, even with AWS variables present', async () => {
    const models = createPiModels(pin, async () => '');
    await expect(models.getAuth('amazon-bedrock')).rejects.toThrow('bearer token');
    await expect(models.logout('amazon-bedrock')).rejects.toThrow('read-only');
  });
});
