import { expect, it } from 'vitest';
import { SessionPlanService } from '../../src/core/session-plan-service.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import type { SessionPlanUpdateInput } from '../../src/domain/session-plan.js';
import { applySessionPlanUpdate, parseSessionPlanUpdate } from '../../src/domain/session-plan.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { sessionConfigurationSnapshot } from '../../src/core/configuration-history.js';
import { MemoryAgentsStore } from './fixtures.js';
import { planSessionLaunch } from '../../src/runner/session-launch-planning.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { functionTools } from '../../src/runner/pi/functions.js';
import { SESSION_PLAN_TOOL, SESSION_PLAN_TOOL_NAME } from '../../src/domain/session-plan.js';
import { AgentsResourceConflictError } from '../../src/domain/agents-api-validation.js';

const sha = 'a'.repeat(64);

function update(expected_revision: number, result_links: Array<{ kind: 'artifact'; artifact_id: string; version_sha256: string } | { kind: 'activity'; turn_id: string; item_id: string }> = []): SessionPlanUpdateInput {
  return parseSessionPlanUpdate({ expected_revision, items: [{ id: 'item_1', text: 'Revise the output', state: 'addressed', reason: 'Updated the saved output.',
    source_message_ids: ['message_1'], result_links }] });
}

function context(current = { revision: 0, items: [] }) {
  return { current, sources: [{ id: 'receipt_1', message_ids: ['message_1'], status: 'accepted' as const }], agentId: 'agent_1', turnId: 'turn_1', updatedAt: 100 };
}

function sessionState(): SessionState {
  const agent = sessionAgent({ model: 'test' }, 'agent_1', 100);
  return { planToolAdmitted: true, session: { id: 'sess_plan', object: 'agent.session', agent, created_at: 100, last_active_at: 100,
    environment: { type: 'none' }, error: null, metadata: {}, status: 'idle', required_actions: [], usage: null, vault_ids: [] },
    turns: [], receipts: {}, deletedArtifacts: [] };
}

class UniqueTransactionStore extends MemoryAgentsStore {
  public readonly transactions: Array<Array<{ collection: string; id: string }>> = [];
  public override async commit(writes: Array<{ resource: import('../../src/core/agents-ports.js').AgentResource<unknown>; expectedRevision: number }>, observations: import('../../src/core/agents-ports.js').AgentObservation[] = []) {
    const keys = writes.map(({ resource }) => ({ collection: resource.collection, id: resource.id }));
    if (new Set(keys.map(key => JSON.stringify(key))).size !== keys.length) throw new Error('Transaction contains duplicate item keys');
    this.transactions.push(keys);
    return super.commit(writes, observations);
  }
}

it('parses the agent boundary and stamps receipt, agent, turn, and time from the host', () => {
  expect(() => parseSessionPlanUpdate({ expected_revision: 0, items: [{ id: 'item_1', text: 'Do it', state: 'addressed', source_message_ids: [], result_links: [] }] }))
    .toThrow(/require an explanation/);
  const plan = applySessionPlanUpdate(update(0), context());
  expect(plan).toMatchObject({ revision: 1, items: [{ id: 'item_1', state: 'addressed', source_refs: [{ receipt_id: 'receipt_1', message_id: 'message_1' }], updated_by: { agent_id: 'agent_1', turn_id: 'turn_1' }, updated_at: 100 }] });
});

it('audits Plan admission and registers the private function only for admitted Codex and Pi launches', () => {
  const base = planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'read-only' } }, '/workspace', 10_000, {});
  const agent = sessionAgent({ model: 'test' }, 'agent_1', 100);
  const common = { sessionId: 'sess_plan', turnId: 'turn_1', agent, environment: { type: 'none' as const }, input: [] };
  const admittedCodex = planSessionLaunch(base, { ...common, planTool: true });
  const existingCodex = planSessionLaunch(base, common);
  expect(admittedCodex.dynamicTools).toContainEqual({ type: 'function', name: SESSION_PLAN_TOOL_NAME,
    description: SESSION_PLAN_TOOL.description, inputSchema: SESSION_PLAN_TOOL.parameters, deferLoading: false });
  expect(existingCodex.dynamicTools).not.toContainEqual(expect.objectContaining({ name: SESSION_PLAN_TOOL_NAME }));
  expect(functionTools({ ...common, planTool: true }).map(tool => tool.name)).toContain(SESSION_PLAN_TOOL_NAME);
  expect(functionTools(common).map(tool => tool.name)).not.toContain(SESSION_PLAN_TOOL_NAME);
  expect(sessionConfigurationSnapshot(sessionState())).toMatchObject({ kind: 'session', configuration: { planToolAdmitted: true } });
});

it('commits Plan head, immutable revision, idempotency record, and activity observation without duplicate transaction keys', async () => {
  const base = new UniqueTransactionStore();
  const store = new SessionEventStore(base, { now: () => 100 });
  await store.put({ ownerId: 'owner', id: 'sess_plan', collection: 'sessions', revision: 1, createdAt: 100, value: sessionState() }, 0);
  const session = await store.get<SessionState>('owner', 'sessions', 'sess_plan');
  const observation = await store.get('owner', 'session_observations', 'sess_plan');
  const service = new SessionPlanService(store, { now: () => 101 });
  const args = { expected_revision: 0, items: [{ id: 'item_1', text: 'Revise the output', state: 'addressed', reason: 'Updated the saved output.',
    source_message_ids: ['message_1'], result_links: [{ kind: 'output', path: '/workspace/outputs/result.txt' }] }] };
  const captured = [{ path: '/workspace/outputs/result.txt', artifact_id: 'artifact_1', version_sha256: sha }];
  const result = await service.resolveCall({ ownerId: 'owner', sessionId: 'sess_plan', turnId: 'turn_1', callId: 'call_1', agentId: 'agent_1', rawArguments: args,
    sessionRevision: session!.revision, observationRevision: observation!.revision, sources: [{ id: 'receipt_1', message_ids: ['message_1'], status: 'accepted' }],
    capturedOutputs: captured, available: { artifacts: [], activity: [] }, validArtifactVersions: new Set(), validActivityItems: new Set() });
  expect(result.plan).toMatchObject({ revision: 1, items: [{ result_links: [{ kind: 'artifact', artifact_id: 'artifact_1', version_sha256: sha }] }] });
  expect(base.transactions.at(-1)?.map(key => key.collection)).toContain('session_observations');
  const keys = base.transactions.at(-1)!.map(key => JSON.stringify(key));
  expect(new Set(keys).size).toBe(keys.length);
  expect((await store.get<{ activity?: { plan?: { revision: number } } }>('owner', 'session_event_batches', 'sess_plan_0000000000000002'))?.value.activity).toMatchObject({ plan: { revision: 1 } });
  expect(await service.history('owner', 'sess_plan', 0, 1)).toMatchObject({ session_id: 'sess_plan', head_revision: 1, revisions: [{ revision: 1 }] });
});

it('replays a call across service restarts, rejects changed arguments, and leaves invalid result links uncommitted', async () => {
  const store = new MemoryAgentsStore();
  await store.put({ ownerId: 'owner', id: 'sess_plan', collection: 'sessions', revision: 1, createdAt: 100, value: {} }, 0);
  await store.put({ ownerId: 'owner', id: 'sess_plan', collection: 'session_observations', revision: 1, createdAt: 100, value: {} }, 0);
  const service = new SessionPlanService(store, { now: () => 100 });
  const base = { ownerId: 'owner', sessionId: 'sess_plan', turnId: 'turn_1', callId: 'call_1', agentId: 'agent_1',
    sessionRevision: 1, observationRevision: 1, sources: [{ id: 'receipt_1', message_ids: ['message_1'], status: 'accepted' as const }],
    available: { artifacts: [], activity: [] }, validArtifactVersions: new Set<string>([`artifact_1:${sha}`]), validActivityItems: new Set<string>() };
  const args = { expected_revision: 0, items: [{ id: 'item_1', text: 'Revise the output', state: 'addressed', reason: 'Updated the saved output.', source_message_ids: ['message_1'],
    result_links: [{ kind: 'artifact', artifact_id: 'artifact_1', version_sha256: sha }] }] };
  const first = await service.resolveCall({ ...base, rawArguments: args });
  const restarted = new SessionPlanService(store, { now: () => 200 });
  expect(await restarted.resolveCall({ ...base, rawArguments: args })).toEqual(first);
  expect(await restarted.resolveCall({ ...base, rawArguments: { ...args, expected_revision: 1 } })).toMatchObject({ error: { code: 'plan_call_conflict' } });

  const broken = await restarted.resolveCall({ ...base, callId: 'call_2', rawArguments: { ...args, expected_revision: 1, items: [{ ...args.items[0], result_links: [{ kind: 'activity', turn_id: 'other', item_id: 'invented' }] }] } });
  expect(broken).toMatchObject({ error: { code: 'invalid_request' } });
  expect(await restarted.head('owner', 'sess_plan')).toMatchObject({ revision: 1, items: [{ id: 'item_1' }] });
  expect(await restarted.history('owner', 'sess_plan')).toMatchObject({ revisions: [{ revision: 1 }], head_revision: 1 });
});

it('does not return a validation error until its observation-fenced call receipt is durable', async () => {
  class ObservationRaceStore extends MemoryAgentsStore {
    private raced = false;
    public override async commit(writes: Array<{ resource: import('../../src/core/agents-ports.js').AgentResource<unknown>; expectedRevision: number }>, observations: import('../../src/core/agents-ports.js').AgentObservation[] = []) {
      const callWrite = writes.find(({ resource }) => resource.collection === 'session_plan_calls');
      if (!this.raced && callWrite) {
        this.raced = true;
        const observed = observations.find(value => value.collection === 'session_observations');
        if (observed) {
          const current = await this.get(observed.ownerId, observed.collection, observed.id);
          if (current) await this.put({ ...current, revision: current.revision + 1 }, current.revision);
        }
        throw new AgentsResourceConflictError();
      }
      return super.commit(writes, observations);
    }
  }

  const store = new ObservationRaceStore();
  await store.put({ ownerId: 'owner', id: 'sess_plan', collection: 'sessions', revision: 1, createdAt: 100, value: {} }, 0);
  await store.put({ ownerId: 'owner', id: 'sess_plan', collection: 'session_observations', revision: 1, createdAt: 100, value: {} }, 0);
  const service = new SessionPlanService(store, { now: () => 100 });
  const args = { expected_revision: 0, items: [{ id: 'item_1', text: 'Revise the output', state: 'addressed', reason: 'Updated the saved output.', source_message_ids: ['message_1'],
    result_links: [{ kind: 'artifact', artifact_id: 'missing', version_sha256: sha }] }] };
  const base = { ownerId: 'owner', sessionId: 'sess_plan', turnId: 'turn_1', callId: 'call_raced', agentId: 'agent_1', rawArguments: args,
    sessionRevision: 1, observationRevision: 1, sources: [{ id: 'receipt_1', message_ids: ['message_1'], status: 'accepted' as const }],
    validArtifactVersions: new Set<string>(), validActivityItems: new Set<string>() };

  await expect(service.resolveCall({ ...base, available: { artifacts: [], activity: [] } })).rejects.toMatchObject({ status: 409, code: 'conflict' });
  expect((await store.list('owner', 'session_plan_calls', { limit: 10 })).data).toEqual([]);

  const updatedAvailable = { artifacts: [{ kind: 'artifact' as const, artifact_id: 'new_context', version_sha256: sha, turn_id: 'turn_2' }], activity: [] };
  const retry = await service.resolveCall({ ...base, observationRevision: 2, available: updatedAvailable });
  expect(retry).toMatchObject({ error: { code: 'invalid_request' }, available_result_links: updatedAvailable });

  const replay = await service.resolveCall({ ...base, observationRevision: 2, available: { artifacts: [], activity: [{ kind: 'activity', turn_id: 'turn_2', item_id: 'later_context' }] } });
  expect(replay).toEqual(retry);
});

it('exports and imports a same-Session Plan history bundle with remapped receipts and separate storage revision', async () => {
  const base = new MemoryAgentsStore();
  const store = new SessionEventStore(base, { now: () => 100 });
  await store.put({ ownerId: 'owner', id: 'sess_plan', collection: 'sessions', revision: 1, createdAt: 100, value: sessionState() }, 0);
  const service = new SessionPlanService(store, { now: () => 100 });
  for (let revision = 0; revision < 3; revision++) {
    const session = await store.get<SessionState>('owner', 'sessions', 'sess_plan');
    const observation = await store.get('owner', 'session_observations', 'sess_plan');
    await service.resolveCall({ ownerId: 'owner', sessionId: 'sess_plan', turnId: 'turn_1', callId: `call_${revision}`, agentId: 'agent_1',
      rawArguments: { expected_revision: revision, items: [{ id: `item_${revision}`, text: `Plan item ${revision}`, state: 'working', source_message_ids: ['message_1'], result_links: [] }] },
      sessionRevision: session!.revision, observationRevision: observation!.revision, sources: [{ id: 'receipt_1', message_ids: ['message_1'], status: 'dispatched' }],
      available: { artifacts: [], activity: [] }, validArtifactVersions: new Set<string>(), validActivityItems: new Set<string>() });
  }
  const transfer = await service.export('owner', 'sess_plan');
  const remapped = service.remapReceipts(transfer, new Map([['receipt_1', 'imported_receipt_1']]));
  const imported = new MemoryAgentsStore();
  const writes = service.importWrites('owner_2', 'sess_copy', remapped, 200);
  expect(writes[0]?.resource).toMatchObject({ collection: 'session_plans', revision: 1, value: { revision: 3 } });
  await imported.commit(writes);
  const importedService = new SessionPlanService(imported, { now: () => 300 });
  expect(await importedService.head('owner_2', 'sess_copy')).toMatchObject({ revision: 3 });
  expect(await importedService.history('owner_2', 'sess_copy', 0, 2)).toMatchObject({
    head_revision: 3, next_after: 2, revisions: [{ revision: 1, items: [{ source_refs: [{ receipt_id: 'imported_receipt_1' }] }] }, { revision: 2 }],
  });
  expect(await importedService.history('owner_2', 'sess_copy', 2, 1)).toMatchObject({ head_revision: 3, revisions: [{ revision: 3 }] });
});
