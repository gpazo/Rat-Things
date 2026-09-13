import { describe, expect, it, vi } from 'vitest';
import { MemoryAgentsStore } from './fixtures.js';
import { ExecutionCommandService } from '../../src/core/execution-command-service.js';
import { claimCommand, commandCollection, commandResponseCollection, validExecutionCommand, type ExecutionCommand } from '../../src/core/execution-command-planning.js';

const target = { runId: 'run', execution: { backend: 'microvm' as const, id: 'vm', generation: 'generation' } };
const request = { method: 'POST' as const, path: '/agent-runtime/v1/runs/run/interrupt', body: { turnId: 'turn' } };
const queued: ExecutionCommand = { target, request, deadline: 28_000, status: 'queued' };

describe('private execution command acceptance', () => {
  it('drains pending pages and accepts backdated arrivals without scanning completed responses', async () => {
    const store = new MemoryAgentsStore();
    const service = new ExecutionCommandService({ store, now: () => 0, id: () => 'command', pause: async () => {} });
    for (let index = 0; index < 103; index++) await store.put({
      ownerId: 'owner', collection: commandCollection('run'), id: `command-${index}`, createdAt: index, revision: 1, value: queued,
    }, 0);
    const perform = vi.fn(async () => ({ status: 200, body: {} }));
    await service.drain('owner', target, perform);
    expect(perform).toHaveBeenCalledTimes(103);
    expect((await store.list('owner', commandCollection('run'), {})).data).toEqual([]);
    await store.put({ ownerId: 'owner', collection: commandCollection('run'), id: 'late', createdAt: -10, revision: 1, value: queued }, 0);
    await service.drain('owner', target, perform);
    expect(perform).toHaveBeenCalledTimes(104);
  });
  it('rejects stale identities, expired commands and caller-controlled origins', () => {
    expect(claimCommand(queued, { ...target, execution: { ...target.execution, generation: 'other' } }, 0).kind).toBe('reject');
    expect(claimCommand(queued, target, 28_000).kind).toBe('reject');
    for (const path of ['https://example.com/', '/agent-runtime/v1/runs/other/interrupt', '/agent-runtime/v1/runs/run/../health']) {
      expect(validExecutionCommand(target, { ...request, path })).toBe(false);
    }
    expect(claimCommand({ ...queued, status: 'claimed' }, target, 0).kind).toBe('ignore');
  });

  it('commits acceptance before the effect and executes only once under concurrent drains', async () => {
    const store = new MemoryAgentsStore();
    const resource = { ownerId: 'owner', collection: commandCollection('run'), id: 'command', createdAt: 0, revision: 1, value: queued };
    await store.put(resource, 0);
    const service = new ExecutionCommandService({ store, now: () => 0, id: () => 'command', pause: async () => {} });
    const perform = vi.fn(async () => {
      expect((await store.get<ExecutionCommand>('owner', resource.collection, resource.id))?.value.status).toBe('claimed');
      return { status: 200, body: { accepted: true } };
    });
    await Promise.all([service.drain('owner', target, perform), service.drain('owner', target, perform)]);
    await service.drain('owner', target, perform);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(await store.get('owner', resource.collection, resource.id)).toBeUndefined();
    expect((await store.get<ExecutionCommand>('owner', commandResponseCollection('run'), resource.id))?.value.status).toBe('completed');
  });

  it('never retries an effect whose response could not be committed', async () => {
    const store = new MemoryAgentsStore();
    const resource = { ownerId: 'owner', collection: commandCollection('run'), id: 'command', createdAt: 0, revision: 1, value: queued };
    await store.put(resource, 0);
    vi.spyOn(store, 'delete').mockRejectedValue(new Error('Storage unavailable'));
    const service = new ExecutionCommandService({ store, now: () => 0, id: () => 'command', pause: async () => {} });
    const perform = vi.fn(async () => ({ status: 200, body: {} }));
    await expect(service.drain('owner', target, perform)).rejects.toThrow('Storage unavailable');
    await service.drain('owner', target, perform);
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('does not execute after storage latency consumes the acceptance deadline', async () => {
    const store = new MemoryAgentsStore();
    await store.put({ ownerId: 'owner', collection: commandCollection('run'), id: 'command', createdAt: 0, revision: 1, value: queued }, 0);
    let now = 0;
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (next, expected) => { await put(next, expected); now = 28_000; });
    const service = new ExecutionCommandService({ store, now: () => now, id: () => 'command', pause: async () => {} });
    const perform = vi.fn();
    await service.drain('owner', target, perform);
    expect(perform).not.toHaveBeenCalled();
  });
});
