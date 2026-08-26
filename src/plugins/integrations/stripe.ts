import type { JsonValue } from '../../domain/contracts.js';
import {
  optionalInputString,
  requiredCredential,
  requiredInputString,
  TrustedHttpIntegrationPlugin,
} from '../http.js';

export function createStripeIntegrationPlugin(options: { fetch?: typeof fetch } = {}): TrustedHttpIntegrationPlugin {
  return new TrustedHttpIntegrationPlugin({
    baseUrl: 'https://api.stripe.com/v1/',
    ...(options.fetch ? { fetch: options.fetch } : {}),
    manifest: {
      id: 'stripe',
      version: '1',
      title: 'Stripe',
      description: 'Search customers, list invoices, and create refunds when the capability envelope permits it.',
      authentication: [{
        scheme: 'api-key',
        title: 'Secret API key',
        fields: [{ key: 'api_key', label: 'Secret key', secret: true }],
      }],
      operations: [
        {
          id: 'stripe.customers.search',
          title: 'Search Stripe customers',
          kind: 'search',
          access: 'read',
          risk: 'routine',
          inputSchema: objectSchema({ query: stringSchema('Stripe customer search query') }, ['query']),
        },
        {
          id: 'stripe.invoices.list',
          title: 'List Stripe invoices',
          kind: 'search',
          access: 'read',
          risk: 'routine',
          inputSchema: objectSchema({ customer: stringSchema('Optional Stripe customer ID') }, []),
        },
        {
          id: 'stripe.refunds.create',
          title: 'Create a Stripe refund',
          kind: 'action',
          access: 'write',
          risk: 'destructive',
          inputSchema: objectSchema({
            paymentIntent: stringSchema('PaymentIntent ID to refund'),
            amount: { type: 'string', description: 'Optional amount in the smallest currency unit' },
          }, ['paymentIntent']),
        },
      ],
    },
    authorization: (credential) => ({
      authorization: `Bearer ${requiredCredential(credential, 'api_key')}`,
    }),
    verification: {
      request: () => ({ method: 'GET', path: 'account' }),
      result: (value, scheme) => {
        const account = requiredRecord(value);
        const id = requiredString(account, 'id');
        const settings = record(account.settings);
        const dashboard = record(settings?.dashboard);
        const label = optionalString(account.business_profile && record(account.business_profile)?.name)
          ?? optionalString(dashboard?.display_name)
          ?? optionalString(account.email)
          ?? id;
        return {
          label,
          authorization: { scheme, access: 'full', scopeModel: 'unknown', scopes: [] },
          externalTenantId: id,
        };
      },
    },
    operations: [
      {
        id: 'stripe.customers.search',
        request: (input) => ({
          method: 'GET',
          path: 'customers/search',
          query: new URLSearchParams({ query: requiredInputString(input, 'query') }),
        }),
      },
      {
        id: 'stripe.invoices.list',
        request: (input) => {
          const customer = optionalInputString(input, 'customer', 256);
          return {
            method: 'GET',
            path: 'invoices',
            ...(customer ? { query: new URLSearchParams({ customer }) } : {}),
          };
        },
      },
      {
        id: 'stripe.refunds.create',
        request: (input) => {
          const form = new URLSearchParams({
            payment_intent: requiredInputString(input, 'paymentIntent', 256),
          });
          const amount = optionalInputString(input, 'amount', 32);
          if (amount) {
            if (!/^[1-9][0-9]{0,11}$/.test(amount)) throw new Error('refund amount is invalid');
            form.set('amount', amount);
          }
          return { method: 'POST', path: 'refunds', form };
        },
      },
    ],
  });
}

function record(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as { [key: string]: JsonValue }
    : undefined;
}

function requiredRecord(value: JsonValue): { [key: string]: JsonValue } {
  const result = record(value);
  if (!result) throw new Error('Stripe verification response is invalid');
  return result;
}

function requiredString(value: { [key: string]: JsonValue }, key: string): string {
  const result = optionalString(value[key]);
  if (!result) throw new Error(`Stripe verification response ${key} is invalid`);
  return result;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value && Buffer.byteLength(value, 'utf8') <= 512
    ? value
    : undefined;
}

function stringSchema(description: string): JsonValue {
  return { type: 'string', description };
}

function objectSchema(
  properties: { [key: string]: JsonValue },
  required: string[],
): { [key: string]: JsonValue } {
  return { type: 'object', properties, required, additionalProperties: false };
}
