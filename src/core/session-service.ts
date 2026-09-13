import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentSession, AgentSessionDeleted, AgentSessionInputParam, SessionArtifactDeleted } from '../domain/agents-api.js';
import { AgentsApiError, invalid, parseAgentsContract, resourceNotFound, validateAgentMetadata } from '../domain/agents-api-validation.js';
import { canonicalJson } from '../domain/json.js';
import type { AgentService } from './agent-service.js';
import type { AgentResource, AgentsClock, AgentsIds, AgentsStore } from './agents-ports.js';
import type { SessionExecution, SessionObservation, SessionState } from './session-ports.js';
import { cursorPage, initialMessages, observeSession, orderedTurnItems, planSessionInput, terminalTurn, sessionAgent } from './session-planning.js';
import { planSessionStream, type SessionStreamSnapshot } from './session-stream.js';
import { sessionEventBatchId, type SessionEventBatch } from './session-event-store.js';

export interface SessionServiceOptions {
  store: AgentsStore;
  agents: Pick<AgentService, 'retrieve'>;
  execution: SessionExecution;
  clock?: AgentsClock;
  ids?: AgentsIds;
  streamIntervalMs?: number;
}

/** Sessions own configuration and an outbox. Execution acknowledgements are separate writes. */
export class SessionService {
  private readonly clock: AgentsClock;
  private readonly ids: AgentsIds;

  public constructor(private readonly options: SessionServiceOptions) {
    this.clock = options.clock ?? { now: () => Math.floor(Date.now() / 1000) };
    this.ids = options.ids ?? { next: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}` };
  }

  public async create(ownerId: string, raw: unknown, integrationId?: string): Promise<AgentSession> {
    // Only trusted integration code supplies this identity; it is never an HTTP parameter.
    if (integrationId) {
      const previous = await this.options.store.get<SessionState>(ownerId, 'sessions', integrationId);
      if (previous) return previous.value.session;
    }
    const input = parseAgentsContract('SessionCreate', raw);
    validateAgentMetadata(input.metadata);
    const messages = initialMessages(input.input);
    if (input.environment.type === 'none' && !messages.length) invalid('Sessions without an environment require initial input', 'input');
    const id = integrationId ?? this.ids.next('sess');
    const preparation = integrationId ? await this.options.store.get<{ agent: AgentSession['agent']; now: number; created?: boolean }>(ownerId, 'session_preparations', id) : undefined;
    if (preparation?.value.created) resourceNotFound();
    const saved = !preparation && input.agent_id ? await this.options.agents.retrieve(ownerId, input.agent_id) : undefined;
    const now = preparation?.value.now ?? this.clock.now();
    const agent = preparation?.value.agent ?? sessionAgent(input.agent, this.ids.next('agent'), now, saved);
    if (integrationId && !preparation) await this.options.store.put({ ownerId, id, collection: 'session_preparations', createdAt: now, revision: 1, value: { agent, now } }, 0);
    const vaultIds = [...new Set(input.vault_ids ?? [])];
    const environment = await this.options.execution.prepare(ownerId, id, input.environment, agent, vaultIds, input.agent?.tools ?? preparation?.value.agent.tools ?? saved?.tools ?? [], Boolean(integrationId));
    const session: AgentSession = {
      id, object: 'agent.session', agent, created_at: now, last_active_at: now,
      environment, error: null, metadata: input.metadata ?? {}, status: 'idle',
      required_actions: [], usage: null, vault_ids: vaultIds,
    };
    const empty: SessionState = { session, turns: [], receipts: {}, deletedArtifacts: [] };
    const events: AgentSessionInputParam[] = messages.length ? [{ type: 'agent.session.input.message', input: messages }] : [];
    const state = events.length ? this.plan(empty, { session, turns: [] }, events, 'initial') : empty;
    try {
      const resource = { id, ownerId, collection: 'sessions', createdAt: now, revision: 1, value: state };
      if (integrationId) {
        const prepared = await this.options.store.get<{ agent: AgentSession['agent']; now: number; created?: boolean }>(ownerId, 'session_preparations', id) ?? resourceNotFound();
        if (prepared.value.created) return (await this.required(ownerId, id)).value.session;
        await this.options.store.commit([{ resource, expectedRevision: 0 }, { resource: { ...prepared, revision: prepared.revision + 1, value: { ...prepared.value, created: true } }, expectedRevision: prepared.revision }]);
      } else await this.options.store.put(resource, 0);
    }
    catch (error) {
      if (!integrationId || !(error instanceof AgentsApiError) || error.code !== 'conflict') throw error;
      return (await this.required(ownerId, id)).value.session;
    }
    return (await this.observe(ownerId, state)).session;
  }

  public async retrieve(ownerId: string, id: string): Promise<AgentSession> {
    return (await this.observe(ownerId, (await this.required(ownerId, id)).value)).session;
  }

  /** Live SSE does not replay missed history. Clients recover from saved items and turns. */
  public async streamSnapshot(ownerId: string, id: string): Promise<SessionStreamSnapshot> {
    const { value } = await this.required(ownerId, id);
    const committed = await this.options.store.get<SessionStreamSnapshot>(ownerId, 'session_observations', id);
    if (committed) return { ...committed.value, eventRevision: committed.revision };
    const observation = await this.observe(ownerId, value);
    const environment = await this.options.execution.environment?.(ownerId, value.session);
    const subagents = await this.subagentSnapshots(ownerId, value);
    return {
      session: observation.session, turns: observation.turns.map(({ turn }) => turn), items: [...await this.allItems(ownerId, value), ...subagents.flatMap((entry) => entry.items)],
      subagents: subagents.map((entry) => entry.subagent),
      failures: Object.entries(value.receipts).flatMap(([id, receipt]) => receipt.failure ? [{ id, ...receipt.failure }] : []),
      ...(environment ? { environment } : {}),
    };
  }

  public async *stream(ownerId: string, id: string, signal: AbortSignal, created = false, baseline?: SessionStreamSnapshot) {
    const subscription = baseline ?? await this.streamSnapshot(ownerId, id);
    if (subscription.eventRevision !== undefined) {
      yield* this.committedStream(ownerId, id, signal, created, subscription);
      return;
    }
    let previous = baseline;
    let first = true;
    let initialTurn: string | undefined;
    while (!signal.aborted) {
      const current = await this.streamSnapshot(ownerId, id);
      if (first && !created && !previous) previous = current;
      if (first && created) initialTurn = current.turns[0]?.id;
      for (const event of planSessionStream(previous, current, first && created)) yield { ...event, event_id: this.ids.next('evt') };
      previous = current;
      first = false;
      if (created && (!initialTurn || current.turns.some((turn) => turn.id === initialTurn && terminalTurn(turn)))) return;
      try { await delay(this.options.streamIntervalMs ?? 500, undefined, { signal }); }
      catch (error) { if (signal.aborted) return; throw error; }
    }
  }

  private async *committedStream(ownerId: string, id: string, signal: AbortSignal, created: boolean, baseline: SessionStreamSnapshot) {
    let revision = created ? 0 : baseline.eventRevision!;
    const initialTurn = created ? baseline.turns.find((turn) => turn.subagent_id === null)?.id : undefined;
    let completed = false;
    while (!signal.aborted) {
      await this.required(ownerId, id);
      const head = await this.options.store.get<SessionStreamSnapshot>(ownerId, 'session_observations', id) ?? resourceNotFound();
      while (revision < head.revision && !signal.aborted) {
        const batch = await this.options.store.get<SessionEventBatch>(ownerId, 'session_event_batches', sessionEventBatchId(id, revision + 1));
        if (!batch) throw new AgentsApiError(409, 'Stream history expired. Reconnect and retrieve saved state.', 'stream_history_expired');
        for (const event of batch.value.events) {
          if (signal.aborted) return;
          yield event;
          if (created && 'turn' in event && event.turn.id === initialTurn && terminalTurn(event.turn)) completed = true;
        }
        revision++;
        if (created && (completed || !initialTurn)) return;
      }
      try { await delay(this.options.streamIntervalMs ?? 500, undefined, { signal }); }
      catch (error) { if (signal.aborted) return; throw error; }
    }
  }

  public async update(ownerId: string, id: string, raw: unknown): Promise<AgentSession> {
    const input = parseAgentsContract('SessionUpdate', raw);
    validateAgentMetadata(input.metadata);
    const resource = await this.required(ownerId, id);
    const observation = await this.observe(ownerId, resource.value);
    const session = {
      ...observation.session,
      metadata: input.metadata === undefined ? resource.value.session.metadata : input.metadata ?? {},
    };
    await this.replace(resource, { ...resource.value, session });
    return session;
  }

  public async list(ownerId: string, raw: unknown = {}) {
    const query = parseAgentsContract('SessionList', raw);
    const limit = pageLimit(query.limit);
    let after = query.after;
    const selected: AgentResource<SessionState>[] = [];
    // Apply the filter before cutting the page; a sparse agent filter must not strand later matches.
    do {
      const page = await this.options.store.list<SessionState>(ownerId, 'sessions', { limit: 100, ...(query.order ? { order: query.order } : {}), ...(after ? { after } : {}) });
      selected.push(...page.data.filter(({ value }) => !query.agent_id || value.session.agent.id === query.agent_id));
      if (selected.length > limit || !page.has_more) break;
      after = page.data.at(-1)?.id;
    } while (after);
    const data = await Promise.all(selected.slice(0, limit).map(({ value }) => this.observe(ownerId, value).then((item) => item.session)));
    return { object: 'list' as const, data, has_more: selected.length > limit };
  }

  public async delete(ownerId: string, id: string): Promise<AgentSessionDeleted> {
    const resource = await this.required(ownerId, id);
    // Closing the whole harness also revokes queued input. It must remain possible
    // when a Turn never reached the worker or the observation channel is unavailable.
    if (this.options.execution.close) await this.options.execution.close(ownerId, resource.value.session);
    else {
      const observation = await this.observe(ownerId, resource.value);
      for (const { turn } of observation.turns.filter(({ turn }) => !terminalTurn(turn))) {
        await this.options.execution.cancel(ownerId, observation.session, turn.id);
      }
    }
    await this.options.store.delete(resource);
    return { id, object: 'agent.session.deleted', deleted: true };
  }

  public async events(ownerId: string, id: string, raw: unknown, idempotencyKey?: string, response?: { waitForConnection: boolean; signal?: AbortSignal }): Promise<void> {
    const { events } = parseAgentsContract('SessionEvents', raw);
    if (idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 256)) invalid('Idempotency-Key must contain 1–256 characters', 'Idempotency-Key');
    const resource = await this.required(ownerId, id);
    const key = hash(idempotencyKey ?? this.ids.next('request'));
    const previous = resource.value.receipts[key];
    if (previous) {
      if (previous.digest !== hash(canonicalJson(events))) throw new AgentsApiError(409, 'This Idempotency-Key was used with different events.', 'idempotency_conflict');
      if (response?.waitForConnection) await this.waitForInputConnection(ownerId, id, key, response.signal);
      return;
    }
    const observation = await this.observe(ownerId, resource.value);
    const items = await this.allItems(ownerId, resource.value);
    const anchors = Object.fromEntries(resource.value.turns.map(({ turn }) => [turn.id, items.filter((item) => item.turn_id === turn.id).at(-1)?.id ?? null]));
    await this.replace(resource, this.plan(resource.value, observation, events, key, anchors));
    if (response?.waitForConnection) await this.waitForInputConnection(ownerId, id, key, response.signal);
  }

  private async waitForInputConnection(ownerId: string, id: string, key: string, signal?: AbortSignal): Promise<void> {
    if (!this.options.execution.checkInputConnection) return;
    while (true) {
      signal?.throwIfAborted();
      const { value } = await this.required(ownerId, id);
      const receipt = value.receipts[key]!;
      if (receipt.failure) throw new AgentsApiError(receipt.failure.code === 'environment_connection_timeout' ? 408 : 400, receipt.failure.message, receipt.failure.code);
      if (receipt.dispatched || value.session.environment.type !== 'self_hosted') return;
      try {
        for (const command of receipt.commands) {
          if (command.type !== 'start') continue;
          const binding = value.turns.find(({ turn }) => turn.id === command.turnId) ?? resourceNotFound();
          if (!binding.cancelRequested && !terminalTurn(binding.turn)) await this.options.execution.checkInputConnection(ownerId, value.session, binding.turn);
        }
        return;
      } catch (error) {
        if (!(error instanceof AgentsApiError) || error.code !== 'environment_unavailable' || error.status !== 503) throw error;
      }
      await delay(this.options.streamIntervalMs ?? 500, undefined, { signal });
    }
  }

  /** Called by the durable outbox consumer. Every command is retryable with the same identity. */
  public async dispatch(ownerId: string, id: string): Promise<void> {
    let resource = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
    if (!resource) return;
    await this.options.execution.initialize?.(ownerId, resource.value.session);
    for (const [key, receipt] of Object.entries(resource.value.receipts)) {
      if (receipt.dispatched) continue;
      let failure: { code: string; message: string } | undefined;
      for (const command of receipt.commands) {
        const session = resource.value.session;
        try { switch (command.type) {
          case 'start': {
            const binding = resource.value.turns.find(({ turn }) => turn.id === command.turnId) ?? resourceNotFound();
            if (binding.cancelRequested) {
              await this.options.execution.cancel(ownerId, session, command.turnId);
              resource = await this.required(ownerId, id);
              resource = await this.replace(resource, { ...resource.value, turns: resource.value.turns.map((previous) => previous.turn.id === command.turnId ? {
                ...previous, turn: { ...previous.turn, status: 'cancelled', completed_at: this.clock.now() },
              } : previous) });
            } else {
              const preceding = resource.value.turns.slice(0, resource.value.turns.findIndex(({ turn }) => turn.id === command.turnId));
              const history = await this.allItems(ownerId, { ...resource.value, turns: preceding });
              await this.options.execution.start(ownerId, session, { ...binding, input: command.input }, history);
            }
            break;
          }
          case 'steer': await this.options.execution.steer(ownerId, session, command.turnId, command.input, command.operationId); break;
          case 'cancel': await this.options.execution.cancel(ownerId, session, command.turnId); break;
          case 'tool_result': await this.options.execution.toolResult(ownerId, session, command.event); break;
        } } catch (error) {
          if (!(error instanceof AgentsApiError) || error.status >= 500 || error.code === 'conflict') throw error;
          failure = { code: error.code ?? 'invalid_request', message: 'The submitted input could not be delivered.' };
          if (command.type === 'start') {
            resource = await this.required(ownerId, id);
            resource = await this.replace(resource, { ...resource.value,
              ...(key === 'initial' ? { session: { ...resource.value.session, status: 'failed', required_actions: [], error: failure.message } } : {}),
              turns: resource.value.turns.map((binding) => binding.turn.id === command.turnId ? {
              ...binding, turn: { ...binding.turn, status: 'failed', completed_at: this.clock.now(), error: { code: error.code === 'environment_connection_timeout' ? 'connection_failed' : 'invalid_request', message: failure!.message } },
            } : binding) });
          }
        }
      }
      // Re-read after effects so acknowledgement cannot discard a concurrently accepted input.
      const current = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
      if (!current) {
        for (const command of receipt.commands) if (command.type === 'start') await this.options.execution.cancel(ownerId, resource.value.session, command.turnId);
        return;
      }
      resource = current;
      resource = await this.replace(resource, {
        ...resource.value,
        receipts: { ...resource.value.receipts, [key]: { ...receipt, dispatched: true, ...(failure ? { failure } : {}) } },
      });
    }
  }

  public async turns(ownerId: string, id: string, raw: unknown = {}) {
    const query = parseAgentsContract('TurnList', raw);
    const resource = await this.required(ownerId, id);
    const observation = await this.observe(ownerId, resource.value);
    return cursorPage(observation.turns.map(({ turn }) => turn).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)), query);
  }

  public async turn(ownerId: string, id: string, turnId: string) {
    const resource = await this.required(ownerId, id);
    const binding = resource.value.turns.find(({ turn }) => turn.id === turnId);
    if (!binding) return (await this.subagentSnapshots(ownerId, resource.value)).flatMap((entry) => entry.turns).find((turn) => turn.id === turnId) ?? resourceNotFound();
    return terminalTurn(binding.turn) ? binding.turn : (await this.options.execution.observe(ownerId, resource.value.session, binding.turn)).turn;
  }

  public async subagents(ownerId: string, id: string, raw: unknown = {}) {
    const query = parseAgentsContract('SubagentList', raw);
    const { value } = await this.required(ownerId, id);
    return cursorPage((await this.subagentSnapshots(ownerId, value)).map((entry) => entry.subagent), query);
  }

  public async subagent(ownerId: string, id: string, subagentId: string) {
    return (await this.requiredSubagent(ownerId, id, subagentId)).subagent;
  }

  public async subagentTurns(ownerId: string, id: string, subagentId: string, raw: unknown = {}) {
    const query = parseAgentsContract('TurnList', raw);
    return cursorPage((await this.requiredSubagent(ownerId, id, subagentId)).turns, query);
  }

  public async subagentTurn(ownerId: string, id: string, subagentId: string, turnId: string) {
    return (await this.requiredSubagent(ownerId, id, subagentId)).turns.find((turn) => turn.id === turnId) ?? resourceNotFound();
  }

  public async subagentItems(ownerId: string, id: string, subagentId: string, raw: unknown = {}, turnId?: string) {
    const query = parseAgentsContract('ItemList', raw);
    const entry = await this.requiredSubagent(ownerId, id, subagentId);
    if (turnId && !entry.turns.some((turn) => turn.id === turnId)) resourceNotFound();
    return cursorPage(entry.items.filter((item) => !turnId || item.turn_id === turnId), query);
  }

  private async requiredSubagent(ownerId: string, id: string, subagentId: string) {
    return (await this.subagentSnapshots(ownerId, (await this.required(ownerId, id)).value)).find((entry) => entry.subagent.id === subagentId) ?? resourceNotFound();
  }

  private async subagentSnapshots(ownerId: string, state: SessionState) {
    const live = await this.options.execution.subagents?.(ownerId, state.session) ?? [];
    const merged = new Map((state.subagents ?? []).map((entry) => [entry.subagent.id, entry]));
    for (const entry of live) merged.set(entry.subagent.id, entry);
    return [...merged.values()].sort((a, b) => a.subagent.opened_at - b.subagent.opened_at || a.subagent.id.localeCompare(b.subagent.id)).map((entry) => ({
      ...entry, items: entry.turns.flatMap((turn) => orderedTurnItems(state, { turn, input: [] }, entry.items.filter((item) => item.turn_id === turn.id))),
    }));
  }

  /** Materialize terminal history before private execution records reach their retention limit. */
  public async completeReadyTurns(ownerId: string, id: string): Promise<void> {
    const resource = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
    if (!resource) return;
    for (const binding of resource.value.turns) await this.completeTurn(ownerId, id, binding.turn.id);
  }

  public async completeTurn(ownerId: string, id: string, turnId: string): Promise<void> {
    const resource = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
    if (!resource) return;
    const binding = resource.value.turns.find(({ turn }) => turn.id === turnId) ?? resourceNotFound();
    if (binding.savedItems && binding.savedArtifacts && terminalTurn(binding.turn)) return;
    const observation = terminalTurn(binding.turn) ? { turn: binding.turn, requiredActions: [] } : await this.options.execution.observe(ownerId, resource.value.session, binding.turn);
    if (!terminalTurn(observation.turn)) return;
    const [savedItems, savedArtifacts] = await Promise.all([
      this.options.execution.items(ownerId, resource.value.session, turnId),
      this.options.execution.artifacts(ownerId, resource.value.session, turnId),
    ]);
    const turns = resource.value.turns.map((previous) => previous.turn.id === turnId ? { ...previous, turn: observation.turn, savedItems, savedArtifacts } : previous);
    await this.replace(resource, { ...resource.value, turns, subagents: await this.subagentSnapshots(ownerId, resource.value) });
  }

  public async items(ownerId: string, id: string, raw: unknown = {}) {
    const query = parseAgentsContract('ItemList', raw);
    const { value } = await this.required(ownerId, id);
    return cursorPage(await this.allItems(ownerId, value), query);
  }

  public async artifacts(ownerId: string, id: string, raw: unknown = {}) {
    const query = parseAgentsContract('ArtifactList', raw);
    const { value } = await this.required(ownerId, id);
    const artifacts = await this.allArtifacts(ownerId, value);
    return cursorPage(artifacts.map(({ artifact }) => artifact).filter((artifact) => !value.deletedArtifacts.includes(artifact.id)), query);
  }

  public async artifact(ownerId: string, id: string, artifactId: string) {
    return (await this.savedArtifact(ownerId, id, artifactId)).artifact;
  }

  /** Trusted application integrations may publish these immutable references after owner checks. */
  public async publicationArtifacts(ownerId: string, id: string, artifactIds: readonly string[]) {
    const { value } = await this.required(ownerId, id);
    const available = await this.allArtifacts(ownerId, value);
    return artifactIds.map((artifactId) => {
      if (value.deletedArtifacts.includes(artifactId)) resourceNotFound();
      return available.find((entry) => entry.artifact.id === artifactId) ?? resourceNotFound();
    });
  }

  private async savedArtifact(ownerId: string, id: string, artifactId: string) {
    const { value } = await this.required(ownerId, id);
    if (value.deletedArtifacts.includes(artifactId)) resourceNotFound();
    return (await this.allArtifacts(ownerId, value)).find((item) => item.artifact.id === artifactId) ?? resourceNotFound();
  }

  private async allArtifacts(ownerId: string, state: SessionState) {
    const [roots, subagents] = await Promise.all([
      Promise.all(state.turns.map((binding) => binding.savedArtifacts ?? this.options.execution.artifacts(ownerId, state.session, binding.turn.id))),
      this.subagentSnapshots(ownerId, state),
    ]);
    return [...roots.flat(), ...subagents.flatMap((subagent) => subagent.artifacts ?? [])];
  }

  public async artifactContent(ownerId: string, id: string, artifactId: string) {
    const artifact = await this.savedArtifact(ownerId, id, artifactId);
    return this.options.execution.artifactContent(ownerId, await this.retrieve(ownerId, id), artifact);
  }

  public async deleteArtifact(ownerId: string, id: string, artifactId: string): Promise<SessionArtifactDeleted> {
    await this.artifact(ownerId, id, artifactId);
    const resource = await this.required(ownerId, id);
    await this.replace(resource, { ...resource.value, deletedArtifacts: [...resource.value.deletedArtifacts, artifactId] });
    return { id: artifactId, object: 'agent.session.artifact.deleted', deleted: true };
  }

  private plan(state: SessionState, observation: SessionObservation, events: AgentSessionInputParam[], key: string, itemAnchors?: Record<string, string | null>): SessionState {
    const plan = planSessionInput(state, observation, events, {
      turnIds: events.map(() => this.ids.next('turn')),
      messageIds: events.flatMap((event) => event.type === 'agent.session.input.message' ? event.input.map(() => this.ids.next('msg')) : []),
      operationIds: events.map(() => this.ids.next('event')),
      ...(itemAnchors ? { itemAnchors } : {}),
    }, this.clock.now());
    return { ...plan.state, receipts: {
      ...state.receipts, [key]: { digest: hash(canonicalJson(events)), commands: plan.commands, dispatched: false },
    } };
  }

  private async observe(ownerId: string, state: SessionState): Promise<SessionObservation> {
    const observations = await Promise.all(state.turns.map(({ turn }) => terminalTurn(turn) ? { turn, requiredActions: [] } : this.options.execution.observe(ownerId, state.session, turn)));
    const subagents = await this.subagentSnapshots(ownerId, state);
    const environment = await this.options.execution.environment?.(ownerId, state.session);
    const current = environment?.status === 'failed' ? { ...state, session: { ...state.session, status: 'failed' as const, error: 'The execution environment is unavailable. Create a new session.' } } : state;
    return observeSession(current, [...observations, ...subagents.flatMap((entry) => entry.turns.map((turn) => ({ turn, requiredActions: (entry.requiredActions ?? []).filter((action) => action.type === 'function_call' && action.turn_id === turn.id) })))]);
  }

  private async allItems(ownerId: string, state: SessionState) {
    return (await Promise.all(state.turns.map(async (binding) => orderedTurnItems(
      state, binding, binding.savedItems ?? await this.options.execution.items(ownerId, state.session, binding.turn.id),
    )))).flat();
  }

  private async required(ownerId: string, id: string) {
    return await this.options.store.get<SessionState>(ownerId, 'sessions', id) ?? resourceNotFound();
  }

  private async replace(resource: AgentResource<SessionState>, value: SessionState) {
    const updated = { ...resource, value, revision: resource.revision + 1 };
    await this.options.store.put(updated, resource.revision);
    return updated;
  }
}

function pageLimit(limit?: number) {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) invalid('limit must be a positive integer', 'limit');
  return Math.min(limit ?? 20, 100);
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
