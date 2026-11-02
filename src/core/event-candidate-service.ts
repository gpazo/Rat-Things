import type { AgentResource, AgentsClock, AgentsStore } from './agents-ports.js';
import type { EventCandidate, EventCandidateAudit, EventCandidateThread } from '../domain/event-candidates.js';
import type { SourceEventPolicy } from '../domain/event-policy.js';
import { validateSourceEventPolicy } from '../domain/event-policy.js';
import type { SessionIntegrationInput, SessionIntegrationTarget, SessionIntegrationState, ThreadSubscription } from '../domain/session-integrations.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { integrationDigest, threadSubscriptionId } from './session-integration-planning.js';
import { parseEventFilterDecision, type EventFilterDecision } from './event-filter-planning.js';

export interface EventFilterModel {
  readonly id: string;
  decide(input: { policies: string[]; eventText: string; threadText: string }): Promise<EventFilterDecision>;
}

type AdmissionWrite = { resource: AgentResource<unknown>; expectedRevision: number };
interface CandidateAdmission {
  accept(ownerId: string, bindingId: string, threadKey: string, target: SessionIntegrationTarget, input: SessionIntegrationInput, writes?: AdmissionWrite[]): Promise<{ sessionId: string }>;
}

export class EventCandidateService {
  public constructor(private readonly options: {
    store: AgentsStore;
    integrations: CandidateAdmission;
    model: EventFilterModel;
    clock?: AgentsClock;
    count?: (metric: 'EventCandidateAccepted' | 'EventCandidateDropped' | 'EventFilterError' | 'EventCandidateCapped') => void;
  }) {}

  public async receipt(ownerId: string, bindingId: string, threadKey: string, input: SessionIntegrationInput): Promise<{ candidateId: string } | undefined> {
    const id = `candidate_${integrationDigest([bindingId, input.id])}`;
    const previous = await this.options.store.get<EventCandidate>(ownerId, 'event_candidates', id);
    if (!previous) return undefined;
    if (previous.value.inputDigest !== integrationDigest([bindingId, threadKey, input])) throw new AgentsApiError(409, 'Candidate occurrence has different input.', 'idempotency_conflict');
    return { candidateId: id };
  }

  public async enqueue(ownerId: string, bindingId: string, threadKey: string, target: SessionIntegrationTarget, input: SessionIntegrationInput, policy: SourceEventPolicy): Promise<{ candidateId: string }> {
    validateSourceEventPolicy(policy);
    if (policy.mode !== 'candidate' || !policy.semantic) throw new Error('Candidate admission requires a semantic policy');
    const id = `candidate_${integrationDigest([bindingId, input.id])}`;
    const inputDigest = integrationDigest([bindingId, threadKey, input]);
    for (let attempt = 0; ; attempt++) {
      const previous = await this.options.store.get<EventCandidate>(ownerId, 'event_candidates', id);
      if (previous) {
        if (previous.value.inputDigest !== inputDigest) throw new AgentsApiError(409, 'Candidate occurrence has different input.', 'idempotency_conflict');
        return { candidateId: id };
      }
      const now = this.now();
      const hour = Math.floor(now / 3600);
      const limitId = integrationDigest([bindingId, hour]);
      const limit = await this.options.store.get<{ count: number }>(ownerId, 'event_candidate_limits', limitId);
      const marker = await this.thread(ownerId, bindingId, threadKey);
      const policyDigest = integrationDigest(policy.semantic.policies);
      const capped = (limit?.value.count ?? 0) >= policy.semantic.maxCandidatesPerHour;
      const value: EventCandidate = { bindingId, threadKey, inputDigest, target: structuredClone(target), input: structuredClone(input), policies: [...policy.semantic.policies], policyDigest, explicitVersion: marker?.value.explicitVersion ?? 0,
        state: capped ? { status: 'discarded', decision: { act: false, reason: 'hourly_cap', model: this.options.model.id, policyDigest } } : { status: 'pending' },
      };
      const writes: AdmissionWrite[] = [{ resource: { ownerId, collection: 'event_candidates', id, createdAt: now, expiresAt: now + 7 * 86400, revision: 1, value }, expectedRevision: 0 }];
      if (!capped) writes.push({ resource: { ownerId, collection: 'event_candidate_limits', id: limitId, createdAt: limit?.createdAt ?? now, expiresAt: (hour + 2) * 3600, revision: (limit?.revision ?? 0) + 1, value: { count: (limit?.value.count ?? 0) + 1 } }, expectedRevision: limit?.revision ?? 0 });
      try {
        await this.options.store.commit(writes);
        this.options.count?.(capped ? 'EventCandidateCapped' : 'EventCandidateAccepted');
        return { candidateId: id };
      } catch (error) { if (!conflict(error) || attempt >= 9) throw error; }
    }
  }

  public async recordExplicit(ownerId: string, bindingId: string, threadKey: string, inputId: string): Promise<void> {
    const id = integrationDigest([bindingId, inputId]);
    for (let attempt = 0; ; attempt++) {
      if (await this.options.store.get(ownerId, 'event_explicit_receipts', id)) return;
      const marker = await this.thread(ownerId, bindingId, threadKey);
      const now = this.now();
      try {
        await this.options.store.commit([
          { resource: { ownerId, collection: 'event_explicit_receipts', id, createdAt: now, expiresAt: now + 7 * 86400, revision: 1, value: { threadKey } }, expectedRevision: 0 },
          this.markerWrite(ownerId, bindingId, threadKey, marker, (marker?.value.explicitVersion ?? 0) + 1),
        ]);
        return;
      } catch (error) { if (!conflict(error) || attempt >= 9) throw error; }
    }
  }

  public async process(ownerId: string, id: string): Promise<{ retryAfterSeconds?: number }> {
    let current = await this.options.store.get<EventCandidate>(ownerId, 'event_candidates', id);
    if (!current || current.value.state.status === 'admitted' || current.value.state.status === 'discarded') return {};
    const now = this.now();
    if (current.value.state.status === 'filtering' && current.value.state.leaseUntil > now) return { retryAfterSeconds: current.value.state.leaseUntil - now };
    if (current.value.state.status !== 'decided') {
      const marker = await this.thread(ownerId, current.value.bindingId, current.value.threadKey);
      const obsolete = current.createdAt + 3600 <= now || (marker?.value.explicitVersion ?? 0) !== current.value.explicitVersion;
      const claimed: AgentResource<EventCandidate> = { ...current, revision: current.revision + 1, value: { ...current.value, state: { status: 'filtering', leaseUntil: now + 90 } } };
      await this.options.store.put(claimed, current.revision);
      let decision: EventCandidateAudit = { act: false, reason: obsolete ? 'superseded_or_expired' : 'filter_error', model: this.options.model.id, policyDigest: current.value.policyDigest };
      if (!obsolete) {
        try {
          const result = parseEventFilterDecision(await this.options.model.decide({ policies: current.value.policies, eventText: current.value.input.text.slice(0, 8_000), threadText: await this.threadText(ownerId, current.value) }));
          decision = { ...decision, ...result };
        } catch { this.options.count?.('EventFilterError'); }
      }
      current = { ...claimed, revision: claimed.revision + 1, value: { ...claimed.value, state: { status: 'decided', decision } } };
      await this.options.store.put(current, claimed.revision);
    }
    if (current.value.state.status !== 'decided') return {};
    const { decision } = current.value.state;
    for (let attempt = 0; ; attempt++) {
      const marker = await this.thread(ownerId, current.value.bindingId, current.value.threadKey);
      const superseded = (marker?.value.explicitVersion ?? 0) !== current.value.explicitVersion;
      if (!decision.act || superseded || current.createdAt + 3600 <= this.now()) {
        await this.options.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, state: { status: 'discarded', decision: superseded ? { ...decision, act: false, reason: 'explicit_request_won' } : decision } } }, current.revision);
        this.options.count?.('EventCandidateDropped');
        return {};
      }
      const admitted: AgentResource<EventCandidate> = { ...current, revision: current.revision + 1, value: { ...current.value, state: { status: 'admitted', decision } } };
      try {
        await this.options.integrations.accept(ownerId, current.value.bindingId, current.value.threadKey, current.value.target,
          { ...current.value.input, admission: 'candidate' }, [
            { resource: admitted, expectedRevision: current.revision },
            this.markerWrite(ownerId, current.value.bindingId, current.value.threadKey, marker, current.value.explicitVersion),
          ]);
        return {};
      } catch (error) {
        if (!conflict(error) || attempt >= 9) throw error;
        const latest = await this.options.store.get<EventCandidate>(ownerId, 'event_candidates', id);
        if (!latest || latest.value.state.status === 'admitted' || latest.value.state.status === 'discarded') return {};
        current = latest;
      }
    }
  }

  private thread(ownerId: string, bindingId: string, threadKey: string) { return this.options.store.get<EventCandidateThread>(ownerId, 'event_candidate_threads', integrationDigest([bindingId, threadKey])); }
  private async threadText(ownerId: string, candidate: EventCandidate): Promise<string> {
    const subscription = await this.options.store.get<ThreadSubscription>(ownerId, 'thread_subscriptions', threadSubscriptionId(candidate.bindingId, candidate.threadKey));
    const id = subscription?.value.subscribers[0]?.sessionId;
    if (!id) return '';
    const integration = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', id);
    return integration?.value.inputs.slice(-8).map(input => input.text.slice(0, 500)).join('\n').slice(0, 4_000) ?? '';
  }
  private markerWrite(ownerId: string, bindingId: string, threadKey: string, previous: AgentResource<EventCandidateThread> | undefined, explicitVersion: number): AdmissionWrite {
    return { resource: { ownerId, collection: 'event_candidate_threads', id: integrationDigest([bindingId, threadKey]), createdAt: previous?.createdAt ?? this.now(), revision: (previous?.revision ?? 0) + 1, value: { explicitVersion } }, expectedRevision: previous?.revision ?? 0 };
  }
  private now(): number { return this.options.clock?.now() ?? Math.floor(Date.now() / 1000); }
}

function conflict(error: unknown): boolean { return error instanceof AgentsApiError && error.code === 'conflict'; }
