import type { Model } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import type { PiModelDescriptor } from '../domain/session-runtime.js';

const converseModels: Readonly<Record<string, readonly string[]>> = {
  'amazon.nova-micro-v1:0': ['none'],
  'amazon.nova-lite-v1:0': ['none'],
  'amazon.nova-pro-v1:0': ['none'],
  'anthropic.claude-haiku-4-5-20251001-v1:0': ['minimal', 'low', 'medium', 'high'],
  'anthropic.claude-sonnet-4-5-20250929-v1:0': ['minimal', 'low', 'medium', 'high'],
  'anthropic.claude-sonnet-4-6': ['low', 'medium', 'high'],
  'anthropic.claude-opus-4-5-20251101-v1:0': ['minimal', 'low', 'medium', 'high'],
  'anthropic.claude-opus-4-6-v1': ['low', 'medium', 'high'],
  'openai.gpt-oss-20b-1:0': ['low', 'medium', 'high'],
  'openai.gpt-oss-120b-1:0': ['low', 'medium', 'high'],
  'openai.gpt-5.4': ['low', 'medium', 'high'],
};

const profilePrefix = /^(?:us|eu|apac|au|ca|jp|in|global|us-gov)\./;
const registry = amazonBedrockProvider().getModels();
const gpt54Profiles = new Set(['us.openai.gpt-5.4', 'global.openai.gpt-5.4']);

export function piRegistryModel(id: string): Model<'bedrock-converse-stream'> {
  const baseId = id.replace(profilePrefix, '');
  const model = registry.find(entry => entry.id === (gpt54Profiles.has(id) ? baseId : id));
  if (!Object.hasOwn(converseModels, baseId) || (baseId === 'openai.gpt-5.4' && !gpt54Profiles.has(id)) ||
      !model || model.api !== 'bedrock-converse-stream') {
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
      reasoning: [...converseModels[id.replace(profilePrefix, '')]!],
    };
  });
}

export function piCatalogFromConfig(modelIdsJson: string | undefined, region: string | undefined): PiModelDescriptor[] {
  if (!modelIdsJson) return [];
  const ids: unknown = JSON.parse(modelIdsJson);
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw new Error('PI_BEDROCK_MODEL_IDS_JSON must be a JSON array of model IDs');
  return piCatalog(ids, region ?? '');
}
