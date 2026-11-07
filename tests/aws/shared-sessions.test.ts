import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import OpenAI from 'openai';
import { createAgentsClient } from '../../src/agents-client.js';
import type { AgentSession, AgentSessionItem, Turn } from '../../src/domain/agents-api.js';
import { createTeamIdentities, type TeamIdentityFixture, type TestTeamIdentity } from '../../testing/aws/team-identities.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_SHARED_SESSIONS === 'true' ? it : it.skip;
const timeout = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
interface Activity {
  session: AgentSession;
  turns: Turn[];
  items: AgentSessionItem[];
  cursor: string;
  inputs: { id: string; actor: { id: string; subject?: string }; sequence: number; status: string; message_ids: string[] }[];
}

live('shares real execution and progress across verified team identities with revocation and reconnect', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Shared Session proof requires explicit real model opt-in.');
  const baseURL = required('SHARED_AGENTS_API_BASE_URL').replace(/\/$/, '');
  const endpoint = new URL(baseURL);
  const region = required('AWS_REGION');
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith(`.lambda-url.${region}.on.aws`)) {
    throw new Error('Use the disposable application-authenticated Lambda URL.');
  }
  const fixture = JSON.parse(required('TEAM_OIDC_FIXTURE_JSON')) as TeamIdentityFixture;
  const identities = await createTeamIdentities(fixture, region, ['manager', 'alice', 'bob', 'viewer', 'follower', 'outsider']);
  const [manager, alice, bob, viewer, follower, outsider] = identities.users;
  if (!manager || !alice || !bob || !viewer || !follower || !outsider) throw new Error('Missing test identities.');
  const operator = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 0 });
  const proof = `team-${randomUUID()}`;
  let spaceId: string | undefined;
  let sessionId: string | undefined;
  let agentId: string | undefined;
  const subscriptions: ReturnType<typeof watchActivity>[] = [];
  const client = (identity: TestTeamIdentity) => new OpenAI({
    baseURL, apiKey: identity.accessTokenForRequest, maxRetries: 0, timeout: 180_000,
    defaultHeaders: { 'X-Rat-Space': spaceId! },
  });
  const request = async (identity: TestTeamIdentity, path: string, options: { method?: string; body?: unknown; token?: string } = {}) => fetch(`${baseURL}${path}`, {
    method: options.method ?? 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${options.token ?? await identity.accessTokenForRequest()}`, 'X-Rat-Space': spaceId!, 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const json = async <T>(identity: TestTeamIdentity, path: string, options?: { method?: string; body?: unknown }): Promise<T> => {
    const response = await request(identity, path, options);
    if (!response.ok) throw new Error(`Team API ${options?.method ?? 'GET'} ${path} returned ${response.status}.`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
  const activity = () => json<Activity>(manager, `/rat/sessions/${sessionId}/activity`);
  try {
    const space = await operator.post<{ id: string }>('/rat/spaces', {
      body: { name: proof, manager: { issuer: manager.issuer, subject: manager.subject, label: 'Manager' } },
    });
    spaceId = space.id;
    for (const [person, role] of [[alice, 'collaborator'], [bob, 'collaborator'], [viewer, 'viewer'], [follower, 'viewer']] as const) {
      await json(manager, `/rat/spaces/${spaceId}/bindings`, {
        method: 'POST', body: { issuer: person.issuer, subject: person.subject, role, label: person.username },
      });
    }
    await json(manager, `/rat/spaces/${spaceId}/execution-roles/default`, {
      method: 'PUT', body: { name: 'Proof capabilities', models: [required('AWS_E2E_CODEX_MODEL_ID')], tools: [],
        environments: [{ type: 'none' }], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [] },
    });
    const agent = await client(manager).beta.agents.create({
      name: proof, model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [],
      instructions: 'Help all participants with this shared task. Keep their contributions in context. Answer briefly and accurately.',
    });
    agentId = agent.id;
    await json(manager, `/rat/agents/${agent.id}/workload`, { method: 'PUT', body: { execution_role_id: 'default' } });

    const invalidToken = await request(manager, '/rat/me', { token: manager.idToken });
    expect(invalidToken.status).toBe(401);
    await invalidToken.body?.cancel();
    const hidden = await request(outsider, '/agents');
    expect([403, 404]).toContain(hidden.status);
    await hidden.body?.cancel();
    const escalation = await request(alice, `/agents/${agent.id}`, { method: 'POST', body: { instructions: 'Unapproved configuration change.' } });
    expect(escalation.status).toBe(403);
    await escalation.body?.cancel();

    const session = await client(alice).beta.agents.sessions.create({
      agent_id: agent.id, environment: { type: 'none' }, input: `Our shared goal is to remember marker ${proof}. Acknowledge it.`,
    });
    sessionId = session.id;
    const start = await json<Activity>(viewer, `/rat/sessions/${session.id}/activity`);
    for (const person of [viewer, follower]) {
      const watch = watchActivity(baseURL, spaceId, session.id, await person.accessTokenForRequest(), start.cursor);
      subscriptions.push(watch);
      await watch.ready;
    }
    const events = (text: string) => ({ events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
    const forbidden = await request(viewer, `/agents/sessions/${session.id}/events`, { method: 'POST', body: events('A viewer must not initiate inference.') });
    expect(forbidden.status).toBe(403);
    await forbidden.body?.cancel();
    const duplicateKey = `${proof}-same-client-key`;
    const send = async (person: TestTeamIdentity, text: string) => fetch(`${baseURL}/agents/sessions/${session.id}/events`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { authorization: `Bearer ${await person.accessTokenForRequest()}`, 'X-Rat-Space': spaceId!, 'content-type': 'application/json', 'idempotency-key': duplicateKey },
      body: JSON.stringify(events(text)),
    });
    const replies = await Promise.all([send(alice, 'Alice contributes: prioritize correctness.'), send(bob, 'Bob contributes: consider the operational cost too.')]);
    for (const response of replies) { expect(response.ok).toBe(true); await response.body?.cancel(); }
    const accepted = await activity();
    const aliceReceipts = accepted.inputs.filter(input => input.actor.subject === alice.subject);
    const bobReceipts = accepted.inputs.filter(input => input.actor.subject === bob.subject);
    expect(aliceReceipts.length).toBeGreaterThanOrEqual(1);
    expect(bobReceipts.length).toBeGreaterThanOrEqual(1);
    expect(new Set(accepted.inputs.map(input => input.sequence)).size).toBe(accepted.inputs.length);
    const replayedSubmission = await send(alice, 'Alice contributes: prioritize correctness.');
    expect(replayedSubmission.ok).toBe(true);
    await replayedSubmission.body?.cancel();
    expect((await activity()).inputs.map(input => input.id)).toEqual(accepted.inputs.map(input => input.id));

    const completed = await until(activity, current => current.turns.length > 0 && current.turns.every(turn => turn.status === 'completed')
      && current.inputs.every(input => input.status === 'dispatched'), timeout);
    await until(async () => subscriptions.map(subscription => subscription.latest()), snapshots =>
      snapshots.every(snapshot => snapshot?.turns.some(turn => turn.status === 'completed')), 15_000);
    for (const subscription of subscriptions) subscription.check();
    for (const subscription of subscriptions) await subscription.stop();

    await client(alice).beta.agents.sessions.events.create(session.id, {
      events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Repeat our shared marker and acknowledge both contributions.' }] }] }],
    }, { headers: { 'Idempotency-Key': `${proof}-unattended` } });
    // Simulate all clients being absent; the next observation cannot drive execution.
    await delay(10_000);
    const unattended = await until(activity, current => current.turns.length > completed.turns.length && current.turns.every(turn => turn.status === 'completed')
      && current.inputs.every(input => input.status === 'dispatched'), timeout);
    const lastTurn = unattended.turns.at(-1)!;
    const answer = unattended.items.flatMap(item => item.type === 'message' && item.role === 'assistant' && item.turn_id === lastTurn.id
      ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('\n');
    expect(answer).toContain(proof);
    const replay = watchActivity(baseURL, spaceId, session.id, await follower.accessTokenForRequest(), start.cursor);
    subscriptions.push(replay);
    await replay.ready;
    await until(async () => replay.latest(), current => current?.turns.length === unattended.turns.length && current.turns.every(turn => turn.status === 'completed'), 15_000);
    expect((await activity()).turns.map(turn => turn.id)).toEqual(unattended.turns.map(turn => turn.id));

    const revoked = watchActivity(baseURL, spaceId, session.id, await viewer.accessTokenForRequest(), unattended.cursor);
    subscriptions.push(revoked);
    await revoked.ready;
    const viewerIdentity = await json<{ actor: { id: string } }>(viewer, '/rat/me');
    await json(manager, `/rat/spaces/${spaceId}/bindings/${encodeURIComponent(viewerIdentity.actor.id)}`, { method: 'DELETE' });
    await Promise.race([revoked.done, delay(8_000).then(() => { throw new Error('Revoked stream did not close within eight seconds.'); })]);
    const deniedAfterRemoval = await request(viewer, `/agents/sessions/${session.id}`);
    expect([403, 404]).toContain(deniedAfterRemoval.status);
    await deniedAfterRemoval.body?.cancel();
    expect((await json<AgentSession>(follower, `/agents/sessions/${session.id}`)).id).toBe(session.id);
    console.log(JSON.stringify({ phase: 'team-verified', proof, spaceId, sessionId: session.id,
      turns: unattended.turns.length, attributedInputs: unattended.inputs.length, viewers: 2, revoked: true }));
  } finally {
    await Promise.all(subscriptions.map(subscription => subscription.stop()));
    try {
      if (spaceId && sessionId) await client(manager).beta.agents.sessions.delete(sessionId);
      if (spaceId && agentId) await client(manager).beta.agents.delete(agentId);
    } finally { await identities.close(); }
  }
}, timeout * 3);

function watchActivity(baseURL: string, spaceId: string, sessionId: string, token: string, cursor: string) {
  const controller = new AbortController();
  let latest: Activity | undefined;
  let failure: Error | undefined;
  const ready = fetch(`${baseURL}/rat/sessions/${sessionId}/activity/events`, {
    headers: { authorization: `Bearer ${token}`, 'X-Rat-Space': spaceId, 'Last-Event-ID': cursor },
    signal: controller.signal, redirect: 'error',
  }).then(response => { if (!response.ok || !response.body) throw new Error(`Activity subscription returned ${response.status}.`); return response; });
  const done = (async () => {
    try {
      const response = await ready;
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
          let boundary: number;
          while ((boundary = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            const event = JSON.parse(data) as { activity?: Activity };
            if (event.activity) latest = event.activity;
          }
        }
      } finally { await reader.cancel().catch(() => undefined); }
    } catch (error) { if (!controller.signal.aborted) failure = error instanceof Error ? error : new Error('Activity subscription failed.'); }
  })();
  return { ready, done, latest: () => latest, check: () => { if (failure) throw failure; },
    stop: async () => { controller.abort(); await done; } };
}

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    if (value && typeof value === 'object' && 'turns' in value && Array.isArray(value.turns) && value.turns.some(turn => turn.status === 'failed' || turn.status === 'cancelled')) {
      throw new Error('A live team Turn failed or was cancelled.');
    }
    await delay(500);
  }
  throw new Error('Timed out waiting for shared Session progress.');
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
