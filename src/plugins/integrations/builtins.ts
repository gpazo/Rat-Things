import type { IntegrationPlugin } from '../integration-types.js';
import { createSlackIntegrationPlugin } from './slack.js';
import { createStripeIntegrationPlugin } from './stripe.js';

export function createBuiltinIntegrationPlugins(): IntegrationPlugin[] {
  return [createSlackIntegrationPlugin(), createStripeIntegrationPlugin()];
}
