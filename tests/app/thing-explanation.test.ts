import { describe, expect, it, vi } from 'vitest';
import { explainThingEnvironment } from '../../src/app/thing-explanation.js';
import { compileThingSpec } from '../../src/core/thing-service.js';
import type {
  ConnectionAccessRequest,
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
import { IntegrationRuntime } from '../../src/plugins/integration-runtime.js';
import type { IntegrationStore } from '../../src/plugins/integration-types.js';

describe('Thing environment explanation', () => {
  it.each<{
    name: string;
    policy: Partial<ConnectionGrant>;
    narrowing: Omit<ConnectionAccessRequest, 'connection'>;
    maximum: 'read-only' | 'full';
    allowed: string[];
  }>([
    { name: 'full access', policy: {}, narrowing: {}, maximum: 'full', allowed: ['customers.search', 'invoices.list', 'refunds.create'] },
    { name: 'stored read-only grant', policy: { preset: 'read-only' }, narrowing: { preset: 'full' }, maximum: 'full', allowed: ['customers.search', 'invoices.list'] },
    { name: 'requested read-only access', policy: {}, narrowing: { preset: 'read-only' }, maximum: 'full', allowed: ['customers.search', 'invoices.list'] },
    { name: 'profile ceiling', policy: {}, narrowing: { preset: 'full' }, maximum: 'read-only', allowed: ['customers.search', 'invoices.list'] },
    { name: 'stored deny', policy: { denyOperations: ['stripe.refunds.create'] }, narrowing: { preset: 'full' }, maximum: 'full', allowed: ['customers.search', 'invoices.list'] },
    { name: 'requested deny', policy: {}, narrowing: { denyOperations: ['stripe.refunds.create'] }, maximum: 'full', allowed: ['customers.search', 'invoices.list'] },
    { name: 'empty requested allowlist', policy: {}, narrowing: { allowOperations: [] }, maximum: 'full', allowed: [] },
    { name: 'custom requested allowlist', policy: {}, narrowing: { preset: 'custom', allowOperations: ['stripe.refunds.create'] }, maximum: 'full', allowed: ['refunds.create'] },
    { name: 'custom request under read-only ceiling', policy: {}, narrowing: { preset: 'custom', allowOperations: ['stripe.refunds.create'] }, maximum: 'read-only', allowed: [] },
    { name: 'expired stored grant', policy: { expiresAt: '2000-01-01T00:00:00.000Z' }, narrowing: { preset: 'full' }, maximum: 'full', allowed: [] },
  ])('matches executable operations for $name', async ({ policy, narrowing, maximum, allowed }) => {
    const env = environment();
    const bundle = (await env.connections.list())[0]!;
    bundle.grant = { ...bundle.grant, ...policy };
    env.connections.list = async () => [bundle];
    env.profiles = new CapabilityProfileRegistry([{
      id: 'test', sandbox: 'read-only', networkAccess: false, webSearch: 'disabled',
      computerUse: 'disabled', maximumIntegrationAccess: maximum,
    }]);
    const { preset, ...operationLimits } = narrowing;
    const spec: ThingSpec = {
      version: '1', name: 'Permission check', goal: 'Inspect account access',
      trigger: { kind: 'manual' }, agent: { capabilities: { profile: 'test' } },
      connections: { accounts: [{
        account: bundle.connection.alias,
        ...(preset ? { access: preset } : {}),
        ...operationLimits,
      }] },
    };
    const result = await explainThingEnvironment('owner-1', explanation(spec), env);
    expect(result.resolvedConnections?.[0]?.operations.filter((operation) => operation.allowed)
      .map((operation) => operation.id)).toEqual(allowed.map((id) => `stripe.${id}`));
    expect(result.runnable).toBe(allowed.length > 0);

    const readRecord = vi.fn();
    const getCredentialBinding = vi.fn();
    const runtime = new IntegrationRuntime({
      registry: env.plugins,
      store: {
        getConnection: async () => bundle.connection,
        getGrant: async () => bundle.grant,
        getCredentialBinding,
      } as unknown as IntegrationStore,
      credentials: { readRecord },
    });
    const session = await runtime.prepare({
      ownerId: 'owner-1', request: compileThingSpec(spec).integrations!,
      maximumIntegrationAccess: maximum,
    });
    expect(session.tools.flatMap((namespace) => namespace.tools.map((tool) => tool.name)))
      .toEqual(allowed.map((id) => id.replaceAll('.', '_')));
    for (const id of ['customers.search', 'invoices.list', 'refunds.create'].filter((id) => !allowed.includes(id))) {
      await expect(session.call({ namespace: 'stripe', tool: id.replaceAll('.', '_'), arguments: {} }))
        .rejects.toThrow('not available');
    }
    expect(getCredentialBinding).not.toHaveBeenCalled();
    expect(readRecord).not.toHaveBeenCalled();
  });

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
