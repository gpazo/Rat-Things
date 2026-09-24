import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { Turn } from '../../src/domain/agents-api.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_MCP_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

live.each(['expired', 'rejected'] as const)('refreshes a %s MCP OAuth grant and enforces revocation on the next call', async mode => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Live MCP validation requires explicit model opt-in');
  const region = required('AWS_REGION');
  const deployment = required('AWS_E2E_DEPLOYMENT_ID');
  if (!/^[a-z0-9][a-z0-9-]{2,13}$/.test(deployment)) throw new Error('Invalid deployment scope');
  const fixture = new URL(required('INTEGRATION_FIXTURE_URL'));
  if (fixture.protocol !== 'https:' || !fixture.hostname.endsWith(`.lambda-url.${region}.on.aws`)) throw new Error('Use the deployment-owned HTTPS fixture');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 0, timeout: 360_000 });
  const sqs = new SQSClient({ region });
  const proof = `mcp-${randomUUID()}`;
  let vaultId: string | undefined;
  let sessionId: string | undefined;
  const syntheticSecrets = [`rejected-${deployment}`, `refresh-${deployment}`, `rotated-${deployment}`, `oauth-${deployment}`, `beta-${deployment}`];
  try {
    const vault = await client.beta.agents.vaults.create({ name: `Disposable MCP ${mode} proof` });
    vaultId = vault.id;
    const credential = await client.beta.agents.vaults.credentials.create(vault.id, { name: 'Fixture OAuth', auth: {
      type: 'mcp_oauth', mcp_server_url: new URL('/mcp', fixture).href, access_token: syntheticSecrets[0]!,
      expires_at: mode === 'expired' ? '2000-01-01T00:00:00Z' : new Date(Date.now() + 3_600_000).toISOString(),
      refresh: { client_id: proof, refresh_token: syntheticSecrets[1]!, token_endpoint: new URL('/oauth/token', fixture).href,
        token_endpoint_auth: { type: 'client_secret_basic', client_secret: syntheticSecrets[3]! } },
    } });
    assertRedacted(credential);
    const session = await client.beta.agents.sessions.create({
      agent: { model: required('AWS_E2E_CODEX_MODEL_ID'), instructions: 'Call fixture_lookup exactly once when requested, then report its actual result. If the call fails, report that failure and finish without retrying.',
        tools: [{ type: 'mcp', server_label: 'fixture', connection_origin: 'service', required: true, allowed_tools: ['fixture_lookup'],
          request_metadata: { proof, enabled: false, count: 0 }, transport: { type: 'http', server_url: new URL('/mcp', fixture).href }, credential_id: credential.id }] },
      vault_ids: [vault.id], environment: { type: 'none' }, input: 'Return exactly READY. Do not call any tools.',
    });
    sessionId = session.id;
    assertRedacted(session);
    await eventually(async () => (await client.beta.agents.sessions.turns.list(session.id, { limit: 100 })).data.some(turn => turn.subagent_id === null && turn.status === 'completed'));
    const first = await input(`Call fixture_lookup with query ${proof}-allowed exactly once, then return its account and query.`);
    expect(first.status).toBe('completed');
    const firstItems = await items(first.id);
    expect(firstItems).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'mcp_call', server_label: 'fixture', name: 'fixture_lookup', status: 'completed' })]));
    const result = firstItems.find(item => item.type === 'mcp_call' && item.status === 'completed');
    expect(JSON.stringify(result)).toContain('beta');
    expect(JSON.stringify(result)).toContain(`${proof}-allowed`);
    assertRedacted(firstItems);
    const audits: Record<string, unknown>[] = [];
    await eventually(async () => {
      const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: required('INTEGRATION_FIXTURE_AUDIT_QUEUE_URL'), MaxNumberOfMessages: 10, WaitTimeSeconds: 5, VisibilityTimeout: 10 }));
      for (const message of page.Messages ?? []) {
        const value = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
        if (value.proof !== proof) continue;
        assertRedacted(value); audits.push(value);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: required('INTEGRATION_FIXTURE_AUDIT_QUEUE_URL'), ReceiptHandle: message.ReceiptHandle! }));
      }
      return audits.some(value => value.operation === 'oauth.refresh') && audits.some(value => value.operation === 'mcp.lookup');
    });
    expect(audits.filter(value => value.operation === 'oauth.refresh')).toHaveLength(1);
    expect(audits.filter(value => value.operation === 'mcp.lookup')).toEqual([expect.objectContaining({ account: 'beta', query: `${proof}-allowed` })]);
    assertRedacted(await client.beta.agents.vaults.credentials.retrieve(credential.id, { vault_id: vault.id }));
    await client.beta.agents.vaults.credentials.delete(credential.id, { vault_id: vault.id });
    const second = await input(`Call fixture_lookup with query ${proof}-revoked exactly once. If it fails, report the failure without retrying.`);
    const secondItems = await items(second.id);
    expect(secondItems).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'mcp_call', server_label: 'fixture', name: 'fixture_lookup', status: 'failed' })]));
    expect(secondItems.filter(item => item.type === 'mcp_call' && item.status === 'completed')).toEqual([]);
    assertRedacted(secondItems);
    console.log(JSON.stringify({ proof, sessionId, mode, refreshes: audits.filter(value => value.operation === 'oauth.refresh').length, revokedTurn: second.id }));
  } finally {
    try { if (sessionId) await client.beta.agents.sessions.delete(sessionId); }
    finally { try { if (vaultId) await client.beta.agents.vaults.delete(vaultId); } finally { sqs.destroy(); } }
  }

  function assertRedacted(value: unknown) { for (const secret of syntheticSecrets) expect(JSON.stringify(value)).not.toContain(secret); }
  async function items(turnId: string) {
    const selected = [];
    for await (const item of client.beta.agents.sessions.items.list(sessionId!, { limit: 100, order: 'asc' })) if (item.turn_id === turnId) selected.push(item);
    return selected;
  }
  async function input(text: string): Promise<Turn> {
    const previous = new Set((await client.beta.agents.sessions.turns.list(sessionId!, { limit: 100 })).data.map(turn => turn.id));
    await client.beta.agents.sessions.events.create(sessionId!, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
    let turn: Turn | undefined;
    await eventually(async () => {
      turn = (await client.beta.agents.sessions.turns.list(sessionId!, { limit: 100 })).data.find(value => value.subagent_id === null && !previous.has(value.id));
      return Boolean(turn && ['completed', 'failed', 'cancelled'].includes(turn.status));
    });
    return turn!;
  }
}, timeoutMs * 3);

async function eventually(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(2000); }
  throw new Error('MCP proof did not settle before its deadline');
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live MCP validation`);
  return value;
}
