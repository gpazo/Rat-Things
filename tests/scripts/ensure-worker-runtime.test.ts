import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ensureWorkerRuntime } from '../../scripts/ensure-worker-runtime.mjs';

it('reuses verified artifacts without requiring Docker and refuses an invalid explicit artifact', async () => {
  const run = vi.fn();
  const validate = vi.fn().mockResolvedValue({});
  expect(await ensureWorkerRuntime({ root: '/project', artifact: '/operator/runtime', run, validate })).toBe('/operator/runtime');
  expect(run).not.toHaveBeenCalled();
  validate.mockRejectedValue(new Error('Source mismatch'));
  await expect(ensureWorkerRuntime({ root: '/project', artifact: '/operator/runtime', run, validate })).rejects.toThrow('Source mismatch');
  expect(run).not.toHaveBeenCalled();
});

it('builds a missing worker in a fresh output directory and validates it before returning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-worker-build-'));
  try {
    const run = vi.fn();
    const validate = vi.fn().mockRejectedValueOnce(new Error('Missing')).mockResolvedValueOnce({});
    const result = await ensureWorkerRuntime({ root, run, validate });
    expect(result).toContain(join(root, '.runtime/codex/quickstart-arm64-'));
    expect(run).toHaveBeenLastCalledWith('docker', ['buildx', 'build', '--platform', 'linux/arm64', '--file', 'runtime/codex/Dockerfile', '--output', `type=local,dest=${result}`, '.']);
    expect(validate).toHaveBeenLastCalledWith(result);
    validate.mockReset().mockRejectedValue(new Error('Unverified build'));
    await expect(ensureWorkerRuntime({ root, run, validate })).rejects.toThrow('Unverified build');
  } finally { await rm(root, { recursive: true, force: true }); }
});
