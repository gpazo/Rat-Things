import type { IntegrationPlugin } from '../integration-types.js';
import { createFixtureCrmIntegrationPlugin } from './fixture-crm.js';
import { createLinearIntegrationPlugin } from './linear.js';
import { createSlackIntegrationPlugin } from './slack.js';
import { createStripeIntegrationPlugin } from './stripe.js';

export function createBuiltinIntegrationPlugins(
  baseUrls: Record<string, string> = integrationPluginBaseUrls(),
): IntegrationPlugin[] {
  return [
    createLinearIntegrationPlugin(),
    createSlackIntegrationPlugin(),
    createStripeIntegrationPlugin(),
    ...(baseUrls['fixture-crm']
      ? [createFixtureCrmIntegrationPlugin(baseUrls['fixture-crm'])]
      : []),
  ];
}

function integrationPluginBaseUrls(): Record<string, string> {
  const encoded = process.env.INTEGRATION_PLUGIN_BASE_URLS;
  if (!encoded) return {};
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error('INTEGRATION_PLUGIN_BASE_URLS must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INTEGRATION_PLUGIN_BASE_URLS must be a JSON object');
  }
  const result: Record<string, string> = {};
  for (const [id, url] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || typeof url !== 'string') {
      throw new Error('INTEGRATION_PLUGIN_BASE_URLS contains an invalid plugin URL');
    }
    result[id] = url;
  }
  return result;
}
