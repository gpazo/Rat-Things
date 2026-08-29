import { AUTH_SCHEMES, validateOperationDefinition } from '../domain/capabilities.js';
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
    validateAuthentication(manifest.id, manifest.authentication);
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

function validateAuthentication(
  pluginId: string,
  authentication: IntegrationPlugin['manifest']['authentication'],
): void {
  if (authentication.length === 0) {
    throw new Error(`integration plugin ${pluginId} authentication is required`);
  }
  const schemes = new Set<string>();
  for (const definition of authentication) {
    if (!AUTH_SCHEMES.includes(definition.scheme) || schemes.has(definition.scheme)) {
      throw new Error(`integration plugin ${pluginId} authentication schemes are invalid`);
    }
    schemes.add(definition.scheme);
    if (!definition.title.trim() || Buffer.byteLength(definition.title, 'utf8') > 128) {
      throw new Error(`integration plugin ${pluginId} authentication title is invalid`);
    }
    if (definition.fields.length === 0) {
      throw new Error(`integration plugin ${pluginId} authentication fields are required`);
    }
    const fields = new Set<string>();
    for (const field of definition.fields) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.key) || fields.has(field.key)) {
        throw new Error(`integration plugin ${pluginId} authentication fields are invalid`);
      }
      fields.add(field.key);
      if (!field.label.trim() || Buffer.byteLength(field.label, 'utf8') > 128) {
        throw new Error(`integration plugin ${pluginId} authentication field label is invalid`);
      }
      if (typeof field.secret !== 'boolean') {
        throw new Error(`integration plugin ${pluginId} authentication field secrecy is invalid`);
      }
      if (field.computed !== undefined && typeof field.computed !== 'boolean') {
        throw new Error(`integration plugin ${pluginId} authentication field computation is invalid`);
      }
      if (field.required !== undefined && typeof field.required !== 'boolean') {
        throw new Error(`integration plugin ${pluginId} authentication field requirement is invalid`);
      }
    }
    if (definition.oauth2) {
      if (definition.scheme !== 'oauth2') {
        throw new Error(`integration plugin ${pluginId} OAuth metadata requires the oauth2 scheme`);
      }
      const authorizationUrl = trustedOAuthUrl(definition.oauth2.authorizationUrl);
      const tokenUrl = trustedOAuthUrl(definition.oauth2.tokenUrl);
      if (authorizationUrl.href === tokenUrl.href) {
        throw new Error(`integration plugin ${pluginId} OAuth endpoints must be distinct`);
      }
      if (
        definition.oauth2.scopes.length === 0 ||
        definition.oauth2.scopes.length > 64 ||
        definition.oauth2.scopes.some((scope) => (
          !scope || Buffer.byteLength(scope, 'utf8') > 256 || /[\s,]/.test(scope)
        )) ||
        new Set(definition.oauth2.scopes).size !== definition.oauth2.scopes.length
      ) throw new Error(`integration plugin ${pluginId} OAuth scopes are invalid`);
      if (!['client-secret-basic', 'client-secret-post'].includes(
        definition.oauth2.tokenEndpointAuthMethod,
      )) throw new Error(`integration plugin ${pluginId} OAuth token authentication is invalid`);
      if (definition.oauth2.secondaryToken) {
        const secondary = definition.oauth2.secondaryToken;
        if (
          !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(secondary.authorizationParameter) ||
          ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method']
            .includes(secondary.authorizationParameter) ||
          !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(secondary.responseField) ||
          !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(secondary.credentialPrefix) ||
          secondary.scopes.length === 0 ||
          secondary.scopes.length > 64 ||
          secondary.scopes.some((scope) => (
            !scope || Buffer.byteLength(scope, 'utf8') > 256 || /[\s,]/.test(scope)
          )) ||
          new Set(secondary.scopes).size !== secondary.scopes.length
        ) throw new Error(`integration plugin ${pluginId} OAuth secondary token metadata is invalid`);
      }
      for (const [key, value] of Object.entries(definition.oauth2.authorizationParameters ?? {})) {
        if (
          !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) ||
          ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method'].includes(key) ||
          !value ||
          Buffer.byteLength(value, 'utf8') > 1_024
        ) throw new Error(`integration plugin ${pluginId} OAuth authorization parameters are invalid`);
      }
    }
  }
}

function trustedOAuthUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) throw new Error('OAuth endpoint must be credential-free HTTPS without query or fragment');
  return url;
}
