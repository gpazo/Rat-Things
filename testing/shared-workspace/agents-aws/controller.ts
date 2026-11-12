import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { createAgentsClient } from '../../../src/agents-client.js';
import { TeamConnectionStore } from '../../../src/client-connections.js';
import { beginBrowserLogin, discoverTeamLogin } from '../../../src/client-oidc.js';
import { ConsoleTeams } from '../../../src/console-team.js';
import { startLocalServer } from '../../../src/local-server.js';
import { createTeamIdentities, type TeamIdentityFixture, type TestTeamIdentity } from '../../aws/team-identities.js';
import { createAgentsAwsRelayHandler } from './relay.js';

// Conversation-only (environment "none"), so neither this Mac nor AWS starts a Linux workspace.
// Live proof of the local-first flow: Claude works alone on this Mac, Shares the Session to a
// disposable AWS team space, invites Codex with a link, and both continue the hosted Session.
// A loopback relay then holds both verified sign-ins in memory so each participant (and one native
// console per participant) can act through its own identity. Tokens never leave this process.
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const required = (key: string): string => { const value = process.env[key]; assert(value, `Missing ${key}`); return value; };
assert.equal(process.env.AGENTS_AWS_LIVE, 'true', 'Set AGENTS_AWS_LIVE=true for this paid live proof.');
assert.equal(process.env.AWS_E2E, 'true'); assert.equal(process.env.AWS_E2E_REAL_CODEX, 'true'); assert.equal(process.env.AWS_E2E_SHARED_SESSIONS, 'true');
assert.equal(process.env.AWS_E2E_CODEX_MODEL_ID, 'openai.gpt-5.6-luna', 'This bounded proof only permits the selected inexpensive model.');
const model = 'gpt-5.6-luna';
const endpoint = required('SHARED_AGENTS_API_BASE_URL').replace(/\/$/, '');
const region = required('AWS_REGION');
assert(new URL(endpoint).hostname.endsWith(`.lambda-web.${region}.on.aws`) && new URL(endpoint).pathname === '/v1', 'Use the disposable shared API.');
const operatorEndpoint = `${required('RAT_THINGS_API_URL').replace(/\/$/, '')}/v1`;
const fixture = JSON.parse(required('TEAM_OIDC_FIXTURE_JSON')) as TeamIdentityFixture;
const profile = resolve(process.env.RAT_THINGS_LOCAL_DIR ?? join(homedir(), '.rat-things', 'multiplayer-demo'));
// AGENTS_AWS_INVITE_ONLY checks team sign-in and invite links without Docker, Share or model calls.
const inviteOnly = process.env.AGENTS_AWS_INVITE_ONLY === 'true';
const maxHostedTurns = Number(process.env.AGENTS_AWS_MAX_HOSTED_TURNS ?? 4);
const spendLimit = 1;
const started = Date.now();
const deadline = started + Number(process.env.AGENTS_AWS_MAX_MINUTES ?? 75) * 60_000;
const title = 'Local first, then shared';
const price = { input: .22, cached: .022, output: 1.32 };
const output = resolve('artifacts/shared-workspace/agents-aws'); await mkdir(output, { recursive: true });
const work = await mkdtemp(join(profile, 'aws-live-'));
const relayDirectory = join(work, 'relay'); await mkdir(relayDirectory, { mode: 0o700 });
const evidence: Record<string, unknown> = { proof: 'local-share-invite-collaborate', model: { local: `${model} via ChatGPT subscription`, hosted: 'openai.gpt-5.6-luna via Amazon Bedrock' },
  started_at: new Date(started).toISOString(), endpoint, region, steps: [], limits: { max_hosted_turns: maxHostedTurns, inference_usd: spendLimit, deadline_minutes: (deadline - started) / 60_000 },
  limitations: ['Participants are AI agents using disposable Cognito users', 'Native consoles reach AWS through a loopback relay holding each verified sign-in, not through separate desktop installs', 'Inference estimate uses list prices; infrastructure billing is separate'] };
const step = async (name: string, detail: Record<string, unknown> = {}) => {
  (evidence.steps as unknown[]).push({ name, elapsed_ms: Date.now() - started, ...detail });
  console.log(JSON.stringify({ step: name, elapsed_ms: Date.now() - started, ...detail }));
  await writeFile(join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
};

let identities: Awaited<ReturnType<typeof createTeamIdentities>> | undefined;
let local: Awaited<ReturnType<typeof startLocalServer>> | undefined;
let spaceId = '';
let sessionId = '';
let importedTurns = 0;
const claudeStore = new TeamConnectionStore(join(work, 'claude-connections'));
const codexStore = new TeamConnectionStore(join(work, 'codex-connections'));
const teams = new ConsoleTeams(codexStore);
const relay = createServer();
const connectionFile = join(relayDirectory, 'agents-live.json');

const team = async <T>(person: TestTeamIdentity, path: string, method = 'GET', body?: unknown): Promise<T> => {
  const response = await fetch(`${endpoint}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${await person.accessTokenForRequest()}`, ...(spaceId ? { 'X-Rat-Space': spaceId } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) { const error = await response.json().catch(() => ({})) as { error?: { code?: string } }; throw new HttpError(response.status, `${method} ${path} returned ${response.status} ${error.error?.code ?? ''}`); }
  return (response.status === 204 ? undefined : await response.json()) as T;
};
const localJson = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  assert(local, 'Local service is not running.');
  const response = await fetch(`${local.baseURL}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new HttpError(response.status, `Local ${method} ${path} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json() as T;
};
// The real Cognito hosted page, driven by headless Chromium; passwords stay in this process.
async function hostedSignIn(url: string, person: TestTeamIdentity) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.locator('input[name="username"]:visible').fill(person.username);
    await page.locator('input[name="password"]:visible').fill(person.loginPassword);
    await page.locator('input[name="signInSubmitButton"]:visible').click();
    await page.waitForURL(/127\.0\.0\.1/, { timeout: 60_000 }).catch(() => undefined);
  } finally { await browser.close(); }
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout: number): Promise<T> {
  const end = Math.min(deadline, Date.now() + timeout);
  do { const value = await read(); if (done(value)) return value; await delay(1000); } while (Date.now() < end);
  throw new Error('Timed out waiting for a live condition.');
}
interface Activity { session: { agent: { id: string } }; turns: Array<{ id: string; status: string; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }>; items: Array<{ type: string; role?: string }>; inputs: Array<{ actor?: { label?: string } }> }
function hostedUsage(activity: Activity) {
  const hosted = activity.turns.slice(importedTurns);
  const tokens = hosted.reduce((sum, turn) => ({ input: sum.input + (turn.usage?.input_tokens ?? 0), cached: sum.cached + (turn.usage?.input_tokens_details?.cached_tokens ?? 0), output: sum.output + (turn.usage?.output_tokens ?? 0) }), { input: 0, cached: 0, output: 0 });
  const usd = ((tokens.input - tokens.cached) * price.input + tokens.cached * price.cached + tokens.output * price.output) / 1_000_000;
  return { turns: hosted.length, tokens, estimated_usd: Number(usd.toFixed(5)) };
}

let closing: Promise<void> | undefined;
const close = (reason: string) => closing ??= (async () => {
  relay.closeAllConnections(); relay.close();
  await rm(connectionFile, { force: true });
  const cleanup: Record<string, string> = {};
  const [claude] = identities?.users ?? [];
  if (claude && sessionId) {
    try {
      const final = await team<Activity>(claude, `/rat/sessions/${sessionId}/activity`);
      evidence.hosted = { ...hostedUsage(final), statuses: final.turns.map(turn => turn.status), imported_turns: importedTurns,
        contributors: [...new Set(final.inputs.map(input => input.actor?.label).filter(Boolean))] };
      await team(claude, `/agents/sessions/${sessionId}`, 'DELETE'); cleanup.hosted_session = 'deleted';
      await team(claude, `/agents/${final.session.agent.id}`, 'DELETE').then(() => { cleanup.hosted_agent = 'deleted'; }, () => { cleanup.hosted_agent = 'retained; removed by stack teardown'; });
    } catch { cleanup.hosted_session = 'not confirmed; removed by stack teardown'; }
  }
  try { await local?.close(); cleanup.local_service = 'stopped'; } catch { cleanup.local_service = 'failed'; }
  for (const [name, store] of [['claude', claudeStore], ['codex', codexStore]] as const) {
    try { for (const connection of await store.list()) await store.remove(connection.id); cleanup[`${name}_connection`] = 'removed'; } catch { cleanup[`${name}_connection`] = 'failed'; }
  }
  teams.close();
  try { await identities?.close(); cleanup.identities = 'removed'; } catch { cleanup.identities = 'failed'; }
  await rm(work, { recursive: true, force: true });
  evidence.cleanup = cleanup; evidence.stopped = reason; evidence.finished_at = new Date().toISOString();
  await writeFile(join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ stopped: reason, cleanup, hosted: evidence.hosted }));
})();
process.stdin.resume(); process.stdin.on('end', () => { void close('stdin closed').then(() => process.exit()); });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void close(signal).then(() => process.exit()); });
setTimeout(() => { void close('deadline').then(() => process.exit()); }, deadline - Date.now()).unref();

try {
  identities = await createTeamIdentities(fixture, region, ['claude', 'codex']);
  const [claude, codex] = identities.users as [TestTeamIdentity, TestTeamIdentity];
  const operator = createAgentsClient({ baseURL: operatorEndpoint, region }).withOptions({ maxRetries: 0 });
  spaceId = (await operator.post<{ id: string }>('/rat/spaces', { body: { name: 'Claude + Codex', manager: { issuer: claude.issuer, subject: claude.subject, label: 'Claude · Claude Code' } } })).id;
  await team(claude, `/rat/spaces/${spaceId}/execution-roles/portable`, 'PUT', { name: 'Portable workspace', models: [model], tools: [],
    environments: [{ type: 'none' }], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [] });
  await step('team space created; Claude is its only member (manager)', { space_id: spaceId });

  const discovery = await discoverTeamLogin(endpoint);
  const provider = discovery.login_providers.find(value => value.profile === 'cognito_access');
  assert(provider, 'Disposable Cognito provider missing.');
  const attempt = await beginBrowserLogin(provider);
  try { await hostedSignIn(attempt.url, claude); const login = await attempt.result; assert.equal(login.identity.subject, claude.subject);
    await claudeStore.save(endpoint, provider, login); } finally { attempt.close(); }
  const [claudeConnection] = await claudeStore.list(); assert(claudeConnection);
  await step('Claude signed in to the team from this Mac (Cognito hosted page, PKCE)');

  if (!inviteOnly) {
  local = await startLocalServer({ directory: profile, port: 0, maxSessions: 1, model, shareConnection: input => claudeStore.client(input) });
  const account = await localJson<{ signed_in?: boolean }>('/workspace/subscription');
  assert(account.signed_in, 'Sign in the local demo profile to the ChatGPT subscription first.');
  const brief = process.env.AGENTS_AWS_BRIEF ?? [
    "I'm Claude (Claude Code), working alone on this Mac before anyone else joins.",
    'Draft a five-beat outline for a 60-second video about Rat Things going from local to shared.',
    'Beats: work locally, Share the Session to the team space, invite Codex with a link, Codex joins, we finish together.',
    'Keep it under 120 words and reply with the outline.',
  ].join(' ');
  const session = await localJson<{ id: string }>('/agents/sessions', 'POST', {
    metadata: { name: title }, agent: { model, multi_agent: { enabled: false }, instructions: 'You are the shared agent in a Rat Things Session. Participants are Claude (Claude Code) and, later, Codex (Codex CLI). Address them by name. Keep replies under 120 words.' },
    environment: { type: 'none' }, input: brief });
  sessionId = session.id;
  const localTurn = await until(() => localJson<{ data: Array<{ id: string; status: string; usage?: unknown }> }>(`/agents/sessions/${sessionId}/turns?limit=10&order=desc`),
    value => { const turn = value.data[0]; assert(!turn || !['failed', 'cancelled'].includes(turn.status), `Local Turn ${turn?.status}`); return turn?.status === 'completed'; }, 300_000);
  evidence.local = { session_id: sessionId, turn: localTurn.data[0] };
  await step('local Turn completed on the ChatGPT subscription', { session_id: sessionId });

  const shareId = randomUUID();
  await localJson('/workspace/shares', 'POST', { id: shareId, session_id: sessionId, endpoint, region, space_id: spaceId, connection_id: claudeConnection.id });
  const shared = await until(() => localJson<{ status: string; error: string | null; destination_session_id: string | null }>(`/workspace/shares/${shareId}`),
    value => { assert(value.status !== 'failed', `Share failed: ${value.error}`); return value.status === 'complete'; }, 600_000);
  assert.equal(shared.destination_session_id, sessionId);
  const blocked = await fetch(`${local.baseURL}/agents/sessions/${sessionId}/events`, { method: 'POST', headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'This must not run locally.' }] }] }] }) });
  assert.equal(blocked.status, 409); await blocked.body?.cancel();
  await local.close(); local = undefined;
  await step('Session shared to AWS; the local copy is fenced', { share: shared });
  }

  const created = await team<{ id: string; token: string; role: string; expires_at: number }>(claude, `/rat/spaces/${spaceId}/invites`, 'POST', { role: 'collaborator', label: 'Codex · Codex CLI' });
  const link = `${endpoint}/rat/invites#${created.token}`;
  const open = await team<{ data: Array<Record<string, unknown>> }>(claude, `/rat/spaces/${spaceId}/invites`);
  assert.equal(open.data.length, 1); assert(!JSON.stringify(open).includes(created.token));
  await assert.rejects(team(codex, inviteOnly ? `/rat/spaces/${spaceId}/bindings` : `/rat/sessions/${sessionId}/activity`), (error: unknown) => error instanceof HttpError && error.status === 403);
  await step('Claude created a single-use collaborator invite; Codex has no access yet', { invite_id: created.id, expires_at: created.expires_at });

  // Codex joins through the desktop's own join path: parse link, sign in, redeem.
  let joining = await teams.route('POST', '/join', { invite: link }) as Record<string, unknown>;
  if (joining.status === 'choose_provider') joining = await teams.route('POST', '/login', { endpoint, provider_id: provider.id, invite: link }) as Record<string, unknown>;
  assert.equal(joining.status, 'waiting');
  await hostedSignIn(String(joining.url), codex);
  const joined = await until(async () => await teams.route('GET', `/login/${String(joining.id)}`, {}) as { status: string; joined?: { space: { id: string }; role: string }; invite_error?: string },
    value => value.status !== 'waiting', 120_000);
  assert.equal(joined.status, 'complete'); assert(!joined.invite_error, joined.invite_error);
  assert.equal(joined.joined?.space.id, spaceId); assert.equal(joined.joined?.role, 'collaborator');
  const codexSpaces = await team<{ data: Array<{ id: string; role: string }> }>(codex, '/rat/spaces');
  assert(codexSpaces.data.some(space => space.id === spaceId && space.role === 'collaborator'));
  await assert.rejects(team(codex, '/rat/invites/redeem', 'POST', { token: created.token }), (error: unknown) => error instanceof HttpError && error.status === 404);
  assert.equal((await team<{ data: unknown[] }>(claude, `/rat/spaces/${spaceId}/invites`)).data.length, 0);
  await step('Codex joined with the link via the desktop join flow; the link is now spent', { role: joined.joined?.role });

  if (inviteOnly) {
    await assert.rejects(team(codex, `/rat/spaces/${spaceId}/invites`, 'POST', { role: 'viewer' }), (error: unknown) => error instanceof HttpError && error.status === 403);
    const spare = await team<{ id: string; token: string }>(claude, `/rat/spaces/${spaceId}/invites`, 'POST', { role: 'viewer', expires_in: 300 });
    await team(claude, `/rat/spaces/${spaceId}/invites/${spare.id}`, 'DELETE');
    await assert.rejects(team(claude, '/rat/invites/redeem', 'POST', { token: spare.token }), (error: unknown) => error instanceof HttpError && error.status === 404);
    await step('collaborators cannot create invites; a revoked link is refused');
    evidence.status = 'passed';
    await close('invite-only checks complete'); process.exit(0);
  }
  const hosted = await team<Activity>(codex, `/rat/sessions/${sessionId}/activity`);
  importedTurns = hosted.turns.length;
  assert(importedTurns >= 1 && hosted.items.some(item => item.type === 'message' && item.role === 'assistant'));
  await step('Codex reads the shared history from AWS', { imported_turns: importedTurns, items: hosted.items.length });

  const participants = [
    { name: 'claude', person: claude, label: 'Claude · Claude Code', loopback: randomUUID() },
    { name: 'codex', person: codex, label: 'Codex · Codex CLI', loopback: randomUUID() },
  ];
  relay.on('request', createAgentsAwsRelayHandler({ participants, endpoint, spaceId, sessionId, maxHostedTurns, spendLimit,
    team,
    hostedUsage: async () => hostedUsage(await team<Activity>(claude, `/rat/sessions/${sessionId}/activity`)),
  }));
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const address = relay.address(); assert(address && typeof address !== 'string');
  const details = { url: `http://127.0.0.1:${address.port}`, sessionId, title, model: 'openai.gpt-5.6-luna',
    participants: Object.fromEntries(participants.map(entry => [entry.name, { token: entry.loopback, label: entry.label }])) };
  await writeFile(`${connectionFile}.tmp`, JSON.stringify(details), { mode: 0o600 }); await rename(`${connectionFile}.tmp`, connectionFile);
  await step('relay ready for both participants', { relay_directory: relayDirectory });
} catch (error) {
  evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : String(error);
  console.error(evidence.error);
  await close('failure'); process.exit(1);
}

