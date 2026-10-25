import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ensureWorkerRuntime } from '../../scripts/ensure-worker-runtime.mjs';

const validateArtifact = async (path: string) => {
  if (await readFile(join(path, 'artifact.json'), 'utf8') !== 'verified') throw new Error('Source mismatch');
};

const buildArtifact = async (_name: string, args: string[]) => {
  const output = args.find(arg => arg.startsWith('type=local,dest='))?.slice('type=local,dest='.length);
  if (output) await writeFile(join(output, 'artifact.json'), 'verified');
};

it('reuses a verified quickstart build on the next invocation without requiring Docker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-worker-reuse-'));
  try {
    const run = vi.fn(buildArtifact);
    const result = await ensureWorkerRuntime({ root, run, validate: validateArtifact });
    expect(result).toContain(join(root, '.runtime/codex/quickstart-arm64-'));
    run.mockClear();
    expect(await ensureWorkerRuntime({ root, run, validate: validateArtifact })).toBe(result);
    expect(run).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reuses verified artifacts without requiring Docker and refuses an invalid explicit artifact', async () => {
  const run = vi.fn();
  const validate = vi.fn().mockResolvedValue({});
  expect(await ensureWorkerRuntime({ root: '/project', run, validate })).toBe('/project/.runtime/codex/linux-arm64');
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

it.each(['missing', 'invalid'])('rebuilds a %s cached artifact without replacing default artifact bytes', async state => {
  const root = await mkdtemp(join(tmpdir(), 'rat-worker-stale-'));
  try {
    const defaultArtifact = join(root, '.runtime/codex/linux-arm64');
    await mkdir(defaultArtifact, { recursive: true });
    await writeFile(join(defaultArtifact, 'artifact.json'), 'operator-owned');
    const run = vi.fn(buildArtifact);
    const original = await ensureWorkerRuntime({ root, run, validate: validateArtifact });
    if (state === 'missing') await rm(original, { recursive: true });
    else await writeFile(join(original, 'artifact.json'), 'outdated');
    run.mockClear();
    const replacement = await ensureWorkerRuntime({ root, run, validate: validateArtifact });
    expect(replacement).not.toBe(original);
    expect(run).toHaveBeenLastCalledWith('docker', ['buildx', 'build', '--platform', 'linux/arm64', '--file', 'runtime/codex/Dockerfile', '--output', `type=local,dest=${replacement}`, '.']);
    expect(await readFile(join(defaultArtifact, 'artifact.json'), 'utf8')).toBe('operator-owned');
    run.mockClear();
    expect(await ensureWorkerRuntime({ root, run, validate: validateArtifact })).toBe(replacement);
    expect(run).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['build', 'validation'])('does not publish a build whose %s fails and retries in a fresh directory', async failure => {
  const root = await mkdtemp(join(tmpdir(), 'rat-worker-failure-'));
  try {
    const run = vi.fn(buildArtifact);
    const failedOutputs: string[] = [];
    const validate = async (path: string) => {
      await validateArtifact(path);
      failedOutputs.push(path);
      if (failure === 'validation') throw new Error('Rejected build');
    };
    const failedRun = vi.fn(async (name: string, args: string[]) => {
      await buildArtifact(name, args);
      const output = args.find(arg => arg.startsWith('type=local,dest='))?.slice('type=local,dest='.length);
      if (output && failure === 'build') {
        failedOutputs.push(output);
        throw new Error('Docker build failed');
      }
    });
    await expect(ensureWorkerRuntime({ root, run: failedRun, validate })).rejects.toThrow(failure === 'build' ? 'Docker build failed' : 'Rejected build');
    const result = await ensureWorkerRuntime({ root, run, validate: validateArtifact });
    expect(failedOutputs).not.toContain(result);
    expect(run).toHaveBeenLastCalledWith('docker', ['buildx', 'build', '--platform', 'linux/arm64', '--file', 'runtime/codex/Dockerfile', '--output', `type=local,dest=${result}`, '.']);
    run.mockClear();
    expect(await ensureWorkerRuntime({ root, run, validate: validateArtifact })).toBe(result);
    expect(run).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
