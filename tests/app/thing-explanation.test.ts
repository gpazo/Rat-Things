import { describe, expect, it } from 'vitest';
import { explainThingEnvironment } from '../../src/app/thing-explanation.js';
import type {
  ConnectionGrant,
  ConnectionSet,
  IntegrationConnection,
} from '../../src/domain/capabilities.js';
import type { ThingExplanation, ThingSpec } from '../../src/domain/things.js';
import {
  CapabilityProfileRegistry,
  createBuiltinCapabilityProfiles,
} from '../../src/plugins/capability-profiles.js';
import { IntegrationPluginRegistry } from '../../src/plugins/integration-registry.js';
import { createBuiltinIntegrationPlugins } from '../../src/plugins/integrations/builtins.js';

describe('Thing environment explanation', () => {
  it('shows the effective profile and operation-level permission intersection for multiple accounts', async () => {
    const result = await explainThingEnvironment('owner-1', explanation({
      version: '1',
      name: 'Operations review',
      goal: 'Review Slack and Stripe.',
      trigger: { kind: 'manual' },
      agent: { capabilities: { profile: 'small-business' } },
      connections: {
        set: 'front-office',
        accounts: [{ account: 'stripe-business', access: 'read-only' }],
      },
    }), environment());

    expect(result.runnable).toBe(true);
    expect(result.effectiveRun).toMatchObject({
      agent: {
        sandbox: 'danger-full-access',
        capabilities: {
          profile: 'small-business',
          networkAccess: true,
          computerUse: 'browser',
        },
      },
    });
    expect(result.resolvedConnections).toHaveLength(2);
    const stripe = result.resolvedConnections?.find((candidate) => candidate.alias === 'stripe-business');
    expect(stripe).toMatchObject({
      selectedBy: ['connection-set', 'account'],
      requestedAccess: 'read-only',
      grant: { preset: 'full' },
    });
    expect(stripe?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stripe.customers.search', allowed: true }),
      expect.objectContaining({
        id: 'stripe.refunds.create',
        allowed: false,
        reason: 'operation requires write access',
      }),
    ]));
    const slack = result.resolvedConnections?.find((candidate) => candidate.alias === 'slack-support');
    expect(slack).toMatchObject({
      selectedBy: ['connection-set'],
      defaultFor: ['slack'],
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'profile', status: 'pass' }),
      expect.objectContaining({ id: 'connection-set', status: 'pass' }),
      expect.objectContaining({ id: 'connection.stripe-business', status: 'pass' }),
    ]));
  });

  it('turns missing deployment-owned dependencies into actionable diagnostics', async () => {
    const result = await explainThingEnvironment('owner-1', explanation({
      version: '1',
      name: 'Broken Thing',
      goal: 'Try a missing account.',
      trigger: { kind: 'manual' },
      agent: { capabilities: { profile: 'not-installed' } },
      connections: { accounts: [{ account: 'missing-account', access: 'read-only' }] },
    }), environment());

    expect(result.runnable).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'profile', status: 'error' }),
      expect.objectContaining({ id: 'connection.missing-account', status: 'error' }),
    ]));
  });
});

function environment() {
  const stripe = connection('stripe-id', 'stripe-business', 'stripe', {
    scheme: 'api-key',
    access: 'full',
    scopeModel: 'coarse',
    scopes: [],
  });
  const slack = connection('slack-id', 'slack-support', 'slack', {
    scheme: 'oauth2',
    access: 'read',
    scopeModel: 'granular',
    scopes: ['search:read'],
  });
  const sets: ConnectionSet[] = [{
    version: '1',
    connectionSetId: 'front-office-id',
    ownerId: 'owner-1',
    name: 'front-office',
    connectionIds: [stripe.connectionId, slack.connectionId],
    defaults: { slack: slack.connectionId },
  }];
  return {
    profiles: new CapabilityProfileRegistry(createBuiltinCapabilityProfiles()),
    plugins: new IntegrationPluginRegistry(createBuiltinIntegrationPlugins()),
    connections: {
      list: async () => [
        { connection: stripe, grant: grant(stripe.connectionId, 'full') },
        { connection: slack, grant: grant(slack.connectionId, 'read-write') },
      ],
      listSets: async () => sets,
    },
  };
}

function explanation(spec: ThingSpec): ThingExplanation {
  return {
    version: '1',
    target: 'draft',
    thing: {
      version: '1',
      thingId: 'thing-1',
      status: 'active',
      draft: {
        version: '1',
        thingId: 'thing-1',
        revision: 1,
        name: spec.name,
        trigger: spec.trigger,
        specHash: 'a'.repeat(64),
        createdAt: '2026-08-21T00:00:00.000Z',
        spec,
      },
      active: {
        version: '1',
        thingId: 'thing-1',
        revision: 1,
        name: spec.name,
        trigger: spec.trigger,
        specHash: 'a'.repeat(64),
        createdAt: '2026-08-21T00:00:00.000Z',
        spec,
      },
      hasUnpublishedChanges: false,
      triggerState: {
        status: 'ready',
        revision: 1,
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    },
    compiledRun: {
      version: '1',
      prompt: spec.goal,
      ...(spec.agent ? { agent: spec.agent } : {}),
      ...(spec.connections ? {
        integrations: {
          ...(spec.connections.set ? { connectionSet: spec.connections.set } : {}),
          ...(spec.connections.accounts ? {
            connections: spec.connections.accounts.map((account) => ({
              connection: account.account,
              ...(account.access ? { preset: account.access } : {}),
            })),
          } : {}),
        },
      } : {}),
    },
    runnable: true,
    diagnostics: [],
  };
}

function connection(
  connectionId: string,
  alias: string,
  pluginId: string,
  authorization: IntegrationConnection['authorization'],
): IntegrationConnection {
  return {
    version: '1',
    connectionId,
    ownerId: 'owner-1',
    pluginId,
    alias,
    label: alias,
    authorization,
    status: 'active',
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

function grant(
  connectionId: string,
  preset: ConnectionGrant['preset'],
): ConnectionGrant {
  return {
    version: '1',
    grantId: `grant-${connectionId}`,
    ownerId: 'owner-1',
    connectionId,
    preset,
  };
}
