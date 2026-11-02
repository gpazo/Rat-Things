import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DescribeSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { it } from 'vitest';
import { integrationSessionId } from '../../src/core/session-integration-planning.js';
import { createAgentsClient } from '../../src/agents-client.js';
import type { AgentSessionItem, SessionArtifact, Turn } from '../../src/domain/agents-api.js';
import type { SourceCapabilityBinding } from '../../src/domain/capabilities.js';
import type { SessionEnvironmentCredentialBinding } from '../../src/domain/session-execution.js';
import type { SessionIntegrationState } from '../../src/domain/session-integrations.js';
import type { SessionEventBatch } from '../../src/core/session-event-store.js';
import type { StoredSessionRuntime } from '../../src/core/session-runtime-store.js';
import type { SessionStreamSnapshot } from '../../src/core/session-stream.js';
import { aws, check, eventually, hash, proofTimeout, required, SecurityProof } from '../../testing/aws/super-security-proof.js';
import { commandArguments } from '../../testing/local-runtime/installed-cloud-transfer.mjs';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_SUPER_AGENT_PROOF === 'true' ? it : it.skip;

interface EchoProof {
  proof_id: string;
  uid: number;
  placeholder: boolean;
  placeholder_value: string;
  private_key_denied: boolean;
  host_role_environment_absent: boolean;
  model_auth_file_available: boolean;
  model_auth_environment_available: boolean;
  status: number;
  body: { raw: string; base64: string; url: string; requestId: string };
  headers: Record<string, string>;
}

live('keeps a synthetic hosted Vault credential out of the managed guest, persisted output, artifacts, and actual Teams delivery', async () => {
  const proof = new SecurityProof();
  const secrets = new SecretsManagerClient({ region: proof.region });
  let agentId: string | undefined;
  let vaultId: string | undefined;
  let binding: SourceCapabilityBinding | undefined;
  const sessionSecrets = new Set<string>();
  const scanned = new Set<string>();
  let succeeded = false;
  try {
    await proof.validate();
    const canary = required('INTEGRATION_FIXTURE_ECHO_KEY');
    check(canary === `echo-${proof.deployment}:/+?=`, 'synthetic deployment echo credential');
    const fixture = new URL(required('INTEGRATION_FIXTURE_URL'));
    check(fixture.protocol === 'https:' && fixture.hostname.endsWith(`.lambda-url.${proof.region}.on.aws`) && fixture.pathname === '/' && !fixture.search && !fixture.username, 'fixed deployment fixture URL');
    const fixtureConfig = await aws<{ FunctionUrl: string; FunctionArn: string }>(proof.region, ['lambda', 'get-function-url-config', '--function-name', `${proof.prefix}-integration-fixture`]);
    check(fixtureConfig.FunctionUrl === fixture.href && fixtureConfig.FunctionArn === `arn:aws:lambda:${proof.region}:${proof.account}:function:${proof.prefix}-integration-fixture`, 'owned credential echo fixture');
    const auditQueue = required('INTEGRATION_FIXTURE_AUDIT_QUEUE_URL');
    const auditAttributes = await proof.sqs.send(new GetQueueAttributesCommand({ QueueUrl: auditQueue, AttributeNames: ['QueueArn'] }));
    check(auditAttributes.Attributes?.QueueArn === `arn:aws:sqs:${proof.region}:${proof.account}:${proof.prefix}-integration-audit`, 'exact fixture audit queue');
    const controlURL = required('RAT_THINGS_API_URL');
    const control = createAgentsClient({ baseURL: controlURL, region: proof.region }).withOptions({ maxRetries: 0, timeout: 360_000 });
    const controlId = new URL(controlURL).hostname.split('.')[0]!;
    const api = await aws<{ Name: string; ApiEndpoint: string; Tags: Record<string, string> }>(proof.region, ['apigatewayv2', 'get-api', '--api-id', controlId]);
    check(api.Name === `${proof.prefix}-api` && api.ApiEndpoint === controlURL.replace(/\/$/, '') && api.Tags.DeploymentId === proof.deployment && api.Tags.Ephemeral === 'true', 'owned control API');
    check(required('INTEGRATIONS_TABLE_NAME') === `${proof.prefix}-integrations`, 'exact integration table');
    check(required('TEAMS_WEBHOOK_URL') === `${controlURL.replace(/\/$/, '')}/webhooks/teams`, 'owned Teams ingress');
    const forms = {
      raw: canary, base64: Buffer.from(canary).toString('base64'), base64url: Buffer.from(canary).toString('base64url'),
      url: encodeURIComponent(canary), lower_url: encodeURIComponent(canary).replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()), form: new URLSearchParams({ v: canary }).toString().slice(2),
    };
    check(forms.raw !== forms.url && forms.raw !== forms.base64, 'distinct encoded echo forms');
    let rejectedTemplate: unknown;
    let unexpectedTemplateId: string | undefined;
    try { unexpectedTemplateId = (await proof.client.beta.agents.environments.templates.create({ env: { PROOF_TOKEN: canary } })).id; }
    catch (error) { rejectedTemplate = error; }
    if (unexpectedTemplateId) await proof.client.beta.agents.environments.templates.delete(unexpectedTemplateId);
    check(rejectedTemplate instanceof Error && (rejectedTemplate as Error & { status?: number }).status === 400 && /Vault/.test(rejectedTemplate.message), 'deployed template rejects inline credential');
    scan('template rejection', rejectedTemplate.message);
    proof.evidence.templateLint = 'credential-like plain environment value rejected with HTTP 400 and Vault guidance';
    const agent = await proof.client.beta.agents.create({ model: proof.model, name: proof.proofId, tools: [], multi_agent: { enabled: false },
      instructions: 'Execute the supplied command verbatim using command tools. Then return the exact JSON printed by that command as your final answer. Do not replace execution with proposed code or manufacture results. Do not inspect any credential other than the named synthetic placeholder. Do not read model authentication token bytes.' });
    agentId = agent.id;
    const vault = await proof.client.beta.agents.vaults.create({ name: proof.proofId });
    vaultId = vault.id;
    try {
      const credential = await proof.client.beta.agents.vaults.credentials.create(vault.id, { name: 'Synthetic credential echo', auth: { type: 'environment_variable', secret_name: 'CREDENTIAL_ECHO', secret_value: canary, networking: { type: 'limited', allowed_hosts: [fixture.hostname] } } });
      scan('credential API response', JSON.stringify(credential));
    } catch { throw new Error('Synthetic Vault credential creation or response confidentiality failed'); }
    binding = await control.post<SourceCapabilityBinding>('/v1/integrations/source-bindings', { body: {
      version: '1', sourceKind: 'teams', selector: { tenantId: proof.proofId }, threadScope: 'thread', agentId: agent.id, vaultIds: [vault.id],
      environment: { type: 'openai_hosted', network: { access: 'restricted', allowed_domains: [fixture.hostname] } },
    } });
    check(binding.ownerId === proof.owner && binding.selector.tenantId === proof.proofId && binding.agentId === agent.id && binding.vaultIds?.join() === vault.id, 'prelaunch Teams binding and Vault envelope');
    const expectedSessionId = integrationSessionId(binding.bindingId, JSON.stringify(['teams', proof.proofId, proof.proofId]));
    check(!await proof.store.get(proof.owner, 'sessions', expectedSessionId) && !await proof.store.get(proof.owner, 'session_integrations', expectedSessionId), 'new disposable Teams thread');
    proof.sessions.add(expectedSessionId);
    const artifactPath = `/workspace/outputs/${proof.proofId}.json`;
    const program = [
      'import os, json, re, glob, urllib.request',
      'from pathlib import Path',
      `proof = {"proof_id": ${JSON.stringify(proof.proofId)}, "uid": os.getuid()}`,
      'placeholder = os.environ["CREDENTIAL_ECHO"]',
      'proof["placeholder"] = bool(re.fullmatch(r"rat_secret_[a-f0-9]{64}", placeholder))',
      'proof["placeholder_value"] = placeholder',
      'try:',
      '    with open(Path(os.environ["SSL_CERT_FILE"]).parent / "private" / "ca.key", "rb"): pass',
      '    proof["private_key_denied"] = False',
      'except (PermissionError, FileNotFoundError): proof["private_key_denied"] = True',
      'host_role_names = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE"]',
      'proof["host_role_environment_absent"] = all(name not in os.environ for name in host_role_names)',
      'proof["model_auth_file_available"] = any(os.access(path, os.R_OK) for path in glob.glob("/tmp/rat-bedrock-auth-*/token"))',
      'proof["model_auth_environment_available"] = "AWS_BEARER_TOKEN_BEDROCK" in os.environ',
      `request = urllib.request.Request(${JSON.stringify(new URL(`/credential-echo?proof=${proof.proofId}`, fixture).href)}, headers={"Authorization": "Bearer " + placeholder})`,
      'with urllib.request.urlopen(request, timeout=30) as response:',
      '    proof["status"] = response.status',
      '    proof["headers"] = {name.lower(): value for name, value in response.headers.items()}',
      '    proof["body"] = json.load(response)',
      `path = Path(${JSON.stringify(artifactPath)})`,
      'path.parent.mkdir(parents=True, exist_ok=True)',
      'path.write_text(json.dumps(proof))',
      'print(json.dumps(proof))',
    ].join('\n');
    const launcher = `import base64; exec(base64.b64decode("${Buffer.from(program).toString('base64')}"))`;
    const command = `python3 -c '${launcher}'`;
    const body = JSON.stringify({ id: proof.proofId, type: 'message', text: `Run this exact command verbatim, without edits or additional commands. Return its entire JSON output unchanged as your final answer.\n\n${command}`, from: { id: proof.proofId }, conversation: { id: proof.proofId }, channelData: { tenant: { id: proof.proofId } } });
    scan('signed Teams input', body);
    const authorization = `HMAC ${createHmac('sha256', Buffer.from(required('TEAMS_WEBHOOK_SIGNING_SECRET'), 'base64')).update(body).digest('base64')}`;
    const admittedAt = performance.now();
    const response = await fetch(required('TEAMS_WEBHOOK_URL'), { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(360_000) });
    const admissionMs = Math.round(performance.now() - admittedAt);
    check(response.status === 200, `signed Teams admission (HTTP ${response.status}, ${admissionMs} ms)`);
    check(admissionMs < 5000, 'Teams acknowledgment deadline');
    proof.evidence.admissionMs = admissionMs;
    const accepted = await response.json() as { text?: string };
    const sessionId = /session (sess_[A-Za-z0-9_]+) completes/.exec(accepted.text ?? '')?.[1];
    check(sessionId === expectedSessionId, 'Teams accepted deterministic Session identity');
    proof.sessions.add(sessionId);
    let turn: Turn | undefined;
    await eventually('managed credential Turn', async () => {
      const turns: Turn[] = [];
      for await (const value of proof.client.beta.agents.sessions.turns.list(sessionId, { order: 'asc', limit: 100 })) turns.push(value);
      scan('API Turns', JSON.stringify(turns));
      turn = turns.find(value => value.subagent_id === null);
      check(!turn || !['failed', 'cancelled'].includes(turn.status), 'managed credential Turn succeeded');
      return turn?.status === 'completed';
    });
    check((turn!.usage?.total_tokens ?? 0) > 0, 'real credential model usage');
    await eventually('persisted terminal credential history', async () => {
      const saved = (await proof.state(sessionId)).value.turns.find(value => value.turn.id === turn!.id);
      return saved?.turn.status === 'completed' && Boolean(saved.savedArtifacts?.length) && Boolean(saved.savedItems?.length);
    });
    const state = (await proof.state(sessionId)).value;
    await rememberSessionSecrets();
    check(state.session.agent.id === agentId && state.session.vault_ids.join() === vaultId && state.session.environment.type === 'openai_hosted', 'executed prebound Agent and Vault');
    const integration = await proof.store.get<SessionIntegrationState>(proof.owner, 'session_integrations', sessionId);
    check(integration?.value.target.agentId === agentId && integration.value.inputs.some(value => value.id && value.turnId === turn!.id), 'natural Teams integration Turn');
    const items: AgentSessionItem[] = [];
    for await (const item of proof.client.beta.agents.sessions.items.list(sessionId, { order: 'asc', limit: 100 })) items.push(item);
    scan('API items', JSON.stringify(items));
    const commands = items.filter(item => item.type === 'command_execution' && item.turn_id === turn!.id && item.status === 'completed' && item.exit_code === 0 && isDeepStrictEqual(commandArguments(item.command), ['python3', '-c', launcher]));
    check(commands.length === 1, 'exact managed program executed once with successful exit');
    const artifacts: SessionArtifact[] = [];
    for await (const artifact of proof.client.beta.agents.sessions.artifacts.list(sessionId, { limit: 100 })) artifacts.push(artifact);
    check(artifacts.some(value => value.path === artifactPath && value.turn_id === turn!.id), 'nonempty echo artifact');
    let echo: EchoProof | undefined;
    for (const artifact of artifacts) {
      const bytes = Buffer.from(await (await proof.client.beta.agents.sessions.artifacts.content(artifact.id, { session_id: sessionId })).arrayBuffer());
      scan('API artifact bytes', bytes.toString('utf8'));
      const saved = state.turns.flatMap(value => value.savedArtifacts ?? []).find(value => value.artifact.id === artifact.id);
      check(saved && saved.content.bucket === required('ARTIFACT_BUCKET') && saved.content.key.startsWith(`owners/${hash(proof.owner).slice(0, 32)}/sessions/${sessionId}/`), 'exact owned persisted artifact reference');
      const stored = Buffer.from(await proof.objects.getBytes(saved.content));
      scan('S3 artifact bytes', stored.toString('utf8'));
      check(bytes.equals(stored), 'API artifact matches exact S3 bytes');
      if (artifact.path === artifactPath) echo = JSON.parse(bytes.toString('utf8')) as EchoProof;
    }
    check(echo && echo.proof_id === proof.proofId && echo.uid === 10001 && echo.placeholder && /^rat_secret_[a-f0-9]{64}$/.test(echo.placeholder_value), 'managed UID and guest placeholder');
    check(echo.private_key_denied && echo.host_role_environment_absent && echo.status === 200, 'host key boundary and authenticated fixture request');
    check(echo.body.raw === echo.placeholder_value && echo.body.base64 === echo.placeholder_value && echo.body.url === echo.placeholder_value && echo.headers['x-credential-echo'] === echo.placeholder_value, 'raw encoded and header echoes are the same placeholder');
    check(typeof echo.body.requestId === 'string' && echo.body.requestId.length > 0, 'fixture request identity');
    const executed = commands[0]!;
    check(executed.type === 'command_execution' && typeof executed.output === 'string' && isDeepStrictEqual(JSON.parse(executed.output), echo), 'exact executed stdout matches persisted artifact');
    await eventually('independent authenticated fixture audit', async () => {
      const page = await proof.sqs.send(new ReceiveMessageCommand({ QueueUrl: auditQueue, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, VisibilityTimeout: 15 }));
      let matched = false;
      for (const message of page.Messages ?? []) {
        check(message.ReceiptHandle, 'fixture audit receipt');
        const audit = JSON.parse(message.Body ?? '{}') as { operation?: string; proof?: string; requestId?: string };
        if (audit.operation === 'credential.echo' && audit.proof === proof.proofId && audit.requestId === echo!.body.requestId) {
          scan('independent fixture audit', message.Body!);
          matched = true;
          await proof.sqs.send(new DeleteMessageCommand({ QueueUrl: auditQueue, ReceiptHandle: message.ReceiptHandle }));
        } else await proof.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: auditQueue, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }));
      }
      return matched;
    });
    check(JSON.stringify(items).includes(echo.placeholder_value) && JSON.stringify(items).includes(proof.proofId), 'API items include actual safe output');
    scan('persisted Session', JSON.stringify(state));
    const observation = await proof.store.get<SessionStreamSnapshot>(proof.owner, 'session_observations', sessionId);
    const runtime = await proof.store.get<StoredSessionRuntime>(proof.owner, 'session_runtime', sessionId);
    check(observation && runtime?.value.snapshot, 'persisted observation and runtime snapshots');
    for (const [label, value] of [['persisted observation', observation.value], ['persisted runtime', runtime.value]] as const) {
      const text = JSON.stringify(value);
      scan(label, text);
      check(text.includes(proof.proofId) && text.includes(echo.placeholder_value), `${label} includes safe actual output`);
    }
    scan('persisted Teams integration', JSON.stringify(integration));
    const batches = (await proof.records<SessionEventBatch>('session_event_batches')).filter(value => value.value.sessionId === sessionId);
    check(batches.some(value => JSON.stringify(value.value).includes(echo.placeholder_value)), 'committed stream events contain safe actual output');
    for (const batch of batches) scan('committed stream event batch', JSON.stringify(batch.value));
    let after: string | undefined;
    let traceCount = 0;
    do {
      const page: { data: Array<{ id: string }>; has_more: boolean } = await proof.client.get(`/agents/sessions/${sessionId}/traces`, { query: { limit: 100, ...(after ? { after } : {}) } });
      scan('API traces', JSON.stringify(page));
      traceCount += page.data.length;
      after = page.has_more ? page.data.at(-1)!.id : undefined;
    } while (after);
    check(traceCount > 0, 'nonempty actual trace surface');
    await eventually('actual safe Teams final delivery', async () => {
      const captures = await proof.capture(value => value.includes(proof.proofId) && value.includes(turn!.id));
      for (const value of captures) {
        scan('Teams captured final body', value);
        const message = JSON.parse(value) as { attachments?: Array<{ content?: { body?: Array<{ text?: string }> } }> };
        const output = message.attachments?.flatMap(attachment => attachment.content?.body ?? []).find(block => block.text?.includes('"proof_id"'))?.text;
        if (!output) continue;
        let delivered: EchoProof;
        try { delivered = JSON.parse(output.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) as EchoProof; }
        catch { throw new Error('Teams final answer did not preserve the complete echo JSON'); }
        check(delivered.proof_id === proof.proofId && delivered.placeholder_value === echo!.placeholder_value && delivered.body.raw === echo!.placeholder_value && delivered.body.base64 === echo!.placeholder_value && delivered.body.url === echo!.placeholder_value && delivered.headers['x-credential-echo'] === echo!.placeholder_value && delivered.body.requestId === echo!.body.requestId, 'Teams carries every echo as the same guest placeholder');
        return true;
      }
      return false;
    });
    await eventually('natural Teams delivery receipt', async () => (await proof.store.get<SessionIntegrationState>(proof.owner, 'session_integrations', sessionId))?.value.inputs.some(value => value.turnId === turn!.id && value.deliveryProcessed) ?? false);
    check(sessionSecrets.size > 0, 'hosted credential snapshot metadata');
    proof.evidence.credential = { sessionId, turnId: turn!.id, uid: echo.uid, encodedEchoVariants: ['raw', 'base64', 'url', 'header'], scannedSurfaces: [...scanned], artifacts: artifacts.length, authenticated: true,
      modelAuthException: { fileAvailable: echo.model_auth_file_available, environmentAvailable: echo.model_auth_environment_available, scope: 'Hosted Vault credential confidentiality and absent host AWS role chain; model authentication may remain guest-readable' } };
    succeeded = true;

    function scan(surface: string, text: string): void {
      for (const [encoding, value] of Object.entries(forms)) check(!text.includes(value), `${surface} contains forbidden ${encoding} synthetic credential`);
      scanned.add(surface);
    }
  } finally {
    const failures: string[] = [];
    try { await rememberSessionSecrets(); } catch { failures.push('owned Session credential metadata'); }
    if (binding) {
      try {
        check(binding.ownerId === proof.owner && binding.selector.tenantId === proof.proofId, 'source binding cleanup scope');
        const claim = hash(JSON.stringify(Object.entries(binding.selector).sort(([a], [b]) => a.localeCompare(b))));
        await proof.db.send(new TransactWriteCommand({ TransactItems: [
          { pk: `OWNER#${hash(proof.owner)}`, sk: `SOURCE#${binding.bindingId}` },
          { pk: 'SOURCE#teams', sk: `BINDING#${binding.bindingId}` },
          { pk: 'SOURCE#teams', sk: `CLAIM#${claim}` },
        ].map(Key => ({ Delete: { TableName: required('INTEGRATIONS_TABLE_NAME'), Key,
          ConditionExpression: '#value.ownerId = :owner AND #value.bindingId = :binding', ExpressionAttributeNames: { '#value': 'value' }, ExpressionAttributeValues: { ':owner': proof.owner, ':binding': binding!.bindingId },
        } })) }));
      } catch { failures.push('owned source binding cleanup'); }
    }
    try { await proof.deleteSessions(); } catch { failures.push('owned Session cleanup'); }
    try {
      await eventually('Session secret retirement', async () => (await Promise.all([...sessionSecrets].map(async id => {
        try { return Boolean((await secrets.send(new DescribeSecretCommand({ SecretId: id }))).DeletedDate); }
        catch (error) { if (error instanceof Error && error.name === 'ResourceNotFoundException') return true; throw error; }
      }))).every(Boolean));
    } catch { failures.push('Session secret retirement'); }
    try { if (agentId) await proof.client.beta.agents.delete(agentId); } catch { failures.push('owned Agent cleanup'); }
    try { if (vaultId) await proof.client.beta.agents.vaults.delete(vaultId); } catch { failures.push('owned Vault cleanup'); }
    secrets.destroy(); proof.destroy();
    check(failures.length === 0, failures.join('; '));
    if (succeeded) console.log(JSON.stringify({ proof: 'live-hosted-credential', status: 'PASS', retiredSessionSecrets: sessionSecrets.size, ...proof.evidence }));
  }

  async function rememberSessionSecrets(): Promise<void> {
    for (const sessionId of proof.sessions) {
      const saved = await proof.store.get<SessionEnvironmentCredentialBinding>(proof.owner, 'session_environment_credentials', sessionId);
      for (const reference of saved?.value.references ?? []) {
        check(reference.startsWith(`${proof.prefix}/connections/agents/${hash(proof.owner)}/sessions/${sessionId}/`), 'exact owned Session credential reference');
        sessionSecrets.add(reference);
      }
    }
  }
}, proofTimeout * 5);
