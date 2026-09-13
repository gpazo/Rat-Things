import type { AgentResource, AgentsClock, AgentsStore } from './agents-ports.js';
import type { AgentListParams, AgentSessionEvent } from '../domain/agents-api.js';
import type { SessionState } from './session-ports.js';
import type { StoredSessionRuntime } from './session-runtime-store.js';
import type { StoredEnvironment } from './environment-service.js';
import { savedSessionObservation } from './session-observation-planning.js';
import { planSessionStream, type SessionStreamSnapshot } from './session-stream.js';
import { planSessionWebhooks, type SessionWebhookEvent, type StoredWebhookEndpoint } from '../domain/session-webhooks.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export interface SessionEventBatch { sessionId: string; events: AgentSessionEvent[]; webhooks: SessionWebhookEvent[]; endpointIds: string[] }
export const sessionEventBatchId = (id: string, revision: number): string => `${id}_${String(revision).padStart(16, '0')}`;

/** Commit each public transition with its source write; readers never reconstruct missed transitions by polling. */
export class SessionEventStore implements AgentsStore {
  public constructor(private readonly base: AgentsStore, private readonly clock: AgentsClock = { now: () => Math.floor(Date.now() / 1000) }) {}
  public get<T>(owner: string, collection: string, id: string) { return this.base.get<T>(owner, collection, id); }
  public list<T>(owner: string, collection: string, query: AgentListParams) { return this.base.list<T>(owner, collection, query); }
  public async delete(resource: AgentResource<unknown>, writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }> = []): Promise<void> {
    if (resource.collection !== 'sessions') return this.base.delete(resource, writes);
    for (let attempt = 0; attempt < 10; attempt++) {
      const previous = await this.base.get<SessionStreamSnapshot>(resource.ownerId, 'session_observations', resource.id);
      // Invalidate readers that observed the Session before deletion. The fence
      // remains, while no deletion event or public Session is created.
      const fence = [{ resource: {
        id: resource.id, ownerId: resource.ownerId, collection: 'session_observations', createdAt: previous?.createdAt ?? this.clock.now(),
        revision: (previous?.revision ?? 0) + 1,
        value: previous?.value ?? savedSessionObservation(resource.value as SessionState, undefined, undefined, this.clock.now()),
      }, expectedRevision: previous?.revision ?? 0 }];
      try { await this.base.delete(resource, [...writes, ...fence]); return; }
      catch (error) {
        if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 9) throw error;
        const current = await this.base.get(resource.ownerId, resource.collection, resource.id);
        if (current?.revision !== resource.revision) throw error;
      }
    }
  }
  public put<T>(resource: AgentResource<T>, expectedRevision: number) { return this.commit([{ resource, expectedRevision }]); }

  public async commit(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await this.commitObserved(writes); return; }
      catch (error) {
        if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 9) throw error;
        // Retry observation contention only. Never overwrite a changed source or
        // replay a transaction whose acknowledgement was lost.
        for (const { resource, expectedRevision } of writes) {
          const current = await this.base.get(resource.ownerId, resource.collection, resource.id);
          if ((current?.revision ?? 0) !== expectedRevision) throw error;
        }
      }
    }
  }
  private async commitObserved(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>): Promise<void> {
    const affected = new Map<string, { ownerId: string; id: string }>();
    for (const { resource } of writes) {
      const id = resource.collection === 'sessions' || resource.collection === 'session_runtime' ? resource.id
        : resource.collection === 'environments' ? (resource.value as StoredEnvironment).sessionId : undefined;
      if (id) affected.set(JSON.stringify([resource.ownerId, id]), { ownerId: resource.ownerId, id });
    }
    const additions: typeof writes = [];
    for (const { ownerId, id } of affected.values()) {
      // Read the compare-and-swap fence first. Concurrent changes to any source
      // also change this fence, so a mixed observation cannot be committed.
      const previous = await this.base.get<SessionStreamSnapshot>(ownerId, 'session_observations', id);
      const read = async <T>(collection: string, resourceId: string) => {
        const pending = writes.find(({ resource }) => resource.ownerId === ownerId && resource.collection === collection && resource.id === resourceId);
        return pending ? pending.resource as AgentResource<T> : this.base.get<T>(ownerId, collection, resourceId);
      };
      const state = await read<SessionState>('sessions', id);
      if (!state) continue; // Preparing an environment does not create a Session.
      const runtime = await read<StoredSessionRuntime>('session_runtime', id);
      const environment = state.value.session.environment.type === 'none' ? undefined : await read<StoredEnvironment>('environments', state.value.session.environment.id);
      const now = this.clock.now();
      const snapshot = savedSessionObservation(state.value, runtime?.value, environment?.value, now);
      const revision = (previous?.revision ?? 0) + 1;
      // Even a non-visible source update participates in the shared fence.
      additions.push({ resource: { id, ownerId, collection: 'session_observations', createdAt: previous?.createdAt ?? now, revision, value: snapshot }, expectedRevision: previous?.revision ?? 0 });
      const identity = sessionEventBatchId(id, revision);
      const events = planSessionStream(previous?.value, snapshot, !previous).map((event, index) => ({ ...event, event_id: `evt_${identity}_${index}` }));
      const webhooks = planSessionWebhooks(previous?.value.session, snapshot.session).map((event, index) => ({ ...event, id: `evt_wh_${identity}_${index}`, object: 'event' as const, created_at: now }));
      const endpoints = webhooks.length ? await this.base.list<StoredWebhookEndpoint>(ownerId, 'webhook_endpoints', { limit: 100 }) : { data: [] };
      const endpointIds = endpoints.data.filter(({ value }) => value.endpoint.enabled && webhooks.some((event) => value.endpoint.events.includes(event.type))).map(({ id }) => id);
      const batch: AgentResource<SessionEventBatch> = { id: identity, ownerId, collection: 'session_event_batches', createdAt: now, revision: 1, expiresAt: now + 4 * 86400, value: { sessionId: id, events, webhooks, endpointIds } };
      additions.push({ resource: batch, expectedRevision: 0 });
    }
    await this.base.commit([...writes, ...additions]);
  }
}
