import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactReference, RunRecord, RunResult } from '../../src/domain/contracts.js';
import type { AgentDriverControl } from '../../src/runner/agent-driver.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';

const fixture = vi.hoisted(() => ({ store: {} as any, agents: {} as any, artifacts: {} as any, execute: vi.fn(), driverSelection: vi.fn() }));
vi.mock('../../src/adapters/dynamo-agents-store.js', () => ({
  DynamoAgentsStore: function () { return fixture.agents; },
}));
vi.mock('../../src/adapters/aws-runtime.js', () => ({
  createAwsClients: () => ({}),
  DynamoRunStore: function () { return fixture.store; },
  S3ArtifactStore: function () { return fixture.artifacts; },
  CachedSecretReader: class {},
  S3PublicationGrantStore: class {},
  S3PublicationObjectStore: class {},
}));
vi.mock('../../src/runner/agent-driver.js', () => ({
  driverFor: (name: string) => { fixture.driverSelection(name); return { name: 'mock', execute: fixture.execute }; },
}));
vi.mock('../../src/runner/workspace.js', () => ({
  prepareWorkspace: async () => {}, collectWorkspacePatch: async () => undefined,
}));
import { runAgentWorker } from '../../src/runner/main.js';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('worker terminal evidence', () => {
  it.each(['interrupted', 'failed', 'completed'] as const)(
    'flushes Session history before publishing private execution evidence for a %s outcome', async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), 'rat-finalization-'));
      const bytes = new Map<string, Uint8Array>();
      const execution = { backend: 'microvm' as const, id: 'microvm-test', generation: 'generation-1' };
      const ownerHash = createHash('sha256').update('owner-test').digest('hex').slice(0, 32);
      const launch = { sessionId: 'sess_test', turnId: 'turn_test', input: [], environment: { type: 'none' }, agent: sessionAgent({ model: 'test' }, 'agent_test', 100) };
      fixture.agents = new MemoryAgentsStore();
      const runtimes = new SessionRuntimeStore(fixture.agents);
      await runtimes.claim('owner-test', 'sess_test', 'run-test', 100);
      const snapshot = initialSessionRuntime('sess_test', 'agent_test', 'native-thread');
      let record = {
        runId: 'run-test', ownerId: 'owner-test', status: 'dispatching', execution,
        ownerCreated: 'owner-test#now#run-test', createdAt: 'now', updatedAt: 'now', expiresAt: 1,
        requestHash: 'a'.repeat(64), input: { bucket: 'artifacts', key: 'input', sha256: 'a'.repeat(64) }, sourceKind: 'api',
        agentsSession: { sessionId: 'sess_test', turnId: 'turn_test', launch: { bucket: 'artifacts', key: `owners/${ownerHash}/sessions/sess_test/launch.json`, sha256: 'a'.repeat(64) } },
      } as RunRecord;
      fixture.store = {
        get: vi.fn(async () => record),
        startExecution: vi.fn(async () => (record = { ...record, status: 'running' })),
        heartbeatExecution: vi.fn(async () => true),
        finishExecution: vi.fn(async (_id, _execution, status, result) => {
          expect((await runtimes.get('owner-test', 'sess_test'))?.value.snapshot).toEqual(snapshot);
          record = { ...record, status, result };
          return true;
        }),
        failExecution: vi.fn(),
      };
      fixture.artifacts = {
        getJson: async (reference: ArtifactReference) => reference.key.endsWith('launch.json') ? launch : ({ version: '1', prompt: 'Write a partial report', agent: {driver: 'mock'} }),
        putBytes: async (key: string, value: Uint8Array): Promise<ArtifactReference> => {
          bytes.set(key, Uint8Array.from(value));
          return { bucket: 'artifacts', key, sha256: createHash('sha256').update(value).digest('hex') };
        },
        putStream: async (key: string, stream: AsyncIterable<Uint8Array>) => {
          const chunks = [];
          for await (const value of stream) chunks.push(value);
          return fixture.artifacts.putBytes(key, Buffer.concat(chunks));
        },
        getStream: async (reference: ArtifactReference) => (async function* () { yield bytes.get(reference.key)!; })(),
      };
      fixture.execute.mockImplementation(async (_request, _workspace, _timeout, _signal, control: AgentDriverControl) => {
        control.sessionRuntime!.changed(snapshot);
        if (outcome === 'failed') throw new Error('controlled runtime failure');
        return { outcome, fullText: outcome === 'completed' ? 'Done' : '', exitCode: 0, durationMs: 10, events: Buffer.from(''), threadId: 'native-thread' };
      });
      for (const [key, value] of Object.entries({
        RUN_ID: 'run-test', RUNS_TABLE_NAME: 'runs', ARTIFACT_BUCKET: 'artifacts',
        RUN_INPUT_BUCKET: 'artifacts', RUN_INPUT_KEY: 'input', MICROVM_ID: 'microvm-test',
        EXECUTION_GENERATION: 'generation-1', PERSISTENT_SESSION: 'false',
        WORKSPACE_ROOT: root, CODEX_HOME: join(root, 'codex'),
        AGENTS_TABLE_NAME: 'agents', DEFINITION_BUCKET: 'definitions',
      })) vi.stubEnv(key, value);
      try {
        await runAgentWorker();
        expect(fixture.driverSelection).toHaveBeenCalledExactlyOnceWith('codex');
        const result = record.result as RunResult;
        expect(record.status).toBe(outcome === 'interrupted' ? 'cancelled' : outcome === 'completed' ? 'succeeded' : 'failed');
        expect(Buffer.from(bytes.get(result.output.key)!).toString()).toBe(result.preview);
        expect(result.preview).toContain(outcome === 'interrupted' ? 'Stopped by you' : outcome === 'failed' ? 'controlled runtime failure' : 'Done');
        expect(fixture.store.finishExecution.mock.calls[0].slice(0, 4)).toEqual(['run-test', execution, record.status, result]);
      } finally { await rm(root, {recursive: true, force: true}); }
    },
  );
});
