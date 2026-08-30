import { describe, expect, it, vi } from 'vitest';
import {
  ConnectionConsumerService,
  type ConnectionConsumerServiceOptions,
} from '../../src/app/connection-consumers.js';

describe('connection consumer projection', () => {
  it('finds direct and connection-set consumers without reading credentials', async () => {
    const connections = {
      get: vi.fn().mockResolvedValue({
        connection: {
          connectionId: 'connection-slack',
          alias: 'slack-work',
        },
      }),
      listSets: vi.fn().mockResolvedValue([{
        connectionSetId: 'set-work',
        name: 'work-apps',
        connectionIds: ['connection-slack'],
      }]),
      listSourceBindings: vi.fn().mockResolvedValue([{
        bindingId: 'binding-slack',
        sourceKind: 'slack',
        connectionSetId: 'set-work',
      }]),
    } as unknown as ConnectionConsumerServiceOptions['connections'];
    const things = {
      list: vi.fn().mockResolvedValue({
        items: [{ thingId: 'thing-support' }, { thingId: 'thing-direct' }],
      }),
      getPublic: vi.fn()
        .mockResolvedValueOnce({
          thingId: 'thing-support',
          status: 'active',
          draft: {
            revision: 2,
            name: 'Support triage draft',
            spec: { connections: { set: 'work-apps' } },
          },
          active: {
            revision: 1,
            name: 'Support triage',
            spec: { connections: { set: 'set-work' } },
          },
        })
        .mockResolvedValueOnce({
          thingId: 'thing-direct',
          status: 'draft',
          draft: {
            revision: 1,
            name: 'Direct Slack review',
            spec: { connections: { accounts: [{ account: 'slack-work' }] } },
          },
        }),
    } as unknown as ConnectionConsumerServiceOptions['things'];
    const routines = {
      list: vi.fn().mockResolvedValue({
        items: [{ routineId: 'routine-daily', name: 'Daily Slack digest', status: 'enabled' }],
      }),
      getRequest: vi.fn().mockResolvedValue({
        integrations: { connections: [{ connection: 'connection-slack' }] },
      }),
    } as unknown as ConnectionConsumerServiceOptions['routines'];

    const result = await new ConnectionConsumerService({ connections, things, routines })
      .list('api:owner-1', 'slack-work');

    expect(result).toMatchObject({ version: '1', connectionId: 'connection-slack', complete: true });
    expect(result.consumers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'connection-set', id: 'set-work', name: 'work-apps' }),
      expect.objectContaining({ kind: 'source-binding', id: 'binding-slack', via: 'set-work' }),
      expect.objectContaining({ kind: 'thing', id: 'thing-support', stage: 'active' }),
      expect.objectContaining({ kind: 'thing', id: 'thing-support', stage: 'draft' }),
      expect.objectContaining({ kind: 'thing', id: 'thing-direct', stage: 'draft' }),
      expect.objectContaining({ kind: 'routine', id: 'routine-daily', status: 'enabled' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('credential');
  });
});
