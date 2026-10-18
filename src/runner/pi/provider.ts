import { createModels, type CredentialStore, type Model, type Models } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import type { PiModelDescriptor, RuntimePin } from '../../domain/session-runtime.js';

export function piCatalog(modelIds: readonly string[], region: string): PiModelDescriptor[] {
  const known = amazonBedrockProvider().getModels();
  return modelIds.map(id => {
    const model = known.find(entry => entry.id === id);
    if (!model || model.api !== 'bedrock-converse-stream') throw new Error(`Unknown Pi Converse model: ${id}`);
    return { id, name: model.name, provider: 'amazon-bedrock', api: 'bedrock-converse-stream', region,
      input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      reasoning: model.reasoning ? ['minimal', 'low', 'medium', 'high'] : ['none'] };
  });
}

export function createPiModels(pin: Extract<RuntimePin, { kind: 'pi' }>, token: () => Promise<string>): Models {
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
  const provider = amazonBedrockProvider();
  const admitted: Model<'bedrock-converse-stream'>[] = pin.catalog.map(descriptor => {
    const model = provider.getModels().find(entry => entry.id === descriptor.id);
    if (!model) throw new Error('Pinned Pi model is absent from the installed registry');
    return { ...model };
  });
  models.setProvider({ ...provider, getModels: () => admitted, getAllModels: () => admitted });
  return models;
}
