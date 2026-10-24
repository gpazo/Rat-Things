import { nativeReleaseId, type NativeInstallationFailure, type NativeReleaseId, type NativeSelection } from './native-release.js';

export type NativeRuntimeChangeAction = 'setup' | 'rollback';
export type NativeRuntimeChangePhase = 'checking' | 'recovering' | 'copying' | 'verifying' | 'probing' | 'selecting';
export type NativeRuntimeChangeFailure = NativeInstallationFailure['kind'] | 'interrupted' | 'storage';
export interface NativeRuntimeChangeIntent {
  readonly target: NativeReleaseId;
  readonly startingGeneration: number;
  readonly requestedGeneration: number;
}
export type NativeRuntimeChangeState =
  | { readonly status: 'queued' }
  | { readonly status: 'working'; readonly phase: NativeRuntimeChangePhase }
  | { readonly status: 'complete' | 'awaiting_restart' }
  | { readonly status: 'failed'; readonly failure: NativeRuntimeChangeFailure };
export interface NativeRuntimeChangeRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly action: NativeRuntimeChangeAction;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly intent: NativeRuntimeChangeIntent | null;
  readonly state: NativeRuntimeChangeState;
}
export type NativeRuntimeChangeView = {
  readonly id: string;
  readonly action: NativeRuntimeChangeAction;
  readonly created_at: number;
  readonly updated_at: number;
} & NativeRuntimeChangeState;
export type NativeRuntimeChangeSubmission =
  | { readonly kind: 'accepted'; readonly change: NativeRuntimeChangeView }
  | { readonly kind: 'conflict'; readonly reason: 'request_id_reused' | 'change_active'; readonly currentChangeId: string };

const PHASES: readonly NativeRuntimeChangePhase[] = ['checking', 'recovering', 'copying', 'verifying', 'probing', 'selecting'];
const FAILURES: readonly NativeRuntimeChangeFailure[] = ['signature', 'verifier_unavailable', 'compatibility', 'manifest',
  'inventory', 'filesystem', 'bounds', 'selection', 'lease_lost', 'probe', 'version_collision', 'busy', 'no_previous',
  'not_started', 'interrupted', 'storage'];

export class NativeRuntimeChangeDecodeError extends Error {}

export function nativeRuntimeChangeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    throw new NativeRuntimeChangeDecodeError('A runtime change requires a UUID.');
  }
  return value.toLowerCase();
}

export function decodeNativeRuntimeChangeRequest(value: unknown): { readonly id: string } {
  const input = object(value);
  if (Object.keys(input).some(key => key !== 'id')) throw new NativeRuntimeChangeDecodeError('A runtime change accepts only its request ID.');
  return { id: nativeRuntimeChangeId(input.id) };
}

export function decodeNativeRuntimeChangeRecord(value: unknown): NativeRuntimeChangeRecord {
  const input = object(value);
  if (input.schemaVersion !== 1 || input.action !== 'setup' && input.action !== 'rollback') throw new NativeRuntimeChangeDecodeError('Invalid runtime change.');
  const createdAt = integer(input.createdAt);
  const updatedAt = integer(input.updatedAt);
  if (updatedAt < createdAt) throw new NativeRuntimeChangeDecodeError('Invalid runtime change time.');
  let intent: NativeRuntimeChangeIntent | null = null;
  if (input.intent !== null) {
    const raw = object(input.intent);
    const startingGeneration = integer(raw.startingGeneration);
    const requestedGeneration = integer(raw.requestedGeneration);
    if (requestedGeneration < startingGeneration || requestedGeneration - startingGeneration > 1) throw new NativeRuntimeChangeDecodeError('Invalid runtime change generation.');
    intent = { target: nativeReleaseId(raw.target), startingGeneration, requestedGeneration };
  }
  const raw = object(input.state);
  let state: NativeRuntimeChangeState;
  switch (raw.status) {
    case 'queued': state = { status: 'queued' }; break;
    case 'working':
      if (!PHASES.includes(raw.phase as NativeRuntimeChangePhase)) throw new NativeRuntimeChangeDecodeError('Invalid runtime change phase.');
      state = { status: 'working', phase: raw.phase as NativeRuntimeChangePhase }; break;
    case 'complete': case 'awaiting_restart':
      if (!intent) throw new NativeRuntimeChangeDecodeError('A selected runtime change needs its intent.');
      state = { status: raw.status }; break;
    case 'failed':
      if (!FAILURES.includes(raw.failure as NativeRuntimeChangeFailure)) throw new NativeRuntimeChangeDecodeError('Invalid runtime change failure.');
      state = { status: 'failed', failure: raw.failure as NativeRuntimeChangeFailure }; break;
    default: throw new NativeRuntimeChangeDecodeError('Invalid runtime change state.');
  }
  return { schemaVersion: 1, id: nativeRuntimeChangeId(input.id), action: input.action,
    createdAt, updatedAt, intent, state };
}

export function nativeRuntimeChangeView(record: NativeRuntimeChangeRecord): NativeRuntimeChangeView {
  return { id: record.id, action: record.action, created_at: record.createdAt, updated_at: record.updatedAt, ...record.state };
}

export function reconcileNativeRuntimeChange(record: NativeRuntimeChangeRecord, selection: NativeSelection, now: number): NativeRuntimeChangeRecord {
  if (record.state.status === 'complete' || record.state.status === 'failed') return record;
  const intent = record.intent;
  let state: NativeRuntimeChangeState = { status: 'failed', failure: 'interrupted' };
  if (intent) {
    if (selection.active === intent.target && selection.generation >= intent.requestedGeneration
      && selection.generation - intent.requestedGeneration <= 1) state = { status: 'complete' };
    else if (selection.generation === intent.requestedGeneration && selection.pending?.release === intent.target
      && selection.pending.action === record.action) state = { status: 'awaiting_restart' };
  }
  if (record.state.status === state.status) return record;
  return { ...record, updatedAt: Math.max(record.updatedAt, now), state };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeRuntimeChangeDecodeError('Expected a runtime change object.');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new NativeRuntimeChangeDecodeError('Invalid runtime change number.');
  return value;
}
