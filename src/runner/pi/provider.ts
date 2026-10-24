import { piRegistryModel } from '../../adapters/pi-model-catalog.js';
export { piCatalog } from '../../adapters/pi-model-catalog.js';
import { createModels, type CredentialStore, type Model, type Models } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import type { RuntimePin } from '../../domain/session-runtime.js';

export function createPiModels(pin: Extract<RuntimePin, { kind: 'pi' }>, token: () => Promise<string>, allowedModelIds: readonly string[] = pin.catalog.map(model => model.id)): Models {
  if (pin.catalog.some(model => model.provider !== 'amazon-bedrock')) throw new Error('AWS Pi permits only Amazon Bedrock models');
  const denied = async (): Promise<never> => { throw new Error('Pi credentials are host-owned and read-only'); };
  const credentials: CredentialStore = {
    read: async provider => {
      if (provider !== 'amazon-bedrock') throw new Error('Pi permits only Amazon Bedrock');
      const key = await token();
      if (!key.trim()) throw new Error('A host Bedrock bearer token is required');
      return { type: 'api_key', key };
    },
    list: async () => [{ providerId: 'amazon-bedrock', type: 'api_key' }], modify: denied, delete: denied,
  };
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  setBedrockProviderModule(bedrockProviderModule);
  const provider = amazonBedrockProvider();
  const admitted: Model<'bedrock-converse-stream'>[] = pin.catalog.filter(descriptor => allowedModelIds.includes(descriptor.id)).map(descriptor => {
    const model = piRegistryModel(descriptor.id);
    return { ...model };
  });
  const selected = (id: string) => {
    const model = admitted.find(entry => entry.id === id);
    const descriptor = pin.catalog.find(entry => entry.id === id);
    if (!model || !descriptor || descriptor.provider !== 'amazon-bedrock') throw new Error('Pi model is outside the pinned catalog');
    return { model, region: descriptor.region };
  };
  models.setProvider({ ...provider, getModels: () => admitted, getAllModels: () => admitted,
    stream: (model, context, options) => {
      const entry = selected(model.id);
      const { toolChoice: _toolChoice, ...base } = options ?? {};
      const configured = { ...base, ...(options?.toolChoice !== undefined ? { toolChoice: options.toolChoice as 'auto' | 'any' | 'none' | { type: 'tool'; name: string } } : {}), region: entry.region, env: { AWS_REGION: entry.region, AWS_EC2_METADATA_DISABLED: 'true', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_CONFIG_FILE: '/dev/null' } };
      return provider.stream(entry.model, context, configured as Parameters<typeof provider.stream>[2]);
    },
    streamSimple: (model, context, options) => {
      const entry = selected(model.id);
      const configured = { ...options, region: entry.region, env: { AWS_REGION: entry.region, AWS_EC2_METADATA_DISABLED: 'true', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_CONFIG_FILE: '/dev/null' } };
      return provider.streamSimple(entry.model, context, configured);
    },
  });
  return models;
}
