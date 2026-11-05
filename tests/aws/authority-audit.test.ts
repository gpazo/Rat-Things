import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { Turn } from '../../src/domain/agents-api.js';
import type { ConfigurationRevision, InspectionPage } from '../../src/domain/configuration-history.js';
import type { ToolAuthorizationReceipt } from '../../src/domain/tool-authorization.js';
import { authorizationTracePage, exportAuthorizationTraces } from '../../src/trace-export.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_AUTHORITY_AUDIT_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

live('pins configuration, records real MCP attempts and enforces rotated and revoked credentials', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Authority validation requires explicit real model opt-in');
  const region = required('AWS_REGION');
  const deployment = required('AWS_E2E_DEPLOYMENT_ID');
  if (!/^[a-z0-9][a-z0-9-]{2,13}$/.test(deployment)) throw new Error('Invalid deployment scope');
  const fixture = new URL(required('INTEGRATION_FIXTURE_URL'));
  if (fixture.protocol !== 'https:' || !fixture.hostname.endsWith(`.lambda-url.${region}.on.aws`)) throw new Error('Use the deployment-owned fixture');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 0, timeout: 360_000 });
  const sqs = new SQSClient({ region });
  const proof = `mcp-${randomUUID()}`;
  const secrets = [`alpha-${deployment}`, `beta-${deployment}`];
  const mcpURL = new URL('/mcp', fixture).href;
  let vaultId: string | undefined;
  let agentId: string | undefined;
  let sessionId: string | undefined;
  const captures: Record<string, unknown>[] = [];
  try {
    const vault = await client.beta.agents.vaults.create({ name: 'Disposable authority audit proof' });
    vaultId = vault.id;
    const credential = await client.beta.agents.vaults.credentials.create(vault.id, { name: 'Synthetic fixture credential',
      auth: { type: 'static_bearer', mcp_server_url: mcpURL, token: secrets[0]! } });
    assertRedacted(credential);
    const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'),
      instructions: 'When asked, call fixture_lookup exactly once with the supplied query. Report its actual result. If the call fails, report the failure and finish without retrying.',
      tools: [{ type: 'mcp', server_label: 'fixture', connection_origin: 'service', required: true, allowed_tools: ['fixture_lookup'],
        request_metadata: { proof }, transport: { type: 'http', server_url: mcpURL }, credential_id: credential.id }] });
    agentId = agent.id;
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id, vault_ids: [vault.id], environment: { type: 'none' },
      input: 'Return exactly READY. Do not call any tools.' });
    sessionId = session.id;
    expect(session.agent.id).toBe(agent.id);
    assertRedacted(session);
    console.log(JSON.stringify({ phase: 'created', proof, sessionId, agentId }));
    await eventually(async () => {
      const turn = (await client.beta.agents.sessions.turns.list(session.id)).data.find(value => value.subagent_id === null);
      if (turn && ['failed', 'cancelled'].includes(turn.status)) throw new Error(`Authority worker startup ${turn.status}: ${turn.error?.code ?? 'no_error_code'}`);
      return turn?.status === 'completed';
    });
    const configurations = await client.get<InspectionPage<ConfigurationRevision>>(`/agents/sessions/${session.id}/configurations`);
    expect(configurations.data).toHaveLength(1);
    const admitted = configurations.data[0]!;
    expect(admitted).toMatchObject({ snapshot: { kind: 'session', configuration: { sourceAgent: { subject: { kind: 'agent', id: agent.id }, revision: 1 } } } });
    await client.beta.agents.update(agent.id, { instructions: 'Future Sessions must return FUTURE_ONLY.', tools: [] });
    const revisions = await client.get<InspectionPage<ConfigurationRevision>>(`/agents/${agent.id}/revisions?order=asc&limit=1`);
    expect(revisions.has_more).toBe(true);
    const nextRevision = await client.get<InspectionPage<ConfigurationRevision>>(`/agents/${agent.id}/revisions?order=asc&after=${revisions.last_id}`);
    expect(nextRevision.data[0]).toMatchObject({ ref: { revision: 2 }, changedPaths: expect.arrayContaining(['/agent/instructions', '/agent/tools']) });

    const first = await input(`${proof}-first`);
    expect(first.status).toBe('completed');
    await collectUntil(() => captures.some(value => value.query === `${proof}-first`));
    expect(captures.filter(value => value.query === `${proof}-first`)).toEqual([expect.objectContaining({ operation: 'mcp.lookup', account: 'alpha' })]);
    const firstReceipts = await receipts();
    expect(firstReceipts).toHaveLength(1);
    expect(firstReceipts[0]).toMatchObject({ decision: 'allow', configuration: admitted.ref, toolName: 'fixture_lookup',
      identity: { sessionId: session.id, agentId: session.agent.id }, credential: { kind: 'vault', credential: { revision: 1 } },
      outcome: { kind: 'response_received', httpStatus: 200, toolResult: 'unobserved' } });

    assertRedacted(await client.beta.agents.vaults.credentials.update(credential.id, { vault_id: vault.id,
      auth: { type: 'static_bearer', token: secrets[1]! } }));
    expect((await input(`${proof}-rotated`)).status).toBe('completed');
    await collectUntil(() => captures.some(value => value.query === `${proof}-rotated`));
    expect(captures.filter(value => value.query === `${proof}-rotated`)).toEqual([expect.objectContaining({ account: 'beta' })]);
    const rotated = await receipts();
    expect(rotated).toHaveLength(2);
    expect(rotated[1]).toMatchObject({ decision: 'allow', credential: { kind: 'vault', credential: { revision: 2 } } });
    const credentialRevisions = await client.get<InspectionPage<ConfigurationRevision>>(`/vaults/${vault.id}/credentials/${credential.id}/revisions?order=asc`);
    expect(credentialRevisions.data.map(value => value.ref.revision)).toEqual([1, 2]);

    await client.beta.agents.vaults.credentials.delete(credential.id, { vault_id: vault.id });
    await input(`${proof}-revoked`);
    const all = await receipts();
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({ decision: 'deny', reason: 'credential_unavailable', outcome: { kind: 'not_dispatched' } });
    for (let observation = 0; observation < 2; observation++) await collectCaptures();
    expect(captures.filter(value => value.query === `${proof}-revoked`)).toEqual([]);
    expect(captures).toHaveLength(2);
    const archived = await client.get<InspectionPage<ConfigurationRevision>>(`/vaults/${vault.id}/credentials/${credential.id}/revisions?order=asc`);
    expect(archived.data.at(-1)).toMatchObject({ change: 'deleted', ref: { revision: 3 }, snapshot: { kind: 'credential', status: 'archived' } });
    const items = [];
    for await (const item of client.beta.agents.sessions.items.list(session.id, { limit: 100, order: 'asc' })) items.push(item);
    expect(items.filter(item => item.type === 'mcp_call' && item.status === 'completed')).toHaveLength(2);
    expect(items.filter(item => item.type === 'mcp_call' && item.status === 'failed')).toHaveLength(1);
    const exported = await exportAuthorizationTraces(query => authorizationTracePage(client, session.id, query), { limit: 1 });
    expect(exported.resourceSpans).toHaveLength(3);
    expect(await exportAuthorizationTraces(query => authorizationTracePage(client, session.id, query), { limit: 2 })).toEqual(exported);
    for (const receipt of all) {
      expect(receipt.configuration).toEqual(admitted.ref);
      expect(receipt.identity).toMatchObject({ sessionId: session.id, agentId: agent.id });
      expect(receipt.identity.runId).toBeTruthy();
      expect(receipt.policyDigest).toMatch(/^[a-f0-9]{64}$/);
      if (receipt.credential.kind === 'vault') {
        const ref = receipt.credential.credential;
        expect(await client.get(`/vaults/${vault.id}/credentials/${credential.id}/revisions/${ref.revision}`)).toMatchObject({ ref });
      }
    }
    for (const value of [all, configurations, revisions, credentialRevisions, archived, items, exported]) assertRedacted(value);
    expect(JSON.stringify(exported)).not.toContain(mcpURL);
    expect(JSON.stringify(all)).not.toContain(`${proof}-first`);
    await client.beta.agents.sessions.delete(session.id);
    sessionId = undefined;
    expect(await receipts(session.id)).toEqual(all);
    expect(await client.get(`/agents/sessions/${session.id}/configurations`)).toEqual(configurations);
    await client.beta.agents.delete(agent.id);
    agentId = undefined;
    expect(await client.get(`/agents/${agent.id}/revisions/1`)).toMatchObject({ ref: { revision: 1 }, snapshot: { kind: 'agent' } });
    const deletedRevisions = await client.get<InspectionPage<ConfigurationRevision>>(`/agents/${agent.id}/revisions?order=asc`);
    expect(deletedRevisions.data.at(-1)).toMatchObject({ change: 'deleted', snapshot: null });
    console.log(JSON.stringify({ phase: 'verified', proof, sessionId: session.id, receipts: all.map(value => ({ id: value.id, decision: value.decision, outcome: value.outcome.kind })),
      fixtureCalls: captures.length, configurationRevision: admitted.ref.revision, otlpSpans: exported.resourceSpans.length }));
  } finally {
    try { if (sessionId) await client.beta.agents.sessions.delete(sessionId); }
    finally {
      try { if (agentId) await client.beta.agents.delete(agentId); }
      finally { try { if (vaultId) await client.beta.agents.vaults.delete(vaultId); } finally { sqs.destroy(); } }
    }
  }

  function assertRedacted(value: unknown) { for (const secret of secrets) expect(JSON.stringify(value)).not.toContain(secret); }
  async function receipts(id = sessionId!) {
    const result: ToolAuthorizationReceipt[] = [];
    let after: string | undefined;
    do {
      const page = await client.get<InspectionPage<ToolAuthorizationReceipt>>(`/agents/sessions/${id}/authorizations`, { query: { order: 'asc', limit: 1, ...(after ? { after } : {}) } });
      result.push(...page.data);
      after = page.has_more ? page.last_id ?? undefined : undefined;
    } while (after);
    return result;
  }
  async function input(query: string): Promise<Turn> {
    const previous = new Set((await client.beta.agents.sessions.turns.list(sessionId!, { limit: 100 })).data.map(turn => turn.id));
    await client.beta.agents.sessions.events.create(sessionId!, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: `Call fixture_lookup with query ${query} exactly once, then report its actual result. On failure report it without retrying.` }] }] }] });
    let turn: Turn | undefined;
    await eventually(async () => {
      turn = (await client.beta.agents.sessions.turns.list(sessionId!, { limit: 100 })).data.find(value => value.subagent_id === null && !previous.has(value.id));
      return Boolean(turn && ['completed', 'failed', 'cancelled'].includes(turn.status));
    });
    return turn!;
  }
  async function collectUntil(done: () => boolean) {
    await eventually(async () => {
      await collectCaptures();
      return done();
    });
  }
  async function collectCaptures() {
    const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: required('INTEGRATION_FIXTURE_AUDIT_QUEUE_URL'), MaxNumberOfMessages: 10, WaitTimeSeconds: 5, VisibilityTimeout: 10 }));
    for (const message of page.Messages ?? []) {
      const value = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
      if (value.proof !== proof) continue;
      assertRedacted(value); captures.push(value);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: required('INTEGRATION_FIXTURE_AUDIT_QUEUE_URL'), ReceiptHandle: message.ReceiptHandle! }));
    }
  }
}, timeoutMs * 5);

async function eventually(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(2000); }
  throw new Error('Authority proof did not settle before its deadline');
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for authority validation`);
  return value;
}
