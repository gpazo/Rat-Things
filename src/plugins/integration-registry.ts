import { validateOperationDefinition } from '../domain/capabilities.js';
import type { IntegrationPlugin } from './integration-types.js';

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const RESERVED_DYNAMIC_NAMESPACES = new Set([
  'api_tool',
  'browser',
  'computer',
  'container',
  'file_search',
  'functions',
  'image_gen',
  'multi_tool_use',
  'python',
  'python_user_visible',
  'submodel_delegator',
  'terminal',
  'tool_search',
  'web',
]);

export class IntegrationPluginRegistry {
  private readonly plugins = new Map<string, IntegrationPlugin>();

  public constructor(plugins: IntegrationPlugin[]) {
    for (const plugin of plugins) this.register(plugin);
  }

  public list(): IntegrationPlugin[] {
    return [...this.plugins.values()];
  }

  public plugin(id: string): IntegrationPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`integration plugin ${id} is not installed`);
    return plugin;
  }

  private register(plugin: IntegrationPlugin): void {
    const manifest = plugin.manifest;
    if (!PLUGIN_ID.test(manifest.id)) throw new Error(`integration plugin ID ${manifest.id} is invalid`);
    if (RESERVED_DYNAMIC_NAMESPACES.has(manifest.id)) {
      throw new Error(`integration plugin ID ${manifest.id} is reserved by the model runtime`);
    }
    if (this.plugins.has(manifest.id)) throw new Error(`duplicate integration plugin ${manifest.id}`);
    if (manifest.version !== '1') throw new Error(`integration plugin ${manifest.id} has an unsupported version`);
    if (
      !manifest.title.trim() ||
      Buffer.byteLength(manifest.title, 'utf8') > 256 ||
      !manifest.description.trim() ||
      Buffer.byteLength(manifest.description, 'utf8') > 1_024
    ) {
      throw new Error(`integration plugin ${manifest.id} requires a title and description`);
    }
    if (manifest.authSchemes.length === 0 || new Set(manifest.authSchemes).size !== manifest.authSchemes.length) {
      throw new Error(`integration plugin ${manifest.id} auth schemes are invalid`);
    }
    if (manifest.operations.length === 0) throw new Error(`integration plugin ${manifest.id} has no operations`);
    const operationIds = new Set<string>();
    for (const operation of manifest.operations) {
      validateOperationDefinition(operation);
      if (!operation.id.startsWith(`${manifest.id}.`)) {
        throw new Error(`operation ${operation.id} is outside plugin namespace ${manifest.id}`);
      }
      if (operationIds.has(operation.id)) throw new Error(`duplicate operation ${operation.id}`);
      operationIds.add(operation.id);
    }
    this.plugins.set(manifest.id, plugin);
  }
}
