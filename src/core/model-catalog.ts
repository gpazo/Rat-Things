import type { PiModelDescriptor } from '../domain/session-runtime.js';

export interface ModelCatalogEntry {
  readonly id: string;
  readonly object: 'model';
  readonly display_name?: string;
  readonly input?: readonly ('text' | 'image')[];
  readonly reasoning?: readonly string[];
}

export interface ModelCatalog {
  readonly object: 'list';
  readonly data: readonly ModelCatalogEntry[];
  readonly default_model?: string;
  readonly runtime?: 'pi';
  readonly capabilities?: typeof PI_CAPABILITIES;
}

export function modelCatalogFromConfig(modelIdsJson: string | undefined, defaultModel?: string): ModelCatalog | undefined {
  if (!modelIdsJson) return undefined;
  let modelIds: unknown;
  try {
    modelIds = JSON.parse(modelIdsJson);
  } catch {
    return undefined;
  }
  return createModelCatalog({ modelIds, ...(defaultModel === undefined ? {} : { defaultModel }) });
}

export function createModelCatalog(config: { readonly modelIds: unknown; readonly defaultModel?: string }): ModelCatalog | undefined {
  if (!Array.isArray(config.modelIds) || config.modelIds.length === 0) return undefined;
  if (config.modelIds.some(modelId => !validModelId(modelId))) return undefined;
  const modelIds = config.modelIds as string[];
  if (new Set(modelIds).size !== modelIds.length) return undefined;
  if (config.defaultModel !== undefined && (!validModelId(config.defaultModel) || !modelIds.includes(config.defaultModel))) return undefined;
  return {
    object: 'list',
    data: modelIds.map(id => ({ id, object: 'model' as const })),
    ...(config.defaultModel === undefined ? {} : { default_model: config.defaultModel }),
  };
}

function validModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export const PI_CAPABILITIES = {
  environments: ['none', 'openai_hosted'],
  tools: ['function', 'mcp'],
  multi_agent: true,
  programmatic_tool_calling: false,
  deferred_tools: false,
  text_formats: ['text'],
  verbosity: ['medium'],
  service_tiers: ['auto'],
  reasoning_summary: [null],
} as const;

export function createPiModelCatalog(catalog: readonly PiModelDescriptor[], defaultModel?: string): ModelCatalog | undefined {
  const base = createModelCatalog({ modelIds: catalog.map(model => model.id), ...(defaultModel === undefined ? {} : { defaultModel }) });
  if (!base) return undefined;
  return {
    ...base, runtime: 'pi', capabilities: PI_CAPABILITIES,
    data: catalog.map(model => ({ id: model.id, object: 'model', display_name: model.name, input: model.input, reasoning: model.reasoning })),
  };
}
