import type { CursorPageResponse } from 'openai/core/pagination';
import type { AgentListParams } from '../domain/agents-api.js';

/** Internal storage metadata. Only `value` is a public API resource. */
export interface AgentResource<T> {
  id: string;
  ownerId: string;
  collection: string;
  createdAt: number;
  revision: number;
  expiresAt?: number;
  value: T;
}

export interface AgentsStore {
  get<T>(ownerId: string, collection: string, id: string): Promise<AgentResource<T> | undefined>;
  list<T>(ownerId: string, collection: string, query: AgentListParams): Promise<CursorPageResponse<AgentResource<T>>>;
  /** expectedRevision=0 creates; subsequent writes compare and swap. */
  put<T>(resource: AgentResource<T>, expectedRevision: number): Promise<void>;
  commit(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>): Promise<void>;
  /** Delete and companion compare-and-swap writes succeed atomically. */
  delete(resource: AgentResource<unknown>, writes?: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>): Promise<void>;
}

export interface AgentsClock {
  now(): number;
}

export interface AgentsIds {
  next(prefix: string): string;
}
