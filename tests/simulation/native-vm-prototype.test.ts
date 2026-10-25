import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { nativeProofCpuCount } from '../../testing/local-runtime/native-vm/worker/runtime.js';
import { nativeFixture, startRequest } from './native-runtime-fixtures.js';

describe('native worker proof cleanup', () => {
  it('limits proof CPU choices before launching a VM', () => {
    expect(nativeProofCpuCount(undefined)).toBe(1);
    expect(nativeProofCpuCount('1')).toBe(1);
    expect(() => nativeProofCpuCount('2')).toThrow('Two-CPU native workers are unsupported');
    for (const value of ['', '0', '3', '2.5', 'two']) expect(() => nativeProofCpuCount(value)).toThrow('must be 1');
  });

  it('reports shutdown failure after the helper has exited', async () => {
    const fixture = await nativeFixture();
    try {
      await fixture.runtime.start(startRequest(), async () => {});
      const machine = fixture.machines[0]!;
      machine.stopError = new Error('unmount failed');
      await expect(fixture.runtime.close()).rejects.toThrow('Native workers failed to stop cleanly');
      expect(machine.stop).toHaveBeenCalledOnce();
      expect(machine.alive()).toBe(false);
      expect((await fixture.runtime.status()).native?.occupied).toBe(false);
    } finally { await fixture.close(); }
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('preserves guest filesystem links and reaps live or exited workers', async () => {
    await expect(promisify(execFile)('python3', ['testing/local-runtime/native-vm/worker/test_guest.py'], { timeout: 15_000 })).resolves.toMatchObject({ stdout: '' });
  });
});
