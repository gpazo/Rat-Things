import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  createAwsClientConfig,
  createAwsClients,
  DynamoRunStore,
  S3ArtifactStore,
  SqsConversationQueue,
  SqsRunQueue,
} from '../../src/adapters/aws-runtime.js';
import { DynamoConversationStore } from '../../src/adapters/dynamo-conversation-store.js';
import { ConversationCoordinator } from '../../src/conversation/coordinator.js';
import { ConversationService } from '../../src/conversation/service.js';
import { RunService } from '../../src/core/run-service.js';
import type { RunRecord, RunStateEvent } from '../../src/domain/contracts.js';
import type {
  ConversationEventPayload,
  ConversationExecutionPolicy,
  ConversationRecord,
} from '../../src/domain/conversations.js';

const integration = process.env.AWS_E2E === 'true' ? describe : describe.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

integration('live AWS agent-runner workflow', () => {
  it('runs the control API and signed provider webhooks through real AWS infrastructure', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const store = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const conversationStore = new DynamoConversationStore(
      clients.dynamodb,
      required('CONVERSATIONS_TABLE_NAME'),
    );
    const artifacts = new S3ArtifactStore(clients.s3, required('ARTIFACT_BUCKET'));

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

    const headlessMarker = `live-headless-${randomUUID()}`;
    const headlessConversation = `headless-${randomUUID()}`;
    const headlessReceipt = await submitApiConversation(
      headlessConversation,
      `Return AWS live marker ${headlessMarker}`,
      { driver: 'mock', sandbox: 'read-only' },
    );
    const headlessStatus = await waitForApiConversationMessage(
      headlessConversation,
      headlessReceipt.messageId,
    );
    const headlessRun = requiredConversationRun(headlessStatus);
    assertSuccessfulMicrovmRun(headlessRun);
    expect(headlessRun.sourceKind).toBe('api');
    expect(headlessRun.conversation).toMatchObject({
      conversationId: expect.stringMatching(/^api:[a-f0-9]{32}:headless-/),
    });
    expect(headlessStatus.conversation).toMatchObject({
      status: 'idle',
      pendingCount: 0,
      session: {
        id: requiredExecutionId(headlessRun),
        state: 'suspended',
      },
    });
    expect(await outputText(clients.s3, headlessRun)).toContain(headlessMarker);
    await expectTerminalEvents(clients.sqs, new Set([headlessRun.runId]));

    const teamsMarker = `live-teams-${randomUUID()}`;
    const teamsProviderConversationId = `aws-e2e-conversation-${randomUUID()}`;
    const [githubRunId, gitlabRunId, teamsReceipt] = await Promise.all([
      submitGitHubWebhook(),
      submitGitLabWebhook(),
      submitTeamsWebhook(teamsMarker, teamsProviderConversationId),
    ]);
    const teamsScheduled = await waitForConversationRun(
      conversationStore,
      artifacts,
      store,
      teamsReceipt.conversationId,
    );
    const teamsRunId = teamsScheduled.runId;
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
    expect(await outputText(clients.s3, teamsRun)).toContain(`Return AWS live marker ${teamsMarker}`);

    await expectTerminalEvents(clients.sqs, new Set([githubRunId, gitlabRunId, teamsRunId]));
    await expectTeamsDeliveries(clients.sqs, new Map([
      [githubRunId, 'mock-agent: Review GitHub pull request'],
      [gitlabRunId, 'mock-agent: Review GitLab merge request'],
      [teamsRunId, `Return AWS live marker ${teamsMarker}`],
    ]));

    await expectEmptyFailureQueues(clients.sqs);
  }, timeoutMs);

  const persistentMicrovmTest = process.env.AWS_E2E_ENABLE_MICROVM === 'true' ? it : it.skip;
  persistentMicrovmTest('suspends and resumes one conversation on the same live Lambda MicroVM', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const runStore = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const conversationStore = new DynamoConversationStore(
      clients.dynamodb,
      required('CONVERSATIONS_TABLE_NAME'),
    );
    const artifacts = new S3ArtifactStore(clients.s3, required('ARTIFACT_BUCKET'));
    const microvms = new LambdaMicrovmsClient(createAwsClientConfig());
    const providerConversationId = `aws-e2e-persistent-${randomUUID()}`;
    const firstMarker = `persistent-first-${randomUUID()}`;
    const secondMarker = `persistent-second-${randomUUID()}`;

    const firstReceipt = await submitTeamsWebhook(firstMarker, providerConversationId);
    const firstRun = await waitForConversationRun(
      conversationStore,
      artifacts,
      runStore,
      firstReceipt.conversationId,
    );
    const firstCompleted = await waitForStoredRun(runStore, firstRun.runId);
    assertSuccessfulMicrovmRun(firstCompleted);
    const firstVmId = requiredExecutionId(firstCompleted);
    const firstConversation = await waitForConversationIdle(
      conversationStore,
      firstReceipt.conversationId,
      firstVmId,
    );
    expect(firstConversation.session).toMatchObject({
      backend: 'microvm',
      id: firstVmId,
      state: 'suspended',
      agentThreadId: 'mock-thread',
    });
    await waitForMicrovmState(microvms, firstVmId, 'SUSPENDED');

    const secondReceipt = await submitTeamsWebhook(secondMarker, providerConversationId);
    expect(secondReceipt.conversationId).toBe(firstReceipt.conversationId);
    const secondRun = await waitForConversationRun(
      conversationStore,
      artifacts,
      runStore,
      secondReceipt.conversationId,
      new Set([firstRun.runId]),
    );
    expect(secondRun.conversation).toMatchObject({
      preferredMicrovmId: firstVmId,
      agentThreadId: 'mock-thread',
    });
    const secondCompleted = await waitForStoredRun(runStore, secondRun.runId);
    assertSuccessfulMicrovmRun(secondCompleted);
    expect(requiredExecutionId(secondCompleted)).toBe(firstVmId);
    const secondOutput = await outputText(clients.s3, secondCompleted);
    expect(secondOutput).toContain(firstMarker);
    expect(secondOutput).toContain(secondMarker);
    await waitForConversationIdle(conversationStore, secondReceipt.conversationId, firstVmId);
    await waitForMicrovmState(microvms, firstVmId, 'SUSPENDED');

    await expectTerminalEvents(clients.sqs, new Set([firstRun.runId, secondRun.runId]));
    await expectTeamsDeliveries(clients.sqs, new Map([
      [firstRun.runId, firstMarker],
      [secondRun.runId, secondMarker],
    ]));
    await expectEmptyFailureQueues(clients.sqs);
  }, timeoutMs);

  persistentMicrovmTest('runs two turns through the actual Rat Things CLI on one suspended MicroVM', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const conversationId = `headless-persistent-${randomUUID()}`;
    const firstMarker = `headless-first-${randomUUID()}`;
    const secondMarker = `headless-second-${randomUUID()}`;

    const firstCli = await runRatThingsCli([
      '--thread',
      conversationId,
      '--driver',
      'mock',
      '--json',
      `Remember ${firstMarker}`,
    ]);
    const firstStatus = JSON.parse(firstCli.stdout) as ApiConversationMessageStatus;
    const firstRun = requiredConversationRun(firstStatus);
    assertSuccessfulMicrovmRun(firstRun);
    expect(firstCli.stderr).toContain('microvm=suspended');
    const microvmId = requiredExecutionId(firstRun);
    expect(firstStatus.conversation.session).toMatchObject({
      id: microvmId,
      state: 'suspended',
    });

    const secondCli = await runRatThingsCli([
      '--thread',
      conversationId,
      '--driver',
      'mock',
      '--json',
      `Return both ${firstMarker} and ${secondMarker}`,
    ]);
    const secondStatus = JSON.parse(secondCli.stdout) as ApiConversationMessageStatus;
    const secondRun = requiredConversationRun(secondStatus);
    assertSuccessfulMicrovmRun(secondRun);
    expect(secondCli.stderr).toContain('microvm=suspended');
    expect(requiredExecutionId(secondRun)).toBe(microvmId);
    expect(secondRun.conversation).toMatchObject({ preferredMicrovmId: microvmId });
    const output = await outputText(clients.s3, secondRun);
    expect(output).toContain(firstMarker);
    expect(output).toContain(secondMarker);
    expect(secondStatus.conversation.session).toMatchObject({
      id: microvmId,
      state: 'suspended',
    });
    await expectTerminalEvents(clients.sqs, new Set([firstRun.runId, secondRun.runId]));
    await expectEmptyFailureQueues(clients.sqs);
  }, timeoutMs);

  persistentMicrovmTest('falls back to a new MicroVM after the durable session expires', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const runStore = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const conversationStore = new DynamoConversationStore(
      clients.dynamodb,
      required('CONVERSATIONS_TABLE_NAME'),
    );
    const artifacts = new S3ArtifactStore(clients.s3, required('ARTIFACT_BUCKET'));
    const microvms = new LambdaMicrovmsClient(createAwsClientConfig());
    const providerConversationId = `aws-e2e-expiry-${randomUUID()}`;
    const firstMarker = `expiry-first-${randomUUID()}`;
    const secondMarker = `expiry-second-${randomUUID()}`;

    const firstReceipt = await submitTeamsWebhook(firstMarker, providerConversationId);
    const firstRun = await waitForConversationRun(
      conversationStore,
      artifacts,
      runStore,
      firstReceipt.conversationId,
    );
    const firstCompleted = await waitForStoredRun(runStore, firstRun.runId);
    assertSuccessfulMicrovmRun(firstCompleted);
    const expiredVmId = requiredExecutionId(firstCompleted);
    await waitForConversationIdle(conversationStore, firstReceipt.conversationId, expiredVmId);
    await waitForMicrovmState(microvms, expiredVmId, 'SUSPENDED');

    await clients.dynamodb.send(new UpdateCommand({
      TableName: required('CONVERSATIONS_TABLE_NAME'),
      Key: conversationMetaKey(firstReceipt.conversationId),
      UpdateExpression: 'SET #session.expiresAt = :expired',
      ConditionExpression: '#session.id = :microvmId AND #session.#state = :suspended',
      ExpressionAttributeNames: { '#session': 'session', '#state': 'state' },
      ExpressionAttributeValues: {
        ':expired': '2000-01-01T00:00:00.000Z',
        ':microvmId': expiredVmId,
        ':suspended': 'suspended',
      },
    }));

    const secondReceipt = await submitTeamsWebhook(secondMarker, providerConversationId);
    const secondRun = await waitForConversationRun(
      conversationStore,
      artifacts,
      runStore,
      secondReceipt.conversationId,
      new Set([firstRun.runId]),
    );
    expect(secondRun.conversation).not.toHaveProperty('preferredMicrovmId');
    expect(secondRun.conversation?.agentThreadId).toBe('mock-thread');
    const secondCompleted = await waitForStoredRun(runStore, secondRun.runId);
    assertSuccessfulMicrovmRun(secondCompleted);
    const replacementVmId = requiredExecutionId(secondCompleted);
    expect(replacementVmId).not.toBe(expiredVmId);
    const replacementOutput = await outputText(clients.s3, secondCompleted);
    expect(replacementOutput).toContain(firstMarker);
    expect(replacementOutput).toContain(secondMarker);
    await waitForConversationIdle(conversationStore, secondReceipt.conversationId, replacementVmId);
    await waitForMicrovmState(microvms, replacementVmId, 'SUSPENDED');

    await expectTerminalEvents(clients.sqs, new Set([firstRun.runId, secondRun.runId]));
    await expectTeamsDeliveries(clients.sqs, new Map([
      [firstRun.runId, firstMarker],
      [secondRun.runId, secondMarker],
    ]));
    await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: expiredVmId }));
    await expectEmptyFailureQueues(clients.sqs);
  }, timeoutMs);

  persistentMicrovmTest('repairs a coordinator crash after binding a run but before its SQS wake-up', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const runStore = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const conversationStore = new DynamoConversationStore(
      clients.dynamodb,
      required('CONVERSATIONS_TABLE_NAME'),
    );
    const artifacts = new S3ArtifactStore(clients.s3, required('ARTIFACT_BUCKET'));
    const conversations = new ConversationService({ store: conversationStore, artifacts });
    const runQueue = new SqsRunQueue(clients.sqs, required('RUN_QUEUE_URL'));
    const liveRuns = new RunService({
      store: runStore,
      artifacts,
      queue: runQueue,
      executions: { stop: async () => { throw new Error('not used by recovery test'); } },
      allowedRepositoryHosts: ['github.com', 'gitlab.com'],
      allowedSandboxModes: ['read-only', 'workspace-write'],
    });
    const conversationQueue = new SqsConversationQueue(
      clients.sqs,
      required('CONVERSATION_QUEUE_URL'),
    );
    const fixture = directConversationFixture(`aws-e2e-recovery-${randomUUID()}`);
    const marker = `recovery-${randomUUID()}`;
    await conversations.appendMessage({
      ...fixture,
      messageId: `message-${randomUUID()}`,
      delivery: 'defer',
      content: { text: `Return AWS live marker ${marker}` },
      executionPolicy: { driver: 'mock', sandbox: 'read-only' },
    });
    const interruptedCoordinator = new ConversationCoordinator({
      conversations,
      artifacts,
      runs: {
        submit: liveRuns.submit.bind(liveRuns),
        wake: async () => { throw new Error('simulated crash before run queue wake-up'); },
      },
      sliceTimeoutSeconds: 120,
    });

    await expect(interruptedCoordinator.handle({
      version: '1',
      conversationId: fixture.conversationId,
      traceId: `crash:${randomUUID()}`,
    })).rejects.toThrow('simulated crash before run queue wake-up');
    const stranded = await waitForConversationRun(
      conversationStore,
      artifacts,
      runStore,
      fixture.conversationId,
    );
    expect(stranded.status).toBe('queued');

    await conversationQueue.enqueue({
      version: '1',
      conversationId: fixture.conversationId,
      traceId: `recovery:${randomUUID()}`,
    });
    const recovered = await waitForStoredRun(runStore, stranded.runId);
    assertSuccessfulMicrovmRun(recovered);
    expect(await outputText(clients.s3, recovered)).toContain(marker);
    const recoveredVmId = requiredExecutionId(recovered);
    await waitForConversationIdle(conversationStore, fixture.conversationId, recoveredVmId);
    const scheduledEvents = (await conversationStore.listEvents(fixture.conversationId, 100))
      .filter((event) => event.type === 'run_scheduled');
    expect(scheduledEvents).toHaveLength(1);
    await expectTerminalEvents(clients.sqs, new Set([recovered.runId]));
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
  realCodexTest('restores a headless API Codex thread and workspace in a replacement MicroVM', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const runStore = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const conversationStore = new DynamoConversationStore(
      clients.dynamodb,
      required('CONVERSATIONS_TABLE_NAME'),
    );
    const microvms = new LambdaMicrovmsClient(createAwsClientConfig());
    const conversationKey = `real-codex-${randomUUID()}`;
    const marker = `retained-bytes-${randomUUID()}`;
    const filename = `retained-${randomUUID().slice(0, 12)}.txt`;
    const policy: ConversationExecutionPolicy = {
      driver: 'codex',
      model: process.env.AWS_E2E_CODEX_MODEL_ID ?? 'openai.gpt-5.6-terra',
      sandbox: 'workspace-write',
      reasoningEffort: 'low',
    };

    const firstReceipt = await submitApiConversation(
      conversationKey,
      [
        `Use the shell tool to create ${filename} in the current workspace.`,
        `Its only line must be exactly: ${marker}`,
        `Then run pwd and cat ${filename}. End your response with FIRST-WRITE ${marker}.`,
      ].join(' '),
      policy,
    );
    const firstStatus = await waitForApiConversationMessage(
      conversationKey,
      firstReceipt.messageId,
    );
    const firstRun = requiredConversationRun(firstStatus);
    const firstCompleted = await waitForStoredRun(runStore, firstRun.runId);
    assertSuccessfulRealCodexRun(firstCompleted);
    const runtimeConversationId = firstCompleted.conversation?.conversationId;
    if (!runtimeConversationId) throw new Error('real Codex run has no conversation binding');
    const firstVmId = requiredExecutionId(firstCompleted);
    const firstThreadId = requiredAgentThreadId(firstCompleted);
    expect(await outputText(clients.s3, firstCompleted)).toContain(marker);
    expect(await resultArtifactText(clients.s3, firstCompleted, 'workspacePatch')).toContain(marker);
    const firstEvents = await resultArtifactText(clients.s3, firstCompleted, 'events');
    expect(firstEvents).toContain('commandExecution');
    expect(firstEvents).toContain(filename);
    expect(firstEvents).toContain(marker);
    const firstConversation = await waitForConversationIdle(
      conversationStore,
      runtimeConversationId,
      firstVmId,
    );
    expect(firstConversation.session?.agentThreadId).toBe(firstThreadId);
    await waitForMicrovmState(microvms, firstVmId, 'SUSPENDED');
    await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: firstVmId }));
    await waitForMicrovmTerminated(microvms, firstVmId);
    await waitForStateObject(clients.s3, filename);

    const secondReceipt = await submitApiConversation(
      conversationKey,
      [
        `Use the shell tool to run pwd and cat the existing ${filename}.`,
        'Do not create, recreate, or modify the file.',
        'End your response with SECOND-READ followed by the exact file content.',
      ].join(' '),
      policy,
    );
    const secondStatus = await waitForApiConversationMessage(
      conversationKey,
      secondReceipt.messageId,
    );
    const secondRun = requiredConversationRun(secondStatus);
    expect(secondRun.conversation).toMatchObject({
      preferredMicrovmId: firstVmId,
      agentThreadId: firstThreadId,
    });
    const secondCompleted = await waitForStoredRun(runStore, secondRun.runId);
    assertSuccessfulRealCodexRun(secondCompleted);
    expect(requiredExecutionId(secondCompleted)).not.toBe(firstVmId);
    expect(requiredAgentThreadId(secondCompleted)).toBe(firstThreadId);
    expect(await outputText(clients.s3, secondCompleted)).toContain(marker);
    expect(await resultArtifactText(clients.s3, secondCompleted, 'workspacePatch')).toContain(marker);
    const secondEvents = await resultArtifactText(clients.s3, secondCompleted, 'events');
    expect(secondEvents).toContain('commandExecution');
    expect(secondEvents).toContain(filename);
    expect(secondEvents).toContain(marker);
    const replacementVmId = requiredExecutionId(secondCompleted);
    await waitForConversationIdle(conversationStore, runtimeConversationId, replacementVmId);
    await waitForMicrovmState(microvms, replacementVmId, 'SUSPENDED');

    await expectTerminalEvents(clients.sqs, new Set([firstRun.runId, secondRun.runId]));
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

interface TeamsReceipt {
  conversationId: string;
  messageId: string;
}

interface ApiConversationReceipt {
  conversationId: string;
  messageId: string;
  status: 'appended' | 'duplicate';
}

interface ApiConversationMessageStatus {
  conversationId: string;
  messageId: string;
  state: 'pending' | 'consumed' | 'dead_letter';
  conversation: ConversationRecord;
  run?: RunRecord;
}

async function runRatThingsCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [`${process.cwd()}/dist/cli.mjs`, ...args],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          RAT_THINGS_API_URL: required('AGENT_RUNTIME_API_URL'),
        },
        maxBuffer: 10 * 1_024 * 1_024,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(
            `Rat Things CLI failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

async function submitApiConversation(
  conversationId: string,
  prompt: string,
  agent: ConversationExecutionPolicy,
): Promise<ApiConversationReceipt> {
  return signedApi<ApiConversationReceipt>(
    `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    'POST',
    { version: '1', prompt, agent },
    { 'idempotency-key': randomUUID() },
  );
}

async function waitForApiConversationMessage(
  conversationId: string,
  messageId: string,
): Promise<ApiConversationMessageStatus> {
  const deadline = Date.now() + timeoutMs - 30_000;
  let latest: ApiConversationMessageStatus | undefined;
  while (Date.now() < deadline) {
    latest = await signedApi<ApiConversationMessageStatus>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      'GET',
    );
    if (latest.run && ['failed', 'cancelled'].includes(latest.run.status)) return latest;
    if (
      latest.run?.status === 'succeeded' &&
      latest.state === 'consumed' &&
      latest.conversation.status === 'idle' &&
      latest.conversation.pendingCount === 0 &&
      latest.conversation.session?.state === 'suspended'
    ) return latest;
    await delay(2_000);
  }
  throw new Error(
    `API conversation message did not complete; last state ${JSON.stringify(latest)}`,
  );
}

function requiredConversationRun(status: ApiConversationMessageStatus): RunRecord {
  if (!status.run) throw new Error(`conversation message ${status.messageId} has no run`);
  return status.run;
}

async function submitTeamsWebhook(
  marker: string,
  providerConversationId: string,
): Promise<TeamsReceipt> {
  const activityId = randomUUID();
  const body = JSON.stringify({
    type: 'message',
    id: activityId,
    text: `<at>Rat Things</at> Return AWS live marker ${marker}`,
    from: { id: 'aws-e2e-user', name: 'AWS E2E' },
    conversation: { id: providerConversationId },
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
  expect(JSON.parse(firstText)).toMatchObject({
    type: 'message',
    text: expect.stringContaining('response received'),
  });
  return {
    conversationId: `teams:aws-e2e-tenant:aws-e2e-user:${providerConversationId}`,
    messageId: activityId,
  };
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

async function waitForConversationRun(
  conversations: DynamoConversationStore,
  artifacts: S3ArtifactStore,
  runs: DynamoRunStore,
  conversationId: string,
  excludedRunIds: Set<string> = new Set(),
): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs - 30_000;
  while (Date.now() < deadline) {
    const events = await conversations.listEvents(conversationId, 100);
    for (const event of events.filter(({ type }) => type === 'run_scheduled').reverse()) {
      const payload = await artifacts.getJson<ConversationEventPayload>(event.payload);
      const data = payload.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const runId = (data as Record<string, unknown>).runId;
      if (typeof runId !== 'string' || excludedRunIds.has(runId)) continue;
      const run = await runs.get(runId);
      if (run) return run;
    }
    await delay(2_000);
  }
  throw new Error(`conversation ${conversationId} did not schedule a new run`);
}

async function waitForConversationIdle(
  store: DynamoConversationStore,
  conversationId: string,
  expectedMicrovmId: string,
): Promise<ConversationRecord> {
  const deadline = Date.now() + 90_000;
  let latest: ConversationRecord | undefined;
  while (Date.now() < deadline) {
    latest = await store.getConversation(conversationId);
    if (latest?.status === 'failed') {
      throw new Error(`conversation ${conversationId} failed`);
    }
    if (
      latest?.status === 'idle' &&
      latest.pendingCount === 0 &&
      latest.session?.id === expectedMicrovmId &&
      latest.session.state === 'suspended'
    ) return latest;
    await delay(2_000);
  }
  throw new Error(
    `conversation ${conversationId} did not become idle; last state ${JSON.stringify(latest)}`,
  );
}

async function waitForMicrovmState(
  client: LambdaMicrovmsClient,
  microvmId: string,
  expectedState: 'SUSPENDED',
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastState: string | undefined;
  while (Date.now() < deadline) {
    const result = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
    lastState = result.state;
    if (lastState === expectedState) return;
    if (lastState === 'TERMINATED' || lastState === 'TERMINATING') {
      throw new Error(`persistent MicroVM ${microvmId} unexpectedly entered ${lastState}`);
    }
    await delay(2_000);
  }
  throw new Error(`MicroVM ${microvmId} did not reach ${expectedState}; last state ${lastState}`);
}

async function waitForMicrovmTerminated(
  client: LambdaMicrovmsClient,
  microvmId: string,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
    if (result.state === 'TERMINATED') return;
    await delay(2_000);
  }
  throw new Error(`MicroVM ${microvmId} did not terminate`);
}

async function waitForStateObject(
  s3: ReturnType<typeof createAwsClients>['s3'],
  filename: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: required('CONVERSATION_STATE_BUCKET'),
      Prefix: 'runtime/',
    }));
    if (result.Contents?.some((object) => object.Key?.endsWith(`/${filename}`))) return;
    await delay(3_000);
  }
  throw new Error(`S3 Files did not export ${filename} to its durable bucket`);
}

function requiredExecutionId(run: RunRecord): string {
  const value = run.execution?.id;
  if (!value) throw new Error(`run ${run.runId} has no execution ID`);
  return value;
}

function requiredAgentThreadId(run: RunRecord): string {
  const value = run.result?.agentThreadId;
  if (!value) throw new Error(`run ${run.runId} has no agent thread ID`);
  return value;
}

function assertSuccessfulRealCodexRun(run: RunRecord): void {
  expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
  expect(run.execution?.backend).toBe('microvm');
  expect(run.execution?.id).toBeTruthy();
  expect(run.result?.exitCode).toBe(0);
  expect(run.result?.agentThreadId).toBeTruthy();
  expect(run.result?.agentThreadId).not.toBe('mock-thread');
  expect(run.result?.usage?.inputTokens).toBeGreaterThan(0);
  expect(run.result?.usage?.outputTokens).toBeGreaterThan(0);
}

function directConversationFixture(providerConversationId: string) {
  const ownerId = 'teams:aws-e2e-tenant:aws-e2e-user';
  const conversationId = `${ownerId}:${providerConversationId}`;
  return {
    conversationId,
    ownerId,
    source: {
      kind: 'teams' as const,
      tenantId: 'aws-e2e-tenant',
      teamId: 'aws-e2e-team',
      channelId: 'aws-e2e-channel',
      conversationId: providerConversationId,
      activityId: `activity-${randomUUID()}`,
      senderId: 'aws-e2e-user',
    },
    destination: { kind: 'none' as const },
    actor: { kind: 'human' as const, id: ownerId, provider: 'teams' as const },
    credentialSubject: { kind: 'runtime' as const, id: 'runtime:teams' },
  };
}

function conversationMetaKey(conversationId: string): { pk: string; sk: 'META' } {
  return {
    pk: `CONVERSATION#${createHash('sha256').update(conversationId).digest('hex')}`,
    sk: 'META',
  };
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

async function resultArtifactText(
  s3: ReturnType<typeof createAwsClients>['s3'],
  run: RunRecord,
  key: 'events' | 'workspacePatch',
): Promise<string> {
  const reference = run.result?.[key];
  if (!reference) throw new Error(`run ${run.runId} has no ${key} artifact`);
  const response = await s3.send(new GetObjectCommand({
    Bucket: reference.bucket,
    Key: reference.key,
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
    'CONVERSATION_FAILURE_QUEUE_URL',
    'CONVERSATION_COMPLETION_FAILURE_QUEUE_URL',
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
