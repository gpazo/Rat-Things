import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { TeamConnectionStore } from '../../src/client-connections.js';
import { startLocalServer } from '../../src/local-server.js';
import { developmentLocalCodexHost } from '../../src/runner/local-codex.js';
import type { TeamIdentityFixture } from '../aws/team-identities.js';
import { expectedProof, localRequest, signedAccount, subscriptionScenario, verificationProgram } from './installed-subscription.mjs';
import { NativeProofRuntime } from './native-vm/worker/runtime.js';
import { shareScenario, type LocalResponse } from './share-scenario.js';

export function parseDevelopmentShareArguments(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  assert(environment.RAT_DEVELOPMENT_SHARE_ACCEPTANCE === '1' && environment.AWS_E2E_REAL_CODEX === 'true',
    'Set RAT_DEVELOPMENT_SHARE_ACCEPTANCE=1 and AWS_E2E_REAL_CODEX=true for live development Share.');
  const { values } = parseArgs({ args, options: {
    directory: { type: 'string' }, assets: { type: 'string' }, model: { type: 'string' },
  } });
  assert(values.directory && values.assets && values.model, 'Supply --directory PRIVATE_SOURCE_PROFILE --assets NATIVE_PROOF_ASSETS --model MODEL_ID.');
  assert(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(values.model), 'Choose an explicit model supported by both providers.');
  return { directory: resolve(values.directory), assets: resolve(values.assets), model: values.model };
}

export async function developmentProfile(directory: string): Promise<string> {
  const canonical = await realpath(directory);
  const info = await lstat(canonical);
  assert(info.isDirectory() && info.uid === process.getuid!() && (info.mode & 0o077) === 0,
    'Use a private source profile owned by this user.');
  for (const marker of ['runtime', 'native-workspaces']) {
    assert(await absent(join(canonical, marker)), 'Development Share cannot reopen an installed runtime profile. Use a separately signed-in source profile.');
  }
  assert(await absent(join(canonical, 'connection.json')), 'Stop the source profile service before acceptance.');
  return canonical;
}

export function developmentAssetIdentity(value: unknown) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected a native development manifest.');
  const manifest = value as Record<string, unknown>;
  assert(manifest.prototype === true, 'Use native-proof development assets.');
  for (const field of ['initrdSha256', 'kernelSha256', 'helperSha256', 'fingerprint']) {
    assert(typeof manifest[field] === 'string' && /^[a-f0-9]{64}$/.test(manifest[field]), 'Native development identity is incomplete.');
  }
  assert(typeof manifest.sourceImage === 'string' && /^sha256:[a-f0-9]{64}$/.test(manifest.sourceImage), 'Native development source image is incomplete.');
  return { provenance: 'development-assets', initrdSha256: manifest.initrdSha256 as string,
    kernelSha256: manifest.kernelSha256 as string, helperSha256: manifest.helperSha256 as string,
    fingerprint: manifest.fingerprint as string, sourceImage: manifest.sourceImage };
}

async function main() {
  const options = parseDevelopmentShareArguments(process.argv.slice(2));
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Native development Share requires Apple silicon.');
  const directory = await developmentProfile(options.directory);
  const assets = await realpath(options.assets);
  const manifestBytes = await readFile(join(assets, 'manifest.json'));
  const assetIdentity = developmentAssetIdentity(JSON.parse(manifestBytes.toString()));
  const endpoint = required('SHARED_AGENTS_API_BASE_URL').replace(/\/$/, '');
  const region = required('AWS_REGION');
  const url = new URL(endpoint);
  assert(/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) && url.protocol === 'https:'
    && url.hostname.endsWith(`.lambda-url.${region}.on.aws`) && url.pathname === '/v1'
    && !url.username && !url.password && !url.search && !url.hash, 'Use the disposable shared API endpoint and region.');
  const operatorEndpoint = required('RAT_THINGS_AGENTS_API_URL');
  const fixture = JSON.parse(required('TEAM_OIDC_FIXTURE_JSON')) as TeamIdentityFixture;
  assert(isAbsolute(required('CODEX_BINARY')), 'Set CODEX_BINARY to the current host Codex executable.');
  const binary = await realpath(required('CODEX_BINARY'));
  const hostCodex = developmentLocalCodexHost(directory, { ...process.env, CODEX_BINARY: binary });
  const { stdout } = await promisify(execFile)(binary, ['--version'], {
    env: hostCodex().environment, timeout: 30_000, maxBuffer: 4096,
  });
  const packageJSON = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(stdout.trim(), `codex-cli ${packageJSON.devDependencies['@openai/codex']}`, 'Use the current source host Codex version.');
  const work = await mkdtemp(join(directory, 'development-share-'));
  const evidencePath = join(work, 'evidence.json');
  const nonce = randomUUID();
  const evidence: Record<string, unknown> = { version: 1, status: 'running', runtime: 'native-development',
    startedAt: new Date().toISOString(), directory, assets, model: options.model, nonce, endpoint, region,
    host: { source: 'current-checkout', controller: fileURLToPath(import.meta.url), binary, version: stdout.trim() },
    guest: { ...assetIdentity, manifestSha256: sha256(manifestBytes) }, observations: {},
    limits: ['development assets may predate current source; runtime integrity and command compatibility are checked independently',
      'no signed distribution or installed application claim',
      'normal Share and completed retry after graceful restarts; fault injection is covered by deterministic tests',
      'browser login exercises the real host PKCE helper; native UI controls are covered separately'],
    retained: { sourceProfile: directory, sourceWorkspaces: 'preserved', hostedSession: 'deployment cleanup' } };
  const save = () => writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const record = async (name: string, value: unknown) => {
    (evidence.observations as Record<string, unknown>)[name] = value;
    await save();
    console.log(`Development Share observed ${name}.`);
  };
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]);
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const store = new TeamConnectionStore(join(work, 'connections'));
  let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  let previousToken: string | undefined;
  let starts = 0;
  let failure = false;
  const localResponse: LocalResponse = async (path, method = 'GET', body) => {
    assert(server, 'Owned development service is unavailable.');
    return fetch(`${server.baseURL}${path}`, { method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  const request = async (method: string, path: string, body?: unknown) => {
    assert(server, 'Owned development service is unavailable.');
    return localRequest(server, method, path, body, signal);
  };
  const start = async () => {
    signal.throwIfAborted();
    await developmentProfile(directory);
    server = await startLocalServer({ directory, port: 0, maxSessions: 1, model: options.model,
      runtime: new NativeProofRuntime(directory, assets), hostCodex, shareConnection: input => store.client(input) });
    assert.notEqual(server.token, previousToken, 'Local restart must rotate authentication.');
    previousToken = server.token;
    const workspace = await request('GET', '/workspace');
    assert(workspace.kind === 'local' && workspace.directory === directory && workspace.service?.kind === 'development'
      && workspace.model_execution === 'subscription' && workspace.harness === 'codex' && workspace.max_sessions === 1);
    const runtime = await request('GET', '/workspace/runtime');
    assert(runtime.ready === true && runtime.platform === 'linux/arm64' && runtime.image === `native-proof:${assetIdentity.initrdSha256}`,
      'The integrity-checked native development runtime must be ready.');
    await record(`start${++starts}`, { service: workspace.service, runtime });
  };
  const stop = async () => {
    if (!server) return;
    await server.close();
    server = undefined;
    assert(await absent(join(directory, 'connection.json')), 'Development service left its connection record.');
  };
  try {
    await save();
    console.log(`Development Share evidence: ${evidencePath}`);
    await start();
    await record('account', signedAccount(await request('GET', '/workspace/subscription')));
    const local = await subscriptionScenario({ nonce, directory, model: options.model }, {
      request, restart: async () => { await stop(); await start(); }, record, signal,
    });
    Object.assign(evidence, local);
    const source = { ...local, nonce, files: expectedProof(nonce, verificationProgram(nonce, directory), 'resume').files };
    await record('localSubscription', { sessionId: source.sessionId, environmentId: source.environmentId, ...local.local });
    await stop();
    await shareScenario({ source, endpoint, region, operatorEndpoint, fixture, store }, { start, stop, localResponse, record, signal });
    evidence.status = 'passed';
  } catch (error) {
    failure = true;
    evidence.failureKind = error instanceof Error ? error.name : 'unknown';
    evidence.failedAfter = Object.keys(evidence.observations as Record<string, unknown>).at(-1) ?? 'preflight';
    evidence.status = 'failed';
    evidence.failure = signal.aborted ? 'Acceptance interrupted or exceeded its deadline.' : 'Development Share acceptance failed; inspect the last completed observation.';
  } finally {
    let serviceCleanup = 'complete';
    try { await stop(); }
    catch { serviceCleanup = 'failed'; failure = true; evidence.status = 'failed'; }
    evidence.cleanup = { service: serviceCleanup, share: (evidence.observations as Record<string, unknown>).shareCleanup ?? 'not_started' };
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    evidence.finishedAt = new Date().toISOString();
    await save();
    console.log(`Development Share evidence: ${evidencePath}`);
  }
  if (failure) throw new Error(`Development Share acceptance failed. Evidence: ${evidencePath}`);
}

async function absent(path: string) { try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } }
function required(name: string) { const value = process.env[name]; assert(value, `Missing ${name}.`); return value; }
function sha256(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(error instanceof Error && error.message.startsWith('Development Share acceptance failed.')
    ? error.message : 'Development Share could not start. Check explicit inputs and the private source profile.'); process.exitCode = 1; }
}
