import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { TeamConnectionStore } from '../../src/client-connections.js';
import type { TeamIdentityFixture } from '../aws/team-identities.js';
import { connectionRecord, nativeIdentity } from './installed-subscription.mjs';
import { subscriptionEvidence } from './installed-cloud-transfer.mjs';
import { shareScenario, until } from './share-scenario.js';

interface LocalConnection { baseURL: string; token: string }
async function main() {
  if (process.env.RAT_INSTALLED_SHARE_ACCEPTANCE !== '1' || process.env.AWS_E2E_REAL_CODEX !== 'true') {
    throw new Error('Set RAT_INSTALLED_SHARE_ACCEPTANCE=1 and AWS_E2E_REAL_CODEX=true for live local/AWS Share.');
  }
  const { values } = parseArgs({ options: Object.fromEntries(['app', 'directory', 'evidence'].map(name => [name, { type: 'string' as const }])) });
  const app = await realpath(requiredValue(values.app, '--app'));
  const directory = await realpath(requiredValue(values.directory, '--directory'));
  const inputPath = await realpath(requiredValue(values.evidence, '--evidence'));
  assert(process.platform === 'darwin' && process.arch === 'arm64');
  const info = await lstat(directory);
  assert(info.isDirectory() && info.uid === process.getuid!() && (info.mode & 0o077) === 0);
  assert(app.endsWith('.app') && inputPath.startsWith(`${directory}/`) && !app.startsWith(`${directory}/`));
  const endpoint = required('SHARED_AGENTS_API_BASE_URL').replace(/\/$/, '');
  const region = required('AWS_REGION');
  const url = new URL(endpoint);
  assert(url.protocol === 'https:' && url.hostname.endsWith(`.lambda-url.${region}.on.aws`) && url.pathname === '/v1');
  const manifestBytes = await readFile(join(app, 'Contents/Resources/Runtime.bundle/Contents/Resources/runtime-manifest.json'));
  const releaseId = sha256(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString());
  const source = subscriptionEvidence(JSON.parse(await readFile(inputPath, 'utf8')), { app, directory, releaseId });
  const connectionPath = join(directory, 'connection.json');
  assert(await absent(connectionPath), 'Stop the profile service before starting Share acceptance.');
  const work = await mkdtemp(join(directory, 'installed-share-'));
  for (const name of ['home', 'tmp', 'cwd']) await mkdir(join(work, name), { mode: 0o700 });
  const evidencePath = join(work, 'evidence.json');
  const evidence: Record<string, unknown> = { version: 1, status: 'running', startedAt: new Date().toISOString(), app, directory, releaseId,
    sourceSessionId: source.sessionId, sourceEvidence: inputPath, endpoint, region, observations: {},
    limits: ['normal handoff and completed retry after service restart; fault injection covered by separate deterministic tests',
      'browser login uses the real host client helper; native button behavior is covered separately',
      'workspace hashes observed through successful exact commands, without reading private host snapshots'] };
  const record = async (name: string, value: unknown) => {
    (evidence.observations as Record<string, unknown>)[name] = value;
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  };
  const store = new TeamConnectionStore(join(work, 'home', '.rat-things', 'connections'));
  let service: ReturnType<typeof startProcess> | undefined;
  let local: LocalConnection | undefined;
  const localResponse = async (path: string, method = 'GET', body?: unknown) => {
    assert(local && service && !service.exited, 'Owned installed service is unavailable.');
    return fetch(`${local.baseURL}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  const localJson = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await localResponse(path, method, body);
    if (!response.ok) throw new Error(`Installed ${method} ${path} returned ${response.status}.`);
    return await response.json() as T;
  };
  const start = async () => {
    assert(await absent(connectionPath));
    service = startProcess(join(app, 'Contents/MacOS/rat-things'), ['serve', '--port', '0', '--max-sessions', '1'], join(work, 'cwd'), {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(work, 'home'), TMPDIR: `${join(work, 'tmp')}/`,
      LANG: 'C', RAT_THINGS_LOCAL_DIR: directory,
    });
    await until(async () => {
      assert(!service!.exited, 'Installed service exited before readiness.');
      if (await absent(connectionPath)) return false;
      local = connectionRecord(JSON.parse(await readFile(connectionPath, 'utf8'))) as LocalConnection;
      return (await localJson<{ ready: boolean }>('/workspace/runtime')).ready;
    }, ready => ready, 180_000);
    await record('installedIdentity', nativeIdentity(await localJson('/workspace'), manifest, directory));
  };
  const stop = async () => { if (service) { await service.stop(); service = undefined; local = undefined; assert(await absent(connectionPath)); } };
  try {
    await shareScenario({ source, endpoint, region, store, operatorEndpoint: required('RAT_THINGS_AGENTS_API_URL'),
      fixture: JSON.parse(required('TEAM_OIDC_FIXTURE_JSON')) as TeamIdentityFixture,
    }, { start, stop, localResponse, record, signal: AbortSignal.timeout(30 * 60_000) });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = error instanceof Error ? error.message : 'Share acceptance failed.';
    throw error;
  } finally {
    evidence.cleanup = (evidence.observations as Record<string, unknown>).shareCleanup;
    evidence.finishedAt = new Date().toISOString();
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(`Installed Share evidence: ${evidencePath}`);
  }
}

function startProcess(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false; let bytes = 0;
  for (const output of [child.stdout, child.stderr]) output.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) child.kill('SIGTERM'); });
  const done = new Promise<number | null>((resolveDone, reject) => { child.once('error', reject); child.once('close', code => { exited = true; resolveDone(code); }); });
  void done.catch(() => undefined);
  return { get exited() { return exited; }, stop: async () => {
    if (!exited) child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Installed service did not stop; profile retained.')), 60_000); })]);
      assert.equal(result, 0, 'Installed service did not exit cleanly.');
    } finally { if (timer) clearTimeout(timer); }
  } };
}
async function absent(path: string) { try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } }
function required(name: string) { return requiredValue(process.env[name], name); }
function requiredValue(value: unknown, name: string): string { if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}.`); return value; }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }

if (resolve(process.argv[1] ?? '') === new URL(import.meta.url).pathname) await main();
