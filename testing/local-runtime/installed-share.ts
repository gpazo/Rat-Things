import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { createAgentsClient } from '../../src/agents-client.js';
import { TeamConnectionStore } from '../../src/client-connections.js';
import { beginBrowserLogin, discoverTeamLogin, refreshLogin } from '../../src/client-oidc.js';
import type { AgentSession, AgentSessionItem, Turn } from '../../src/domain/agents-api.js';
import { createTeamIdentities, type TeamIdentityFixture } from '../aws/team-identities.js';
import { connectionRecord, nativeIdentity } from './installed-subscription.mjs';
import { cloudCommand, commandProof, subscriptionEvidence } from './installed-cloud-transfer.mjs';

interface LocalConnection { baseURL: string; token: string }
interface Activity { session: AgentSession; turns: Turn[]; items: AgentSessionItem[]; cursor: string }
interface SharePlan { id: string; source_session_id: string; destination_session_id: string | null; status: string; can_abort: boolean; error: string | null }

/** Real installed source + real Cognito browser login + same-ID hosted execution. */
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
  const identities = await createTeamIdentities(JSON.parse(required('TEAM_OIDC_FIXTURE_JSON')) as TeamIdentityFixture, region, ['share-manager', 'share-collaborator', 'share-viewer']);
  const [manager, collaborator, viewer] = identities.users;
  assert(manager && collaborator && viewer);
  // Installed launchers deliberately filter executable/configuration overrides.
  // Use the normal host store under this controller's private child HOME.
  const store = new TeamConnectionStore(join(work, 'home', '.rat-things', 'connections'));
  let connectionId: string | undefined;
  let service: ReturnType<typeof startProcess> | undefined;
  let local: LocalConnection | undefined;
  let spaceId = '';
  let operationError: unknown;
  const team = async <T>(path: string, method = 'GET', body?: unknown, person = manager): Promise<T> => {
    const response = await fetch(`${endpoint}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${await person.accessTokenForRequest()}`, 'X-Rat-Space': spaceId, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Team ${method} ${path} returned ${response.status}.`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
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
    const operator = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 0 });
    const space = await operator.post<{ id: string }>('/rat/spaces', { body: { name: `Share ${randomUUID()}`, manager: { issuer: manager.issuer, subject: manager.subject } } });
    spaceId = space.id;
    await record('space', { id: spaceId });
    for (const [person, role] of [[collaborator, 'collaborator'], [viewer, 'viewer']] as const) {
      await team(`/rat/spaces/${spaceId}/bindings`, 'POST', { issuer: person.issuer, subject: person.subject, role, label: person.username });
    }
    await team(`/rat/spaces/${spaceId}/execution-roles/portable`, 'PUT', {
      name: 'Portable workspace', models: [source.model], tools: [],
      environments: [{ type: 'openai_hosted', network: { access: 'disabled' } }], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [],
    });
    const discovery = await discoverTeamLogin(endpoint);
    const provider = discovery.login_providers.find(value => value.profile === 'cognito_access');
    assert(provider, 'Disposable Cognito login provider missing.');
    const attempt = await beginBrowserLogin(provider);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(attempt.url);
      await page.locator('input[name="username"]:visible').fill(collaborator.username);
      await page.locator('input[name="password"]:visible').fill(collaborator.loginPassword);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const login = await attempt.result;
      assert.equal(login.identity.subject, collaborator.subject);
      const renewed = await refreshLogin(provider, login.tokens);
      const connection = await store.save(endpoint, provider, { ...login, tokens: renewed });
      connectionId = connection.id;
      await record('browserLogin', { provider: provider.id, verifiedSubject: login.identity.subject, flow: 'authorization_code_pkce', refresh: 'provider_accepted', credentialsSavedPrivately: true });
    } finally { attempt.close(); await browser.close(); }
    await start();
    const before = await localJson<AgentSession>(`/agents/sessions/${source.sessionId}`);
    const beforeItems = await localJson<{ data: AgentSessionItem[]; has_more: boolean }>(`/agents/sessions/${source.sessionId}/items?limit=100&order=asc`);
    const beforeTurns = await localJson<{ data: Turn[]; has_more: boolean }>(`/agents/sessions/${source.sessionId}/turns?limit=100&order=asc`);
    assert(!beforeItems.has_more && !beforeTurns.has_more && beforeTurns.data.length === 2);
    const shareId = randomUUID();
    const plan = await localJson<SharePlan>('/workspace/shares', 'POST', { id: shareId, session_id: source.sessionId, endpoint, region, space_id: spaceId, connection_id: connectionId });
    assert.equal(plan.id, shareId);
    const complete = await until(() => localJson<SharePlan>(`/workspace/shares/${shareId}`), value => {
      if (value.status === 'failed') throw new Error(`Share interrupted: ${value.error}`);
      return value.status === 'complete';
    }, 600_000);
    assert.equal(complete.destination_session_id, source.sessionId);
    assert.equal(complete.can_abort, false);
    await record('share', complete);
    await stop();
    await start();
    const retried = await localJson<SharePlan>(`/workspace/shares/${shareId}`, 'POST');
    assert.equal(retried.destination_session_id, source.sessionId);
    assert.equal(retried.status, 'complete');
    const input = { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'This must never run locally.' }] }] }] };
    const blocked = await localResponse(`/agents/sessions/${source.sessionId}/events`, 'POST', input);
    assert.equal(blocked.status, 409); await blocked.body?.cancel();
    const abort = await localResponse(`/workspace/shares/${shareId}`, 'DELETE');
    assert.equal(abort.status, 409); await abort.body?.cancel();
    const hosted = await team<Activity>(`/rat/sessions/${source.sessionId}/activity`, 'GET', undefined, viewer);
    assert.equal(hosted.session.id, before.id); assert.deepEqual(hosted.session.agent, before.agent);
    assert.deepEqual(hosted.turns, beforeTurns.data);
    assert.deepEqual(hosted.items, beforeItems.data);
    await record('restoredHistory', { sessionId: hosted.session.id, agentId: hosted.session.agent.id, model: hosted.session.agent.model,
      turns: hosted.turns.map(turn => turn.id), items: hosted.items.length, historySha256: sha256(JSON.stringify(hosted.items)), sourceRestartFenced: true });
    const proof = cloudCommand(randomUUID(), source);
    await team(`/agents/sessions/${source.sessionId}/events`, 'POST', {
      events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: `Continue our shared workspace. Run this exact command once, then report the output.\n${proof.command}` }] }] }],
    }, collaborator);
    await stop();
    await delay(10_000); // No local service or viewer drives this hosted Turn.
    const finished = await until(() => team<Activity>(`/rat/sessions/${source.sessionId}/activity`, 'GET', undefined, viewer), value => {
      const turn = value.turns.find(turn => !beforeTurns.data.some(previous => previous.id === turn.id));
      if (turn && ['failed', 'cancelled'].includes(turn.status)) throw new Error(`Hosted continuation ${turn.status}: ${turn.error?.code}`);
      return turn?.status === 'completed';
    }, 600_000);
    const turn = finished.turns.find(turn => !beforeTurns.data.some(previous => previous.id === turn.id))!;
    await record('hostedCommand', commandProof(finished.items, turn.id, proof));
    await record('sourceFiles', source.files);
    evidence.status = 'passed';
  } catch (error) {
    operationError = error;
    evidence.status = 'failed';
    evidence.failure = error instanceof Error ? error.message : 'Share acceptance failed.';
    throw error;
  } finally {
    const cleanup: Record<string, 'complete' | 'failed'> = {};
    const cleanupErrors: unknown[] = [];
    for (const [name, action] of [
      ['service', stop],
      ['connection', async () => { if (connectionId) await store.remove(connectionId); }],
      ['identities', () => identities.close()],
    ] as const) {
      try { await action(); cleanup[name] = 'complete'; }
      catch (error) { cleanup[name] = 'failed'; cleanupErrors.push(error); }
    }
    evidence.cleanup = cleanup;
    if (cleanupErrors.length) evidence.status = 'failed';
    evidence.finishedAt = new Date().toISOString();
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(`Installed Share evidence: ${evidencePath}`);
    if (cleanupErrors.length) throw new AggregateError([
      ...(operationError === undefined ? [] : [operationError]), ...cleanupErrors,
    ], 'Installed Share cleanup could not be confirmed; inspect the retained evidence.');
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
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, milliseconds: number): Promise<T> {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await delay(500); }
  throw new Error('Acceptance operation did not complete before its deadline.');
}
async function absent(path: string) { try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } }
function required(name: string) { return requiredValue(process.env[name], name); }
function requiredValue(value: unknown, name: string): string { if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}.`); return value; }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }

if (resolve(process.argv[1] ?? '') === new URL(import.meta.url).pathname) await main();
