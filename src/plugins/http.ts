import type { IntegrationCredentialValue } from '../credentials/types.js';
import type { IntegrationConnection } from '../domain/capabilities.js';
import type { JsonValue } from '../domain/contracts.js';
import type {
  IntegrationPlugin,
  IntegrationPluginManifest,
} from './integration-types.js';

export interface TrustedHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: URLSearchParams;
  headers?: Record<string, string>;
  json?: JsonValue;
  form?: URLSearchParams;
}

export interface TrustedHttpOperation {
  id: string;
  request(
    input: { [key: string]: JsonValue },
    connection: IntegrationConnection,
  ): TrustedHttpRequest;
}

export interface TrustedHttpPluginOptions {
  manifest: IntegrationPluginManifest;
  baseUrl: string;
  operations: TrustedHttpOperation[];
  authorization(
    credential: IntegrationCredentialValue,
    operationId: string,
  ): Record<string, string>;
  validateResponse?(value: JsonValue): void;
  fetch?: typeof fetch;
}

export class TrustedHttpIntegrationPlugin implements IntegrationPlugin {
  public readonly manifest: IntegrationPluginManifest;
  private readonly baseUrl: URL;
  private readonly operations: Map<string, TrustedHttpOperation>;
  private readonly fetcher: typeof fetch;

  public constructor(private readonly options: TrustedHttpPluginOptions) {
    this.manifest = options.manifest;
    this.baseUrl = trustedBaseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? fetch;
    this.operations = new Map(options.operations.map((operation) => [operation.id, operation]));
    if (this.operations.size !== options.operations.length) throw new Error('duplicate HTTP operation binding');
    for (const operation of options.manifest.operations) {
      if (!this.operations.has(operation.id)) throw new Error(`HTTP operation ${operation.id} has no binding`);
    }
    for (const id of this.operations.keys()) {
      if (!options.manifest.operations.some((operation) => operation.id === id)) {
        throw new Error(`HTTP binding ${id} has no manifest operation`);
      }
    }
  }

  public async execute(
    operationId: string,
    input: { [key: string]: JsonValue },
    context: {
      connection: IntegrationConnection;
      credential: IntegrationCredentialValue;
      signal?: AbortSignal;
    },
  ): Promise<JsonValue> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`HTTP integration operation ${operationId} is not implemented`);
    const request = operation.request(input, context.connection);
    const url = new URL(request.path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(this.baseUrl.pathname)) {
      throw new Error('integration request escaped its trusted API base URL');
    }
    for (const [key, value] of request.query ?? []) url.searchParams.append(key, value);
    if (request.json !== undefined && request.form !== undefined) {
      throw new Error('integration request cannot contain JSON and form bodies');
    }
    const encoded = request.json !== undefined
      ? boundedJson(request.json, 'integration request')
      : request.form?.toString();
    const headers = {
      accept: 'application/json',
      ...this.options.authorization(context.credential, operationId),
      ...(request.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(request.form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...request.headers,
    };
    const timeout = AbortSignal.timeout(20_000);
    const signal = context.signal
      ? AbortSignal.any([context.signal, timeout])
      : timeout;
    const response = await this.fetcher(url, {
      method: request.method,
      headers,
      ...(encoded !== undefined ? { body: encoded } : {}),
      redirect: 'error',
      signal,
    });
    const text = await boundedResponse(response, 256 * 1024);
    if (!response.ok) throw new Error(`${this.manifest.title} returned HTTP ${response.status}`);
    if (!text) return { ok: true };
    try {
      const result = JSON.parse(text) as JsonValue;
      boundedJson(result, 'integration response');
      this.options.validateResponse?.(result);
      return result;
    } catch (error) {
      if (error instanceof SyntaxError) return { text };
      throw error;
    }
  }
}

export function requiredCredential(
  credential: IntegrationCredentialValue,
  ...fields: string[]
): string {
  for (const field of fields) {
    const value = credential[field];
    if (value) return value;
  }
  throw new Error(`integration credential requires ${fields.join(' or ')}`);
}

export function requiredInputString(
  input: { [key: string]: JsonValue },
  key: string,
  maximumBytes = 4_096,
): string {
  const value = input[key];
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximumBytes) {
    throw new Error(`integration input ${key} must be a bounded non-empty string`);
  }
  return value;
}

export function optionalInputString(
  input: { [key: string]: JsonValue },
  key: string,
  maximumBytes = 4_096,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximumBytes) {
    throw new Error(`integration input ${key} must be a bounded string`);
  }
  return value;
}

function trustedBaseUrl(value: string): URL {
  const result = new URL(value);
  if (
    result.protocol !== 'https:' ||
    result.username ||
    result.password ||
    result.search ||
    result.hash ||
    !result.hostname
  ) throw new Error('integration API base URL must be credential-free HTTPS');
  if (!result.pathname.endsWith('/')) result.pathname += '/';
  return result;
}

function boundedJson(value: JsonValue, label: string): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error(`${label} is too large`);
  return encoded;
}

async function boundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error('integration response is too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
