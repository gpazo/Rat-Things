import { createHash } from 'node:crypto';
import type { SessionLaunch } from '../domain/session-execution.js';
import type { EnvironmentFileOperations } from './environment-file-ports.js';
import type { ArtifactStore } from './ports.js';
import type { SavedSessionArtifact } from './session-ports.js';
import type { NativeTurnBinding, SessionRuntimeState } from './session-runtime-planning.js';
import { terminalTurn } from './session-planning.js';
import { workspacePath, decodeBase64 } from '../domain/environment-planning.js';

/** Copy output bytes before publishing terminal turns. Saved objects never follow live files. */
export class SessionArtifactCapture {
  private readonly saved = new Map<string, SavedSessionArtifact[]>();
  public constructor(private readonly options: {
    ownerId: string; launch: SessionLaunch; files?: EnvironmentFileOperations;
    artifacts: Pick<ArtifactStore, 'putBytes'>;
  }) {}

  public async capture(state: SessionRuntimeState): Promise<SessionRuntimeState> {
    const turns: NativeTurnBinding[] = [];
    for (const binding of state.turns) {
      if (!terminalTurn(binding.turn)) { turns.push(binding); continue; }
      const artifacts = binding.artifacts ?? this.saved.get(binding.turn.id) ?? await this.outputs(binding);
      this.saved.set(binding.turn.id, artifacts);
      turns.push({ ...binding, artifacts });
    }
    return { ...state, turns };
  }

  private async outputs(binding: NativeTurnBinding): Promise<SavedSessionArtifact[]> {
    const { launch, files } = this.options;
    if (launch.environment.type !== 'openai_hosted') return [];
    if (!files) throw new Error('Environment output capture is not configured');
    const entries = await files.execute(launch.environment.id, '', { operation: 'list', path: '/workspace/outputs', missingOk: true });
    if (!Array.isArray(entries)) throw new Error('Invalid output directory');
    if (entries.reduce((total, entry) => total + (record(entry) ? Number(entry.size_bytes) : Infinity), 0) > 500 * 1024 * 1024) throw new Error('Published outputs exceed 500 MiB');
    const saved: SavedSessionArtifact[] = [];
    for (const entry of entries) {
      if (!record(entry) || typeof entry.path !== 'string' || !entry.path.startsWith('/workspace/outputs/') || !Number.isSafeInteger(entry.size_bytes) || Number(entry.size_bytes) < 0 || Number(entry.size_bytes) > 200 * 1024 * 1024) throw new Error('Invalid output file');
      workspacePath(entry.path, 'path');
      const chunks: Buffer[] = [];
      let offset = 0;
      let version: unknown;
      do {
        const result = await files.execute(launch.environment.id, '', { operation: 'read', path: entry.path, offset, length: 1024 * 1024 });
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

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
