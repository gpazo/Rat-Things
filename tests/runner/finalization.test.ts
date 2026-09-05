import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactReference, RunRecord, RunResult } from '../../src/domain/contracts.js';

const fixture = vi.hoisted(() => ({ store: {} as any, artifacts: {} as any, execute: vi.fn() }));
vi.mock('../../src/adapters/aws-runtime.js', () => ({
  createAwsClients: () => ({}),
  DynamoRunStore: function () { return fixture.store; },
  S3ArtifactStore: function () { return fixture.artifacts; },
  CachedSecretReader: class {},
  S3PublicationGrantStore: class {},
  S3PublicationObjectStore: class {},
}));
vi.mock('../../src/runner/agent-driver.js', () => ({
  driverFor: () => ({ name: 'mock', execute: fixture.execute }),
}));
vi.mock('../../src/runner/workspace.js', () => ({
  prepareWorkspace: async () => {}, collectWorkspacePatch: async () => undefined,
}));
import { runAgentWorker } from '../../src/runner/main.js';
import { restoreArtifactCatalog } from '../../src/runner/artifacts.js';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('worker terminal evidence', () => {
  it.each(['interrupted', 'failed', 'completed'] as const)(
    'publishes files and final output for a %s turn before clearing scratch', async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), 'rat-finalization-'));
      const bytes = new Map<string, Uint8Array>();
      const execution = { backend: 'microvm' as const, id: 'microvm-test', generation: 'generation-1' };
      let record = {
        runId: 'run-test', ownerId: 'owner-test', status: 'dispatching', execution,
        conversation: { conversationId: 'conversation-test' },
      } as RunRecord;
      fixture.store = {
        get: vi.fn(async () => record),
        startExecution: vi.fn(async () => (record = { ...record, status: 'running' })),
        heartbeatExecution: vi.fn(async () => true),
        finishExecution: vi.fn(async (_id, _execution, status, result) => {
          record = { ...record, status, result };
          return true;
        }),
        failExecution: vi.fn(),
      };
      fixture.artifacts = {
        getJson: async () => ({ version: '1', prompt: 'Write a partial report', agent: {driver: 'mock'} }),
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
      fixture.execute.mockImplementation(async (_request, workspace) => {
        await writeFile(join(workspace, '.rat-things/artifacts/partial.txt'), 'saved before stopping');
        if (outcome === 'failed') throw new Error('controlled runtime failure');
        return { outcome, fullText: outcome === 'completed' ? 'Done' : '', exitCode: 0, durationMs: 10, events: Buffer.from(''), threadId: 'native-thread' };
      });
      for (const [key, value] of Object.entries({
        RUN_ID: 'run-test', RUNS_TABLE_NAME: 'runs', ARTIFACT_BUCKET: 'artifacts',
        RUN_INPUT_BUCKET: 'artifacts', RUN_INPUT_KEY: 'input', MICROVM_ID: 'microvm-test',
        EXECUTION_GENERATION: 'generation-1', PERSISTENT_SESSION: 'true',
        WORKSPACE_ROOT: root, CODEX_HOME: join(root, 'codex'), AGENT_PUBLICATION_ENABLED: 'false',
      })) vi.stubEnv(key, value);
      try {
        await runAgentWorker();
        const result = record.result as RunResult;
        expect(record.status).toBe(outcome === 'interrupted' ? 'cancelled' : outcome === 'completed' ? 'succeeded' : 'failed');
        expect(result.artifacts).toHaveLength(1);
        const replacement = join(root, 'replacement');
        await restoreArtifactCatalog(replacement, { version: '1', files: result.artifacts! }, fixture.artifacts);
        expect(await readFile(join(replacement, '.rat-things/artifacts/partial.txt'), 'utf8')).toBe('saved before stopping');
        expect(result.preview).toContain(outcome === 'interrupted' ? 'Stopped by you' : outcome === 'failed' ? 'controlled runtime failure' : 'Done');
        expect(fixture.store.finishExecution.mock.calls[0].slice(0, 4)).toEqual(['run-test', execution, record.status, result]);
      } finally { await rm(root, {recursive: true, force: true}); }
    },
  );
});
