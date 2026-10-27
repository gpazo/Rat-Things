import { canonicalJson, sha256Hex } from './json.js';

/** Evidence of an observed cold continuation, never an upstream flush acknowledgement. */
export interface NativeCheckpointEvidence {
  kind: 'codex-cold-native';
  threadIds: string[];
  historyDigest: string;
  /** Separately persisted public items, including coordination payloads absent from native read. */
  hostJournalDigest: string;
  historyModes: Array<'legacy' | 'paginated'>;
}
export interface NativeCheckpointManifest {
  rootThreadId: string;
  hostJournalDigest: string;
  /** Parent-before-child order. Runtime-only fields are excluded explicitly below. */
  threads: Record<string, unknown>[];
}

export function nativeThreadHistory(value: unknown): Record<string, unknown> {
  if (!record(value) || typeof value.id !== 'string' || !value.id || value.ephemeral !== false
    || !['legacy', 'paginated'].includes(String(value.historyMode)) || !Array.isArray(value.turns)
    || !value.turns.length || value.turns.length > 10_000) throw new Error('Native checkpoint history is unavailable or unsupported');
  const ids = new Set<string>();
  for (const turn of value.turns) {
    if (!record(turn) || typeof turn.id !== 'string' || !turn.id || ids.has(turn.id)
      || turn.status !== 'completed' || !Array.isArray(turn.items)) throw new Error('Native checkpoint requires complete unique successful turns');
    ids.add(turn.id);
  }
  if (JSON.stringify(value).length > 32 * 1024 * 1024) throw new Error('Native checkpoint history exceeds its bound');
  // sessionId depends on whether the tree is loaded. Callers validate it separately;
  // updatedAt/status/environments/canAcceptDirectInput describe the current process.
  const fields = ['id', 'parentThreadId', 'forkedFromId', 'ephemeral', 'historyMode', 'modelProvider', 'model',
    'reasoningEffort', 'createdAt', 'cwd', 'cliVersion', 'source', 'agentNickname', 'agentRole', 'name', 'turns'];
  return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]));
}

export function assertNativeHistory(expected: Record<string, unknown>, actual: unknown, sessionId: string): void {
  if (!record(actual) || actual.sessionId !== sessionId || canonicalJson(nativeThreadHistory(actual)) !== canonicalJson(expected)) {
    throw new Error('Cold native history differs from the completed Session manifest');
  }
}

export function nativeCheckpointEvidence(manifest: NativeCheckpointManifest): NativeCheckpointEvidence {
  return { kind: 'codex-cold-native', threadIds: manifest.threads.map(thread => thread.id as string),
    historyDigest: sha256Hex(canonicalJson(manifest.threads)), hostJournalDigest: manifest.hostJournalDigest, historyModes: [...new Set(manifest.threads.map(thread => thread.historyMode as 'legacy' | 'paginated'))] };
}
export function sameNativeThreadIds(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length && left.every(id => right.includes(id));
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
