import type { Model } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import type { PiModelDescriptor } from '../domain/session-runtime.js';
import supportedModels from './pi-bedrock-models.json' with { type: 'json' };

const converseModels = new Map(supportedModels.entries.flatMap(entry => entry.invocationIds.map(id => [id, entry] as const)));
const registry = new Map(amazonBedrockProvider().getModels().map(model => [model.id, model]));

export function piRegistryModel(id: string): Model<'bedrock-converse-stream'> {
  const supported = converseModels.get(id);
  const model = supported && (registry.get(id) ?? registry.get(supported.registryId));
  if (!model || model.api !== 'bedrock-converse-stream') {
    throw new Error(`Unsupported Pi Converse model: ${id}`);
  }
  return { ...model, id };
}

export function piCatalog(modelIds: readonly string[], region: string): PiModelDescriptor[] {
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) throw new Error('AWS_REGION is required for the Pi Bedrock catalog');
  if (new Set(modelIds).size !== modelIds.length) throw new Error('PI_BEDROCK_MODEL_IDS_JSON must not contain duplicates');
  return modelIds.map(id => {
    const model = piRegistryModel(id);
    return {
      id, name: model.name, provider: 'amazon-bedrock', api: 'bedrock-converse-stream', region,
      input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      reasoning: [...converseModels.get(id)!.reasoning],
    };
  });
}

export function piCatalogFromConfig(modelIdsJson: string | undefined, region: string | undefined): PiModelDescriptor[] {
  if (!modelIdsJson) return [];
  const ids: unknown = JSON.parse(modelIdsJson);
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw new Error('PI_BEDROCK_MODEL_IDS_JSON must be a JSON array of model IDs');
  return piCatalog(ids, region ?? '');
}
