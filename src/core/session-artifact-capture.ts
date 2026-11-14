import { createHash } from 'node:crypto';
import type { SessionLaunch } from '../domain/session-execution.js';
import type { EnvironmentFileOperations } from './environment-file-ports.js';
import type { ArtifactStore } from './ports.js';
import type { SavedSessionArtifact } from './session-ports.js';
import type { NativeTurnBinding, SessionRuntimeState } from './session-runtime-planning.js';
import { terminalTurn } from './session-planning.js';
import { workspacePath, decodeBase64 } from '../domain/environment-planning.js';
import { parseSessionPlanUpdate, SESSION_PLAN_TOOL_NAME } from '../domain/session-plan.js';

/** Copy output bytes before publishing terminal turns. Saved objects never follow live files. */
export class SessionArtifactCapture {
  private readonly saved = new Map<string, Pick<NativeTurnBinding, 'artifacts' | 'planArtifactCalls' | 'artifactsFinal'>>();
  public constructor(private readonly options: {
    ownerId: string; launch: SessionLaunch; files?: EnvironmentFileOperations;
    artifacts: Pick<ArtifactStore, 'putBytes'>;
  }) {}

  public async capture(state: SessionRuntimeState): Promise<SessionRuntimeState> {
    const turns: NativeTurnBinding[] = [];
    for (const binding of state.turns) {
      let captured = { ...binding, ...this.saved.get(binding.turn.id) };
      if (binding.threadId === state.rootThreadId && this.options.launch.planTool) {
        for (const request of planOutputRequests(state, binding.turn.id)) {
          if (captured.planArtifactCalls?.[request.callId]) continue;
          // A failed preview is a tool validation error, not a failed agent Turn.
          const outputs = await this.outputs(binding, request.paths).catch(() => []);
          captured = { ...captured, artifacts: uniqueArtifacts([...(captured.artifacts ?? []), ...outputs]),
            planArtifactCalls: { ...captured.planArtifactCalls, [request.callId]: outputs.map(({ artifact, content }) => ({
              path: artifact.path, artifact_id: artifact.id, version_sha256: content.sha256,
            })) } };
        }
      }
      const complete = captured.artifactsFinal || captured.artifacts !== undefined && !captured.planArtifactCalls;
      if (terminalTurn(binding.turn) && !complete) {
        captured = { ...captured, artifacts: uniqueArtifacts([...(captured.artifacts ?? []), ...await this.outputs(binding)]), artifactsFinal: true };
      }
      const { artifacts, planArtifactCalls, artifactsFinal } = captured;
      this.saved.set(binding.turn.id, { ...(artifacts ? { artifacts } : {}), ...(planArtifactCalls ? { planArtifactCalls } : {}), ...(artifactsFinal ? { artifactsFinal } : {}) });
      turns.push(captured);
    }
    return { ...state, turns };
  }

  private async outputs(binding: NativeTurnBinding, paths?: readonly string[]): Promise<SavedSessionArtifact[]> {
    const { launch, files } = this.options;
    if (launch.environment.type !== 'openai_hosted') return [];
    if (!files) throw new Error('Environment output capture is not configured');
    const listed = await files.execute({ operation: 'list', path: '/workspace/outputs', missingOk: true });
    if (!Array.isArray(listed)) throw new Error('Invalid output directory');
    const entries = paths ? listed.filter(entry => record(entry) && paths.includes(String(entry.path))) : listed;
    if (paths && entries.length !== paths.length) throw new Error('Requested output does not exist');
    if (entries.reduce((total, entry) => total + (record(entry) ? Number(entry.size_bytes) : Infinity), 0) > 500 * 1024 * 1024) throw new Error('Published outputs exceed 500 MiB');
    const saved: SavedSessionArtifact[] = [];
    for (const entry of entries) {
      if (!record(entry) || typeof entry.path !== 'string' || !entry.path.startsWith('/workspace/outputs/') || !Number.isSafeInteger(entry.size_bytes) || Number(entry.size_bytes) < 0 || Number(entry.size_bytes) > 200 * 1024 * 1024) throw new Error('Invalid output file');
      workspacePath(entry.path, 'path');
      const chunks: Buffer[] = [];
      let offset = 0;
      let version: unknown;
      do {
        const result = await files.execute({ operation: 'read', path: entry.path, offset, length: 1024 * 1024 });
        if (!record(result) || typeof result.data !== 'string' || typeof result.version !== 'string' || result.size_bytes !== entry.size_bytes || version !== undefined && result.version !== version) throw new Error('Output file changed while it was being saved');
        version = result.version;
        const bytes = Buffer.from(decodeBase64(result.data, 'output.data'));
        if (bytes.length > 1024 * 1024 || !bytes.length && offset < Number(entry.size_bytes) || offset + bytes.length > Number(entry.size_bytes)) throw new Error('Invalid output file range');
        chunks.push(bytes); offset += bytes.length;
      } while (offset < Number(entry.size_bytes));
      const bytes = Buffer.concat(chunks);
      const id = `art_${hash(`${binding.turn.id}:${entry.path}:${hash(bytes)}`)}`;
      const content = await this.options.artifacts.putBytes(`owners/${hash(this.options.ownerId).slice(0, 32)}/sessions/${launch.sessionId}/${binding.turn.id}/artifacts/${id}`, bytes, 'application/octet-stream');
      saved.push({ content, artifact: { id, object: 'agent.session.artifact', session_id: launch.sessionId,
        turn_id: binding.turn.id, environment_id: launch.environment.id, path: entry.path, size_bytes: bytes.length,
        created_at: binding.turn.completed_at ?? binding.turn.created_at,
      } });
    }
    return saved;
  }
}

function uniqueArtifacts(values: SavedSessionArtifact[]): SavedSessionArtifact[] {
  return [...new Map(values.map(value => [value.artifact.id, value])).values()];
}

function planOutputRequests(state: SessionRuntimeState, turnId: string): Array<{ callId: string; paths: string[] }> {
  return state.requiredActions.flatMap(action => {
    if (action.type !== 'function_call' || action.turn_id !== turnId || action.name !== SESSION_PLAN_TOOL_NAME) return [];
    try {
      const input = parseSessionPlanUpdate(action.arguments);
      const paths = [...new Set(input.items.flatMap(item => item.result_links.flatMap(link => link.kind === 'output' ? [workspacePath(link.path, 'path')] : [])))];
      return paths.length ? [{ callId: action.call_id, paths }] : [];
    } catch { return []; }
  });
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
