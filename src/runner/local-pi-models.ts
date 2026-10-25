import { createModels, type CredentialStore, type Models, type OAuthCredential } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { PiModelDescriptor, RuntimePin } from '../domain/session-runtime.js';

const providerId = 'openai-codex';
const registry = openaiCodexProvider();

export function localPiCatalog(): PiModelDescriptor[] {
  return registry.getModels().map(model => ({ id: model.id, name: model.name, provider: providerId, api: 'openai-codex-responses',
    input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    reasoning: model.reasoning ? ['low', 'medium', 'high', ...Object.keys(model.thinkingLevelMap ?? {}).filter(level => ['xhigh', 'max'].includes(level))] : [],
  }));
}

/** Subscription-only inference: no API-key, AWS, ambient credential or custom-endpoint fallback. */
export function createLocalPiModels(pin: Extract<RuntimePin, { kind: 'pi' }>, token: () => Promise<string>): Models {
  const admitted = pin.catalog.map(descriptor => {
    const model = registry.getModels().find(model => model.id === descriptor.id);
    if (!model || descriptor.provider !== providerId || descriptor.api !== model.api) throw new Error('Local Pi model is outside the subscription catalog');
    return model;
  });
  const credential = async (): Promise<OAuthCredential> => {
    const access = await token();
    if (!access.trim()) throw new Error('A local ChatGPT subscription token is required');
    // The host refreshes through Codex before every read. Pi must never rotate or persist it.
    return { type: 'oauth', access, refresh: '', expires: Number.MAX_SAFE_INTEGER };
  };
  const denied = async (): Promise<never> => { throw new Error('Subscription credentials are owned by the local sign-in service'); };
  const credentials: CredentialStore = {
    read: async provider => { if (provider !== providerId) return undefined; return credential(); },
    list: async () => [{ providerId, type: 'oauth' }], modify: denied, delete: denied,
  };
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider({ ...registry, getModels: () => admitted, getAllModels: () => admitted });
  return models;
}
