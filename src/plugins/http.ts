import type { IntegrationCredentialValue } from '../credentials/types.js';
import type {
  IntegrationAuthScheme,
  IntegrationConnection,
} from '../domain/capabilities.js';
import type { JsonValue } from '../domain/contracts.js';
import type {
  IntegrationPlugin,
  IntegrationPluginManifest,
  VerifiedIntegrationCredential,
} from './integration-types.js';
import { IntegrationProviderUnavailableError } from './integration-types.js';
import {
  trustedBaseUrl,
  trustedHttpHeaders,
  trustedHttpRequestPlan,
  trustedHttpResponsePlan,
  type TrustedHttpRequest,
} from './http-planning.js';

export { optionalInputString, requiredCredential, requiredInputString } from './http-planning.js';
export type { TrustedHttpRequest } from './http-planning.js';

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
  verification: {
    request(
      credential: IntegrationCredentialValue,
      scheme: IntegrationAuthScheme,
    ): TrustedHttpRequest;
    result(
      value: JsonValue,
      scheme: IntegrationAuthScheme,
      credential: IntegrationCredentialValue,
    ): VerifiedIntegrationCredential;
  };
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

  public async verifyCredential(
    scheme: IntegrationAuthScheme,
    credential: IntegrationCredentialValue,
    signal?: AbortSignal,
  ): Promise<VerifiedIntegrationCredential> {
    if (!this.manifest.authentication.some((definition) => definition.scheme === scheme)) {
      throw new Error(`plugin ${this.manifest.id} does not support ${scheme}`);
    }
    const value = await this.send(
      this.options.verification.request(credential, scheme),
      credential,
      '$verify',
      signal,
    );
    return this.options.verification.result(value, scheme, credential);
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
    if (!operation) throw new Error(`HTTP integration operation ${operationId} is not registered`);
    return this.send(
      operation.request(input, context.connection),
      context.credential,
      operationId,
      context.signal,
    );
  }

  private async send(
    request: TrustedHttpRequest,
    credential: IntegrationCredentialValue,
    operationId: string,
    callerSignal?: AbortSignal,
  ): Promise<JsonValue> {
    const plan = trustedHttpRequestPlan(this.baseUrl, request);
    const authorization = this.options.authorization(credential, operationId);
    const headers = trustedHttpHeaders(request, authorization);
    const timeout = AbortSignal.timeout(20_000);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(plan.url, {
        method: request.method,
        headers,
        ...(plan.body !== undefined ? { body: plan.body } : {}),
        redirect: 'error',
        signal,
      });
      text = await boundedResponse(response, 256 * 1024);
    } catch (error) {
      if (error instanceof IntegrationProviderUnavailableError) throw error;
      throw new IntegrationProviderUnavailableError(this.manifest.title);
    }
    const parsed = trustedHttpResponsePlan(response, text, this.manifest.title);
    if (parsed.kind !== 'json') return parsed.value;
    try {
      this.options.validateResponse?.(parsed.value);
      return parsed.value;
    } catch (error) {
      if (error instanceof SyntaxError) return { text };
      throw error;
    }
  }
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
