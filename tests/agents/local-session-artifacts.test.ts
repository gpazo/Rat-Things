import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { CodexRpcClient } from '../../src/adapters/codex-rpc.js';
import type { SessionState, SessionTurnBinding } from '../../src/core/session-ports.js';
import { SessionArtifactCapture } from '../../src/core/session-artifact-capture.js';
import { MemoryAgentsStore } from './fixtures.js';
import { LocalSessionArtifactStore } from '../../src/runner/local-session-artifact-store.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import type { LocalManagedEnvironment } from '../../src/runner/local-managed-environment.js';
import type { SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import type { AgentSession } from '../../src/domain/agents-api.js';
import type { SessionLaunch } from '../../src/domain/session-execution.js';

const localRpc = vi.hoisted(() => ({ planTools: [] as Array<boolean>, fileOperations: [] as string[], complete: false }));
vi.mock('../../src/runner/local-codex.js', async original => ({ ...await original<typeof import('../../src/runner/local-codex.js')>(),
  localCodexClient: (options: ConstructorParameters<typeof CodexRpcClient>[0]) => ({
    initialize: async () => {}, close: async () => {},
    call: async (method: string) => {
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'root' } };
      if (method === 'turn/start') {
        options.onEvent?.({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'native', status: 'inProgress' } } });
        options.onEvent?.({ method: 'item/tool/call', params: { threadId: 'root', turnId: 'native', callId: 'call_plan', tool: 'rat_things_plan_update', arguments: {
          expected_revision: 0, items: [{ id: 'report', text: 'Save the report', state: 'working', source_message_ids: ['message_1'], result_links: [{ kind: 'output', path: outputPath }] }],
        } } });
        if (localRpc.complete) options.onEvent?.({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'native', status: 'completed' } } });
        return { turn: { id: 'native' } };
      }
      return {};
    },
  }) }));

const owner = 'owner';
const session = { id: 'sess_artifact', environment: { type: 'openai_hosted', id: 'env_artifact' } } as AgentSession;
const outputPath = '/workspace/outputs/report.txt';
const outputBytes = Buffer.from('captured output\n');
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

function planState(): SessionRuntimeState {
  return {
    sessionId: session.id, agentId: 'agent', rootThreadId: 'root', subagents: [],
    turns: [{ threadId: 'root', nativeTurnId: 'native', turn: { id: 'turn_artifact', created_at: 1, completed_at: null, status: 'waiting' } as never, items: [] }],
    requiredActions: [{ type: 'function_call', turn_id: 'turn_artifact', call_id: 'call_plan', name: 'rat_things_plan_update', arguments: {
      expected_revision: 0,
      items: [{ id: 'report', text: 'Save the report', state: 'working', source_message_ids: ['message_1'], result_links: [{ kind: 'output', path: outputPath }] }],
    } }],
  };
}

it('captures local managed output immutably, records the exact Plan result version, and reads it after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-local-session-artifact-'));
  const store = new MemoryAgentsStore();
  const bytes = new Map([[outputPath, outputBytes]]);
  const fileCalls: unknown[] = [];
  const capture = new SessionArtifactCapture({ ownerId: owner,
    launch: { sessionId: session.id, turnId: '', agent: {} as SessionLaunch['agent'], environment: session.environment, input: [], planTool: true } as SessionLaunch,
    files: { execute: async operation => {
      fileCalls.push(operation);
      if (operation.operation === 'list') return [...bytes].map(([path, content]) => ({ path, size_bytes: content.length }));
      if (operation.operation === 'read') {
        const content = bytes.get(operation.path)!;
        return { data: content.subarray(operation.offset, operation.offset + operation.length).toString('base64'), size_bytes: content.length, version: digest(content) };
      }
      throw new Error('Unexpected managed file operation');
    } },
    artifacts: new LocalSessionArtifactStore(store, owner, session.id),
  });

  try {
    const captured = await capture.capture(planState());
    const binding = captured.turns[0]!;
    const saved = binding.artifacts![0]!;
    expect(saved.artifact).toMatchObject({ session_id: session.id, turn_id: 'turn_artifact', path: outputPath, size_bytes: outputBytes.length });
    expect(binding.planArtifactCalls?.call_plan).toEqual([{ path: outputPath, artifact_id: saved.artifact.id, version_sha256: saved.content.sha256 }]);
    expect(saved.content.sha256).toBe(digest(outputBytes));
    expect(fileCalls.map(call => (call as { operation: string }).operation)).toEqual(['list', 'read']);
    bytes.set(outputPath, Buffer.from('live workspace changed\n'));

    const contentStore = new LocalSessionArtifactStore(store, owner, session.id);
    const stored = saved;
    const sessionResource = { ownerId: owner, collection: 'sessions', id: session.id, createdAt: 1, revision: 1,
      value: { session, turns: [], receipts: {}, deletedArtifacts: [] } as unknown as SessionState };
    await store.put(sessionResource, 0);
    await store.put({ ownerId: owner, collection: 'local_runtime', id: session.id, createdAt: 1, revision: 1, value: captured }, 0);
    const restarted = new LocalSessionExecution({ store, directory, maxSessions: 1 });
    const artifacts = await restarted.artifacts(owner, session, 'turn_artifact');
    expect(artifacts).toEqual([stored]);
    const stream = await restarted.artifactContent(owner, session, stored);
    const reader = stream.getReader();
    const result = await reader.read();
    expect(Buffer.from(result.value!)).toEqual(outputBytes);
    expect(await reader.read()).toMatchObject({ done: true });
    await expect(restarted.artifactContent(owner, session, { ...stored, content: { ...stored.content, key: 'foreign' } }))
      .rejects.toMatchObject({ code: 'resource_not_found' });
    await restarted.shutdown();
    await contentStore.deleteSession();
    await expect(new LocalSessionArtifactStore(store, owner, session.id).getBytes(saved.content)).rejects.toThrow('Local artifact content is unavailable');
    await expect(new LocalSessionArtifactStore(store, 'other-owner', session.id).getBytes(saved.content)).rejects.toThrow('Local artifact content is unavailable');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps artifact keys immutable and removes only the deleted Session’s encrypted records', async () => {
  const store = new MemoryAgentsStore();
  const artifacts = new LocalSessionArtifactStore(store, owner, 'sess_delete');
  const target = `owners/${createHash('sha256').update(owner).digest('hex').slice(0, 32)}/sessions/sess_delete/turn/artifacts/one`;
  const other = `owners/${createHash('sha256').update(owner).digest('hex').slice(0, 32)}/sessions/sess_keep/turn/artifacts/two`;
  const targetReference = await artifacts.putBytes(target, outputBytes);
  const otherStore = new LocalSessionArtifactStore(store, owner, 'sess_keep');
  const otherReference = await otherStore.putBytes(other, outputBytes);
  await expect(artifacts.putBytes(target, Buffer.from('changed'))).rejects.toThrow('already bound to different bytes');
  await artifacts.deleteSession();
  await expect(artifacts.getBytes(targetReference)).rejects.toThrow('content is unavailable');
  expect(await otherStore.getBytes(otherReference)).toEqual(outputBytes);
});

it('captures Plan output through LocalSessionExecution before publishing the action snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-local-session-execution-artifact-'));
  const store = new MemoryAgentsStore();
  const managedFilesStarted = (() => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; })();
  let releaseFiles!: () => void;
  const fileGate = new Promise<void>(resolve => { releaseFiles = resolve; });
  const managed = {
    launch: async (_owner: string, _session: AgentSession, base: Parameters<LocalManagedEnvironment['launch']>[2], _history: AgentSession['required_actions'], planTool?: true) => {
      localRpc.planTools.push(Boolean(planTool)); return base;
    },
    admitTurn: async () => {}, close: async () => {}, shutdown: async () => {},
    files: async (_owner: string, _sessionId: string, operation: import('../../src/core/environment-file-ports.js').EnvironmentFileOperation) => {
      localRpc.fileOperations.push(operation.operation);
      if (operation.operation === 'list') {
        managedFilesStarted.resolve(); await fileGate;
        return [{ path: outputPath, size_bytes: outputBytes.length }];
      }
      if (operation.operation === 'read') return { data: outputBytes.toString('base64'), size_bytes: outputBytes.length, version: digest(outputBytes) };
      throw new Error('Unexpected managed file operation');
    },
  } as unknown as LocalManagedEnvironment;
  const session = { id: 'sess_local_capture', object: 'agent.session', agent: { id: 'agent', model: 'fixture', tools: [] },
    environment: { type: 'openai_hosted', id: 'env_artifact', capability_directories: [], network: { access: 'disabled', allowed_domains: [] } },
    created_at: 1, last_active_at: 1, error: null, metadata: {}, status: 'idle', required_actions: [], usage: null, vault_ids: [] } as unknown as AgentSession;
  const binding = { turn: { id: 'turn_local_capture', created_at: 1, completed_at: null, status: 'queued', error: null, usage: null }, input: [] } as never;
  await store.put({ ownerId: owner, collection: 'sessions', id: session.id, createdAt: 1, revision: 1,
    value: { planToolAdmitted: true, session, turns: [], receipts: {}, deletedArtifacts: [] } as unknown as SessionState }, 0);
  const execution = new LocalSessionExecution({ store, directory, maxSessions: 1, managed,
    hostCodex: () => ({ binary: '/fixture/codex', environment: {} }) });
  localRpc.planTools.length = 0; localRpc.fileOperations.length = 0;
  localRpc.complete = false;

  try {
    const starting = execution.start(owner, session, binding);
    await managedFilesStarted.promise;
    const beforeCapture = await store.get<SessionRuntimeState>(owner, 'local_runtime', session.id);
    expect(beforeCapture?.value.requiredActions).toEqual([]);
    let artifactReadFinished = false;
    const artifactRead = execution.artifacts(owner, session, 'turn_local_capture').then(value => { artifactReadFinished = true; return value; });
    await Promise.resolve();
    expect(artifactReadFinished).toBe(false);
    releaseFiles();
    await starting;
    const saved = await artifactRead;
    expect(localRpc.planTools).toEqual([true]);
    expect(localRpc.fileOperations).toEqual(['list', 'read']);
    expect(saved).toHaveLength(1);
    const persisted = await store.get<SessionRuntimeState>(owner, 'local_runtime', session.id);
    expect(persisted?.value.turns[0]?.planArtifactCalls?.call_plan).toEqual([
      { path: outputPath, artifact_id: saved[0]!.artifact.id, version_sha256: digest(outputBytes) },
    ]);
    expect(persisted?.value.turns[0]?.artifacts).toEqual(saved);
  } finally {
    releaseFiles(); await execution.shutdown(); await rm(directory, { recursive: true, force: true });
    localRpc.planTools.length = 0; localRpc.fileOperations.length = 0;
    localRpc.complete = false;
  }
});

it('fails a Turn when terminal artifact capture fails without publishing completion or poisoning other Sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-local-session-artifact-failure-'));
  const store = new MemoryAgentsStore();
  let primaryLists = 0;
  const managed = { launch: async (_owner: string, _session: AgentSession, base: Parameters<LocalManagedEnvironment['launch']>[2]) => base,
    admitTurn: async () => {}, close: async () => {}, shutdown: async () => {},
    files: async (_owner: string, sessionId: string, operation: import('../../src/core/environment-file-ports.js').EnvironmentFileOperation) => {
      if (operation.operation === 'list' && sessionId === session.id) {
        primaryLists++;
        if (primaryLists === 1) return [];
        if (primaryLists === 2) throw new Error('private host file diagnostic');
        return [{ path: outputPath, size_bytes: outputBytes.length }];
      }
      if (operation.operation === 'list') return [];
      if (operation.operation === 'read') return { data: outputBytes.toString('base64'), size_bytes: outputBytes.length, version: digest(outputBytes) };
      throw new Error('Unexpected managed file operation');
    },
  } as unknown as LocalManagedEnvironment;
  const session = { id: 'sess_capture_failure', object: 'agent.session', agent: { id: 'agent', model: 'fixture', tools: [] },
    environment: { type: 'openai_hosted', id: 'env_artifact', capability_directories: [], network: { access: 'disabled', allowed_domains: [] } },
    created_at: 1, last_active_at: 1, error: null, metadata: {}, status: 'idle', required_actions: [], usage: null, vault_ids: [] } as unknown as AgentSession;
  const binding = { turn: { id: 'turn_capture_failure', object: 'agent.session.turn', session_id: session.id, agent_id: 'agent', subagent_id: null,
    created_at: 1, started_at: null, completed_at: null, status: 'queued', error: null, usage: null }, input: [] } as SessionTurnBinding;
  await store.put({ ownerId: owner, collection: 'sessions', id: session.id, createdAt: 1, revision: 1,
    value: { planToolAdmitted: true, session, turns: [], receipts: {}, deletedArtifacts: [] } as unknown as SessionState }, 0);
  const previousArtifact = { artifact: { id: 'art_previous', object: 'agent.session.artifact' as const, session_id: session.id,
    turn_id: 'turn_previous', environment_id: 'env_artifact', created_at: 3, path: '/workspace/outputs/previous.txt', size_bytes: 8 },
    content: { bucket: 'local-session-artifacts', key: 'previous', sha256: 'a'.repeat(64) } };
  const previous = { ...initialSessionRuntime(session.id, 'agent', 'root'), turns: [{ threadId: 'root', nativeTurnId: 'native_previous',
    turn: { id: 'turn_previous', created_at: 1, completed_at: 3, status: 'completed', error: null, usage: null } as never,
    items: [], artifacts: [previousArtifact], artifactsFinal: true }] };
  await store.put({ ownerId: owner, collection: 'local_runtime', id: session.id, createdAt: 1, revision: 1, value: previous }, 0);
  const execution = new LocalSessionExecution({ store, directory, maxSessions: 2, managed,
    hostCodex: () => ({ binary: '/fixture/codex', environment: {} }) });
  localRpc.complete = true;
  localRpc.planTools.length = 0;
  try {
    await execution.start(owner, session, binding);
    await vi.waitFor(async () => {
      const saved = await store.get<SessionRuntimeState>(owner, 'local_runtime', session.id);
      expect(saved?.value.turns.find(turn => turn.turn.id === binding.turn.id)?.turn).toMatchObject({ status: 'failed', error: { code: 'connection_failed' } });
    });
    localRpc.complete = false;
    const otherSession = { ...session, id: 'sess_capture_other' };
    await store.put({ ownerId: owner, collection: 'sessions', id: otherSession.id, createdAt: 1, revision: 1,
      value: { planToolAdmitted: true, session: otherSession, turns: [], receipts: {}, deletedArtifacts: [] } as unknown as SessionState }, 0);
    await execution.start(owner, otherSession, { ...binding, turn: { ...binding.turn, id: 'turn_capture_other' } });
    expect(await store.get<SessionRuntimeState>(owner, 'local_runtime', otherSession.id)).toBeDefined();
    await execution.shutdown();
    const failed = await store.get<SessionRuntimeState>(owner, 'local_runtime', session.id);
    expect(failed?.value.turns.find(turn => turn.turn.id === binding.turn.id)?.turn).toMatchObject({ status: 'failed', error: { code: 'connection_failed' } });
    expect(failed?.value.turns.find(turn => turn.turn.id === binding.turn.id)?.artifactsFinal).toBe(true);
    expect(failed?.value.turns.find(turn => turn.turn.id === 'turn_previous')).toMatchObject({ turn: { status: 'completed' }, artifacts: [previousArtifact], artifactsFinal: true });
    expect(JSON.stringify(failed?.value)).not.toContain('private host file diagnostic');
    expect(await store.get<SessionRuntimeState>(owner, 'local_runtime', otherSession.id)).toBeDefined();
    expect(primaryLists).toBe(2);
  } finally {
    localRpc.complete = false;
    await execution.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
