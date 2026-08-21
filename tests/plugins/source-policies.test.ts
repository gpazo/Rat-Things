import { describe, expect, it } from 'vitest';
import type { IntegrationStore } from '../../src/plugins/integration-types.js';
import {
  CapabilityProfileRegistry,
  createBuiltinCapabilityProfiles,
  resolveAgentProfile,
} from '../../src/plugins/capability-profiles.js';
import { StoredSourcePolicyResolver } from '../../src/plugins/source-policies.js';

describe('stored source policies', () => {
  it('delegates an installer-owned connection set without changing provider run ownership', async () => {
    const resolver = new StoredSourcePolicyResolver({
      matchingSourceBindings: async () => [
        {
          version: '1',
          bindingId: 'tenant-default',
          ownerId: 'api:installer',
          sourceKind: 'slack',
          selector: { teamId: 'T1' },
          capabilityProfile: 'read-only',
        },
        {
          version: '1',
          bindingId: 'billing-channel',
          ownerId: 'api:installer',
          sourceKind: 'slack',
          selector: { teamId: 'T1', channelId: 'C-BILLING' },
          capabilityProfile: 'small-business',
          connectionSetId: 'shop-ops',
        },
      ],
    } as unknown as IntegrationStore);

    const applied = await resolver.apply(
      'slack:T1:U9',
      {
        version: '1',
        prompt: 'Check the failed payment.',
        agent: { sandbox: 'read-only' },
      },
      {
        kind: 'slack',
        teamId: 'T1',
        channelId: 'C-BILLING',
        eventId: 'E1',
        userId: 'U9',
      },
    );
    expect(applied).toEqual({
      policyOwnerId: 'api:installer',
      request: {
        version: '1',
        prompt: 'Check the failed payment.',
        agent: { capabilities: { profile: 'small-business' } },
        integrations: { connectionSet: 'shop-ops' },
      },
    });
    expect(resolveAgentProfile(
      applied.request.agent,
      new CapabilityProfileRegistry(createBuiltinCapabilityProfiles()),
    )).toMatchObject({
      agent: {
        sandbox: 'danger-full-access',
        capabilities: {
          profile: 'small-business',
          networkAccess: true,
          computerUse: 'browser',
        },
      },
      maximumIntegrationAccess: 'read-write',
    });
  });

  it('does not let one API principal claim another principal\'s API runs', async () => {
    const resolver = new StoredSourcePolicyResolver({
      matchingSourceBindings: async () => [
        {
          version: '1',
          bindingId: 'other-owner-api-default',
          ownerId: 'api:other-owner',
          sourceKind: 'api',
          selector: { kind: 'api' },
          capabilityProfile: 'microvm-full',
        },
        {
          version: '1',
          bindingId: 'caller-api-default',
          ownerId: 'api:caller',
          sourceKind: 'api',
          selector: { kind: 'api' },
          capabilityProfile: 'small-business',
        },
      ],
    } as unknown as IntegrationStore);

    await expect(resolver.apply(
      'api:caller',
      { version: '1', prompt: 'Handle this API request.' },
      { kind: 'api' },
    )).resolves.toMatchObject({
      policyOwnerId: 'api:caller',
      request: { agent: { capabilities: { profile: 'small-business' } } },
    });
  });
});
