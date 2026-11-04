import { describe, expect, it, vi } from 'vitest';
import { ToolAuthorizationService } from '../../src/core/tool-authorization-service.js';
import { planToolAuthorization } from '../../src/core/tool-authorization-planning.js';
import type { ToolAuthorizationDecision } from '../../src/domain/tool-authorization.js';
import { MemoryAgentsStore } from './fixtures.js';

const decision = (id: string): ToolAuthorizationDecision => ({ id, object: 'rat_things.tool_authorization', requestId: 'host-request', attempt: 1, at: 10,
  identity: { sessionId: 'session', agentId: 'agent', runId: 'run', generation: 'generation', runtimeEpoch: 0 }, configuration: null,
  context: { kind: 'unresolved', reason: 'unavailable' }, policy: { serverLabel: 'crm', allowedTools: ['lookup'], destinationDigest: 'digest' },
  policyDigest: 'digest', toolName: 'lookup', credential: { kind: 'none' }, decision: 'allow' });

describe('immutable tool authorization receipts', () => {
  it('lists bounded owner-scoped pages and preserves unknown observations', async () => {
    const store = new MemoryAgentsStore(); const service = new ToolAuthorizationService(store);
    await service.record('alice', [decision('a'), decision('b'), decision('c')]);
    const first = await service.list('alice', 'session', { limit: 2, order: 'asc' });
    expect(first).toMatchObject({ first_id: 'a', last_id: 'b', has_more: true });
    const last = await service.list('alice', 'session', { limit: 2, order: 'asc', after: first.last_id });
    expect(last).toMatchObject({ first_id: 'c', last_id: 'c', has_more: false });
    expect(first.data[0]?.outcome).toEqual({ kind: 'unknown', reason: 'no_observation' });
    expect((await service.list('bob', 'session')).data).toEqual([]);
    await expect(service.retrieve('bob', 'session', 'a')).rejects.toMatchObject({ status: 404 });
    await expect(service.recordOutcome('bob', 'session', ['a'], { kind: 'not_dispatched', at: 10 })).rejects.toMatchObject({ status: 404 });
    expect([...store.resources.values()].every(row => row.expiresAt === undefined)).toBe(true);
  });

  it('retains immutable decisions and independent immutable outcomes', async () => {
    const store = new MemoryAgentsStore(); const service = new ToolAuthorizationService(store);
    await service.record('alice', [decision('a')]);
    await service.record('alice', [decision('a')]); // Exact acknowledgement reconciliation.
    await expect(service.record('alice', [{ ...decision('a'), decision: 'deny', reason: 'execution_inactive' }])).rejects.toThrow('persistence');
    const outcome = { kind: 'response_received', at: 11, httpStatus: 200, toolResult: 'unobserved' } as const;
    await service.recordOutcome('alice', 'session', ['a'], outcome);
    await service.recordOutcome('alice', 'session', ['a'], outcome);
    await expect(service.recordOutcome('alice', 'session', ['a'], { kind: 'not_dispatched', at: 12 })).rejects.toThrow('persistence');
    expect(await service.retrieve('alice', 'session', 'a')).toMatchObject({ decision: 'allow', outcome });
  });

  it('recovers lost acknowledgements only by matching the whole retained transaction', async () => {
    const store = new MemoryAgentsStore(); const commit = store.commit.bind(store);
    vi.spyOn(store, 'commit').mockImplementation(async writes => { await commit(writes); throw new Error('lost acknowledgement'); });
    const service = new ToolAuthorizationService(store);
    await service.record('alice', [decision('a'), decision('b')]);
    expect(store.commit).toHaveBeenCalledTimes(1);
    expect((await service.list('alice', 'session')).data).toHaveLength(2);
  });

  it('does not leave partial batch decisions when one immutable ID conflicts', async () => {
    const store = new MemoryAgentsStore(); const service = new ToolAuthorizationService(store);
    await service.record('alice', [decision('b')]);
    await expect(service.record('alice', [decision('a'), { ...decision('b'), attempt: 2 }])).rejects.toThrow('persistence');
    expect((await service.list('alice', 'session')).data.map(row => row.id)).toEqual(['b']);
    await expect(service.record('alice', Array.from({ length: 33 }, (_, index) => decision(String(index))))).rejects.toThrow('batch');
    await expect(service.list('alice', 'session', { limit: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it('plans pure whole-envelope denial while retaining per-member reasons', () => {
    const policy = Object.freeze({ serverLabel: 'crm', destinationDigest: 'digest', allowedTools: ['lookup'] });
    const operations = Object.freeze([{ toolName: 'lookup', valid: true }, { toolName: 'erase', valid: true }, { toolName: 'lookup', valid: false }]);
    expect(planToolAuthorization(policy, operations)).toEqual([{ decision: 'deny', reason: 'batch_denied' }, { decision: 'deny', reason: 'tool_not_admitted' }, { decision: 'deny', reason: 'invalid_call' }]);
    expect(operations[0]).toEqual({ toolName: 'lookup', valid: true });
  });
});
