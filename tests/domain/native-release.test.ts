import { describe, expect, it } from 'vitest';
import {
  activateNativeSelection, decodeAuthenticatedNativeManifest, decodeNativeSelection, EMPTY_NATIVE_SELECTION,
  nativeBundlePath, nativeCompatibility, nativeReleaseId, requestNativeSelection,
} from '../../src/domain/native-release.js';
import { fixtureRequirements } from '../fixtures/native-installation.js';

const a = nativeReleaseId('a'.repeat(64));
const b = nativeReleaseId('b'.repeat(64));
const c = nativeReleaseId('c'.repeat(64));
const manifest = {
  schemaVersion: 1, version: '1.0', compatibility: {
    hostTarget: 'aarch64-apple-darwin', guestTarget: 'aarch64-unknown-linux-gnu', minimumMacOS: '14.0',
    appProtocol: { minimum: 1, maximum: 2 }, controllerProtocol: { minimum: 1, maximum: 2 }, workerProtocol: 1,
    workspaceFormat: { read: [1], write: 1 }, accountStateFormat: 1, profileSchema: 1,
  }, files: [
    { path: 'Contents/Helpers/helper', bytes: 1, sha256: a, kind: 'host-executable', role: 'vm-helper' },
    { path: 'Contents/Helpers/codex', bytes: 1, sha256: b, kind: 'host-executable', role: 'host-codex' },
  ],
};

describe('native release decisions', () => {
  it('decodes complete typed inventory and checks all compatibility dimensions', () => {
    const decoded = decodeAuthenticatedNativeManifest(manifest);
    expect(nativeCompatibility(decoded, fixtureRequirements)).toBeUndefined();
    expect(nativeCompatibility(decoded, { ...fixtureRequirements, hostTarget: 'x86_64-apple-darwin', guestTarget: 'other', macOS: '13.0',
      appProtocol: 3, controllerProtocol: 3, workerProtocol: 2, workspaceFormat: 2, accountStateFormat: 2, profileSchema: 2 })).toEqual({
      kind: 'compatibility', fields: ['hostTarget', 'guestTarget', 'minimumMacOS', 'appProtocol', 'controllerProtocol', 'workerProtocol', 'workspaceFormat', 'accountStateFormat', 'profileSchema'],
    });
  });

  it.each(['../escape', '/Contents/file', 'Contents/../file', 'Contents//file', 'Contents/./file', 'Contents/a\\b', 'Contents/a:b', 'Contents/a\nfile'])('rejects unsafe relative path %j', path => {
    expect(() => nativeBundlePath(path)).toThrow();
  });

  it('rejects case aliases, signature metadata and incomplete executable declarations', () => {
    expect(() => decodeAuthenticatedNativeManifest({ ...manifest, files: [...manifest.files, { ...manifest.files[0], path: 'Contents/Helpers/HELPER' }] })).toThrow();
    for (const name of ['CodeDirectory', 'CodeRequirements', 'CodeSignature', 'CodeResources']) {
      expect(() => decodeAuthenticatedNativeManifest({ ...manifest, files: [...manifest.files, { ...manifest.files[0], kind: 'resource', path: `Contents/_CodeSignature/${name}` }] })).toThrow();
    }
    expect(() => decodeAuthenticatedNativeManifest({ ...manifest, files: manifest.files.slice(0, 1) })).toThrow();
  });

  it('preserves the Codex package layout inside sealed resources', () => {
    const files = [manifest.files[0], { ...manifest.files[1], path: 'Contents/Resources/codex/bin/codex' },
      ...['bin/codex-code-mode-host', 'codex-path/rg', 'codex-resources/voice/bin/codex-voice-host'].map(path => ({
        ...manifest.files[1], role: 'host-companion', path: `Contents/Resources/codex/${path}`,
      }))];
    expect(decodeAuthenticatedNativeManifest({ ...manifest, files }).files.map(file => file.path)).toEqual(files.map(file => file!.path));
    expect(() => decodeAuthenticatedNativeManifest({ ...manifest, files: [files[0], {
      ...manifest.files[1], path: 'Contents/Resources/other/bin/codex',
    }] })).toThrow('Invalid host executable');
  });

  it('rejects incoherent records instead of resetting selection', () => {
    for (const value of [{}, { ...EMPTY_NATIVE_SELECTION, generation: -1 }, { ...EMPTY_NATIVE_SELECTION, previous: a },
      { ...EMPTY_NATIVE_SELECTION, active: a, previous: a }, { ...EMPTY_NATIVE_SELECTION, active: a, pending: { action: 'setup', release: a } },
      { ...EMPTY_NATIVE_SELECTION, active: a, previous: b, pending: { action: 'rollback', release: c } }]) {
      expect(() => decodeNativeSelection(value)).toThrow();
    }
  });

  it('stages and activates once without exchanging previous on replay', () => {
    const initial = decodeNativeSelection({ ...EMPTY_NATIVE_SELECTION, generation: 7, active: a });
    const pending = requestNativeSelection(initial, 'setup', b);
    expect(pending.kind).toBe('write');
    if (pending.kind !== 'write') throw new Error('Expected a write');
    expect(requestNativeSelection(pending.selection, 'setup', b)).toEqual({ kind: 'unchanged', selection: pending.selection });
    const active = activateNativeSelection(pending.selection, b);
    expect(active).toEqual({ kind: 'write', selection: { schemaVersion: 1, generation: 9, active: b, previous: a, pending: null } });
    if (active.kind !== 'write') throw new Error('Expected a write');
    expect(activateNativeSelection(active.selection, b)).toEqual({ kind: 'unchanged', selection: active.selection });
    expect(activateNativeSelection(active.selection, a).kind).toBe('rejected');
    expect(initial).toEqual({ ...EMPTY_NATIVE_SELECTION, generation: 7, active: a });
  });

  it('allows an explicit request to replace a completed pending change and rejects unknown rollback', () => {
    const selection = decodeNativeSelection({ schemaVersion: 1, generation: 4, active: b, previous: a, pending: { action: 'setup', release: c } });
    expect(requestNativeSelection(selection, 'rollback', a)).toEqual({ kind: 'write', selection: { ...selection, generation: 5, pending: { action: 'rollback', release: a } } });
    expect(requestNativeSelection(selection, 'setup', b)).toEqual({ kind: 'write', selection: { ...selection, generation: 5, pending: null } });
    expect(requestNativeSelection(selection, 'rollback', c)).toEqual({ kind: 'rejected', failure: { kind: 'no_previous' } });
  });
});
