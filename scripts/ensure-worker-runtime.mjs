import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateCodexRuntimeArtifact } from './codex-runtime-artifact.mjs';

/**
 * Build locally only when no valid cached artifact exists. Never replace operator-supplied bytes.
 * @param {{ root: string, artifact?: string | undefined, run: (name: string, args: string[]) => Promise<unknown>, validate?: (path: string) => Promise<unknown> }} options
 */
export async function ensureWorkerRuntime({ root, artifact, run,
  validate = path => validateCodexRuntimeArtifact(path, { expectedTarget: 'aarch64-unknown-linux-gnu' }),
}) {
  const existing = resolve(root, artifact ?? '.runtime/codex/linux-arm64');
  try { await validate(existing); return existing; }
  catch (error) { if (artifact) throw error; }
  await run('docker', ['info']);
  await run('docker', ['buildx', 'version']);
  const cache = join(root, '.runtime/codex');
  await mkdir(cache, { recursive: true });
  const output = await mkdtemp(join(cache, 'quickstart-arm64-'));
  await run('docker', ['buildx', 'build', '--platform', 'linux/arm64', '--file', 'runtime/codex/Dockerfile', '--output', `type=local,dest=${output}`, '.']);
  await validate(output);
  return output;
}
