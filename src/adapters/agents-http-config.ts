import { AgentsApiError } from '../domain/agents-api-validation.js';

export interface HttpListenAddress { readonly host: string; readonly port: number }

export function parseHttpListenAddress(value: string | undefined, fallback = '127.0.0.1:8080'): HttpListenAddress {
  const address = value ?? fallback;
  const separator = address.lastIndexOf(':');
  if (separator < 1) throw new Error('HTTP listen address must be host:port.');
  const rawHost = address.slice(0, separator);
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const port = Number(address.slice(separator + 1));
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('HTTP listen address must be host:port.');
  return { host, port };
}

export function agentsWebFunctionBaseURL(host: string | undefined, region: string): string {
  const escapedRegion = region.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const regionalEndpoint = new RegExp(`^${label}\\.${label}\\.lambda-web\\.${escapedRegion}\\.on\\.aws$`);
  if (!host || host !== host.toLowerCase() || !regionalEndpoint.test(host)) {
    throw new AgentsApiError(400, 'Invalid Web Function endpoint host.', 'invalid_request');
  }
  return `https://${host}/v1`;
}
