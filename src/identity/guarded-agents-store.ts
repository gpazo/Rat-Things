import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentListQuery, AgentObservation, AgentResource, AgentsStore } from '../core/agents-ports.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { excludingWrites, type SpaceAuthority } from './space-access.js';
import { requireUnexpired } from './principal.js';

type Guard = { authority: SpaceAuthority; readOnly: boolean };
/** Only request-scoped configuration effects use this guard. Durable Session acceptance carries explicit observations. */
export class GuardedAgentsStore implements AgentsStore {
  private readonly context = new AsyncLocalStorage<Guard>();
  public constructor(private readonly base: AgentsStore) {}
  public run<T>(authority: SpaceAuthority, readOnly: boolean, work: () => Promise<T>): Promise<T> { return this.context.run({ authority, readOnly }, work); }
  public get<T>(ownerId: string, collection: string, id: string) { return this.base.get<T>(ownerId, collection, id); }
  public list<T>(ownerId: string, collection: string, query: AgentListQuery) { return this.base.list<T>(ownerId, collection, query); }
  public put<T>(resource: AgentResource<T>, expectedRevision: number) { return this.commit([{ resource, expectedRevision }]); }
  public async commit(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>, observations: AgentObservation[] = []) {
    const guarded = await this.guards(writes.map(w => w.resource));
    return this.base.commit(writes, mergeObservations(observations, guarded));
  }
  public async delete(resource: AgentResource<unknown>, writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }> = [], observations: AgentObservation[] = []) {
    const guarded = await this.guards([resource, ...writes.map(w => w.resource)]);
    return this.base.delete(resource, writes, mergeObservations(observations, guarded));
  }
  private async guards(resources: AgentResource<unknown>[]) {
    const context = this.context.getStore();
    if (!context) return [];
    if (context.readOnly) throw new AgentsApiError(403, 'Observation requests cannot mutate resources.', 'insufficient_permissions');
    await context.authority.revalidate();
    requireUnexpired(context.authority);
    const observations = excludingWrites(context.authority.observations, resources);
    for (const observed of context.authority.observations) {
      const written = resources.find(r => r.ownerId === observed.ownerId && r.collection === observed.collection && r.id === observed.id);
      if (written && written.revision !== observed.revision + 1) throw new AgentsApiError(403, 'Space authority changed.', 'insufficient_permissions');
    }
    return observations;
  }
}
function mergeObservations(left: AgentObservation[], right: AgentObservation[]): AgentObservation[] {
  const records = new Map<string, AgentObservation>();
  for (const item of [...left, ...right]) {
    const key = JSON.stringify([item.ownerId, item.collection, item.id]);
    const previous = records.get(key);
    if (previous && previous.revision !== item.revision) throw new AgentsApiError(409, 'Conflicting authority observations.', 'conflict');
    records.set(key, item);
  }
  return [...records.values()];
}
