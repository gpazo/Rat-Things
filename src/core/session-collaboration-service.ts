import type { AgentsStore } from './agents-ports.js';
import type { SessionCaller } from './session-caller.js';
import { validateSessionCaller } from './session-caller.js';
import { AgentsApiError, resourceNotFound } from '../domain/agents-api-validation.js';
import { activeTypists, assignParticipants, participantKey, requireContribution, typingRequest, TYPING_SECONDS, type AttributedActor, type Participant, type TypingLease } from './session-collaboration-planning.js';
import { sessionInputs } from './session-activity.js';
import type { SessionState } from './session-ports.js';
import { requireSessionMutable } from './session-fork-planning.js';
import { feedbackDigest } from './session-feedback-planning.js';

/** Presence is isolated from Session state and its dispatch outbox. Only new identities contend on a roster. */
export class SessionCollaborationService {
  constructor(private readonly store: AgentsStore, private readonly now: () => number) {}
  async participants(owner: string, id: string, actors: readonly AttributedActor[]) {
    return assignParticipants((await this.store.get<Participant[]>(owner, 'session_participants', id))?.value ?? [], actors);
  }
  async register(owner: string, state: SessionState, caller: SessionCaller): Promise<Participant> {
    const source = { actor: caller.actor, provenance: { kind: 'authenticated' as const } };
    for (let attempt = 0; attempt < 64; attempt++) {
      const previous = await this.store.get<Participant[]>(owner, 'session_participants', state.session.id);
      const existing = previous?.value.find(p => p.key === participantKey(source));
      if (existing) return { ...existing, actor: caller.actor };
      const value = assignParticipants(previous?.value ?? [], [...sessionInputs(state), source]);
      await validateSessionCaller(caller);
      try {
        await this.store.commit([{ resource: { ownerId: owner, collection: 'session_participants', id: state.session.id, createdAt: previous?.createdAt ?? this.now(), revision: (previous?.revision ?? 0) + 1, value }, expectedRevision: previous?.revision ?? 0 }], caller.observations);
        return value.find(p => p.key === participantKey(source))!;
      } catch (error) { if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 63) throw error; }
    }
    throw new Error('Participant registration exhausted');
  }
  async typing(owner: string, id: string, raw: unknown, caller: SessionCaller) {
    requireContribution(caller.permissions);
    const input = typingRequest(raw);
    let state = await this.store.get<SessionState>(owner, 'sessions', id) ?? resourceNotFound();
    requireSessionMutable(state.value, this.now());
    const participant = await this.register(owner, state.value, caller);
    const collection = `session_typing:${id}`;
    const key = feedbackDigest([participant.key, input.client_id]);
    for (let attempt = 0; attempt < 5; attempt++) {
      await validateSessionCaller(caller);
      const previous = await this.store.get<TypingLease>(owner, collection, key);
      if (previous && previous.value.sequence >= input.sequence) return;
      const now = this.now();
      try {
        await this.store.commit([{ resource: { ownerId: owner, collection, id: key, createdAt: previous?.createdAt ?? now, revision: (previous?.revision ?? 0) + 1,
          // Keep a short sequence tombstone; logical expiry, not asynchronous TTL deletion, hides typing.
          expiresAt: now + 3600, value: { participant, client_id: input.client_id, sequence: input.sequence, expires_at: input.typing ? now + TYPING_SECONDS : now } }, expectedRevision: previous?.revision ?? 0 }], [
          { ownerId: owner, collection: 'sessions', id, revision: state.revision }, ...caller.observations ?? [],
        ]);
        return;
      } catch (error) {
        if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 4) throw error;
        state = await this.store.get<SessionState>(owner, 'sessions', id) ?? resourceNotFound();
        requireSessionMutable(state.value, this.now());
      }
    }
  }
  async presence(owner: string, id: string) {
    const leases: TypingLease[] = [];
    let after: string | undefined;
    do {
      const page = await this.store.list<TypingLease>(owner, `session_typing:${id}`, { limit: 100, ...(after ? { after } : {}) });
      leases.push(...page.data.map(row => row.value));
      if (!page.has_more) break;
      after = page.data.at(-1)?.id;
    } while (after);
    return activeTypists(leases, this.now());
  }
}
