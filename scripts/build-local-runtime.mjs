import { cp, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { build } from 'esbuild';
import { validateCodexRuntimeArtifact } from './codex-runtime-artifact.mjs';
import { codexRuntimeTargets } from './codex-runtime-targets.mjs';

const context = await mkdtemp(join(tmpdir(), 'rat-local-image-'));
try {
  const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
    || JSON.parse(execFileSync('docker', ['context', 'inspect'], { encoding: 'utf8', timeout: 10_000 }))[0]?.Endpoints?.docker?.Host;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://')) throw new Error('Build the local worker against a local Unix socket');
  const { DOCKER_CONTEXT: _context, DOCKER_HOST: _host, ...environment } = process.env;
  const info = JSON.parse(execFileSync('docker', ['--host', endpoint, 'info', '--format', '{{json .}}'], { env: environment, encoding: 'utf8', timeout: 10_000 }));
  const arch = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', amd64: 'x64' }[info.Architecture];
  const target = codexRuntimeTargets[`linux-${arch}`];
  if (!target) throw new Error('The local worker requires a Linux ARM64 or x64 engine.');
  const platform = arch === 'x64' ? 'linux/amd64' : 'linux/arm64';
  const artifact = await validateCodexRuntimeArtifact(process.env.CODEX_RUNTIME_ARTIFACT ?? resolve(`.runtime/codex/linux-${arch}`), { expectedTarget: target.nativeTarget });
  await copyFile('runtime/local/Dockerfile', join(context, 'Dockerfile'));
  await copyFile('runtime/native/package-inventory.py', join(context, 'package-inventory.py'));
  await cp('runtime/codex/licenses', join(context, 'codex-runtime/licenses'), { recursive: true });
  const entries = [...artifact.files.map(file => ({ source: file.source, target: `codex-runtime/${file.path}` })),
    { source: artifact.manifestPath, target: 'codex-runtime/artifact.json' }];
  for (const entry of entries) {
    const target = join(context, entry.target);
    await mkdir(resolve(target, '..'), { recursive: true });
    await cp(entry.source, target, { preserveTimestamps: true });
  }
  await build({ entryPoints: ['src/runner/local-worker-entry.ts'], outfile: join(context, 'local-worker.mjs'), bundle: true,
    platform: 'node', target: 'node22', format: 'esm', banner: { js: "import { createRequire as __ratRequire } from 'node:module'; const require = __ratRequire(import.meta.url);" } });
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['--host', endpoint, 'build', '--platform', platform, '--target', 'worker', '--tag', 'docker.io/library/rat-things-local:1', context], { env: environment, stdio: 'inherit', shell: false });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Local worker image build failed')));
  });
  const image = JSON.parse(execFileSync('docker', ['--host', endpoint, 'image', 'inspect', 'docker.io/library/rat-things-local:1'], { env: environment, encoding: 'utf8', timeout: 10_000 }))[0];
  if (`${image.Os}/${image.Architecture}` !== platform) throw new Error('The built local worker image does not match the engine architecture.');
} finally { await rm(context, { recursive: true, force: true }); }
