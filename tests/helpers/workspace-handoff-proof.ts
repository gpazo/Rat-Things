import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { AgentsStore } from '../../src/core/agents-ports.js';
import { WorkspaceHandoffService } from '../../src/core/workspace-handoff-service.js';
import type { StoredEnvironment } from '../../src/core/environment-service.js';
import { publicTemplate } from '../../src/domain/environment-planning.js';
import { workspaceDigests, type WorkspaceCheckpoint } from '../../src/domain/workspace-checkpoint.js';

/** Shared assertions run with the in-memory store and real encrypted AWS storage. No native-runtime claim. */
export async function exerciseWorkspaceHandoff(store: AgentsStore) {
  const ownerId = `checkpoint-proof-${randomUUID()}`;
  const id = `env_${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const configuration = { network: { access: 'disabled' as const } };
  const environment = { ...publicTemplate(configuration, { id, created_at: now, updated_at: now }), type: 'openai_hosted' as const, files: [], skills: [] };
  const source = { runId: `source-${randomUUID()}`, generation: randomUUID() };
  const checkpoint: WorkspaceCheckpoint = { id: randomUUID(), source, sandboxId: randomUUID(), ...workspaceDigests({ environment, hostedConfiguration: configuration }),
    rootThreadId: randomUUID(), lastRootTurnId: 'api-turn', lastNativeTurnId: 'native-turn', reason: 'hibernate', createdAt: now };
  const service = new WorkspaceHandoffService({ store, enabled: true });
  const value: StoredEnvironment = { sessionId: randomUUID(), environment, configuration, runId: source.runId, sandboxId: checkpoint.sandboxId, resetCount: 0, status: 'connected' };
  await store.put({ id, ownerId, collection: 'environments', revision: 1, createdAt: now, value }, 0);
  await service.bind(ownerId, id, source);
  await service.begin(ownerId, id, source, checkpoint.id);
  await service.commit(ownerId, id, checkpoint);
  const { lease } = await service.leaseSnapshot(ownerId, id, checkpoint.id);
  await expect(service.adopt(ownerId, id, checkpoint.id, { runId: 'blocked', generation: randomUUID() }, 'attempt', checkpoint)).rejects.toThrow('copied');
  const snapshot = await service.publishSnapshot(ownerId, id, checkpoint.id, lease.id, 123);
  const contenders = Array.from({ length: 4 }, () => ({ successor: { runId: randomUUID(), generation: randomUUID() }, attemptId: randomUUID() }));
  const results = await Promise.allSettled(contenders.map(({ successor, attemptId }) => service.adopt(ownerId, id, checkpoint.id, successor, attemptId, checkpoint)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(3);
  const winner = contenders[results.findIndex(result => result.status === 'fulfilled')]!;
  const adopted = await service.adopt(ownerId, id, checkpoint.id, winner.successor, winner.attemptId, checkpoint);
  expect(adopted.sandboxId).toBe(checkpoint.sandboxId);
  expect(adopted.resetCount).toBe(0);
  await expect(service.commit(ownerId, id, checkpoint)).rejects.toThrow('authority');
  await expect(service.adopt('another-owner', id, checkpoint.id, winner.successor, winner.attemptId, checkpoint)).rejects.toMatchObject({ status: 404 });
  const sourceResource = (await store.get<StoredEnvironment>(ownerId, 'environments', id))!;
  await store.delete(sourceResource);
  expect((await store.get(ownerId, 'fork_snapshots', snapshot.id))?.value).toEqual(snapshot);
  return { ownerId, environmentId: id, checkpointId: checkpoint.id, snapshotId: snapshot.id, successfulClaims: 1, rejectedClaims: 3 };
}
