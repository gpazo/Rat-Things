import type { ExecutionReference, RunRecord, RunRequest } from '../../src/domain/contracts.js';

export const timestamp = '2026-08-24T20:05:00.000Z';
export const execution: ExecutionReference = { backend: 'microvm', id: 'microvm-1', generation: 'a'.repeat(64) };
export const request: RunRequest = { version: '1', prompt: 'Exercise dispatch', agent: { driver: 'mock', sandbox: 'read-only' } };

export function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1', ownerId: 'owner-1', ownerCreated: 'owner-1#2026-08-24T20:00:00.000Z#run-1', status: 'queued',
    createdAt: '2026-08-24T20:00:00.000Z', updatedAt: '2026-08-24T20:00:01.000Z', expiresAt: 2_000_000_000,
    requestHash: 'b'.repeat(64), input: { bucket: 'artifacts', key: 'input.json', sha256: 'c'.repeat(64) },
    sourceKind: 'api', ...overrides,
  };
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
