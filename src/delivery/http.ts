import { AGENT_RESULT_MARKER } from '../channels/result-marker.js';
import type { RunRecord } from '../domain/contracts.js';
import { KnownNotDeliveredError } from './errors.js';

export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
}

export async function checkedJson(response: Response, provider: string): Promise<Record<string, unknown>> {
  await checkedResponse(response, provider);
  const value = await response.json() as unknown;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function checkedResponse(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  const retryable = response.status === 429 || response.status >= 500;
  throw new KnownNotDeliveredError(`${provider} returned HTTP ${response.status}`, retryable);
}

export function formatMessage(
  body: string,
  run: RunRecord,
  maximum: number,
  markSourceResult = false,
): string {
  const prefix = markSourceResult ? `${AGENT_RESULT_MARKER}\n` : '';
  const suffix = `\n\n---\nAgent run: ${run.runId}`;
  return `${prefix}${body.slice(0, Math.max(0, maximum - prefix.length - suffix.length))}${suffix}`;
}

export function validatedBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('provider API base URL must be credential-free HTTPS');
  }
  return url.toString().replace(/\/$/, '');
}
