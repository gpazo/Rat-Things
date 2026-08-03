import { createHmac, randomUUID } from 'node:crypto';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import {
  createAwsClients,
  DynamoRunStore,
} from '../../src/adapters/aws-runtime.js';
import type { RunRecord, RunStateEvent } from '../../src/domain/contracts.js';

const integration = process.env.AWS_E2E === 'true' ? describe : describe.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

integration('live AWS agent-runner workflow', () => {
  it('runs the control API and signed provider webhooks through real AWS infrastructure', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const store = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));

    const health = await fetch(new URL('/health', `${required('AGENT_RUNTIME_API_URL')}/`));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });

    const controlMarker = `live-control-${randomUUID()}`;
    const idempotencyKey = `aws-e2e-${randomUUID()}`;
    const submitted = await signedApi<RunRecord>('/v1/runs', 'POST', {
      version: '1',
      prompt: `Return AWS live marker ${controlMarker}`,
      agent: { driver: 'mock', sandbox: 'read-only' },
      execution: { backend: 'microvm', timeoutSeconds: 120 },
      destinations: [{ kind: 'none' }],
    }, { 'idempotency-key': idempotencyKey });
    expect(submitted.status).toBe('queued');

    const repeated = await signedApi<RunRecord>('/v1/runs', 'POST', {
      version: '1',
      prompt: `Return AWS live marker ${controlMarker}`,
      agent: { driver: 'mock', sandbox: 'read-only' },
      execution: { backend: 'microvm', timeoutSeconds: 120 },
      destinations: [{ kind: 'none' }],
    }, { 'idempotency-key': idempotencyKey });
    expect(repeated.runId).toBe(submitted.runId);

    const controlRun = await waitForApiRun(submitted.runId);
    assertSuccessfulMicrovmRun(controlRun);
    expect(controlRun.result?.preview).toBe(`mock-agent: Return AWS live marker ${controlMarker}`);
    await expectTerminalEvents(clients.sqs, new Set([submitted.runId]));

    const descriptor = await signedApi<{ url: string }>(
      `/v1/runs/${submitted.runId}/artifacts/output`,
      'GET',
    );
    const outputResponse = await fetch(descriptor.url);
    expect(outputResponse.status).toBe(200);
    expect(await outputResponse.text()).toBe(`mock-agent: Return AWS live marker ${controlMarker}`);

    const teamsMarker = `live-teams-${randomUUID()}`;
    const [githubRunId, gitlabRunId, teamsRunId] = await Promise.all([
      submitGitHubWebhook(),
      submitGitLabWebhook(),
      submitTeamsWebhook(teamsMarker),
    ]);
    const [githubRun, gitlabRun, teamsRun] = await Promise.all([
      waitForStoredRun(store, githubRunId),
      waitForStoredRun(store, gitlabRunId),
      waitForStoredRun(store, teamsRunId),
    ]);
    assertSuccessfulMicrovmRun(githubRun);
    assertSuccessfulMicrovmRun(gitlabRun);
    assertSuccessfulMicrovmRun(teamsRun);
    expect(githubRun.sourceKind).toBe('github');
    expect(gitlabRun.sourceKind).toBe('gitlab');
    expect(teamsRun.sourceKind).toBe('teams');
    expect(await outputText(clients.s3, githubRun)).toContain('mock-agent: Review GitHub pull request');
    expect(await outputText(clients.s3, gitlabRun)).toContain('mock-agent: Review GitLab merge request');
    expect(await outputText(clients.s3, teamsRun)).toBe(`mock-agent: Return AWS live marker ${teamsMarker}`);

    await expectTerminalEvents(clients.sqs, new Set([githubRunId, gitlabRunId, teamsRunId]));
    await expectTeamsDeliveries(clients.sqs, new Map([
      [githubRunId, 'mock-agent: Review GitHub pull request'],
      [gitlabRunId, 'mock-agent: Review GitLab merge request'],
      [teamsRunId, `mock-agent: Return AWS live marker ${teamsMarker}`],
    ]));

    await expectEmptyFailureQueues(clients.sqs);
  }, timeoutMs);

  const microvmTest = process.env.AWS_E2E_ENABLE_MICROVM === 'true' ? it : it.skip;
  microvmTest('runs a repository-backed request in a real Lambda MicroVM', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const microvmMarker = `live-microvm-${randomUUID()}`;
    const microvmRun = await signedApi<RunRecord>('/v1/runs', 'POST', {
      version: '1',
      prompt: `Return AWS live marker ${microvmMarker}`,
      repository: {
        provider: 'github',
        url: required('AWS_E2E_GITHUB_REPOSITORY_URL'),
        ref: required('AWS_E2E_GITHUB_SHA'),
      },
      agent: { driver: 'mock', sandbox: 'read-only' },
      execution: { backend: 'microvm', timeoutSeconds: 120 },
      destinations: [{ kind: 'none' }],
    }, { 'idempotency-key': `aws-e2e-microvm-${randomUUID()}` });
    const completedMicrovmRun = await waitForApiRun(microvmRun.runId);
    assertSuccessfulRun(completedMicrovmRun, 'microvm');
    expect(completedMicrovmRun.execution?.id).not.toMatch(/^arn:aws:ecs:/);
    expect(await outputText(clients.s3, completedMicrovmRun))
      .toBe(`mock-agent: Return AWS live marker ${microvmMarker}`);
    await expectTerminalEvents(clients.sqs, new Set([microvmRun.runId]));
    await expectEmptyFailureQueues(clients.sqs);
  }, timeoutMs);

  const realCodexTest = process.env.AWS_E2E_REAL_CODEX === 'true' ? it : it.skip;
  realCodexTest('runs a real Codex response through Bedrock in a Lambda MicroVM', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const marker = `real-codex-${randomUUID()}`;
    const submitted = await signedApi<RunRecord>('/v1/runs', 'POST', {
      version: '1',
      prompt: `Respond with exactly this marker and no other text: ${marker}`,
      agent: {
        driver: 'codex',
        model: process.env.AWS_E2E_CODEX_MODEL_ID ?? 'openai.gpt-5.6-terra',
        sandbox: 'read-only',
        reasoningEffort: 'low',
      },
      execution: { backend: 'microvm', timeoutSeconds: 300 },
      destinations: [{ kind: 'none' }],
    }, { 'idempotency-key': `aws-e2e-real-codex-${randomUUID()}` });

    const completed = await waitForApiRun(submitted.runId);
    expect(completed.status, JSON.stringify(completed.error)).toBe('succeeded');
    expect(completed.execution?.backend).toBe('microvm');
    expect(completed.execution?.id).toBeTruthy();
    expect(completed.result?.exitCode).toBe(0);
    expect(completed.result?.agentThreadId).toBeTruthy();
    expect(completed.result?.agentThreadId).not.toBe('mock-thread');
    expect(completed.result?.usage?.inputTokens).toBeGreaterThan(0);
    expect(completed.result?.usage?.outputTokens).toBeGreaterThan(0);
    expect((await outputText(clients.s3, completed)).trim()).toContain(marker);
    await expectTerminalEvents(clients.sqs, new Set([submitted.runId]));
    await expectEmptyFailureQueues(clients.sqs);
  }, timeoutMs);
});

async function submitGitHubWebhook(): Promise<string> {
  const deliveryId = randomUUID();
  const body = JSON.stringify({
    action: 'opened',
    number: 1,
    installation: { id: 4242 },
    repository: {
      full_name: required('AWS_E2E_GITHUB_REPOSITORY'),
      clone_url: required('AWS_E2E_GITHUB_REPOSITORY_URL'),
    },
    pull_request: {
      title: 'AWS live infrastructure validation',
      body: 'Deterministic mock-agent execution against the live Lambda MicroVM runner.',
      user: { login: 'aws-e2e' },
      head: { sha: required('AWS_E2E_GITHUB_SHA') },
      base: { ref: 'master' },
    },
  });
  const signature = `sha256=${createHmac('sha256', required('GITHUB_WEBHOOK_SIGNING_SECRET'))
    .update(body)
    .digest('hex')}`;
  const headers = {
    'content-type': 'application/json',
    'x-github-event': 'pull_request',
    'x-github-delivery': deliveryId,
    'x-hub-signature-256': signature,
  };
  const first = await webhook(required('GITHUB_WEBHOOK_URL'), body, headers);
  const repeated = await webhook(required('GITHUB_WEBHOOK_URL'), body, headers);
  expect(first.status).toBe(202);
  expect(repeated.status).toBe(202);
  expect(repeated.runId).toBe(first.runId);
  return first.runId;
}

async function submitGitLabWebhook(): Promise<string> {
  const webhookId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const body = JSON.stringify({
    object_kind: 'merge_request',
    project: {
      id: 13083,
      path_with_namespace: required('AWS_E2E_GITLAB_REPOSITORY'),
      git_http_url: required('AWS_E2E_GITLAB_REPOSITORY_URL'),
    },
    object_attributes: {
      action: 'open',
      iid: 1,
      title: 'AWS live infrastructure validation',
      description: 'Deterministic mock-agent execution against the live Lambda MicroVM runner.',
      target_branch: 'master',
      last_commit: { id: required('AWS_E2E_GITLAB_SHA') },
    },
  });
  const token = required('GITLAB_WEBHOOK_SIGNING_TOKEN');
  const signature = createHmac('sha256', Buffer.from(token.slice('whsec_'.length), 'base64'))
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest('base64');
  const response = await webhook(required('GITLAB_WEBHOOK_URL'), body, {
    'content-type': 'application/json',
    'webhook-id': webhookId,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
    'x-gitlab-event': 'Merge Request Hook',
  });
  expect(response.status).toBe(202);
  return response.runId;
}

async function submitTeamsWebhook(marker: string): Promise<string> {
  const activityId = randomUUID();
  const body = JSON.stringify({
    type: 'message',
    id: activityId,
    text: `<at>Indubitably</at> Return AWS live marker ${marker}`,
    from: { id: 'aws-e2e-user', name: 'AWS E2E' },
    conversation: { id: 'aws-e2e-conversation' },
    channelData: {
      tenant: { id: 'aws-e2e-tenant' },
      team: { id: 'aws-e2e-team' },
      channel: { id: 'aws-e2e-channel' },
    },
  });
  const key = Buffer.from(required('TEAMS_WEBHOOK_SIGNING_SECRET'), 'base64');
  const signature = `HMAC ${createHmac('sha256', key).update(body, 'utf8').digest('base64')}`;
  const request = (): Promise<Response> => fetch(required('TEAMS_WEBHOOK_URL'), {
    method: 'POST',
    headers: {
      authorization: signature,
      'content-type': 'application/json',
    },
    body,
  });
  const first = await request();
  const firstText = await first.text();
  const repeated = await request();
  const repeatedText = await repeated.text();
  expect(first.status).toBe(200);
  expect(repeated.status).toBe(200);
  expect(repeatedText).toBe(firstText);
  const runId = firstText.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
  if (!runId) throw new Error(`Teams webhook returned no run ID: ${firstText.slice(0, 500)}`);
  return runId;
}

async function webhook(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; runId: string }> {
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  const value = text ? JSON.parse(text) as { runId?: unknown } : {};
  if (typeof value.runId !== 'string') {
    throw new Error(`webhook returned HTTP ${response.status} without a run ID: ${text.slice(0, 500)}`);
  }
  return { status: response.status, runId: value.runId };
}

async function waitForApiRun(runId: string): Promise<RunRecord> {
  return waitForRun(async () => signedApi<RunRecord>(`/v1/runs/${runId}`, 'GET'));
}

async function waitForStoredRun(store: DynamoRunStore, runId: string): Promise<RunRecord> {
  return waitForRun(async () => {
    const run = await store.get(runId);
    if (!run) throw new Error(`run ${runId} was not found`);
    return run;
  });
}

async function waitForRun(load: () => Promise<RunRecord>): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs - 30_000;
  let latest: RunRecord | undefined;
  while (Date.now() < deadline) {
    latest = await load();
    if (['succeeded', 'failed', 'cancelled'].includes(latest.status)) return latest;
    await delay(2_000);
  }
  throw new Error(`run did not become terminal; last state was ${latest?.status ?? 'unknown'}`);
}

function assertSuccessfulMicrovmRun(run: RunRecord): void {
  assertSuccessfulRun(run, 'microvm');
  expect(run.execution?.id).not.toMatch(/^arn:aws:/);
}

function assertSuccessfulRun(run: RunRecord, backend: 'microvm'): void {
  expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
  expect(run.execution?.backend).toBe(backend);
  expect(run.execution?.id).toBeTruthy();
  expect(run.result).toMatchObject({ exitCode: 0, agentThreadId: 'mock-thread' });
}

async function outputText(
  s3: ReturnType<typeof createAwsClients>['s3'],
  run: RunRecord,
): Promise<string> {
  if (!run.result) throw new Error(`run ${run.runId} has no result`);
  const response = await s3.send(new GetObjectCommand({
    Bucket: run.result.output.bucket,
    Key: run.result.output.key,
  }));
  return response.Body ? response.Body.transformToString('utf8') : '';
}

async function expectTerminalEvents(
  sqs: ReturnType<typeof createAwsClients>['sqs'],
  expectedRunIds: Set<string>,
): Promise<void> {
  const remaining = new Set(expectedRunIds);
  const deadline = Date.now() + 60_000;
  while (remaining.size > 0 && Date.now() < deadline) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: required('TERMINAL_EVENTS_QUEUE_URL'),
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 20,
    }));
    for (const message of response.Messages ?? []) {
      const event = JSON.parse(message.Body ?? '{}') as { detail?: RunStateEvent };
      if (event.detail?.runId && remaining.has(event.detail.runId)) {
        expect(event.detail.status).toBe('succeeded');
        remaining.delete(event.detail.runId);
      }
      if (message.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({
          QueueUrl: required('TERMINAL_EVENTS_QUEUE_URL'),
          ReceiptHandle: message.ReceiptHandle,
        }));
      }
    }
  }
  expect([...remaining], 'terminal EventBridge events not observed').toEqual([]);
}

async function expectTeamsDeliveries(
  sqs: ReturnType<typeof createAwsClients>['sqs'],
  expected: Map<string, string>,
): Promise<void> {
  const remaining = new Map(expected);
  const deadline = Date.now() + 60_000;
  while (remaining.size > 0 && Date.now() < deadline) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: required('DELIVERY_CAPTURE_QUEUE_URL'),
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 20,
    }));
    for (const message of response.Messages ?? []) {
      const payload = JSON.parse(message.Body ?? '{}') as {
        type?: unknown;
        attachments?: Array<{
          content?: {
            body?: Array<{ type?: unknown; text?: unknown; facts?: Array<{ value?: unknown }> }>;
          };
        }>;
      };
      const cardBody = payload.attachments?.[0]?.content?.body ?? [];
      const deliveredRunId = cardBody
        .flatMap((item) => item.facts ?? [])
        .map((fact) => fact.value)
        .find((value): value is string => typeof value === 'string' && remaining.has(value));
      if (deliveredRunId) {
        expect(payload.type).toBe('message');
        const text = cardBody
          .map((item) => item.text)
          .filter((value): value is string => typeof value === 'string')
          .join('\n');
        expect(text).toContain('Agent run succeeded');
        expect(text).toContain(remaining.get(deliveredRunId));
        remaining.delete(deliveredRunId);
      }
      if (message.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({
          QueueUrl: required('DELIVERY_CAPTURE_QUEUE_URL'),
          ReceiptHandle: message.ReceiptHandle,
        }));
      }
    }
  }
  expect([...remaining.keys()], 'Teams delivery payloads not observed').toEqual([]);
}

async function expectEmptyFailureQueues(
  sqs: ReturnType<typeof createAwsClients>['sqs'],
): Promise<void> {
  for (const name of [
    'RUN_FAILURE_QUEUE_URL',
    'STATE_STREAM_FAILURE_QUEUE_URL',
    'NOTIFIER_DELIVERY_FAILURE_QUEUE_URL',
  ]) {
    const response = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: required(name),
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    expect(Number(response.Attributes?.ApproximateNumberOfMessages ?? '0'), name).toBe(0);
    expect(Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0'), name).toBe(0);
  }
}

async function signedApi<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, `${required('AGENT_RUNTIME_API_URL').replace(/\/$/, '')}/`);
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  const unsignedHeaders: Record<string, string> = {
    host: url.host,
    accept: 'application/json',
    ...(encoded ? { 'content-type': 'application/json' } : {}),
    ...extraHeaders,
  };
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: required('AWS_REGION'),
    service: 'execute-api',
    sha256: Sha256,
  });
  const signed = await signer.sign(new HttpRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: unsignedHeaders,
    ...(encoded ? { body: encoded } : {}),
  }));
  const response = await fetch(url, {
    method,
    headers: signed.headers,
    ...(encoded ? { body: encoded } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}: ${text.slice(0, 1_000)}`);
  return JSON.parse(text) as T;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
