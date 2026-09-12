import type { IntegrationCredentialValue } from '../credentials/types.js';
import type { JsonValue } from '../domain/contracts.js';
import { IntegrationProviderUnavailableError } from './integration-types.js';

export interface TrustedHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: URLSearchParams;
  headers?: Record<string, string>;
  json?: JsonValue;
  form?: URLSearchParams;
}

export interface TrustedHttpRequestPlan {
  url: URL;
  body?: string;
}

/** Distinguishes parsed JSON requiring provider validation from completed empty/text responses. */
export type TrustedHttpResponsePlan =
  | { kind: 'json'; value: JsonValue }
  | { kind: 'empty'; value: { ok: true } }
  | { kind: 'text'; value: { text: string } };

export function trustedHttpRequestPlan(baseUrl: URL, request: TrustedHttpRequest): TrustedHttpRequestPlan {
  const url = new URL(request.path, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new Error('integration request escaped its trusted API base URL');
  }
  for (const [key, value] of request.query ?? []) url.searchParams.append(key, value);
  if (request.json !== undefined && request.form !== undefined) {
    throw new Error('integration request cannot contain JSON and form bodies');
  }
  const encoded = request.json !== undefined
    ? boundedJson(request.json, 'integration request')
    : request.form?.toString();
  return { url, ...(encoded !== undefined ? { body: encoded } : {}) };
}

export function trustedHttpHeaders(
  request: TrustedHttpRequest,
  authorization: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    accept: 'application/json',
    ...authorization,
    ...(request.json !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(request.form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    ...request.headers,
  };
}

export function trustedHttpResponsePlan(
  response: { ok: boolean; status: number },
  text: string,
  pluginTitle: string,
): TrustedHttpResponsePlan {
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new IntegrationProviderUnavailableError(pluginTitle);
    }
    throw new Error(`${pluginTitle} returned HTTP ${response.status}`);
  }
  if (!text) return { kind: 'empty', value: { ok: true } };
  try {
    const result = JSON.parse(text) as JsonValue;
    boundedJson(result, 'integration response');
    return { kind: 'json', value: result };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'text', value: { text } };
    throw error;
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

export function trustedBaseUrl(value: string): URL {
  const result = new URL(value);
  const localHttp = result.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(result.hostname);
  if (
    (result.protocol !== 'https:' && !localHttp) ||
    result.username ||
    result.password ||
    result.search ||
    result.hash ||
    !result.hostname
  ) throw new Error('integration API base URL must be credential-free HTTPS or loopback HTTP');
  if (!result.pathname.endsWith('/')) result.pathname += '/';
  return result;
}

function boundedJson(value: JsonValue, label: string): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error(`${label} is too large`);
  return encoded;
}
