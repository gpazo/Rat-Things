import { describe, expect, it, vi } from 'vitest';
import { ExecutionRegistry } from '../../src/execution/registry.js';
import type { RunExecutor } from '../../src/execution/types.js';

function executor(backend: 'microvm'): RunExecutor {
  return {
    backend,
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('execution registry', () => {
  it('routes execution control through the selected backend', async () => {
    const microvm = executor('microvm');
    const registry = new ExecutionRegistry([microvm]);

    expect(registry.get('microvm')).toBe(microvm);
    await registry.stop({ backend: 'microvm', id: 'microvm-1' }, 'cancelled');
    expect(microvm.stop).toHaveBeenCalledWith('microvm-1', 'cancelled');
  });

  it('rejects duplicate or disabled backends', () => {
    expect(() => new ExecutionRegistry([executor('microvm'), executor('microvm')]))
      .toThrow('duplicate execution backend microvm');
    expect(() => new ExecutionRegistry([]).get('microvm'))
      .toThrow('execution backend microvm is not enabled');
  });
});
