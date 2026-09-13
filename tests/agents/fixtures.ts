import type { AgentsStore, AgentResource } from '../../src/core/agents-ports.js';
import type { AgentListParams } from '../../src/domain/agents-api.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';

export class MemoryAgentsStore implements AgentsStore {
  public readonly resources = new Map<string, AgentResource<unknown>>();

  public async get<T>(ownerId: string, collection: string, id: string): Promise<AgentResource<T> | undefined> {
    return structuredClone(this.resources.get(this.key(ownerId, collection, id))) as AgentResource<T> | undefined;
  }

  public async list<T>(ownerId: string, collection: string, query: AgentListParams) {
    const direction = query.order === 'asc' ? 1 : -1;
    const resources = [...this.resources.values()]
      .filter((resource) => resource.ownerId === ownerId && resource.collection === collection)
      .sort((a, b) => direction * (a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
    const cursor = query.after ? resources.findIndex((resource) => resource.id === query.after) : -1;
    if (query.after && cursor < 0) throw new AgentsApiError(400, 'Invalid pagination cursor.', 'invalid_request', 'after');
    const page = resources.slice(cursor + 1, cursor + 1 + (query.limit ?? 20));
    return {
      data: structuredClone(page) as Array<AgentResource<T>>,
      has_more: cursor + 1 + page.length < resources.length,
    };
  }

  public put<T>(resource: AgentResource<T>, expectedRevision: number): Promise<void> {
    return this.commit([{ resource, expectedRevision }]);
  }

  public async commit(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>): Promise<void> {
    for (const { resource, expectedRevision } of writes) {
      const current = this.resources.get(this.key(resource.ownerId, resource.collection, resource.id));
      if ((current?.revision ?? 0) !== expectedRevision) throw new AgentsApiError(409, 'Resource changed concurrently.', 'conflict');
    }
    for (const { resource } of writes) {
      this.resources.set(this.key(resource.ownerId, resource.collection, resource.id), structuredClone(resource));
    }
  }

  public async delete(resource: AgentResource<unknown>, writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }> = []): Promise<void> {
    const key = this.key(resource.ownerId, resource.collection, resource.id);
    if (this.resources.get(key)?.revision !== resource.revision) throw new AgentsApiError(409, 'Resource changed concurrently.', 'conflict');
    for (const { resource: next, expectedRevision } of writes) {
      if ((this.resources.get(this.key(next.ownerId, next.collection, next.id))?.revision ?? 0) !== expectedRevision) throw new AgentsApiError(409, 'Resource changed concurrently.', 'conflict');
    }
    for (const { resource: next } of writes) this.resources.set(this.key(next.ownerId, next.collection, next.id), structuredClone(next));
    this.resources.delete(key);
  }

  private key(ownerId: string, collection: string, id: string): string {
    return JSON.stringify([ownerId, collection, id]);
  }
}
