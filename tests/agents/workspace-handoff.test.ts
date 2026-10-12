import { describe, expect, it, vi } from 'vitest';
import { WorkspaceHandoffService } from '../../src/core/workspace-handoff-service.js';
import { EnvironmentService, type StoredEnvironment } from '../../src/core/environment-service.js';
import { planManagedReadiness } from '../../src/core/managed-environment-planning.js';
import { publicTemplate } from '../../src/domain/environment-planning.js';
import { workspaceDigests, type WorkspaceCheckpoint } from '../../src/domain/workspace-checkpoint.js';
import { MemoryAgentsStore } from './fixtures.js';
import { exerciseWorkspaceHandoff } from '../helpers/workspace-handoff-proof.js';

export async function handoffFixture(withHandoffs = false) {
  const store = new MemoryAgentsStore();
  let now = 100;
  const clock = { now: () => now };
  const source = { runId: 'source', generation: 'generation-1' };
  const successor = { runId: 'successor', generation: 'generation-2' };
  const configuration = { network: { access: 'disabled' as const } };
  const environment = { ...publicTemplate(configuration, { id: 'environment', created_at: now, updated_at: now }), type: 'openai_hosted' as const, files: [], skills: [] };
  const digests = workspaceDigests({ hostedConfiguration: configuration, environment });
  const value: StoredEnvironment = { sessionId: 'session', environment, configuration, runId: source.runId, sandboxId: 'sandbox', resetCount: 0, status: 'connected', connectedUntil: 145 };
  await store.put({ ownerId: 'owner', id: environment.id, collection: 'environments', createdAt: now, revision: 1, value }, 0);
  const stopped = vi.fn(async () => true);
  const ended = vi.fn(async () => false);
  const service = new WorkspaceHandoffService({ store, enabled: true, clock, sourceStopped: stopped, runEnded: ended });
  const environments = new EnvironmentService({ store, clock, ...(withHandoffs ? { handoffs: service } : {}), credentials: { create: async () => '', read: async () => ({ harness: '', executor: '' }), revoke: async () => {} } });
  const checkpoint: WorkspaceCheckpoint = { id: 'checkpoint', source, sandboxId: 'sandbox', ...digests, rootThreadId: 'native-root', lastRootTurnId: 'api-turn', lastNativeTurnId: 'native-turn', reason: 'hibernate', createdAt: now };
  const get = async () => (await store.get<StoredEnvironment>('owner', 'environments', environment.id))!.value;
  const begin = async () => { await service.bind('owner', environment.id, source); await service.begin('owner', environment.id, source, checkpoint.id); };
  const commit = async () => { await begin(); await service.commit('owner', environment.id, checkpoint); };
  const adopt = (attempt = 'attempt') => service.adopt('owner', environment.id, checkpoint.id, successor, attempt, checkpoint);
  return { store, service, environments, source, successor, checkpoint, get, begin, commit, adopt, stopped, ended, setTime: (time: number) => { now = time; } };
}

describe('workspace handoff storage foundation', () => {
  it('also requires a stopped writer when a bound worker died before beginning a checkpoint', async () => {
    const f = await handoffFixture(true);
    await f.service.bind('owner', 'environment', f.source);
    f.stopped.mockResolvedValueOnce(false);
    await expect(f.environments.attachManaged('owner', 'environment', f.successor.runId)).rejects.toThrow('confirmed stopped');
    expect((await f.get()).runId).toBe(f.source.runId);
    await f.environments.attachManaged('owner', 'environment', f.successor.runId);
    expect(f.stopped).toHaveBeenLastCalledWith(f.source);
    await f.service.bind('owner', 'environment', f.successor);
  });

  it('does not reuse termination evidence after another execution claims admission', async () => {
    const f = await handoffFixture(true);
    await f.service.bind('owner', 'environment', f.source);
    f.stopped.mockImplementationOnce(async () => {
      const current = (await f.store.get<StoredEnvironment>('owner', 'environments', 'environment'))!;
      await f.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, runId: 'contender', executionGeneration: 'contender-generation' } }, current.revision);
      return true;
    });
    await expect(f.environments.attachManaged('owner', 'environment', f.successor.runId)).rejects.toThrow('admission changed');
    expect((await f.get()).runId).toBe('contender');
  });

  it('reserves one replacement before storage access and adopts only its resolved authority', async () => {
    const f = await handoffFixture(true);
    f.checkpoint.authorityDigest = 'resolved-authority';
    await f.commit();
    await expect(f.service.prepareWorker('owner', 'environment', f.successor, f.checkpoint, 'resolved-authority')).rejects.toThrow('authority');
    await f.environments.attachManaged('owner', 'environment', f.successor.runId);
    await expect(f.environments.attachManaged('owner', 'environment', 'contender')).rejects.toThrow('already owns');
    await expect(f.service.prepareWorker('owner', 'environment', f.successor, f.checkpoint, 'changed-authority')).rejects.toThrow('authority');
    expect((await f.get()).handoff?.phase).toBe('committed');
    expect(await f.service.prepareWorker('owner', 'environment', f.successor, f.checkpoint, 'resolved-authority')).toEqual(f.checkpoint);
    expect((await f.get()).pendingRunId).toBeUndefined();
    expect((await f.get()).runId).toBe(f.successor.runId);
    await expect(f.service.prepareWorker('owner', 'environment', f.successor, f.checkpoint, 'resolved-authority')).rejects.toThrow('bound');
    await f.environments.managedReady('owner', 'environment', f.successor.runId, { id: 'sandbox', replaced: false });
    await f.service.begin('owner', 'environment', f.successor, 'second-checkpoint');
    expect((await f.get()).handoff?.phase).toBe('quiescing');
  });

  it('releases a replacement reservation only after that Run ended without consuming it', async () => {
    const f = await handoffFixture(true);
    await f.commit();
    await f.environments.attachManaged('owner', 'environment', 'never-started');
    await expect(f.environments.attachManaged('owner', 'environment', f.successor.runId)).rejects.toThrow('already owns');
    f.ended.mockResolvedValue(true);
    await f.environments.attachManaged('owner', 'environment', f.successor.runId);
    expect((await f.get()).pendingRunId).toBe(f.successor.runId);
    expect((await f.get()).handoff?.phase).toBe('committed');
    expect(f.stopped).not.toHaveBeenCalled();
  });

  it('recovers a consumed checkpoint through replacement admission only after confirmed termination', async () => {
    const f = await handoffFixture(true);
    await f.commit(); await f.adopt();
    f.stopped.mockResolvedValueOnce(false);
    await expect(f.environments.attachManaged('owner', 'environment', 'third')).rejects.toThrow('confirmed stopped');
    expect((await f.get()).handoff?.phase).toBe('consumed');
    await f.environments.attachManaged('owner', 'environment', 'third');
    expect(f.stopped).toHaveBeenLastCalledWith(f.successor);
    expect((await f.get()).handoff).toBeUndefined();
    expect((await f.get()).runId).toBe('third');
  });

  it('executes the same storage proof used against real DynamoDB and encrypted S3', async () => {
    await exerciseWorkspaceHandoff(new MemoryAgentsStore());
  });

  it('does nothing unless explicitly enabled and scopes every lookup to the owner', async () => {
    const f = await handoffFixture();
    const put = vi.spyOn(f.store, 'put');
    await expect(new WorkspaceHandoffService({ store: f.store }).begin('owner', 'environment', f.source, 'checkpoint')).rejects.toThrow('disabled');
    expect(put).not.toHaveBeenCalled();
    await expect(f.service.bind('other', 'environment', f.source)).rejects.toMatchObject({ status: 404 });
  });

  it('binds a fresh generation after unexpected loss without a handoff', async () => {
    const f = await handoffFixture();
    await f.service.bind('owner', 'environment', f.source);
    await f.environments.attachManaged('owner', 'environment', f.successor.runId);
    await f.service.bind('owner', 'environment', f.successor);
    expect((await f.get()).executionGeneration).toBe(f.successor.generation);
    await expect(f.service.begin('owner', 'environment', f.source, 'late')).rejects.toThrow('authority');
  });

  it('rejects stale generations, late commits and stale status/readiness updates', async () => {
    const f = await handoffFixture();
    await f.begin();
    await expect(f.service.begin('owner', 'environment', { ...f.source, generation: 'old' }, 'other')).rejects.toThrow('authority');
    await expect(f.environments.managedStatus('owner', 'environment', 'source', 'connected')).rejects.toThrow('authority');
    await expect(f.environments.managedReady('owner', 'environment', 'source', { id: 'sandbox', replaced: false })).rejects.toThrow('handoff');
    await expect(f.environments.attachManaged('owner', 'environment', 'replacement')).rejects.toThrow('handoff');
    f.setTime(220);
    await expect(f.service.commit('owner', 'environment', f.checkpoint)).rejects.toMatchObject({ status: 409 });
    expect((await f.get()).handoff?.phase).toBe('quiescing');
  });

  it('recovers a crashed transition only after lease expiry and irreversible termination', async () => {
    const f = await handoffFixture();
    await f.begin();
    await expect(f.service.recover('owner', 'environment', f.source)).rejects.toThrow('abandoned');
    expect(f.stopped).not.toHaveBeenCalled();
    f.setTime(220);
    f.stopped.mockResolvedValueOnce(false);
    await expect(f.service.recover('owner', 'environment', f.source)).rejects.toThrow('confirmed stopped');
    await f.service.recover('owner', 'environment', f.source);
    await f.environments.attachManaged('owner', 'environment', 'replacement');
    expect((await f.get()).handoff).toBeUndefined();
    expect((await f.get()).sandboxId).toBe('sandbox'); // replacement still follows normal reset accounting
    await expect(f.service.commit('owner', 'environment', f.checkpoint)).rejects.toThrow('authority');
  });

  it('never clears a record changed by deletion while recovery checks termination', async () => {
    const f = await handoffFixture();
    await f.begin();
    await f.service.abort('owner', 'environment', f.source, f.checkpoint.id);
    f.stopped.mockImplementationOnce(async () => {
      const current = (await f.store.get<StoredEnvironment>('owner', 'environments', 'environment'))!;
      await f.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, retired: true } }, current.revision);
      return true;
    });
    await expect(f.service.recover('owner', 'environment', f.source)).rejects.toMatchObject({ status: 409 });
    expect((await f.get()).retired).toBe(true);
  });

  it.each(['sandboxId', 'setupDigest', 'policyDigest'] as const)('rejects incompatible %s without consuming the checkpoint', async field => {
    const f = await handoffFixture();
    await f.commit();
    await expect(f.service.adopt('owner', 'environment', 'checkpoint', f.successor, 'attempt', { ...f.checkpoint, [field]: 'different' })).rejects.toThrow('incompatible');
    expect((await f.get()).handoff?.phase).toBe('committed');
  });

  it('allows acknowledgement retries but never reuses a consumed checkpoint after a process restart', async () => {
    const f = await handoffFixture();
    await f.commit();
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (resource, revision) => { await put(resource, revision); throw new Error('Lost acknowledgement'); });
    await expect(f.adopt()).rejects.toThrow('Lost acknowledgement');
    const adopted = await f.adopt();
    expect(planManagedReadiness(adopted, 'successor', { id: 'sandbox', replaced: false }, 101).resetCount).toBe(0);
    await expect(f.adopt('new-process')).rejects.toThrow('already consumed');
    await f.service.recover('owner', 'environment', f.successor);
    expect((await f.get()).handoff).toBeUndefined();
    await expect(f.adopt()).rejects.toThrow('No committed');
  });

  it('retains a committed checkpoint when a response is lost and abort is attempted', async () => {
    const f = await handoffFixture();
    await f.begin();
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (resource, revision) => { await put(resource, revision); throw new Error('Lost acknowledgement'); });
    await expect(f.service.commit('owner', 'environment', f.checkpoint)).rejects.toThrow('Lost acknowledgement');
    await expect(f.service.abort('owner', 'environment', f.source, 'checkpoint')).rejects.toMatchObject({ status: 409 });
    await f.service.commit('owner', 'environment', f.checkpoint);
    expect((await f.get()).handoff?.phase).toBe('committed');
  });

  it('blocks source deletion and adoption during copying; expires old publication authority', async () => {
    const f = await handoffFixture();
    await f.commit();
    const first = await f.service.leaseSnapshot('owner', 'environment', 'checkpoint');
    await expect(f.environments.retire('owner', 'environment')).rejects.toThrow('copied');
    await expect(f.adopt()).rejects.toThrow('copied');
    await expect(f.service.leaseSnapshot('owner', 'environment', 'checkpoint')).rejects.toThrow('copied');
    f.setTime(220);
    const second = await f.service.leaseSnapshot('owner', 'environment', 'checkpoint');
    expect(second.storageKey).not.toBe(first.storageKey);
    await expect(f.service.publishSnapshot('owner', 'environment', 'checkpoint', first.lease.id, 12)).rejects.toThrow('lease');
    await f.service.publishSnapshot('owner', 'environment', 'checkpoint', second.lease.id, 12);
    await f.environments.retire('owner', 'environment');
    expect((await f.store.list('owner', 'fork_snapshots', {})).data).toHaveLength(1);
  });

  it('publishes atomically and retries a lost publication acknowledgement', async () => {
    const f = await handoffFixture();
    await f.commit();
    const { lease } = await f.service.leaseSnapshot('owner', 'environment', 'checkpoint');
    const commit = f.store.commit.bind(f.store);
    vi.spyOn(f.store, 'commit').mockImplementationOnce(async writes => { await commit(writes); throw new Error('Lost acknowledgement'); });
    await expect(f.service.publishSnapshot('owner', 'environment', 'checkpoint', lease.id, 12)).rejects.toThrow('Lost acknowledgement');
    const published = await f.service.publishSnapshot('owner', 'environment', 'checkpoint', lease.id, 12);
    expect(published.rootThreadId).toBe('native-root');
    await expect(f.service.publishSnapshot('owner', 'environment', 'checkpoint', lease.id, 13)).rejects.toMatchObject({ status: 409 });
    await f.adopt();
  });

  it('separates setup from network policy using deterministic digests', async () => {
    const environment = (await handoffFixture()).checkpoint;
    expect(environment.setupDigest).toHaveLength(64);
    const base = { type: 'none' as const };
    const first = workspaceDigests({ environment: base, hostedConfiguration: { network: { access: 'enabled' }, env: { A: '1', B: '2' } } });
    const second = workspaceDigests({ environment: base, hostedConfiguration: { env: { B: '2', A: '1' }, network: { access: 'disabled' } } });
    expect(first.setupDigest).toBe(second.setupDigest);
    expect(first.policyDigest).not.toBe(second.policyDigest);
  });
});
