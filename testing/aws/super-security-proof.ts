import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createAgentsClient } from '../../src/agents-client.js';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { S3ArtifactStore } from '../../src/adapters/aws-runtime.js';
import type { AgentResource } from '../../src/core/agents-ports.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { StoredSessionRuntime } from '../../src/core/session-runtime-store.js';
import type { SessionEventBatch } from '../../src/core/session-event-store.js';
import type { WatchdogFinding } from '../../src/domain/watchdog.js';
import type { WatchdogService } from '../../src/core/watchdog-service.js';
import type { SessionIntegrationState, IntegrationOccurrence, ThreadSubscription } from '../../src/domain/session-integrations.js';
import type { WebhookDelivery } from '../../src/domain/session-webhooks.js';
import type { RunRecord } from '../../src/domain/contracts.js';
import { watchdogIdentity } from '../../src/core/watchdog-planning.js';

export const proofTimeout = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export function check(value: unknown, label: string): asserts value { if (!value) throw new Error(`Live security proof failed: ${label}`); }
export function required(name: string): string { const value = process.env[name]; check(value, `${name} is required`); return value; }
export async function eventually(label: string, predicate: () => Promise<boolean>, timeout = proofTimeout): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(2000); }
  throw new Error(`Live security proof deadline: ${label}`);
}
export async function aws<T>(region: string, args: string[]): Promise<T> {
  try {
    const result = await promisify(execFile)('aws', [...args, '--region', region, '--output', 'json', '--no-cli-pager'], { timeout: 330_000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(result.stdout) as T;
  } catch { throw new Error(`Live security AWS operation failed: ${args[0]} ${args[1]}`); }
}
interface Mapping { UUID: string; State: string; FunctionArn: string; EventSourceArn: string }
interface FunctionConfig { Configuration: { FunctionArn: string; Timeout: number; Environment?: { Variables?: Record<string, string> } }; Tags?: Record<string, string> }
type WatchdogTick = Awaited<ReturnType<WatchdogService['tick']>>;

export class SecurityProof {
  readonly region = required('AWS_REGION');
  readonly deployment = required('AWS_E2E_DEPLOYMENT_ID');
  readonly prefix = `rat-things-${this.deployment}`;
  readonly account = required('AWS_E2E_CALLER_ACCOUNT');
  readonly owner = `api:${required('AWS_E2E_CALLER_ARN')}`;
  readonly model = required('AWS_E2E_CODEX_MODEL_ID');
  readonly proofId = `security-${randomUUID()}`;
  readonly queue = required('DELIVERY_CAPTURE_QUEUE_URL');
  readonly client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region: this.region }).withOptions({ maxRetries: 0, timeout: 360_000 });
  readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: this.region }));
  readonly s3 = new S3Client({ region: this.region });
  readonly sqs = new SQSClient({ region: this.region });
  objects!: S3ArtifactStore;
  store!: DynamoAgentsStore;
  readonly sessions = new Set<string>();
  readonly captures: string[] = [];
  readonly evidence: Record<string, unknown> = {};
  private mapping: Mapping | undefined;
  private scanOwner: string | undefined;

  async validate(): Promise<void> {
    check(process.env.AWS_E2E === 'true' && process.env.AWS_E2E_SUPER_AGENT_PROOF === 'true' && process.env.AWS_E2E_REAL_CODEX === 'true', 'explicit live model and security opt-ins');
    check(/^[a-z0-9][a-z0-9-]{2,13}$/.test(this.deployment), 'disposable deployment ID');
    check(/^\d{12}$/.test(this.account), 'AWS account');
    const caller = await aws<{ Account: string; Arn: string }>(this.region, ['sts', 'get-caller-identity']);
    check(caller.Account === this.account && `api:${caller.Arn}` === this.owner, 'authenticated owner and account');
    check(required('AGENTS_TABLE_NAME') === `${this.prefix}-agents`, 'exact Agents table');
    const table = await this.db.send(new DescribeTableCommand({ TableName: required('AGENTS_TABLE_NAME') }));
    check(table.Table?.TableArn === `arn:aws:dynamodb:${this.region}:${this.account}:table/${this.prefix}-agents`, 'Agents table ARN');
    const suffix = hash(`${this.account}:${this.region}:${this.prefix}`).slice(0, 12);
    for (const [name, kind] of [['DEFINITION_BUCKET', 'definitions'], ['ARTIFACT_BUCKET', 'artifacts']] as const) {
      check(required(name) === `${this.prefix}-${kind}-${suffix}`, `exact ${kind} bucket`);
      await this.s3.send(new HeadBucketCommand({ Bucket: required(name), ExpectedBucketOwner: this.account }));
    }
    const queue = await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.queue, AttributeNames: ['QueueArn'] }));
    check(queue.Attributes?.QueueArn === `arn:aws:sqs:${this.region}:${this.account}:${this.prefix}-delivery-capture`, 'exact capture queue ARN');
    const watchdog = await this.function('watchdog');
    const env = watchdog.Configuration.Environment?.Variables;
    check(env?.WATCHDOG_MODEL === this.model && env.WATCHDOG_LONG_RUNNING_SECONDS === '1800' && env.WATCHDOG_STUCK_SECONDS === '300' && env.WATCHDOG_RETRY_BACKOFF_SECONDS === '1' && env.WATCHDOG_MAX_CANDIDATES === '100' && env.WATCHDOG_MAX_JUDGES_PER_TICK === '1' && env.WATCHDOG_ALLOW_CANCEL !== 'true', 'deployed watchdog proof policy');
    check(env.AGENTS_TABLE_NAME === required('AGENTS_TABLE_NAME') && env.DEFINITION_BUCKET === required('DEFINITION_BUCKET'), 'watchdog storage scope');
    const kmsKey = env.DEFINITION_KMS_KEY_ARN;
    check(kmsKey && kmsKey.startsWith(`arn:aws:kms:${this.region}:${this.account}:key/`), 'deployment definition KMS key');
    this.objects = new S3ArtifactStore(this.s3, required('DEFINITION_BUCKET'), { algorithm: 'aws:kms', kmsKeyId: kmsKey });
    this.store = new DynamoAgentsStore(this.db, required('AGENTS_TABLE_NAME'), this.objects);
    check(env.WATCHDOG_OWNER_ID, 'watchdog scan owner');
    this.scanOwner = env.WATCHDOG_OWNER_ID;
    const rule = await aws<{ Arn: string; ScheduleExpression: string; State: string }>(this.region, ['events', 'describe-rule', '--name', required('AWS_E2E_WATCHDOG_RULE_NAME')]);
    check(required('AWS_E2E_WATCHDOG_RULE_NAME') === `${this.prefix}-watchdog` && rule.Arn === `arn:aws:events:${this.region}:${this.account}:rule/${this.prefix}-watchdog` && rule.ScheduleExpression === 'rate(1 minute)' && rule.State === 'ENABLED', 'deployed watchdog schedule');
    const targets = await aws<{ Targets: Array<{ Arn: string }> }>(this.region, ['events', 'list-targets-by-rule', '--rule', required('AWS_E2E_WATCHDOG_RULE_NAME')]);
    check(targets.Targets.length === 1 && targets.Targets[0]!.Arn === watchdog.Configuration.FunctionArn, 'scheduled watchdog target');
    const capture = new URL(required('AWS_E2E_WEBHOOK_CAPTURE_URL'));
    const captureApi = await aws<{ Name: string; ApiEndpoint: string; Tags: Record<string, string> }>(this.region, ['apigatewayv2', 'get-api', '--api-id', capture.hostname.split('.')[0]!]);
    check(captureApi.Name === `${this.prefix}-delivery-capture` && capture.origin === captureApi.ApiEndpoint && capture.pathname === '/teams' && captureApi.Tags.DeploymentId === this.deployment, 'owned report capture URL');
    this.evidence.scope = { deployment: this.deployment, ownerHash: hash(this.owner), proofId: this.proofId };
  }
  async function(kind: 'watchdog' | 'agents-outbox'): Promise<FunctionConfig> {
    const name = required(kind === 'watchdog' ? 'AWS_E2E_WATCHDOG_FUNCTION_NAME' : 'AWS_E2E_AGENTS_OUTBOX_FUNCTION_NAME');
    check(name === `${this.prefix}-${kind}`, 'exact function name');
    const value = await aws<FunctionConfig>(this.region, ['lambda', 'get-function', '--function-name', name]);
    check(value.Configuration.FunctionArn === `arn:aws:lambda:${this.region}:${this.account}:function:${name}`, 'function ARN');
    check(value.Tags?.Ephemeral === 'true' && value.Tags.DeploymentId === this.deployment && value.Tags.Purpose === 'live-e2e-validation', 'disposable function tags');
    return value;
  }
  async pauseOutbox(): Promise<void> {
    const fn = await this.function('agents-outbox');
    const queueArn = `arn:aws:sqs:${this.region}:${this.account}:${this.prefix}-agents.fifo`;
    const result = await aws<{ EventSourceMappings: Mapping[] }>(this.region, ['lambda', 'list-event-source-mappings', '--function-name', fn.Configuration.FunctionArn, '--event-source-arn', queueArn]);
    check(result.EventSourceMappings.length === 1, 'one exact agents FIFO consumer');
    const mapping = result.EventSourceMappings[0]!;
    check(mapping.FunctionArn === fn.Configuration.FunctionArn && mapping.EventSourceArn === queueArn && ['Enabled', 'Disabled'].includes(mapping.State), 'stable matching FIFO consumer');
    this.mapping = mapping;
    this.evidence.mapping = { uuid: mapping.UUID, original: mapping.State };
    if (mapping.State === 'Enabled') await aws(this.region, ['lambda', 'update-event-source-mapping', '--uuid', mapping.UUID, '--no-enabled']);
    await this.mappingState('Disabled');
    await delay((fn.Configuration.Timeout + 5) * 1000);
  }
  async mappingState(state: string): Promise<void> {
    check(this.mapping, 'mapping snapshot exists');
    await eventually(`mapping ${state}`, async () => {
      const current = await aws<Mapping>(this.region, ['lambda', 'get-event-source-mapping', '--uuid', this.mapping!.UUID]);
      check(current.EventSourceArn === this.mapping!.EventSourceArn && current.FunctionArn === this.mapping!.FunctionArn, 'mapping ownership unchanged');
      return current.State === state;
    }, 120_000);
  }
  async restoreOutbox(): Promise<void> {
    if (!this.mapping) return;
    if (this.mapping.State === 'Enabled') await aws(this.region, ['lambda', 'update-event-source-mapping', '--uuid', this.mapping.UUID, '--enabled']);
    await this.mappingState(this.mapping.State);
    this.evidence.mappingRestored = this.mapping.State;
  }
  async tick(): Promise<WatchdogTick> {
    const directory = await mkdtemp(join(tmpdir(), 'rat-watchdog-tick-'));
    try {
      const output = join(directory, 'response.json');
      const result = await aws<{ FunctionError?: string; StatusCode: number }>(this.region, ['lambda', 'invoke', '--function-name', required('AWS_E2E_WATCHDOG_FUNCTION_NAME'), '--payload', '{}', '--cli-binary-format', 'raw-in-base64-out', output]);
      check(result.StatusCode === 200 && !result.FunctionError, 'deployed watchdog invocation');
      const file = await open(output, 'r');
      let body: string;
      try {
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        check(bytesRead > 0 && bytesRead <= 4096, 'bounded watchdog invocation response');
        body = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await file.close(); }
      const tick = JSON.parse(body) as WatchdogTick | null;
      check(tick && typeof tick.partial === 'boolean' && [tick.candidates, tick.reports, tick.errors].every(value => Number.isSafeInteger(value) && value >= 0), 'watchdog invocation result');
      return { candidates: tick.candidates, reports: tick.reports, errors: tick.errors, partial: tick.partial };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async revisit(): Promise<void> {
    check(this.scanOwner, 'configured collector owner');
    // Finish the current page cycle, then one complete cycle from the beginning.
    for (let cycle = 0; cycle < 2; cycle++) await eventually('complete deployed collector sweep', async () => {
      await this.tick();
      const cursor = await this.store.get<{ agents?: unknown; candidateOffset?: number }>(this.scanOwner!, 'watchdog_scan', 'cursor');
      return Boolean(cursor && !cursor.value.agents && !cursor.value.candidateOffset);
    });
  }
  async records<T>(collection: string): Promise<Array<AgentResource<T>>> {
    const values: Array<AgentResource<T>> = [];
    let after: string | undefined;
    do {
      const page = await this.store.list<T>(this.owner, collection, { limit: 100, order: 'asc', ...(after ? { after } : {}) });
      values.push(...page.data);
      after = page.has_more ? page.data.at(-1)!.id : undefined;
    } while (after);
    return values;
  }
  async state(id: string): Promise<AgentResource<SessionState>> {
    check(this.sessions.has(id), 'Session belongs to proof manifest');
    const state = await this.store.get<SessionState>(this.owner, 'sessions', id);
    check(state && state.ownerId === this.owner && state.value.session.id === id, 'owned persisted Session');
    return state;
  }
  async capture(matches: (body: string) => boolean): Promise<string[]> {
    const found = this.captures.filter(matches);
    if (found.length) return found;
    const page = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.queue, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, VisibilityTimeout: 15 }));
    for (const message of page.Messages ?? []) {
      check(message.ReceiptHandle, 'capture receipt');
      if (matches(message.Body ?? '')) {
        this.captures.push(message.Body!);
        found.push(message.Body!);
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queue, ReceiptHandle: message.ReceiptHandle }));
      } else await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queue, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }));
    }
    return found;
  }
  async deleteSessions(): Promise<void> {
    if (!this.sessions.size) return;
    const failures: string[] = [];
    const findings = (await this.records<WatchdogFinding>('watchdog_findings')).filter(value => value.value.candidate.ownerId === this.owner && this.sessions.has(value.value.candidate.sessionId ?? ''));
    for (const finding of findings) {
      check(finding.id === watchdogIdentity(finding.value.candidate), 'derived finding identity');
      if (finding.value.judge.status !== 'skipped' && finding.value.judge.sessionId) this.sessions.add(finding.value.judge.sessionId);
    }
    for (const id of this.sessions) {
      try {
        try { await this.client.beta.agents.sessions.delete(id); }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
        check(!await this.store.get(this.owner, 'sessions', id), 'Session deleted');
        const runtime = await this.store.get<StoredSessionRuntime>(this.owner, 'session_runtime', id);
        check(!runtime || runtime.value.closed, 'Session runtime closed');
        if (runtime?.value.runId) await this.retiredWorker(id, runtime.value.runId);
      } catch { failures.push(`Session cleanup ${id}`); }
    }
    // A failed Session deletion must not remove evidence needed for recovery.
    if (!failures.length) {
      const remaining = (await this.records<WatchdogFinding>('watchdog_findings')).filter(value => value.value.candidate.ownerId === this.owner && this.sessions.has(value.value.candidate.sessionId ?? ''));
      for (const finding of remaining) {
        check(finding.id === watchdogIdentity(finding.value.candidate), 'cleanup finding identity');
        await this.store.delete(finding);
      }
      for (const batch of await this.records<SessionEventBatch>('session_event_batches')) if (this.sessions.has(batch.value.sessionId)) await this.store.delete(batch);
      for (const delivery of await this.records<WebhookDelivery>('webhook_deliveries')) if (this.sessions.has(delivery.value.event.data.id)) await this.store.delete(delivery);
      for (const integration of await this.records<SessionIntegrationState>('session_integrations')) if (this.sessions.has(integration.id)) {
        const subscriptionId = integration.value.threadSubscriptionId;
        if (subscriptionId) {
          const subscription = await this.store.get<ThreadSubscription>(this.owner, 'thread_subscriptions', subscriptionId);
          check(!subscription || subscription.value.subscribers.every(value => this.sessions.has(value.sessionId)), 'exclusive owned thread subscription');
          if (subscription) await this.store.delete(subscription);
        }
        await this.store.delete(integration);
      }
      for (const occurrence of await this.records<IntegrationOccurrence>('integration_occurrences')) if (this.sessions.has(occurrence.value.sessionId)) await this.store.delete(occurrence);
    }
    check(failures.length === 0, failures.join('; '));
    this.evidence.cleanedSessions = [...this.sessions];
  }
  private async retiredWorker(sessionId: string, runId: string): Promise<void> {
    const result = await this.db.send(new GetCommand({ TableName: `${this.prefix}-runs`, Key: { runId }, ConsistentRead: true }));
    const run = result.Item as RunRecord | undefined;
    check(run?.ownerId === this.owner && run.agentsSession?.sessionId === sessionId, 'owned worker Run');
    if (run.execution?.backend !== 'ec2' || run.execution.id === 'pending') return;
    const execution = run.execution;
    await eventually('dedicated worker retirement', async () => {
      const result = await aws<{ Reservations: Array<{ Instances: Array<{ InstanceId: string; State: { Name: string }; Tags: Array<{ Key: string; Value: string }> }> }> }>(this.region, ['ec2', 'describe-instances', '--instance-ids', execution.id]);
      const instances = result.Reservations.flatMap(value => value.Instances);
      check(instances.length === 1 && instances[0]!.InstanceId === execution.id, 'exact worker instance');
      const tags = Object.fromEntries(instances[0]!.Tags.map(tag => [tag.Key, tag.Value]));
      check(tags.RatDeployment === this.prefix && tags.RatRunId === runId && tags.RatGeneration === execution.generation, 'dedicated worker ownership');
      return instances[0]!.State.Name === 'terminated';
    }, 180_000);
  }
  destroy(): void { this.db.destroy(); this.s3.destroy(); this.sqs.destroy(); }
}

export function assistantText(state: SessionState, turnId: string): string {
  return (state.turns.find(binding => binding.turn.id === turnId)?.savedItems ?? []).flatMap(item => item.type === 'message' && item.role === 'assistant' && item.phase !== 'commentary' ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('\n');
}
