import { describe, expect, it } from 'vitest';
import type { IntegrationStore } from '../../src/plugins/integration-types.js';
import type { SourceCapabilityBinding } from '../../src/domain/capabilities.js';
import { StoredSourceSessionResolver } from '../../src/plugins/source-policies.js';
const source = { kind: 'slack' as const, teamId: 'T1', channelId: 'billing', eventId: 'E1', userId: 'U1' };
const binding: SourceCapabilityBinding = { version: '1', bindingId: 'default', ownerId: 'operator', sourceKind: 'slack', selector: { teamId: 'T1' }, agentId: 'agent_1', environment: { type: 'none' } };
const resolver = (bindings: SourceCapabilityBinding[]) => new StoredSourceSessionResolver({ matchingSourceBindings: async () => bindings } as unknown as IntegrationStore);
describe('source Agent selection', () => {
  it('selects the most specific operator-owned Agent and delivery grant', async () => {
    const selected = { ...binding, bindingId: 'billing', selector: { teamId: 'T1', channelId: 'billing' }, agentId: 'agent_2', connectionSetId: 'slack-notifications' };
    expect(await resolver([binding, selected]).resolve(source)).toEqual(selected);
  });
  it('rejects ambiguous selections and never routes API identities through provider bindings', async () => {
    await expect(resolver([binding, { ...binding, bindingId: 'second' }]).resolve(source)).rejects.toThrow('equally specific');
    expect(await resolver([binding]).resolve({ kind: 'api' })).toBeUndefined();
    expect(await resolver([binding]).resolve({ ...source, teamId: 'other' })).toBeUndefined();
  });
});
