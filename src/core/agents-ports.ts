import type { CursorPageResponse } from 'openai/core/pagination';
import type { AgentListParams } from '../domain/agents-api.js';

export type AgentListOrdering = 'createdAt' | 'id';
/** Select the collection's stored list mode; this is not an arbitrary alternate sort. */
export type AgentListQuery = AgentListParams & { orderBy?: AgentListOrdering };

/** Internal storage metadata. Only `value` is a public API resource. */
export interface AgentResource<T> {
  id: string;
  ownerId: string;
  collection: string;
  createdAt: number;
  /** Fixed at creation; omitted metadata retains creation-time ordering. */
  listOrder?: AgentListOrdering;
  revision: number;
  expiresAt?: number;
  value: T;
}

export interface AgentObservation { ownerId: string; collection: string; id: string; revision: number }

export interface AgentsStore {
  get<T>(ownerId: string, collection: string, id: string): Promise<AgentResource<T> | undefined>;
  list<T>(ownerId: string, collection: string, query: AgentListQuery): Promise<CursorPageResponse<AgentResource<T>>>;
  /** expectedRevision=0 creates; subsequent writes compare and swap. */
  put<T>(resource: AgentResource<T>, expectedRevision: number): Promise<void>;
  commit(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>, observations?: AgentObservation[]): Promise<void>;
  commitAtObservation?(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>, observation: { ownerId: string; id: string; revision: number }): Promise<void>;
  /** Delete and companion compare-and-swap writes succeed atomically. */
  delete(resource: AgentResource<unknown>, writes?: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>): Promise<void>;
}

export interface AgentsClock {
  now(): number;
}

export interface AgentsIds {
  next(prefix: string): string;
}
