import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { validateCodexRuntimeArtifact } from './codex-runtime-artifact.mjs';

/**
 * Build locally only when no valid cached artifact exists. Never replace operator-supplied bytes.
 * @param {{ root: string, artifact?: string | undefined, run: (name: string, args: string[]) => Promise<unknown>, validate?: (path: string) => Promise<unknown> }} options
 */
export async function ensureWorkerRuntime({ root, artifact, run,
  validate = path => validateCodexRuntimeArtifact(path, { expectedTarget: 'aarch64-unknown-linux-musl' }),
}) {
  const existing = resolve(root, artifact ?? '.runtime/codex/linux-arm64');
  try { await validate(existing); return existing; }
  catch (error) { if (artifact) throw error; }
  const cache = resolve(root, '.runtime/codex');
  const pointer = join(cache, 'quickstart-arm64.current');
  try {
    const name = (await readFile(pointer, 'utf8')).trim();
    if (/^quickstart-arm64-[A-Za-z0-9]+$/.test(name)) {
      const cached = join(cache, name);
      await validate(cached);
      return cached;
    }
  } catch {}
  await run('docker', ['info']);
  await run('docker', ['buildx', 'version']);
  await mkdir(cache, { recursive: true });
  const output = await mkdtemp(join(cache, 'quickstart-arm64-'));
  await run('docker', ['buildx', 'build', '--platform', 'linux/arm64', '--file', 'runtime/codex/Dockerfile', '--output', `type=local,dest=${output}`, '.']);
  await validate(output);
  const pendingPointer = `${output}.current`;
  await writeFile(pendingPointer, basename(output), { flag: 'wx' });
  await rename(pendingPointer, pointer);
  return output;
}
