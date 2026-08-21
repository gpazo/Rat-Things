import type { JsonValue } from '../../domain/contracts.js';
import {
  optionalInputString,
  requiredCredential,
  requiredInputString,
  TrustedHttpIntegrationPlugin,
} from '../http.js';

export function createStripeIntegrationPlugin(): TrustedHttpIntegrationPlugin {
  return new TrustedHttpIntegrationPlugin({
    baseUrl: 'https://api.stripe.com/v1/',
    manifest: {
      id: 'stripe',
      version: '1',
      title: 'Stripe',
      description: 'Search customers, list invoices, and create explicitly approved refunds.',
      authSchemes: ['api-key'],
      operations: [
        {
          id: 'stripe.customers.search',
          title: 'Search Stripe customers',
          kind: 'search',
          access: 'read',
          risk: 'routine',
          defaultApproval: 'never',
          inputSchema: objectSchema({ query: stringSchema('Stripe customer search query') }, ['query']),
        },
        {
          id: 'stripe.invoices.list',
          title: 'List Stripe invoices',
          kind: 'search',
          access: 'read',
          risk: 'routine',
          defaultApproval: 'never',
          inputSchema: objectSchema({ customer: stringSchema('Optional Stripe customer ID') }, []),
        },
        {
          id: 'stripe.refunds.create',
          title: 'Create a Stripe refund',
          kind: 'action',
          access: 'write',
          risk: 'destructive',
          defaultApproval: 'always',
          inputSchema: objectSchema({
            paymentIntent: stringSchema('PaymentIntent ID to refund'),
            amount: { type: 'string', description: 'Optional amount in the smallest currency unit' },
          }, ['paymentIntent']),
        },
      ],
    },
    authorization: (credential) => ({
      authorization: `Bearer ${requiredCredential(credential, 'api_key', 'secret_key', 'value')}`,
    }),
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

function stringSchema(description: string): JsonValue {
  return { type: 'string', description };
}

function objectSchema(
  properties: { [key: string]: JsonValue },
  required: string[],
): { [key: string]: JsonValue } {
  return { type: 'object', properties, required, additionalProperties: false };
}
