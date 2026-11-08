import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import type { SessionExecution, SessionTurnObservation } from '../../src/core/session-ports.js';
import type { PortableFile } from '../../src/domain/workspace-transfer.js';

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function generatedWorkspace(mib: number) {
  if (![1, 10, 40].includes(mib)) throw new Error('Supported fixture sizes are 1, 10, and 40 MiB.');
  const bytes = randomBytes(mib * 1024 * 1024);
  return { files: [{ path: 'payload.bin', data: bytes.toString('base64'), mode: 0o600 }] satisfies PortableFile[],
    evidence: { path: 'payload.bin', bytes: bytes.length, sha256: sha256(bytes), generation: 'crypto.randomBytes before the transfer timer' } };
}

/** Real local services/storage; execution and workspace export are explicit fixtures. */
export async function createSource(model: string) {
  const directory = await mkdtemp(join(tmpdir(), 'rat-share-performance-'));
  const sqlite = new SqliteAgentsStore(directory);
  sqlite.acquireServerLease();
  const store = new SessionEventStore(sqlite);
  const owner = 'share-performance-fixture';
  const observations = new Map<string, SessionTurnObservation>();
  let executorClosed = false;
  const templates = new EnvironmentTemplateService({ store });
  const unsupported = async (): Promise<never> => { throw new Error('This source fixture does not use environment credentials or native file operations.'); };
  const environments = new EnvironmentService({ store, templates,
     managedFiles: unsupported });
  const agents = new AgentService({ store });
  const execution: SessionExecution = {
    prepare: (owner, id, environment, _agent, _vaults, _tools, resume, _placement, runtime) => environments.prepare(owner, id, environment, resume, runtime),
    start: async (_owner, _session, binding) => {
      if (executorClosed) throw new Error('Fixture executor is closed.');
      const seconds = Math.floor(Date.now() / 1000);
      observations.set(binding.turn.id, { turn: { ...binding.turn, status: 'completed', started_at: seconds, completed_at: seconds, usage: null }, requiredActions: [] });
    },
    steer: unsupported, toolResult: unsupported,
    cancel: async (_owner, _session, id) => { const old = observations.get(id); if (old) observations.set(id, { ...old, turn: { ...old.turn, status: 'cancelled' } }); },
    observe: async (_owner, _session, turn) => observations.get(turn.id) ?? { turn, requiredActions: [] },
    items: async (_owner, _session, turnId) => [{ id: `fixture_${turnId}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', turn_id: turnId,
      content: [{ type: 'output_text', text: 'Deterministic source fixture completed; no model was invoked.' }] }],
    artifacts: async () => [], artifactContent: unsupported,
    close: async () => { executorClosed = true; },
  };
  const sessions = new SessionService({ store, agents, execution });
  const close = async () => { await sqlite.drainServerLease(); sqlite.close(true); await rm(directory, { recursive: true, force: true }); };
  try {
    const template = await templates.create(owner, { name: 'Share performance source', network: { access: 'disabled' }, env: {} });
    const agent = await agents.create(owner, { name: 'Share performance source', model, tools: [] });
    const session = await sessions.create(owner, { agent_id: agent.id, environment: { type: 'openai_hosted', environment_template_id: template.id }, input: 'Synthetic completed source history for transfer measurement.' });
    await sqlite.runWhileServerLeaseHeld(() => sessions.dispatch(owner, session.id));
    await sessions.completeReadyTurns(owner, session.id);
    const history = await sessions.activity(owner, session.id);
    if (history.turns.length !== 1 || history.turns[0]?.status !== 'completed' || history.inputs.some(input => input.status !== 'dispatched')) throw new Error('Source fixture did not reach a completed boundary.');
    return { owner, directory, store, sessions, agents, environments, session, agent, history, close, executorClosed: () => executorClosed };
  } catch (error) {
    try { await close(); } catch { throw new Error('source_setup_cleanup_unconfirmed'); }
    throw error;
  }
}

/** Only safe numeric telemetry from this local service is retained. */
export function shareMetric(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.event !== 'rat.performance' || record.Operation !== 'share-transfer') return undefined;
  const names = ['RequestDuration', 'ShareQuiesceDuration', 'ShareSnapshotDuration', 'ShareUploadDuration', 'ShareStageDuration', 'ShareReleaseDuration', 'ShareActivateDuration', 'ShareArchiveBytes', 'ShareWorkspaceBytes'];
  const metrics = Object.fromEntries(names.flatMap(name => typeof record[name] === 'number' && Number.isFinite(record[name]) && record[name] >= 0 ? [[name, record[name]]] : []));
  return { outcome: ['success', 'aborted', 'error'].includes(String(record.Outcome)) ? String(record.Outcome) : 'unclassified', metrics };
}
