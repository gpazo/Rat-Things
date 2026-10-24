export type NativeSha256 = string & { readonly nativeSha256: unique symbol };
export type NativeReleaseId = NativeSha256 & { readonly nativeReleaseId: unique symbol };
export type NativeBundlePath = string & { readonly nativeBundlePath: unique symbol };

export interface NativeProtocolRange { readonly minimum: number; readonly maximum: number }
export interface NativeReleaseCompatibility {
  readonly hostTarget: string;
  readonly guestTarget: string;
  readonly minimumMacOS: string;
  readonly appProtocol: NativeProtocolRange;
  readonly controllerProtocol: NativeProtocolRange;
  readonly workerProtocol: number;
  readonly workspaceFormat: { readonly read: readonly number[]; readonly write: number };
  readonly accountStateFormat: number;
  readonly profileSchema: number;
}
export type NativeReleaseFile = {
  readonly path: NativeBundlePath;
  readonly bytes: number;
  readonly sha256: NativeSha256;
} & ({ readonly kind: 'resource' } | {
  readonly kind: 'host-executable'; readonly role: 'vm-helper' | 'host-codex' | 'host-companion';
});
export interface NativeReleaseManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly compatibility: NativeReleaseCompatibility;
  readonly files: readonly NativeReleaseFile[];
}
export interface NativeCompatibilityRequirements {
  readonly hostTarget: string;
  readonly guestTarget: string;
  readonly macOS: string;
  readonly appProtocol: number;
  readonly controllerProtocol: number;
  readonly workerProtocol: number;
  readonly workspaceFormat: number;
  readonly accountStateFormat: number;
  readonly profileSchema: number;
}
export type NativeCompatibilityField = keyof NativeReleaseCompatibility;
export interface NativeCompatibilityFailure {
  readonly kind: 'compatibility';
  readonly fields: readonly NativeCompatibilityField[];
}
export type NativeVerificationFailure =
  | { readonly kind: 'signature'; readonly scope: 'bundle' | 'executable';
      readonly reason: 'unsigned' | 'ad_hoc' | 'wrong_team' | 'wrong_identifier' | 'invalid';
      readonly path?: string; readonly osStatus?: number }
  | { readonly kind: 'verifier_unavailable'; readonly reason: string };
export type NativeInstallationFailure = NativeVerificationFailure | NativeCompatibilityFailure
  | { readonly kind: 'manifest'; readonly reason: string }
  | { readonly kind: 'inventory'; readonly reason: string; readonly path?: string }
  | { readonly kind: 'filesystem'; readonly reason: string; readonly code?: string }
  | { readonly kind: 'bounds'; readonly limit: string }
  | { readonly kind: 'selection'; readonly reason: string }
  | { readonly kind: 'lease_lost' }
  | { readonly kind: 'probe'; readonly reason: 'unavailable' | 'recovery' | 'failed'; readonly detail: string }
  | { readonly kind: 'version_collision'; readonly release: NativeReleaseId }
  | { readonly kind: 'busy'; readonly operation: 'startup' | 'setup' | 'rollback' }
  | { readonly kind: 'no_previous' }
  | { readonly kind: 'not_started' };

export interface NativeSelection {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly active: NativeReleaseId | null;
  readonly previous: NativeReleaseId | null;
  readonly pending: { readonly action: 'setup' | 'rollback'; readonly release: NativeReleaseId } | null;
}
export const EMPTY_NATIVE_SELECTION: NativeSelection = Object.freeze({
  schemaVersion: 1, generation: 0, active: null, previous: null, pending: null,
});

export class NativeReleaseDecodeError extends Error {}

export function nativeReleaseId(value: unknown): NativeReleaseId {
  return nativeSha256(value) as NativeReleaseId;
}

function nativeSha256(value: unknown): NativeSha256 {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new NativeReleaseDecodeError('Invalid release digest');
  return value as NativeSha256;
}

export function nativeBundlePath(value: unknown): NativeBundlePath {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('Contents/')
    || /[\\:\u0000-\u001f\u007f]/.test(value) || value.normalize('NFC') !== value
    || value.split('/').length > 32 || value.split('/').some(part => !part || part === '.' || part === '..' || part.length > 255)) {
    throw new NativeReleaseDecodeError('Invalid bundle-relative path');
  }
  return value as NativeBundlePath;
}

/** This decodes bytes supplied only after independent bundle authentication. It does not verify signatures. */
export function decodeAuthenticatedNativeManifest(value: unknown): NativeReleaseManifest {
  const object = record(value);
  if (object.schemaVersion !== 1) throw new NativeReleaseDecodeError('Unsupported manifest schema');
  if (typeof object.version !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(object.version)) throw new NativeReleaseDecodeError('Invalid release version');
  const compatibility = record(object.compatibility);
  const workspace = record(compatibility.workspaceFormat);
  const read = numberList(workspace.read);
  const write = positive(workspace.write);
  if (!read.includes(write)) throw new NativeReleaseDecodeError('Workspace writer must read its format');
  if (!Array.isArray(object.files) || object.files.length === 0 || object.files.length > 65_536) throw new NativeReleaseDecodeError('Invalid file inventory');
  const files = object.files.map((value): NativeReleaseFile => {
    const file = record(value);
    const entry = { path: nativeBundlePath(file.path), bytes: nonnegative(file.bytes), sha256: nativeSha256(file.sha256) };
    if (entry.path === NATIVE_MANIFEST_PATH || NATIVE_SIGNATURE_PATHS.includes(entry.path)) throw new NativeReleaseDecodeError('Inventory names signature metadata');
    if (file.kind === 'resource') return Object.freeze({ ...entry, kind: 'resource' });
    if (file.kind !== 'host-executable' || !['vm-helper', 'host-codex', 'host-companion'].includes(String(file.role))
      || !['Contents/Helpers/', 'Contents/Resources/codex/'].some(prefix => entry.path.startsWith(prefix))) throw new NativeReleaseDecodeError('Invalid host executable inventory');
    return Object.freeze({ ...entry, kind: 'host-executable', role: file.role as 'vm-helper' | 'host-codex' | 'host-companion' });
  });
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new NativeReleaseDecodeError('Duplicate or case-aliased inventory path');
  for (const role of ['vm-helper', 'host-codex']) {
    if (files.filter(file => file.kind === 'host-executable' && file.role === role).length !== 1) throw new NativeReleaseDecodeError(`Inventory requires one ${role}`);
  }
  return Object.freeze({ schemaVersion: 1, version: object.version, files: Object.freeze(files), compatibility: Object.freeze({
    hostTarget: target(compatibility.hostTarget), guestTarget: target(compatibility.guestTarget),
    minimumMacOS: osVersion(compatibility.minimumMacOS), appProtocol: protocolRange(compatibility.appProtocol),
    controllerProtocol: protocolRange(compatibility.controllerProtocol), workerProtocol: positive(compatibility.workerProtocol),
    workspaceFormat: Object.freeze({ read: Object.freeze(read), write }), accountStateFormat: positive(compatibility.accountStateFormat),
    profileSchema: positive(compatibility.profileSchema),
  }) });
}

export const NATIVE_MANIFEST_PATH = 'Contents/Resources/runtime-manifest.json';
export const NATIVE_SIGNATURE_PATHS: readonly string[] = Object.freeze([
  'Contents/_CodeSignature/CodeDirectory',
  'Contents/_CodeSignature/CodeRequirements',
  'Contents/_CodeSignature/CodeSignature',
  'Contents/_CodeSignature/CodeResources',
]);

export function nativeCompatibility(manifest: NativeReleaseManifest, required: NativeCompatibilityRequirements): NativeCompatibilityFailure | undefined {
  const value = manifest.compatibility;
  const checks: readonly [NativeCompatibilityField, boolean][] = [
    ['hostTarget', value.hostTarget === required.hostTarget], ['guestTarget', value.guestTarget === required.guestTarget],
    ['minimumMacOS', compareVersions(osVersion(required.macOS), value.minimumMacOS) >= 0],
    ['appProtocol', contains(value.appProtocol, required.appProtocol)],
    ['controllerProtocol', contains(value.controllerProtocol, required.controllerProtocol)],
    ['workerProtocol', value.workerProtocol === required.workerProtocol],
    ['workspaceFormat', value.workspaceFormat.read.includes(required.workspaceFormat) && value.workspaceFormat.write === required.workspaceFormat],
    ['accountStateFormat', value.accountStateFormat === required.accountStateFormat], ['profileSchema', value.profileSchema === required.profileSchema],
  ];
  const fields = checks.filter(([, compatible]) => !compatible).map(([field]) => field);
  return fields.length ? { kind: 'compatibility', fields } : undefined;
}

export function decodeNativeSelection(value: unknown): NativeSelection {
  const object = record(value);
  if (object.schemaVersion !== 1) throw new NativeReleaseDecodeError('Unsupported selection schema');
  const active = object.active === null ? null : nativeReleaseId(object.active);
  const previous = object.previous === null ? null : nativeReleaseId(object.previous);
  let pending: NativeSelection['pending'] = null;
  if (object.pending !== null) {
    const request = record(object.pending);
    if (request.action !== 'setup' && request.action !== 'rollback') throw new NativeReleaseDecodeError('Invalid pending action');
    pending = Object.freeze({ action: request.action, release: nativeReleaseId(request.release) });
  }
  if ((!active && previous) || (active && active === previous) || (pending && active === pending.release)
    || (pending?.action === 'rollback' && pending.release !== previous)) throw new NativeReleaseDecodeError('Incoherent release selection');
  return Object.freeze({ schemaVersion: 1, generation: nonnegative(object.generation), active, previous, pending });
}

export type NativeSelectionDecision =
  | { readonly kind: 'unchanged'; readonly selection: NativeSelection }
  | { readonly kind: 'write'; readonly selection: NativeSelection }
  | { readonly kind: 'rejected'; readonly failure: NativeInstallationFailure };

export function requestNativeSelection(selection: NativeSelection, action: 'setup' | 'rollback', release: NativeReleaseId): NativeSelectionDecision {
  if (action === 'rollback' && selection.previous !== release) return { kind: 'rejected', failure: { kind: 'no_previous' } };
  if (selection.pending?.action === action && selection.pending.release === release) return { kind: 'unchanged', selection };
  if (selection.active === release) return selection.pending
    ? { kind: 'write', selection: Object.freeze({ ...selection, generation: nextGeneration(selection), pending: null }) }
    : { kind: 'unchanged', selection };
  return { kind: 'write', selection: Object.freeze({ ...selection, generation: nextGeneration(selection), pending: Object.freeze({ action, release }) }) };
}

export function activateNativeSelection(selection: NativeSelection, release: NativeReleaseId): NativeSelectionDecision {
  if (selection.active === release && !selection.pending) return { kind: 'unchanged', selection };
  if (selection.pending?.release !== release) return { kind: 'rejected', failure: { kind: 'selection', reason: 'Activation does not match the pending release' } };
  return { kind: 'write', selection: Object.freeze({ ...selection, generation: nextGeneration(selection), active: release, previous: selection.active, pending: null }) };
}

function nextGeneration(selection: NativeSelection): number {
  if (selection.generation >= Number.MAX_SAFE_INTEGER) throw new NativeReleaseDecodeError('Selection generation exhausted');
  return selection.generation + 1;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || !value || Array.isArray(value)) throw new NativeReleaseDecodeError('Expected an object');
  return value as Record<string, unknown>;
}
function nonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new NativeReleaseDecodeError('Expected a nonnegative safe integer');
  return value;
}
function positive(value: unknown): number {
  const number = nonnegative(value);
  if (!number) throw new NativeReleaseDecodeError('Expected a positive integer');
  return number;
}
function numberList(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new NativeReleaseDecodeError('Invalid format list');
  const values = value.map(positive);
  if (new Set(values).size !== values.length) throw new NativeReleaseDecodeError('Duplicate format');
  return values;
}
function target(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,127}$/.test(value)) throw new NativeReleaseDecodeError('Invalid artifact target');
  return value;
}
function osVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(value)) throw new NativeReleaseDecodeError('Invalid macOS version');
  return value;
}
function protocolRange(value: unknown): NativeProtocolRange {
  const object = record(value); const minimum = positive(object.minimum); const maximum = positive(object.maximum);
  if (minimum > maximum) throw new NativeReleaseDecodeError('Inverted protocol range');
  return Object.freeze({ minimum, maximum });
}
function contains(range: NativeProtocolRange, version: number): boolean { return range.minimum <= version && version <= range.maximum; }
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) { const result = (a[index] ?? 0) - (b[index] ?? 0); if (result) return result; }
  return 0;
}
