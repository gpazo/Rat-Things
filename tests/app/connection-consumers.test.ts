import { describe, expect, it, vi } from 'vitest';
import { ConnectionConsumerService, type ConnectionConsumerServiceOptions } from '../../src/app/connection-consumers.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';

describe('connection delivery consumers', () => {
  it('finds bindings, schedules and Sessions within the connection owner scope', async () => {
    const connections = { get: vi.fn().mockResolvedValue({ connection: { connectionId: 'slack' } }), listSets: async () => [{ connectionSetId: 'work', name: 'Work', connectionIds: ['slack'] }], listSourceBindings: async () => [{ bindingId: 'binding', sourceKind: 'slack', connectionSetId: 'work' }] } as unknown as ConnectionConsumerServiceOptions['connections'];
    const store = new MemoryAgentsStore();
    for (const ownerId of ['owner', 'other']) {
      await store.put({ ownerId, collection: 'schedules', id: `schedule-${ownerId}`, revision: 1, createdAt: 1, value: { schedule: { name: 'Daily', connectionSetId: 'work', status: 'active' } } }, 0);
      await store.put({ ownerId, collection: 'session_integrations', id: `session-${ownerId}`, revision: 1, createdAt: 1, value: { target: { connectionSetId: 'work' } } }, 0);
    }
    const result = await new ConnectionConsumerService({ connections, store }).list('owner', 'slack');
    expect(result.complete).toBe(true);
    expect(result.consumers.map(({ id }) => id).sort()).toEqual(['binding', 'schedule-owner', 'session-owner', 'work']);
    expect(JSON.stringify(result)).not.toContain('credential');
  });
});
