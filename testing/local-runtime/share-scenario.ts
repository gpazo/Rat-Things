import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { createAgentsClient } from '../../src/agents-client.js';
import type { TeamConnectionStore } from '../../src/client-connections.js';
import { beginBrowserLogin, discoverTeamLogin, refreshLogin } from '../../src/client-oidc.js';
import type { AgentSession, AgentSessionItem, Turn } from '../../src/domain/agents-api.js';
import { createTeamIdentities, type TeamIdentityFixture } from '../aws/team-identities.js';
import { cloudCommand, commandProof } from './installed-cloud-transfer.mjs';

interface Activity { session: AgentSession; turns: Turn[]; items: AgentSessionItem[]; cursor: string }
interface SharePlan { id: string; source_session_id: string; destination_session_id: string | null; status: string; can_abort: boolean; error: string | null }
export interface ShareSource { sessionId: string; model: string; files: { path: string; bytes: number; sha256: string }[] }
export type LocalResponse = (path: string, method?: string, body?: unknown) => Promise<Response>;

export async function shareScenario({ source, endpoint, region, operatorEndpoint, fixture, store, contextMarker }: {
  contextMarker?: string; source: ShareSource; endpoint: string; region: string; operatorEndpoint: string; fixture: TeamIdentityFixture; store: TeamConnectionStore;
}, { start, stop, localResponse, record, signal }: {
  start(): Promise<void>; stop(): Promise<void>; localResponse: LocalResponse;
  record(name: string, value: unknown): Promise<void>; signal: AbortSignal;
}) {
  let identities: Awaited<ReturnType<typeof createTeamIdentities>> | undefined;
  let identitiesAttempted = false;
  let connectionId: string | undefined;
  let operationError: unknown;
  let phase = 'identities';
  const localJson = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await localResponse(path, method, body);
    if (!response.ok) throw new Error(`Local ${method} ${path} returned ${response.status}.`);
    return await response.json() as T;
  };
  try {
    signal.throwIfAborted();
    identitiesAttempted = true;
    identities = await createTeamIdentities(fixture, region, ['share-manager', 'share-collaborator', 'share-viewer']);
    const [manager, collaborator, viewer] = identities.users;
    assert(manager && collaborator && viewer);
    let spaceId = '';
    const team = async <T>(path: string, method = 'GET', body?: unknown, person = manager): Promise<T> => {
      const response = await fetch(`${endpoint}${path}`, { method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        headers: { authorization: `Bearer ${await person.accessTokenForRequest()}`, 'X-Rat-Space': spaceId, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error(`Team ${method} ${path} returned ${response.status}.`);
      return (response.status === 204 ? undefined : await response.json()) as T;
    };
    const operator = createAgentsClient({ baseURL: operatorEndpoint, region }).withOptions({ maxRetries: 0 });
    phase = 'space';
    const space = await operator.post<{ id: string }>('/rat/spaces', { body: { name: `Share ${randomUUID()}`, manager: { issuer: manager.issuer, subject: manager.subject } } });
    spaceId = space.id;
    await record('space', { id: spaceId });
    phase = 'team_policy';
    for (const [person, role] of [[collaborator, 'collaborator'], [viewer, 'viewer']] as const) {
      await team(`/rat/spaces/${spaceId}/bindings`, 'POST', { issuer: person.issuer, subject: person.subject, role, label: person.username });
    }
    await team(`/rat/spaces/${spaceId}/execution-roles/portable`, 'PUT', {
      name: 'Portable workspace', models: [source.model], tools: [],
      environments: [{ type: 'openai_hosted', network: { access: 'disabled' } }], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [],
    });
    phase = 'login_discovery';
    const discovery = await discoverTeamLogin(endpoint);
    const provider = discovery.login_providers.find(value => value.profile === 'cognito_access');
    assert(provider, 'Disposable Cognito login provider missing.');
    const attempt = await beginBrowserLogin(provider);
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      phase = 'login_form';
      await page.goto(attempt.url);
      await page.locator('input[name="username"]:visible').fill(collaborator.username);
      await page.locator('input[name="password"]:visible').fill(collaborator.loginPassword);
      await page.locator('input[name="signInSubmitButton"]:visible').click();
      phase = 'login_callback';
      const login = await attempt.result;
      assert.equal(login.identity.subject, collaborator.subject);
      phase = 'login_refresh';
      const renewed = await refreshLogin(provider, login.tokens);
      const connection = await store.save(endpoint, provider, { ...login, tokens: renewed });
      connectionId = connection.id;
      await record('browserLogin', { provider: provider.id, verifiedSubject: login.identity.subject, flow: 'authorization_code_pkce', refresh: 'provider_accepted', credentialsSavedPrivately: true });
    } finally { attempt.close(); await browser?.close(); }
    phase = 'source_start';
    await start();
    const before = await localJson<AgentSession>(`/agents/sessions/${source.sessionId}`);
    const beforeItems = await localJson<{ data: AgentSessionItem[]; has_more: boolean }>(`/agents/sessions/${source.sessionId}/items?limit=100&order=asc`);
    const beforeTurns = await localJson<{ data: Turn[]; has_more: boolean }>(`/agents/sessions/${source.sessionId}/turns?limit=100&order=asc`);
    assert(!beforeItems.has_more && !beforeTurns.has_more && beforeTurns.data.length === 2
      && beforeTurns.data.every(turn => turn.status === 'completed'));
    if (contextMarker !== undefined) {
      assert(!beforeItems.data.some(item => item.type === 'command_execution' && JSON.stringify(item).includes(contextMarker)),
        'Conversation-only marker appeared in a source command.');
      assert(!JSON.stringify({ agent: before.agent, environment: before.environment, metadata: before.metadata }).includes(contextMarker),
        'Conversation-only marker appeared in source configuration.');
    }
    const shareId = randomUUID();
    phase = 'share';
    const plan = await localJson<SharePlan>('/workspace/shares', 'POST', { id: shareId, session_id: source.sessionId, endpoint, region, space_id: spaceId, connection_id: connectionId });
    assert.equal(plan.id, shareId);
    const complete = await until(() => localJson<SharePlan>(`/workspace/shares/${shareId}`), value => {
      if (value.status === 'failed') throw new Error(`Share interrupted: ${value.error}`);
      return value.status === 'complete';
    }, 600_000, signal);
    assert.equal(complete.destination_session_id, source.sessionId);
    assert.equal(complete.can_abort, false);
    await record('share', complete);
    phase = 'source_restart_fence';
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
    phase = 'restored_history';
    const hosted = await team<Activity>(`/rat/sessions/${source.sessionId}/activity`, 'GET', undefined, viewer);
    assert.equal(hosted.session.id, before.id); assert.deepEqual(hosted.session.agent, before.agent);
    assert.deepEqual(hosted.turns, beforeTurns.data);
    assert.deepEqual(hosted.items, beforeItems.data);
    await record('restoredHistory', { sessionId: hosted.session.id, agentId: hosted.session.agent.id, model: hosted.session.agent.model,
      turns: hosted.turns.map(turn => turn.id), items: hosted.items.length, historySha256: sha256(JSON.stringify(hosted.items)), sourceRestartFenced: true });
    const proof = cloudCommand(randomUUID(), source);
    phase = 'hosted_continuation';
    await stop();
    await team(`/agents/sessions/${source.sessionId}/events`, 'POST', {
      events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: hostedContinuationInput(proof.command, contextMarker !== undefined) }] }] }],
    }, collaborator);
    await delay(10_000, undefined, { signal });
    const finished = await until(() => team<Activity>(`/rat/sessions/${source.sessionId}/activity`, 'GET', undefined, viewer), value => {
      const turn = value.turns.find(turn => !beforeTurns.data.some(previous => previous.id === turn.id));
      if (turn && ['failed', 'cancelled'].includes(turn.status)) throw new Error(`Hosted continuation ${turn.status}: ${turn.error?.code}`);
      return turn?.status === 'completed';
    }, 600_000, signal);
    const newTurns = finished.turns.filter(turn => !beforeTurns.data.some(previous => previous.id === turn.id));
    assert.equal(newTurns.length, 1);
    assert.deepEqual(finished.items.slice(0, beforeItems.data.length), beforeItems.data);
    const turn = newTurns[0]!;
    const hostedCommand = commandProof(finished.items, turn.id, proof);
    await record('hostedCommand', hostedCommand);
    if (contextMarker !== undefined) {
      phase = 'conversation_recall';
      await record('conversationRecall', conversationRecallProof(finished.items, turn.id, contextMarker, hostedCommand.commandId));
    }
    await record('sourceFiles', source.files);
  } catch (error) {
    operationError = error;
    await record('shareFailure', { phase, kind: error instanceof Error ? error.name : 'unknown' });
    throw error;
  } finally {
    const cleanup: Record<string, 'complete' | 'failed' | 'unconfirmed'> = {};
    const cleanupErrors: unknown[] = [];
    for (const [name, action] of [
      ['service', stop],
      ['connection', async () => { if (connectionId) await store.remove(connectionId); }],
      ['identities', async () => { await identities?.close(); }],
    ] as const) {
      try { await action(); cleanup[name] = 'complete'; }
      catch (error) { cleanup[name] = 'failed'; cleanupErrors.push(error); }
    }
    if (identitiesAttempted && !identities) cleanup.identities = 'unconfirmed';
    await record('shareCleanup', cleanup);
    if (cleanupErrors.length) throw new AggregateError([
      ...(operationError === undefined ? [] : [operationError]), ...cleanupErrors,
    ], 'Share cleanup could not be confirmed; inspect the retained evidence.');
  }
}

export function hostedContinuationInput(command: string, recallContext = false): string {
  const recall = recallContext ? ' In your final answer, recall the exact conversation-only marker from our earlier messages on a line of its own formatted RAT_CONVERSATION_RECALL followed by a space and the marker. Recover it only from the conversation. Do not search files or put the marker in a command.' : '';
  return `Continue our shared workspace.${recall} Run this exact command once, then report the output.\n${command}`;
}

export function conversationRecallProof(items: readonly AgentSessionItem[], turnId: string, marker: string, commandId: string) {
  assert(/^context_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(marker), 'Invalid conversation-only marker.');
  const tools = items.filter(item => item.turn_id === turnId && !['message', 'reasoning'].includes(item.type));
  assert.equal(tools.length, 1, 'Conversation recall must not use additional retrieval tools.');
  assert(tools[0]?.type === 'command_execution' && tools[0].id === commandId, 'Conversation recall must use only the verified workspace command.');
  assert(!JSON.stringify(tools[0]).includes(marker), 'Conversation-only marker appeared in hosted tool activity.');
  const answers = items.filter(item => item.type === 'message').filter(item => item.role === 'assistant'
    && item.status === 'completed' && item.phase === 'final_answer' && item.turn_id === turnId);
  const matches = answers.flatMap(item => {
    assert(typeof item.id === 'string' && item.id.length <= 200, 'Conversation recall message has no bounded identity.');
    const text = item.content.filter(part => part.type === 'output_text').map(part => part.text).join('\n');
    assert(Buffer.byteLength(text) <= 64 * 1024, 'Conversation recall answer exceeded its limit.');
    return text.split(/\r?\n/).filter(line => line.trim() === `RAT_CONVERSATION_RECALL ${marker}`).map(() => item.id);
  });
  assert.equal(matches.length, 1, 'Hosted final answer did not recall the exact conversation-only marker.');
  return { turnId, messageId: matches[0]!, markerSha256: sha256(marker), source: 'assistant.final_answer', recalled: true };
}

export async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, milliseconds: number, signal?: AbortSignal): Promise<T> {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    const value = await read();
    if (predicate(value)) return value;
    await delay(500, undefined, { signal });
  }
  throw new Error('Acceptance operation did not complete before its deadline.');
}
function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }
