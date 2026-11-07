import type { AgentListQuery, AgentObservation, AgentResource, AgentsStore } from '../../src/core/agents-ports.js';

export interface StorageCounts { calls: Record<string, number>; collections: Record<string, number>; writeResources: number; conditions: number; failures: number }
const empty = (): StorageCounts => ({ calls: {}, collections: {}, writeResources: 0, conditions: 0, failures: 0 });
/** Counts calls at the SQLite adapter boundary, not SQL statements, bytes or billed units. */
export class CountingStore implements AgentsStore {
  private counts = empty();
  public constructor(private readonly base: AgentsStore) {}
  public snapshot(): StorageCounts { return structuredClone(this.counts); }
  private async count<T>(method: string, collections: string[], writeResources: number, conditions: number, work: () => Promise<T>): Promise<T> {
    this.counts.calls[method] = (this.counts.calls[method] ?? 0) + 1;
    for (const collection of collections) this.counts.collections[`${method}:${collection}`] = (this.counts.collections[`${method}:${collection}`] ?? 0) + 1;
    this.counts.writeResources += writeResources; this.counts.conditions += conditions;
    try { return await work(); } catch (error) { this.counts.failures++; throw error; }
  }
  public get<T>(owner: string, collection: string, id: string) { return this.count('get', [collection], 0, 0, () => this.base.get<T>(owner, collection, id)); }
  public list<T>(owner: string, collection: string, query: AgentListQuery) { return this.count('list', [collection], 0, 0, () => this.base.list<T>(owner, collection, query)); }
  public put<T>(resource: AgentResource<T>, expectedRevision: number) { return this.count('put', [resource.collection], 1, 1, () => this.base.put(resource, expectedRevision)); }
  public commit(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>, observations: AgentObservation[] = []) {
    return this.count('commit', writes.map(write => write.resource.collection), writes.length, writes.length + observations.length, () => this.base.commit(writes, observations));
  }
  public delete(resource: AgentResource<unknown>, writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }> = [], observations: AgentObservation[] = []) {
    return this.count('delete', [resource.collection, ...writes.map(write => write.resource.collection)], writes.length + 1, writes.length + 1 + observations.length, () => this.base.delete(resource, writes, observations));
  }
}
export function subtractCounts(after: StorageCounts, before: StorageCounts): StorageCounts {
  const difference = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(a).map(key => [key, a[key]! - (b[key] ?? 0)]).filter(([, n]) => n !== 0));
  return { calls: difference(after.calls, before.calls), collections: difference(after.collections, before.collections),
    writeResources: after.writeResources - before.writeResources, conditions: after.conditions - before.conditions, failures: after.failures - before.failures };
}
