import { expect, it } from 'vitest';
import { decodeNativeRuntimeChangeRecord, decodeNativeRuntimeChangeRequest, nativeRuntimeChangeView, reconcileNativeRuntimeChange,
  type NativeRuntimeChangeRecord } from '../../src/domain/local-native-change.js';
import { EMPTY_NATIVE_SELECTION, nativeReleaseId, type NativeSelection } from '../../src/domain/native-release.js';

const target = nativeReleaseId('a'.repeat(64));
const other = nativeReleaseId('b'.repeat(64));
const record: NativeRuntimeChangeRecord = { schemaVersion: 1, id: '11111111-1111-4111-8111-111111111111', action: 'setup',
  createdAt: 1, updatedAt: 1, intent: { target, startingGeneration: 2, requestedGeneration: 3 }, state: { status: 'working', phase: 'selecting' } };

it('decodes caller IDs and rejects authority-bearing request fields', () => {
  expect(decodeNativeRuntimeChangeRequest({ id: record.id })).toEqual({ id: record.id });
  for (const raw of [null, [], {}, { id: 'not-a-uuid' }, { id: record.id, bundlePath: '/tmp/runtime' }, { id: record.id, target }]) {
    expect(() => decodeNativeRuntimeChangeRequest(raw)).toThrow();
  }
});

it('decodes stored state and projects only bounded public progress', () => {
  expect(decodeNativeRuntimeChangeRecord(record)).toEqual(record);
  expect(nativeRuntimeChangeView(record)).toEqual({ id: record.id, action: 'setup', created_at: 1, updated_at: 1, status: 'working', phase: 'selecting' });
  for (const invalid of [{ ...record, schemaVersion: 2 }, { ...record, intent: { ...record.intent, requestedGeneration: 5 } },
    { ...record, state: { status: 'working', phase: '/private/path' } }, { ...record, state: { status: 'failed', failure: 'subprocess stderr' } },
    { ...record, intent: null, state: { status: 'complete' } }]) {
    expect(() => decodeNativeRuntimeChangeRecord(invalid)).toThrow();
  }
});

it('recognizes committed intent by its target and exact selection generations', () => {
  const pending: NativeSelection = { schemaVersion: 1, generation: 3, active: other, previous: null, pending: { action: 'setup', release: target } };
  const staged = reconcileNativeRuntimeChange(record, pending, 2);
  expect(staged.state).toEqual({ status: 'awaiting_restart' });
  expect(reconcileNativeRuntimeChange(staged, pending, 3)).toBe(staged);
  const activated = { ...pending, generation: 4, active: target, previous: other, pending: null };
  expect(reconcileNativeRuntimeChange(staged, activated, 4).state).toEqual({ status: 'complete' });
  expect(reconcileNativeRuntimeChange(record, { ...activated, generation: 6 }, 4).state).toEqual({ status: 'failed', failure: 'interrupted' });
  expect(reconcileNativeRuntimeChange(record, { ...pending, generation: 2 }, 4).state).toEqual({ status: 'failed', failure: 'interrupted' });
  expect(reconcileNativeRuntimeChange({ ...record, action: 'rollback' }, pending, 4).state).toEqual({ status: 'failed', failure: 'interrupted' });
});

it('interrupts jobs without an effect and preserves terminal history', () => {
  expect(reconcileNativeRuntimeChange({ ...record, intent: null, state: { status: 'queued' } }, EMPTY_NATIVE_SELECTION, 2).state)
    .toEqual({ status: 'failed', failure: 'interrupted' });
  for (const state of [{ status: 'complete' }, { status: 'failed', failure: 'probe' }] as const) {
    const terminal = { ...record, state };
    expect(reconcileNativeRuntimeChange(terminal, EMPTY_NATIVE_SELECTION, 9)).toBe(terminal);
  }
});
