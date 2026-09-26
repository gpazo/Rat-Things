import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DescribeSecretCommand, ListSecretsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { Turn } from '../../src/domain/agents-api.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_CREDENTIAL_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

live('substitutes hosted credentials outside the guest, snapshots rotation, and retires Session secrets', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Live credential validation requires explicit model opt-in');
  const region = required('AWS_REGION');
  const deployment = required('AWS_E2E_DEPLOYMENT_ID');
  if (!/^[a-z0-9][a-z0-9-]{2,13}$/.test(deployment)) throw new Error('Invalid deployment scope');
  const fixture = new URL(required('INTEGRATION_FIXTURE_URL'));
  if (fixture.protocol !== 'https:' || !fixture.hostname.endsWith(`.lambda-url.${region}.on.aws`)) throw new Error('Use the deployment-owned HTTPS fixture');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 0, timeout: 360_000 });
  const secrets = new SecretsManagerClient({ region });
  const sqs = new SQSClient({ region });
  const sessionIds: string[] = [];
  const references: string[] = [];
  const proofId = `credential-${randomUUID()}`;
  let agentId: string | undefined;
  let vaultId: string | undefined;
  try {
    const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), name: 'Disposable hosted credential proof', tools: [],
      instructions: 'Execute the supplied Python program verbatim using command tools, then finish. Do not replace execution with a proposed command or manufacture results.' });
    agentId = agent.id;
    const vault = await client.beta.agents.vaults.create({ name: 'Disposable hosted credential proof' });
    vaultId = vault.id;
    const credential = await client.beta.agents.vaults.credentials.create(vault.id, { name: 'Fixture API', auth: {
      type: 'environment_variable', secret_name: 'PARITY_CREDENTIAL', secret_value: required('INTEGRATION_FIXTURE_ALPHA_KEY'),
      networking: { type: 'limited', allowed_hosts: [fixture.hostname] },
    } });
    expect(JSON.stringify(credential)).not.toContain(required('INTEGRATION_FIXTURE_ALPHA_KEY'));
    const first = await client.beta.agents.sessions.create({ agent_id: agent.id, vault_ids: [vault.id],
      environment: { type: 'openai_hosted', network: { access: 'restricted', allowed_domains: [fixture.hostname] } } });
    sessionIds.push(first.id);
    const firstTurn = await probe(first.id, 'original');
    expect(firstTurn.proof).toMatchObject({ uid: 10001, placeholder: true, private_key_denied: true, upstream: { tenant_id: 'fixture-alpha' }, write_status: 403 });

    const rotated = await client.beta.agents.vaults.credentials.update(credential.id, { vault_id: vault.id,
      auth: { type: 'environment_variable', secret_value: required('INTEGRATION_FIXTURE_BETA_KEY') } });
    expect(JSON.stringify(rotated)).not.toContain(required('INTEGRATION_FIXTURE_BETA_KEY'));
    const continued = await probe(first.id, 'continued', new Set([firstTurn.turn.id]));
    expect(continued.proof).toMatchObject({ uid: 10001, placeholder: true, private_key_denied: true, upstream: { tenant_id: 'fixture-alpha' }, write_status: 403 });
    const second = await client.beta.agents.sessions.create({ agent_id: agent.id, vault_ids: [vault.id],
      environment: { type: 'openai_hosted', network: { access: 'enabled' } } });
    sessionIds.push(second.id);
    expect((await probe(second.id, 'rotated')).proof).toMatchObject({ uid: 10001, placeholder: true, private_key_denied: true, upstream: { tenant_id: 'fixture-beta' }, write_status: 201 });
    await expectAudit();

    // Read metadata only, scoped to the deployment and Sessions this test created.
    await eventually(async () => {
      let next: string | undefined;
      const matched = new Map<string, string>();
      do {
        const page = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: 'name', Values: [`rat-things-${deployment}/connections/agents/`] }], NextToken: next }));
        for (const secret of page.SecretList ?? []) {
          if (secret.Name && secret.ARN && sessionIds.some(id => secret.Name!.includes(`/sessions/${id}/`))) matched.set(secret.Name, secret.ARN);
        }
        next = page.NextToken;
      } while (next);
      if (!sessionIds.every(id => [...matched.keys()].some(name => name.includes(`/sessions/${id}/`)))) return false;
      references.push(...matched.values());
      return true;
    });
    for (const id of sessionIds) await client.beta.agents.sessions.delete(id);
    await eventually(async () => (await Promise.all(references.map(async reference => {
      try { return Boolean((await secrets.send(new DescribeSecretCommand({ SecretId: reference }))).DeletedDate); }
      catch (error) { if (error instanceof Error && error.name === 'ResourceNotFoundException') return true; throw error; }
    }))).every(Boolean));
    console.log(JSON.stringify({ proofId, credentialSessions: sessionIds, retiredSecrets: references.length }));
  } finally {
    const cleanup = await Promise.allSettled(sessionIds.map(async id => {
      try { await client.beta.agents.sessions.delete(id); }
      catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    }));
    const definitions = await Promise.allSettled([
      ...(agentId ? [client.beta.agents.delete(agentId)] : []),
      ...(vaultId ? [client.beta.agents.vaults.delete(vaultId)] : []),
    ]);
    secrets.destroy(); sqs.destroy();
    const failures = [...cleanup, ...definitions].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Disposable credential proof cleanup failed');
  }

  async function probe(id: string, phase: string, previous = new Set<string>()) {
    const path = `/workspace/outputs/${proofId}-${phase}.json`;
    const program = [
      'import os, json, re, urllib.request, urllib.error',
      'from pathlib import Path',
      'proof = {"uid": os.getuid(), "placeholder": bool(re.fullmatch(r"rat_secret_[a-f0-9]{64}", os.environ["PARITY_CREDENTIAL"]))}',
      'try:',
      '    with open(Path(os.environ["SSL_CERT_FILE"]).parent / "private" / "ca.key", "rb") as key: key.read(1)',
      '    proof["private_key_denied"] = False',
      'except (PermissionError, FileNotFoundError): proof["private_key_denied"] = True',
      'headers = {"Authorization": "Bearer " + os.environ["PARITY_CREDENTIAL"], "Content-Type": "application/json"}',
      `with urllib.request.urlopen(urllib.request.Request(${JSON.stringify(new URL('/me', fixture).href)}, headers=headers), timeout=30) as response: proof["upstream"] = json.load(response)`,
      'try:',
      `    request = urllib.request.Request(${JSON.stringify(new URL('/records', fixture).href)}, data=json.dumps({"name": ${JSON.stringify(proofId)}}).encode(), headers=headers, method="POST")`,
      '    with urllib.request.urlopen(request, timeout=30) as response: proof["write_status"] = response.status',
      'except urllib.error.HTTPError as error: proof["write_status"] = error.code',
      `path = Path(${JSON.stringify(path)})`,
      'path.parent.mkdir(parents=True, exist_ok=True)',
      'path.write_text(json.dumps(proof))',
      'print(json.dumps(proof))',
    ].join('\n');
    await client.beta.agents.sessions.events.create(id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: `Run this Python program verbatim, then finish.\n\n${program}` }] }] }] });
    let turn: Turn | undefined;
    await eventually(async () => {
      turn = (await client.beta.agents.sessions.turns.list(id, { order: 'asc', limit: 100 })).data.find(value => value.subagent_id === null && !previous.has(value.id));
      if (turn && ['failed', 'cancelled'].includes(turn.status)) throw new Error(`Credential Turn ${turn.id} ${turn.status}: ${turn.error?.code}`);
      return turn?.status === 'completed';
    });
    const items = (await client.beta.agents.sessions.items.list(id, { order: 'asc', limit: 100 })).data;
    for (const name of ['INTEGRATION_FIXTURE_ALPHA_KEY', 'INTEGRATION_FIXTURE_BETA_KEY']) expect(JSON.stringify(items)).not.toContain(required(name));
    let artifact = (await client.beta.agents.sessions.artifacts.list(id, { limit: 100 })).data.find(value => value.path === path && value.turn_id === turn!.id);
    await eventually(async () => {
      artifact = (await client.beta.agents.sessions.artifacts.list(id, { limit: 100 })).data.find(value => value.path === path && value.turn_id === turn!.id);
      return artifact !== undefined;
    });
    expect(artifact).toBeDefined();
    const proof = await (await client.beta.agents.sessions.artifacts.content(artifact!.id, { session_id: id })).json() as Record<string, unknown>;
    return { turn: turn!, proof };
  }
  async function expectAudit() {
    await eventually(async () => {
      const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: required('INTEGRATION_FIXTURE_AUDIT_QUEUE_URL'), MaxNumberOfMessages: 10, WaitTimeSeconds: 5, VisibilityTimeout: 10 }));
      for (const message of page.Messages ?? []) {
        const value = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
        if (value.name !== proofId) continue;
        expect(value).toMatchObject({ operation: 'records.create', account: 'beta' });
        await sqs.send(new DeleteMessageCommand({ QueueUrl: required('INTEGRATION_FIXTURE_AUDIT_QUEUE_URL'), ReceiptHandle: message.ReceiptHandle! }));
        return true;
      }
      return false;
    });
  }
}, timeoutMs * 5);

async function eventually(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(2000); }
  throw new Error('Credential proof did not settle before its deadline');
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live credential proof`);
  return value;
}
