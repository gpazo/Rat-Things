import { describe, expect, it } from 'vitest';
import { executionGeneration } from '../../src/execution/generation.js';

describe('execution generation', () => {
  it('is stable across retries and changes for a different semantic Run', () => {
    const first = executionGeneration({ runId: 'run-1', requestHash: 'a'.repeat(64) });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(executionGeneration({ runId: 'run-1', requestHash: 'a'.repeat(64) })).toBe(first);
    expect(executionGeneration({ runId: 'run-2', requestHash: 'a'.repeat(64) })).not.toBe(first);
    expect(executionGeneration({ runId: 'run-1', requestHash: 'b'.repeat(64) })).not.toBe(first);
  });
});
