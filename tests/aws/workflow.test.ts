import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { GetScheduleCommand } from '@aws-sdk/client-scheduler';
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
import { describe, expect, it, onTestFinished } from 'vitest';
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
import { DynamoThingStore } from '../../src/adapters/dynamo-thing-store.js';
import { thingScheduleName } from '../../src/adapters/eventbridge-thing-scheduler.js';
import { fetchSharedResource } from '../../src/adapters/publication-client.js';
import { ConversationCoordinator } from '../../src/conversation/coordinator.js';
import { ConversationService } from '../../src/conversation/service.js';
import { RunService } from '../../src/core/run-service.js';
import type { PublicRunRecord } from '../../src/core/run-projection.js';
import type { RunRecord, RunRequest, RunStateEvent } from '../../src/domain/contracts.js';
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
    const submitted = await signedApi<PublicRunRecord>('/v1/runs', 'POST', {
      version: '1',
      prompt: `Return AWS live marker ${controlMarker}`,
      agent: { driver: 'mock', sandbox: 'read-only' },
      execution: { backend: 'microvm', timeoutSeconds: 120 },
      destinations: [{ kind: 'none' }],
    }, { 'idempotency-key': idempotencyKey });
    expect(submitted.status).toBe('queued');

    const repeated = await signedApi<PublicRunRecord>('/v1/runs', 'POST', {
      version: '1',
      prompt: `Return AWS live marker ${controlMarker}`,
      agent: { driver: 'mock', sandbox: 'read-only' },
      execution: { backend: 'microvm', timeoutSeconds: 120 },
      destinations: [{ kind: 'none' }],
    }, { 'idempotency-key': idempotencyKey });
    expect(repeated.runId).toBe(submitted.runId);

    const controlRun = await waitForApiRun(submitted.runId);
    assertSuccessfulPublicMicrovmRun(controlRun);
    expect(controlRun.result?.preview).toBe(`mock-agent: Return AWS live marker ${controlMarker}`);
    await expectTerminalEvents(clients.sqs, new Set([submitted.runId]));

    const descriptor = await signedApi<{ url: string }>(
      `/v1/runs/${submitted.runId}/artifacts/output`,
      'GET',
    );
    const outputResponse = process.env.AWS_E2E_PUBLICATION_DOMAIN
      ? await waitForSharedResource(descriptor.url, 'assets/output')
      : await fetch(descriptor.url);
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
    assertSuccessfulPublicMicrovmRun(headlessRun);
    const storedHeadlessRun = await waitForStoredRun(store, headlessRun.runId);
    assertSuccessfulMicrovmRun(storedHeadlessRun);
    expect(headlessRun.sourceKind).toBe('api');
    expect(storedHeadlessRun.conversation).toMatchObject({
      conversationId: expect.stringMatching(/^api:[a-f0-9]{32}:headless-/),
    });
    expect(headlessStatus.conversation).toMatchObject({
      status: 'idle',
      pendingCount: 0,
      session: {
        backend: 'microvm',
        state: 'suspended',
      },
    });
    expect(headlessStatus.conversation.session).not.toHaveProperty('id');
    expect(await outputText(clients.s3, storedHeadlessRun)).toContain(headlessMarker);
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

  it('runs a revisioned multi-account Thing through the live headless API', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const fixture = randomUUID().slice(0, 8);
    const personalAlias = `fixture-alpha-${fixture}`;
    const businessAlias = `fixture-beta-${fixture}`;
    const connectionSetName = `shop-accounts-${fixture}`;
    const personalToken = required('INTEGRATION_FIXTURE_ALPHA_KEY');
    const businessToken = required('INTEGRATION_FIXTURE_BETA_KEY');
    const credentialDirectory = await mkdtemp(join(tmpdir(), 'rat-things-aws-connect-'));
    onTestFinished(() => rm(credentialDirectory, { recursive: true, force: true }));
    const personalCredential = join(credentialDirectory, 'alpha.json');
    const businessCredential = join(credentialDirectory, 'beta.json');
    const invalidCredential = join(credentialDirectory, 'invalid.json');
    await Promise.all([
      writeFile(personalCredential, JSON.stringify({ api_key: personalToken }), { mode: 0o600 }),
      writeFile(businessCredential, JSON.stringify({ api_key: businessToken }), { mode: 0o600 }),
      writeFile(invalidCredential, JSON.stringify({ api_key: `invalid-${fixture}` }), { mode: 0o600 }),
    ]);

    const discoveryResponse = await fetch(new URL(
      '/.well-known/rat-things',
      `${required('AGENT_RUNTIME_API_URL')}/`,
    ));
    expect(discoveryResponse.status).toBe(200);
    expect(await discoveryResponse.json()).toMatchObject({
      service: 'rat-things',
      deployment: { operation: 'independent', oauthApplications: 'bring-your-own' },
      capabilities: {
        things: { immutableRevisions: true, explain: true },
        integrations: {
          multipleAccounts: true,
          credentialOnboarding: 'manifest-driven',
          credentialVerification: 'before-persistence',
          providerIdentity: 'derived',
        },
      },
    });

    const createConnection = async (
      alias: string,
      credentialFile: string,
      access: 'read-only' | 'read-write',
    ) => JSON.parse((await runRatThingsCli([
      'connect',
      'fixture-crm',
      '--credential-file',
      credentialFile,
      '--access',
      access,
      '--alias',
      alias,
    ])).stdout) as {
      connection: {
        connectionId: string;
        alias: string;
        label: string;
        externalTenantId: string;
        authorization: { access: string; scopeModel: string; scopes: string[] };
      };
      grant: { preset: string };
    };
    await expect(runRatThingsCli([
      'connect',
      'fixture-crm',
      '--credential-file',
      invalidCredential,
    ])).rejects.toThrow('runtime API returned HTTP 400');
    const personal = await createConnection(
      personalAlias,
      personalCredential,
      'read-only',
    );
    const business = await createConnection(
      businessAlias,
      businessCredential,
      'read-write',
    );
    expect(personal.connection).toMatchObject({
      label: 'Alpha Support',
      externalTenantId: 'fixture-alpha',
      authorization: {
        access: 'read',
        scopeModel: 'granular',
        scopes: ['records:read'],
      },
    });
    expect(business.connection).toMatchObject({
      label: 'Beta Support',
      externalTenantId: 'fixture-beta',
      authorization: {
        access: 'full',
        scopeModel: 'granular',
        scopes: ['records:read', 'records:write'],
      },
    });
    expect(JSON.stringify([personal, business])).not.toContain(personalToken);
    expect(JSON.stringify([personal, business])).not.toContain(businessToken);

    const connectionSet = await signedApi<{
      connectionIds: string[];
      defaults: Record<string, string>;
    }>('/v1/integrations/connection-sets', 'POST', {
      version: '1',
      name: connectionSetName,
      connections: [personalAlias, businessAlias],
      defaults: { crm: businessAlias },
    });
    expect(connectionSet).toMatchObject({
      connectionIds: [personal.connection.connectionId, business.connection.connectionId],
      defaults: { crm: business.connection.connectionId },
    });

    const firstGoal = `Review both live accounts ${fixture}.`;
    const created = await signedApi<{
      thingId: string;
      draft: { revision: number };
      status: string;
    }>('/v1/things', 'POST', {
      ...liveThingSpec(
        'Live multi-account Thing',
        firstGoal,
        connectionSetName,
        personalAlias,
        businessAlias,
      ),
    });
    expect(created).toMatchObject({ draft: { revision: 1 }, status: 'draft' });
    expect(JSON.stringify(created)).not.toContain(firstGoal);

    const secondGoal = `Return live Thing marker ${randomUUID()}`;
    const revised = await signedApi<{ draft: { revision: number }; status: string }>(
      `/v1/things/${created.thingId}/versions`,
      'POST',
      {
        version: '1',
        expectedDraftRevision: 1,
        spec: liveThingSpec(
          'Live multi-account Thing',
          secondGoal,
          connectionSetName,
          personalAlias,
          businessAlias,
        ),
      },
    );
    expect(revised).toMatchObject({ draft: { revision: 2 }, status: 'draft' });
    const versions = await signedApi<{ versions: Array<{ revision: number }> }>(
      `/v1/things/${created.thingId}/versions`,
      'GET',
    );
    expect(versions.versions.map(({ revision }) => revision)).toEqual([1, 2]);
    const original = await signedApi<{ spec: { goal: string } }>(
      `/v1/things/${created.thingId}/versions/1`,
      'GET',
    );
    expect(original.spec.goal).toBe(firstGoal);

    const explanation = await signedApi<{
      runnable: boolean;
      resolvedConnections: Array<{
        alias: string;
        grant?: { resourceConstraints?: Record<string, string[]> };
        operations: Array<{ id: string; allowed: boolean }>;
      }>;
      diagnostics: Array<{ id: string; status: string }>;
    }>(`/v1/things/${created.thingId}/explain`, 'GET');
    expect(explanation.runnable).toBe(true);
    expect(explanation.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'profile', status: 'pass' }),
      expect.objectContaining({ id: 'connection-set', status: 'pass' }),
    ]));
    const personalResolution = explanation.resolvedConnections.find(
      ({ alias }) => alias === personalAlias,
    );
    const businessResolution = explanation.resolvedConnections.find(
      ({ alias }) => alias === businessAlias,
    );
    expect(personalResolution?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'fixture-crm.records.search', allowed: true }),
      expect.objectContaining({ id: 'fixture-crm.records.create', allowed: false }),
    ]));
    expect(businessResolution).toMatchObject({
      operations: expect.arrayContaining([
        expect.objectContaining({ id: 'fixture-crm.records.search', allowed: true }),
        expect.objectContaining({ id: 'fixture-crm.records.create', allowed: false }),
      ]),
    });
    expect(JSON.stringify(explanation)).not.toContain(personalToken);
    expect(JSON.stringify(explanation)).not.toContain(businessToken);

    const thingStore = new DynamoThingStore(
      clients.dynamodb,
      required('THINGS_TABLE_NAME'),
    );
    const storedThing = await thingStore.get(created.thingId);
    expect(storedThing).toMatchObject({
      draft: { revision: 2, spec: { bucket: required('DEFINITION_BUCKET') } },
      status: 'draft',
    });
    if (!storedThing) throw new Error('live Thing metadata was not persisted');
    expect(JSON.stringify(storedThing)).not.toContain(secondGoal);
    const definition = await clients.s3.send(new GetObjectCommand({
      Bucket: storedThing.draft.spec.bucket,
      Key: storedThing.draft.spec.key,
    }));
    expect(definition.ServerSideEncryption).toBe('aws:kms');
    expect(definition.SSEKMSKeyId).toBeTruthy();
    expect(definition.Body ? await definition.Body.transformToString('utf8') : '').toContain(
      secondGoal,
    );

    const draftTest = await signedApi<PublicRunRecord>(
      `/v1/things/${created.thingId}/test`,
      'POST',
      {},
      { 'idempotency-key': `thing-live-test-${randomUUID()}` },
    );
    const completedDraftTest = await waitForApiRun(draftTest.runId);
    assertSuccessfulPublicMicrovmRun(completedDraftTest);
    expect(completedDraftTest.thing).toEqual({
      version: '1',
      thingId: created.thingId,
      revision: 2,
      specHash: storedThing.draft.specHash,
      invocation: 'test',
    });

    const published = await signedApi<{
      status: string;
      draft: { revision: number };
      active: { revision: number };
      hasUnpublishedChanges: boolean;
    }>(`/v1/things/${created.thingId}/publish`, 'POST', {
      version: '1',
      expectedDraftRevision: 2,
      expectedSpecHash: storedThing.draft.specHash,
      testRunId: completedDraftTest.runId,
    });
    expect(published).toMatchObject({
      status: 'active',
      draft: { revision: 2 },
      active: { revision: 2 },
      hasUnpublishedChanges: false,
    });

    const idempotencyKey = `thing-live-${randomUUID()}`;
    const runThing = () => signedApi<PublicRunRecord>(
      `/v1/things/${created.thingId}/run`,
      'POST',
      {},
      { 'idempotency-key': idempotencyKey },
    );
    const queued = await runThing();
    const duplicate = await runThing();
    expect(duplicate.runId).toBe(queued.runId);
    const publicCompleted = await waitForApiRun(queued.runId);
    assertSuccessfulPublicMicrovmRun(publicCompleted);
    const completed = await waitForStoredRun(
      new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME')),
      queued.runId,
    );
    assertSuccessfulMicrovmRun(completed);
    expect(completed).toMatchObject({
      capabilityOwnerId: completed.ownerId,
      provenance: { actor: { kind: 'system', id: `thing:${created.thingId}` } },
    });
    expect(await outputText(clients.s3, completed)).toContain(secondGoal);
    const runInput = await new S3ArtifactStore(
      clients.s3,
      required('ARTIFACT_BUCKET'),
    ).getJson<RunRequest>(completed.input);
    expect(runInput).toMatchObject({
      prompt: secondGoal,
      integrations: {
        connectionSet: connectionSetName,
        connections: [
          { connection: personalAlias, preset: 'full' },
          { connection: businessAlias, preset: 'read-only' },
        ],
      },
      metadata: {
        thingId: created.thingId,
        thingRevision: 2,
        thingInvocation: 'manual',
      },
    });
    await expectTerminalEvents(clients.sqs, new Set([completed.runId]));

    await signedApi(`/v1/things/${created.thingId}/pause`, 'POST', {});
    await signedApi(`/v1/things/${created.thingId}/resume`, 'POST', {});
    const archived = await signedApi<{ status: string }>(
      `/v1/things/${created.thingId}/archive`,
      'POST',
      {},
    );
    expect(archived.status).toBe('archived');
    const allThings = await signedApi<{ items: Array<{ thingId: string; status: string }> }>(
      '/v1/things?includeArchived=true',
      'GET',
    );
    expect(allThings.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ thingId: created.thingId, status: 'archived' }),
    ]));

    await runRatThingsCli([
      'rotate',
      businessAlias,
      '--credential-file',
      businessCredential,
    ]);
    await signedApi(`/v1/integrations/connections/${personalAlias}/revoke`, 'POST', {});
    await signedApi(`/v1/integrations/connections/${businessAlias}/revoke`, 'POST', {});
    const listedConnections = await signedApi<{
      connections: Array<{ connection: { alias: string; status: string } }>;
    }>('/v1/integrations/connections', 'GET');
    expect(listedConnections.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ connection: expect.objectContaining({ alias: personalAlias, status: 'revoked' }) }),
      expect.objectContaining({ connection: expect.objectContaining({ alias: businessAlias, status: 'revoked' }) }),
    ]));
    expect(JSON.stringify(listedConnections)).not.toContain(businessToken);
    await expectEmptyFailureQueues(clients.sqs);
  }, timeoutMs);

  it('publishes, invokes, pauses, resumes, and removes a real EventBridge Scheduler Thing', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const marker = `scheduled-thing-${randomUUID()}`;
    const created = await signedApi<{
      thingId: string;
      draft: { revision: number };
      status: string;
    }>('/v1/things', 'POST', {
      version: '1',
      name: 'Live EventBridge Scheduler Thing',
      goal: `Return AWS scheduled Thing marker ${marker}`,
      trigger: { kind: 'schedule', expression: 'rate(1 minute)' },
      agent: { driver: 'mock', sandbox: 'read-only' },
      deliver: [{ kind: 'none' }],
    });
    expect(created).toMatchObject({ draft: { revision: 1 }, status: 'draft' });

    const draft = await signedApi<{
      draft: { revision: number; specHash: string };
    }>(`/v1/things/${created.thingId}`, 'GET');
    const testRun = await signedApi<PublicRunRecord>(
      `/v1/things/${created.thingId}/test`,
      'POST',
      {},
      { 'idempotency-key': `scheduled-thing-test-${randomUUID()}` },
    );
    const completedTest = await waitForApiRun(testRun.runId);
    assertSuccessfulPublicMicrovmRun(completedTest);

    const published = await signedApi<{
      status: string;
      active: { revision: number };
      triggerState: { status: string; revision?: number };
    }>(`/v1/things/${created.thingId}/publish`, 'POST', {
      version: '1',
      expectedDraftRevision: 1,
      expectedSpecHash: draft.draft.specHash,
      testRunId: completedTest.runId,
    });
    expect(published).toMatchObject({
      status: 'active',
      active: { revision: 1 },
      triggerState: { status: 'ready', revision: 1 },
    });

    const scheduleName = thingScheduleName(created.thingId);
    const installed = await clients.scheduler.send(new GetScheduleCommand({
      GroupName: required('THING_SCHEDULE_GROUP_NAME'),
      Name: scheduleName,
    }));
    expect(installed).toMatchObject({
      ScheduleExpression: 'rate(1 minute)',
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });
    expect(JSON.parse(installed.Target?.Input ?? '{}')).toEqual({
      version: '1',
      thingId: created.thingId,
      revision: 1,
      scheduledAt: '<aws.scheduler.scheduled-time>',
    });

    const occurred = await waitForScheduledThing(created.thingId);
    const runId = occurred.lastRunId;
    if (!runId) throw new Error('scheduled Thing has no run ID');
    expect(occurred).toMatchObject({
      status: 'active',
      active: { revision: 1 },
      triggerState: { status: 'ready', revision: 1 },
    });
    // A rate schedule keeps the second at which it was created; one-minute
    // precision does not imply that every occurrence lands at second 00.
    expect(occurred.lastRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);

    const publicCompleted = await waitForApiRun(runId);
    assertSuccessfulPublicMicrovmRun(publicCompleted);
    const runStore = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const completed = await waitForStoredRun(runStore, runId);
    assertSuccessfulMicrovmRun(completed);
    expect(completed.provenance).toMatchObject({
      actor: { kind: 'system', id: `thing:${created.thingId}`, provider: 'api' },
    });
    const artifacts = new S3ArtifactStore(clients.s3, required('ARTIFACT_BUCKET'));
    const input = await artifacts.getJson<RunRequest>(completed.input);
    const scheduledAt = occurred.lastRunAt;
    if (!scheduledAt) throw new Error('scheduled Thing has no occurrence timestamp');
    expect(input).toMatchObject({
      prompt: `Return AWS scheduled Thing marker ${marker}`,
      source: {
        kind: 'api',
        requestId: `thing:${created.thingId}:1:${scheduledAt}`,
      },
      metadata: {
        thingId: created.thingId,
        thingRevision: 1,
        thingInvocation: 'schedule',
        scheduledAt,
      },
    });
    expect(await outputText(clients.s3, completed)).toContain(marker);

    const recent = await runStore.list(completed.ownerId, 100);
    const matching: string[] = [];
    for (const candidate of recent.items) {
      const candidateInput = await artifacts.getJson<RunRequest>(candidate.input);
      if (
        candidateInput.metadata?.thingId === created.thingId &&
        candidateInput.metadata.scheduledAt === scheduledAt
      ) matching.push(candidate.runId);
    }
    expect(matching).toEqual([runId]);

    const paused = await signedApi<{ status: string; lastRunId?: string }>(
      `/v1/things/${created.thingId}/pause`,
      'POST',
      {},
    );
    expect(paused).toMatchObject({ status: 'paused', lastRunId: runId });
    await expect(clients.scheduler.send(new GetScheduleCommand({
      GroupName: required('THING_SCHEDULE_GROUP_NAME'),
      Name: scheduleName,
    }))).resolves.toMatchObject({ State: 'DISABLED' });

    const resumed = await signedApi<{ status: string; triggerState: { status: string } }>(
      `/v1/things/${created.thingId}/resume`,
      'POST',
      {},
    );
    expect(resumed).toMatchObject({ status: 'active', triggerState: { status: 'ready' } });
    await expect(clients.scheduler.send(new GetScheduleCommand({
      GroupName: required('THING_SCHEDULE_GROUP_NAME'),
      Name: scheduleName,
    }))).resolves.toMatchObject({ State: 'ENABLED' });

    await signedApi(`/v1/things/${created.thingId}/archive`, 'POST', {});
    await expect(clients.scheduler.send(new GetScheduleCommand({
      GroupName: required('THING_SCHEDULE_GROUP_NAME'),
      Name: scheduleName,
    }))).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
    await expectTerminalEvents(clients.sqs, new Set([runId]));
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
    const runStore = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const conversationId = `headless-persistent-${randomUUID()}`;
    const firstMarker = `headless-first-${randomUUID()}`;
    const secondMarker = `headless-second-${randomUUID()}`;
    const attachmentDirectory = await mkdtemp(join(tmpdir(), 'rat-things-aws-cli-conversation-'));
    onTestFinished(() => rm(attachmentDirectory, { recursive: true, force: true }));
    const attachmentPath = join(attachmentDirectory, 'live-cli-evidence.txt');
    await writeFile(attachmentPath, `attachment ${firstMarker}`, { mode: 0o600 });

    const firstCli = await runRatThingsCli([
      '--thread',
      conversationId,
      '--driver',
      'mock',
      '--attach',
      attachmentPath,
      '--delivery',
      'defer',
      '--json',
      `Remember ${firstMarker}`,
    ]);
    const firstStatus = JSON.parse(firstCli.stdout) as ApiConversationMessageStatus;
    const firstPublicRun = requiredConversationRun(firstStatus);
    assertSuccessfulPublicMicrovmRun(firstPublicRun);
    const firstRun = await waitForStoredRun(runStore, firstPublicRun.runId);
    assertSuccessfulMicrovmRun(firstRun);
    expect(firstCli.stderr).toContain('microvm=suspended');
    const microvmId = requiredExecutionId(firstRun);
    expect(firstStatus.conversation.session).toMatchObject({
      backend: 'microvm',
      state: 'suspended',
    });
    expect(firstStatus.conversation.session).not.toHaveProperty('id');

    const search = JSON.parse((await runRatThingsCli([
      'conversations', 'search', firstMarker, '--json',
    ])).stdout) as { items: Array<{ conversation: { conversationId: string; threadKey?: string } }> };
    expect(search.items).toHaveLength(1);
    const publicConversationId = search.items[0]!.conversation.conversationId;
    expect(search.items[0]!.conversation.threadKey).toBe(conversationId);
    const listed = JSON.parse((await runRatThingsCli([
      'conversations', 'list', '--visibility', 'all', '--json',
    ])).stdout) as { items: Array<{ conversationId: string }> };
    expect(listed.items.some((item) => item.conversationId === publicConversationId)).toBe(true);
    await runRatThingsCli(['conversation', 'pin', publicConversationId]);
    await runRatThingsCli(['conversation', 'read', publicConversationId]);
    await runRatThingsCli([
      'conversation', 'react', publicConversationId, firstStatus.messageId, '👍',
    ]);
    const sources = JSON.parse((await runRatThingsCli([
      'conversation', 'sources', publicConversationId, '--json',
    ])).stdout) as {
      complete: boolean;
      pages: number;
      sources: Array<{ kind: string; path?: string }>;
    };
    expect(sources).toMatchObject({ complete: true, pages: expect.any(Number) });
    expect(sources.pages).toBeGreaterThanOrEqual(1);
    expect(sources.sources).toContainEqual(expect.objectContaining({ kind: 'file' }));
    expect(sources.sources.some((source) =>
      source.path === 'live-cli-evidence.txt' || source.path?.endsWith('/live-cli-evidence.txt'),
    )).toBe(true);
    await expect(runRatThingsCli([
      'conversation', 'pin', publicConversationId, '--dry-run', 'true',
    ])).rejects.toThrow(/unknown option --dry-run/);

    const secondCli = await runRatThingsCli([
      '--thread',
      conversationId,
      '--driver',
      'mock',
      '--reply-to',
      firstStatus.messageId,
      '--delivery',
      'interrupt',
      '--json',
      `Return both ${firstMarker} and ${secondMarker}`,
    ]);
    const secondStatus = JSON.parse(secondCli.stdout) as ApiConversationMessageStatus;
    const secondPublicRun = requiredConversationRun(secondStatus);
    assertSuccessfulPublicMicrovmRun(secondPublicRun);
    const secondRun = await waitForStoredRun(runStore, secondPublicRun.runId);
    assertSuccessfulMicrovmRun(secondRun);
    expect(secondCli.stderr).toContain('microvm=suspended');
    expect(requiredExecutionId(secondRun)).toBe(microvmId);
    expect(secondRun.conversation).toMatchObject({ preferredMicrovmId: microvmId });
    const output = await outputText(clients.s3, secondRun);
    expect(output).toContain(firstMarker);
    expect(output).toContain(secondMarker);
    expect(secondStatus.conversation.session).toMatchObject({
      backend: 'microvm',
      state: 'suspended',
    });
    expect(secondStatus.conversation.session).not.toHaveProperty('id');
    const detail = JSON.parse((await runRatThingsCli([
      'conversation', 'show', publicConversationId, '--json',
    ])).stdout) as {
      pinned: boolean;
      unread: boolean;
      transcript: { messages: Array<{ messageId?: string; replyToMessageId?: string; reactions?: Array<{ emoji: string; reacted: boolean }> }> };
    };
    expect(detail.pinned).toBe(true);
    expect(detail.transcript.messages).toContainEqual(expect.objectContaining({
      messageId: secondStatus.messageId,
      replyToMessageId: firstStatus.messageId,
    }));
    expect(detail.transcript.messages).toContainEqual(expect.objectContaining({
      messageId: firstStatus.messageId,
      reactions: expect.arrayContaining([
        expect.objectContaining({ emoji: '👍', reacted: true }),
      ]),
    }));
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
    const messageId = `message-${randomUUID()}`;
    const request: RunRequest = {
      version: '1',
      prompt: `Return AWS live marker ${marker}`,
      source: fixture.source,
      destinations: [fixture.destination],
      agent: { driver: 'mock', sandbox: 'read-only' },
    };
    const reserved = await liveRuns.submit(fixture.ownerId, request, {
      idempotencyKey: messageId,
      enqueue: false,
      provenance: {
        actor: fixture.actor,
        credentialSubject: fixture.credentialSubject,
      },
      conversation: {
        conversationId: fixture.conversationId,
        messageId,
        delivery: 'defer',
      },
    });
    await conversations.appendMessage({
      ...fixture,
      messageId,
      runId: reserved.runId,
      delivery: 'defer',
      content: { text: request.prompt, request },
      executionPolicy: { driver: 'mock', sandbox: 'read-only' },
    });
    const interruptedCoordinator = new ConversationCoordinator({
      conversations,
      artifacts,
      runs: {
        get: liveRuns.get.bind(liveRuns),
        prepareConversation: liveRuns.prepareConversation.bind(liveRuns),
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
  microvmTest('fences live heartbeats and repairs a dead attached MicroVM generation', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const store = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const microvms = new LambdaMicrovmsClient(createAwsClientConfig());
    const marker = `live-liveness-${randomUUID()}`;
    const submitted = await signedApi<PublicRunRecord>('/v1/runs', 'POST', {
      version: '1',
      prompt: `Hold the deterministic worker for liveness validation ${marker}`,
      agent: { driver: 'mock', sandbox: 'read-only' },
      execution: { backend: 'microvm', timeoutSeconds: 180 },
      destinations: [{ kind: 'none' }],
      metadata: { mockDelayMs: 150_000 },
    }, { 'idempotency-key': `aws-e2e-liveness-${randomUUID()}` });

    const running = await waitForStoredRunWhere(store, submitted.runId, (candidate) =>
      candidate.status === 'running' && Boolean(candidate.heartbeatAt),
    );
    const microvmId = requiredExecutionId(running);
    const generation = running.execution?.generation;
    if (!generation) throw new Error('live Run has no execution generation');
    expect(generation).toMatch(/^[a-f0-9]{64}$/);
    const firstHeartbeat = running.heartbeatAt!;
    const refreshed = await waitForStoredRunWhere(store, submitted.runId, (candidate) =>
      candidate.status === 'running' &&
      Boolean(candidate.heartbeatAt) &&
      candidate.heartbeatAt !== firstHeartbeat,
    );
    expect(refreshed.updatedAt).toBe(running.updatedAt);

    const staleHeartbeat = '2000-01-01T00:00:00.000Z';
    await forceStaleHeartbeat(clients, submitted.runId, microvmId, generation, staleHeartbeat);
    await delay(2_000);
    await invokeReconciler();
    const verifiedActive = await store.get(submitted.runId);
    expect(verifiedActive).toMatchObject({
      status: 'running',
      execution: { id: microvmId, generation },
      liveness: { outcome: 'active', consecutiveUncertain: 0 },
    });

    await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    await waitForMicrovmTerminated(microvms, microvmId);
    await waitForStoredRun(store, submitted.runId);
    await clients.dynamodb.send(new UpdateCommand({
      TableName: required('RUNS_TABLE_NAME'),
      Key: { runId: submitted.runId },
      UpdateExpression: [
        'SET #status = :running, #heartbeatAt = :stale, #updatedAt = :stale',
        'REMOVE #error, #result, #liveness',
      ].join(' '),
      ConditionExpression: '#execution.#id = :microvmId AND #execution.#generation = :generation',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#heartbeatAt': 'heartbeatAt',
        '#updatedAt': 'updatedAt',
        '#error': 'error',
        '#result': 'result',
        '#liveness': 'liveness',
        '#execution': 'execution',
        '#id': 'id',
        '#generation': 'generation',
      },
      ExpressionAttributeValues: {
        ':running': 'running',
        ':stale': staleHeartbeat,
        ':microvmId': microvmId,
        ':generation': generation,
      },
    }));
    await delay(2_000);

    let repaired: RunRecord | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await invokeReconciler();
      repaired = await store.get(submitted.runId);
      if (repaired?.status === 'failed' && repaired.error?.code === 'execution_lost') break;
      await delay(2_000);
    }
    expect(repaired).toMatchObject({
      status: 'failed',
      execution: { id: microvmId, generation },
      error: { code: 'execution_lost', retryable: true },
    });
  }, timeoutMs);

  microvmTest('runs a repository-backed request in a real Lambda MicroVM', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const runStore = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const microvmMarker = `live-microvm-${randomUUID()}`;
    const microvmRun = await signedApi<PublicRunRecord>('/v1/runs', 'POST', {
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
    const publicMicrovmRun = await waitForApiRun(microvmRun.runId);
    assertSuccessfulPublicMicrovmRun(publicMicrovmRun);
    const completedMicrovmRun = await waitForStoredRun(runStore, microvmRun.runId);
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
      reasoningEffort: 'medium',
    };
    const writeCommand = [
      `printf '%s\\n' '${marker}' > './${filename}'`,
      `test "$(cat './${filename}')" = '${marker}'`,
      'pwd',
      `cat './${filename}'`,
    ].join(' && ');

    const firstReceipt = await submitApiConversation(
      conversationKey,
      [
        'This is an end-to-end tool-use verification.',
        'The requested file is private working state, not a returned artifact or publication.',
        'Keep it at the exact workspace-root path in the command; do not redirect it into .rat-things/artifacts.',
        `Use the shell tool to execute this exact command before responding: ${writeCommand}`,
        'Do not merely describe the command or synthesize its output.',
        `After it succeeds, end your response with exactly: FIRST-WRITE ${marker}`,
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
    expect(await outputText(clients.s3, firstCompleted)).toContain(`FIRST-WRITE ${marker}`);
    expect(await requiredWorkspacePatchText(clients.s3, firstCompleted)).toContain(marker);
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

    const readCommand = `pwd && test -f './${filename}' && cat './${filename}'`;
    const secondReceipt = await submitApiConversation(
      conversationKey,
      [
        'This is the replacement-MicroVM half of an end-to-end tool-use verification.',
        `Use the shell tool to execute this exact read-only command: ${readCommand}`,
        'Do not create, recreate, or modify the file, and do not synthesize the command output.',
        `After it succeeds, end your response with exactly: SECOND-READ ${marker}`,
      ].join(' '),
      policy,
    );
    const secondStatus = await waitForApiConversationMessage(
      conversationKey,
      secondReceipt.messageId,
    );
    const secondRun = requiredConversationRun(secondStatus);
    assertSuccessfulPublicMicrovmRun(secondRun);
    const secondCompleted = await waitForStoredRun(runStore, secondRun.runId);
    expect(secondCompleted.conversation).toMatchObject({
      preferredMicrovmId: firstVmId,
      agentThreadId: firstThreadId,
    });
    assertSuccessfulRealCodexRun(secondCompleted);
    expect(requiredExecutionId(secondCompleted)).not.toBe(firstVmId);
    expect(requiredAgentThreadId(secondCompleted)).toBe(firstThreadId);
    expect(await outputText(clients.s3, secondCompleted)).toContain(`SECOND-READ ${marker}`);
    expect(await requiredWorkspacePatchText(clients.s3, secondCompleted)).toContain(marker);
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

  realCodexTest('lets a real agent read one verified account and make one statically admitted write to another', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const runStore = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const fixture = randomUUID().slice(0, 8);
    const marker = `agent-integration-${randomUUID()}`;
    const alphaAlias = `agent-alpha-${fixture}`;
    const betaAlias = `agent-beta-${fixture}`;
    const credentialDirectory = await mkdtemp(join(tmpdir(), 'rat-things-agent-integration-'));
    onTestFinished(() => rm(credentialDirectory, { recursive: true, force: true }));
    const alphaCredential = join(credentialDirectory, 'alpha.json');
    const betaCredential = join(credentialDirectory, 'beta.json');
    await Promise.all([
      writeFile(alphaCredential, JSON.stringify({
        api_key: required('INTEGRATION_FIXTURE_ALPHA_KEY'),
      }), { mode: 0o600 }),
      writeFile(betaCredential, JSON.stringify({
        api_key: required('INTEGRATION_FIXTURE_BETA_KEY'),
      }), { mode: 0o600 }),
    ]);
    await runRatThingsCli([
      'connect', 'fixture-crm', '--credential-file', alphaCredential,
      '--access', 'read-only', '--alias', alphaAlias,
    ]);
    await runRatThingsCli([
      'connect', 'fixture-crm', '--credential-file', betaCredential,
      '--access', 'read-write', '--alias', betaAlias,
    ]);

    const submitted = await signedApi<PublicRunRecord>('/v1/runs', 'POST', {
      version: '1',
      prompt: [
        'This is a strict live integration test. You must use the Fixture CRM tools exactly twice.',
        `First call records_search using account ${alphaAlias} and query ${marker}.`,
        `Then call records_create using account ${betaAlias} and name ${marker}.`,
        'Do not use either operation on any other account.',
        `After both calls succeed, end your response with exactly: INTEGRATION-PROOF ${marker}`,
        'Do not use shell commands, browser tools, or web search.',
      ].join(' '),
      agent: {
        driver: 'codex',
        model: process.env.AWS_E2E_CODEX_MODEL_ID ?? 'openai.gpt-5.6-terra',
        sandbox: 'read-only',
        reasoningEffort: 'medium',
        capabilities: {
          profile: 'small-business',
          networkAccess: true,
          computerUse: 'disabled',
        },
      },
      integrations: {
        connections: [
          { connection: alphaAlias, preset: 'read-only' },
          { connection: betaAlias, preset: 'read-write' },
        ],
      },
      execution: { backend: 'microvm', timeoutSeconds: 300 },
      destinations: [{ kind: 'none' }],
    }, { 'idempotency-key': `aws-e2e-integration-${randomUUID()}` });

    const publicCompleted = await waitForApiRun(submitted.runId);
    assertSuccessfulPublicMicrovmRun(publicCompleted);
    const completed = await waitForStoredRun(runStore, submitted.runId);
    assertSuccessfulRealCodexRun(completed);
    const [output, events] = await Promise.all([
      outputText(clients.s3, completed),
      resultArtifactText(clients.s3, completed, 'events'),
    ]);
    expect(output).toContain(`INTEGRATION-PROOF ${marker}`);
    expect(events).toContain('records_search');
    expect(events).toContain('records_create');
    expect(events).toContain(marker);
    await expectFixtureAudit(clients.sqs, marker);
    const evidence = `${JSON.stringify(completed)}\n${output}\n${events}`;
    expect(evidence).not.toContain(required('INTEGRATION_FIXTURE_ALPHA_KEY'));
    expect(evidence).not.toContain(required('INTEGRATION_FIXTURE_BETA_KEY'));

    await signedApi(`/v1/integrations/connections/${alphaAlias}/revoke`, 'POST', {});
    await signedApi(`/v1/integrations/connections/${betaAlias}/revoke`, 'POST', {});
    await expectTerminalEvents(clients.sqs, new Set([submitted.runId]));
    await expectEmptyFailureQueues(clients.sqs);
  }, timeoutMs);

  const browserPublicationTest = process.env.AWS_E2E_REAL_CODEX === 'true' &&
    Boolean(process.env.AWS_E2E_PUBLICATION_DOMAIN) ? it : it.skip;
  const liveComputerTest = process.env.AWS_E2E_REAL_CODEX === 'true' ? it : it.skip;
  liveComputerTest('views, takes over, teaches, and returns an active MicroVM browser', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const marker = `live-computer-${randomUUID()}`;
    const secret = `redact-${randomUUID()}`;
    const submitted = await signedApi<PublicRunRecord>('/v1/runs', 'POST', {
      version: '1',
      prompt: [
        'Use the shell tool to run exactly: sleep 90',
        'Do not use browser tools.',
        `After the command completes, reply with exactly: COMPUTER-CONTROL ${marker}`,
      ].join(' '),
      agent: {
        driver: 'codex',
        model: process.env.AWS_E2E_CODEX_MODEL_ID ?? 'openai.gpt-5.6-terra',
        sandbox: 'danger-full-access',
        reasoningEffort: 'low',
        capabilities: {
          profile: 'small-business',
          networkAccess: true,
          computerUse: 'browser',
        },
      },
      execution: { backend: 'microvm', timeoutSeconds: 180 },
      destinations: [{ kind: 'none' }],
    }, { 'idempotency-key': `aws-e2e-computer-${randomUUID()}` });

    const initial = await waitForLiveComputer(submitted.runId);
    expect(initial).toMatchObject({
      version: '1',
      runId: submitted.runId,
      available: true,
      control: 'agent',
      viewport: { width: 1280, height: 720 },
      teach: { state: 'idle' },
    });
    expect(initial.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    const activity = await runRatThingsCli(['watch', submitted.runId]);
    expect(activity.stdout).toMatch(/Agent activity|Agent turn started|Command started|Command running/);
    expect(activity.stdout).not.toContain('"method"');

    const taken = JSON.parse((await runRatThingsCli([
      'computer', 'takeover', submitted.runId,
    ])).stdout) as Record<string, unknown>;
    expect(taken).toMatchObject({ control: 'human', takeover: { expiresAt: expect.any(String) } });
    const taughtName = `Taught browser workflow ${marker}`;
    await runRatThingsCli([
      'computer', 'teach', 'start', submitted.runId,
      '--name', taughtName,
      '--goal', 'Repeat the demonstrated public-web workflow with reviewed runtime inputs.',
    ]);
    await runRatThingsCli([
      'computer', 'navigate', submitted.runId,
      `https://example.com/?private=${secret}#fragment`,
    ]);
    await runRatThingsCli(['computer', 'type', submitted.runId, secret]);
    const saved = JSON.parse((await runRatThingsCli([
      'computer', 'teach', 'stop', submitted.runId,
    ])).stdout) as {
      recording: { discarded: boolean; demonstratedSteps: number };
      thing: { thingId: string; status: string };
    };
    expect(saved).toMatchObject({
      recording: { discarded: false, demonstratedSteps: 2 },
      thing: { status: 'draft' },
    });
    const taughtThing = await signedApi<Record<string, unknown>>(
      `/v1/things/${saved.thing.thingId}`,
      'GET',
    );
    const taughtEvidence = JSON.stringify(taughtThing);
    expect(taughtEvidence).toContain(taughtName);
    expect(taughtEvidence).toContain('{{input_1}}');
    expect(taughtEvidence).not.toContain(secret);
    expect(taughtEvidence).not.toContain('private=');

    const returned = JSON.parse((await runRatThingsCli([
      'computer', 'release', submitted.runId,
    ])).stdout) as Record<string, unknown>;
    expect(returned).toMatchObject({ control: 'agent' });
    const completed = await waitForApiRun(submitted.runId);
    assertSuccessfulPublicMicrovmRun(completed);
    expect(completed.result?.preview).toContain(`COMPUTER-CONTROL ${marker}`);
  }, timeoutMs);

  browserPublicationTest('uses the autonomous browser interaction surface and shares evidence', async () => {
    delete process.env.AWS_ENDPOINT_URL;
    const clients = createAwsClients();
    const runStore = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const marker = `browser-publication-${randomUUID()}`;
    const shareRequest = JSON.stringify({
      version: '1',
      publications: [
        {
          version: '1',
          kind: 'file',
          path: 'browser/form-filled.png',
          title: 'Browser full-page form screenshot',
        },
        {
          version: '1',
          kind: 'file',
          path: 'browser/submitted.jpg',
          title: 'Browser submitted screenshot',
        },
        {
          version: '1',
          kind: 'video',
          path: 'browser/full-interaction.webm',
          poster: 'browser/submitted.jpg',
          title: 'Browser interaction recording',
        },
      ],
    });
    const shareCommand = [
      'mkdir -p .rat-things',
      `printf '%s' '${shareRequest}' > .rat-things/share.json`,
    ].join(' && ');
    const browserFixture = process.env.AWS_E2E_BROWSER_FIXTURE_URL ??
      'https://www.selenium.dev/selenium/web/web-form.html';
    const formMarker = `rat-browser-${randomUUID()}`;
    const appendedMarker = `${formMarker}-append`;
    const submitted = await signedApi<PublicRunRecord>('/v1/runs', 'POST', {
      version: '1',
      prompt: [
        'This is a strict end-to-end autonomous browser interaction and publication verification.',
        'Use the rat_browser tools for every browser action; do not substitute curl, web search, or shell browser automation.',
        `Navigate to ${browserFixture} and explicitly call observe with includeScreenshot true.`,
        'Start a recording at browser/full-interaction.webm with 5 fps.',
        `Type ${formMarker} into Text input with clear true and submit false.`,
        'Type -append into the same Text input with clear false and submit false.',
        'Press Tab, then select value 2 from Dropdown (select).',
        'Use the current element box to click Default checkbox by x/y coordinates, not by ref, and confirm checked is true.',
        'Save a full-page PNG screenshot at browser/form-filled.png.',
        'Click Submit by element ref and confirm the target page says Received!',
        `Confirm the submitted URL contains my-text=${appendedMarker}, my-select=2, and two my-check values.`,
        'Wait 800 milliseconds, explicitly observe again with includeScreenshot true, and save a viewport JPEG at browser/submitted.jpg.',
        'Navigate back, confirm the Web form title, then type rat-things-submit-with-enter into Text input with clear true and submit true.',
        'Confirm that Enter submits the form and the target page says Received! again.',
        'Navigate to https://www.selenium.dev/selenium/web/longContentPage.html, scroll down 600 pixels, confirm scrollY is greater than zero, and wait 800 milliseconds.',
        'Navigate back and confirm the submitted target page is restored.',
        'Stop and finalize the recording.',
        `Then use the shell tool to execute this exact command: ${shareCommand}`,
        'Do not invent share URLs; the trusted runner will append them.',
        `After every step succeeds, end your own response with exactly: BROWSER-SHARE ${marker}`,
      ].join(' '),
      agent: {
        driver: 'codex',
        model: process.env.AWS_E2E_CODEX_MODEL_ID ?? 'openai.gpt-5.6-terra',
        sandbox: 'danger-full-access',
        reasoningEffort: 'low',
        capabilities: {
          profile: 'small-business',
          networkAccess: true,
          computerUse: 'browser',
        },
      },
      execution: { backend: 'microvm', timeoutSeconds: 720 },
      destinations: [{ kind: 'none' }],
    }, { 'idempotency-key': `aws-e2e-browser-${randomUUID()}` });
    const publicCompleted = await waitForApiRun(submitted.runId);
    assertSuccessfulPublicMicrovmRun(publicCompleted);
    const completed = await waitForStoredRun(runStore, submitted.runId);
    assertSuccessfulRealCodexRun(completed);
    const output = await outputText(clients.s3, completed);
    expect(output).toContain(`BROWSER-SHARE ${marker}`);
    const events = await resultArtifactText(clients.s3, completed, 'events');
    for (const tool of [
      'navigate',
      'observe',
      'record_start',
      'type',
      'press',
      'select',
      'click',
      'scroll',
      'wait',
      'screenshot',
      'back',
      'record_stop',
    ]) {
      expect(events).toContain(tool);
    }
    expect(events).toContain('rat_browser');
    expect(events).toContain(encodeURIComponent(appendedMarker));
    expect(events).toContain('my-select=2');
    expect(events.match(/my-check=on/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(events).toContain('rat-things-submit-with-enter');
    const fullPageArtifact = completed.result?.artifacts?.find(
      (artifact) => artifact.path === 'browser/form-filled.png',
    );
    const screenshotArtifact = completed.result?.artifacts?.find(
      (artifact) => artifact.path === 'browser/submitted.jpg',
    );
    const videoArtifact = completed.result?.artifacts?.find(
      (artifact) => artifact.path === 'browser/full-interaction.webm',
    );
    expect(fullPageArtifact).toMatchObject({ mediaType: 'image/png' });
    expect(screenshotArtifact).toMatchObject({ mediaType: 'image/jpeg' });
    expect(videoArtifact).toMatchObject({ mediaType: 'video/webm' });
    if (!fullPageArtifact || !screenshotArtifact || !videoArtifact) {
      throw new Error('browser run did not return all capture artifacts');
    }
    const [fullPageBytes, screenshotBytes, videoBytes] = await Promise.all([
      artifactBytes(clients.s3, fullPageArtifact.file),
      artifactBytes(clients.s3, screenshotArtifact.file),
      artifactBytes(clients.s3, videoArtifact.file),
    ]);
    expect(fullPageBytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(screenshotBytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(videoBytes.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    expect(videoBytes.includes(Buffer.from('V_VP8'))).toBe(true);
    expect(createHash('sha256').update(fullPageBytes).digest('hex'))
      .toBe(fullPageArtifact.file.sha256);
    expect(createHash('sha256').update(screenshotBytes).digest('hex'))
      .toBe(screenshotArtifact.file.sha256);
    expect(createHash('sha256').update(videoBytes).digest('hex'))
      .toBe(videoArtifact.file.sha256);

    const links = new Map(
      [...output.matchAll(/- \[([^\]]+)\]\((https:\/\/[^)]+)\)/g)]
        .flatMap((match) => match[1] && match[2] ? [[match[1], match[2]] as const] : []),
    );
    expect([...links.keys()]).toEqual([
      'Browser full-page form screenshot',
      'Browser submitted screenshot',
      'Browser interaction recording',
    ]);
    const fullPageUrl = links.get('Browser full-page form screenshot');
    const screenshotUrl = links.get('Browser submitted screenshot');
    const videoUrl = links.get('Browser interaction recording');
    if (!fullPageUrl || !screenshotUrl || !videoUrl) {
      throw new Error('browser publication links are missing');
    }
    expect(new Set([fullPageUrl, screenshotUrl, videoUrl].map((url) => new URL(url).hostname)).size)
      .toBe(3);

    const [
      fullPageViewer,
      screenshotViewer,
      videoViewer,
      sharedFullPage,
      sharedScreenshot,
      sharedVideo,
    ] = await Promise.all([
      waitForSharedResource(fullPageUrl),
      waitForSharedResource(screenshotUrl),
      waitForSharedResource(videoUrl),
      waitForSharedResource(fullPageUrl, 'assets/form-filled.png'),
      waitForSharedResource(screenshotUrl, 'assets/submitted.jpg'),
      waitForSharedResource(videoUrl, 'assets/full-interaction.webm'),
    ]);
    expect(fullPageViewer.headers.get('content-type')).toContain('text/html');
    expect(await fullPageViewer.text()).toContain('<img');
    expect(screenshotViewer.headers.get('content-type')).toContain('text/html');
    expect(await screenshotViewer.text()).toContain('<img');
    expect(videoViewer.headers.get('content-type')).toContain('text/html');
    expect(await videoViewer.text()).toContain('<video');
    expect(sharedFullPage.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await sharedFullPage.arrayBuffer())).toEqual(fullPageBytes);
    expect(sharedScreenshot.headers.get('content-type')).toContain('image/jpeg');
    expect(Buffer.from(await sharedScreenshot.arrayBuffer())).toEqual(screenshotBytes);
    expect(sharedVideo.headers.get('content-type')).toContain('video/webm');
    expect(Buffer.from(await sharedVideo.arrayBuffer())).toEqual(videoBytes);

    const evidencePath = process.env.AWS_E2E_BROWSER_EVIDENCE_FILE;
    if (evidencePath) {
      await writeFile(evidencePath, `${JSON.stringify({
        runId: completed.runId,
        marker,
        browserFixture,
        formMarker: appendedMarker,
        capabilityModel: 'fixed-before-launch',
        fullPageScreenshot: {
          url: fullPageUrl,
          bytes: fullPageBytes.byteLength,
          sha256: fullPageArtifact.file.sha256,
        },
        screenshot: {
          url: screenshotUrl,
          bytes: screenshotBytes.byteLength,
          sha256: screenshotArtifact.file.sha256,
        },
        video: {
          url: videoUrl,
          bytes: videoBytes.byteLength,
          sha256: videoArtifact.file.sha256,
        },
        verifiedAt: new Date().toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
      const evidenceDirectory = dirname(evidencePath);
      await Promise.all([
        writeFile(join(evidenceDirectory, 'browser-form-filled-evidence.png'), fullPageBytes, { mode: 0o600 }),
        writeFile(join(evidenceDirectory, 'browser-submitted-evidence.jpg'), screenshotBytes, { mode: 0o600 }),
        writeFile(join(evidenceDirectory, 'browser-full-interaction-evidence.webm'), videoBytes, { mode: 0o600 }),
      ]);
    }
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

interface TeamsReceipt {
  conversationId: string;
  messageId: string;
}

interface ApiConversationReceipt {
  conversationId: string;
  messageId: string;
  runId: string;
  status: 'appended' | 'duplicate';
}

interface ApiConversationMessageStatus {
  conversationId: string;
  messageId: string;
  state: 'pending' | 'consumed' | 'dead_letter';
  conversation: ConversationRecord;
  run?: PublicRunRecord;
}

interface ScheduledThingState {
  thingId: string;
  status: string;
  active?: { revision: number };
  triggerState: { status: string; revision?: number };
  lastRunAt?: string;
  lastRunId?: string;
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
  const messageId = randomUUID();
  const run = await signedApi<PublicRunRecord>(
    '/v1/runs',
    'POST',
    { version: '1', prompt, agent, thread: { key: conversationId } },
    { 'idempotency-key': messageId },
  );
  return { conversationId, messageId, runId: run.runId, status: 'appended' };
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

function requiredConversationRun(status: ApiConversationMessageStatus): PublicRunRecord {
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
  expect(first.status, firstText).toBe(200);
  expect(repeated.status, repeatedText).toBe(200);
  expect(repeatedText).toBe(firstText);
  expect(JSON.parse(firstText)).toMatchObject({
    type: 'message',
    text: expect.stringMatching(
      /^Rat Things request received\. I'll reply when run [A-Za-z0-9-]+ finishes\.$/,
    ),
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

async function waitForApiRun(runId: string): Promise<PublicRunRecord> {
  return waitForRun(async () => signedApi<PublicRunRecord>(`/v1/runs/${runId}`, 'GET'));
}

async function waitForLiveComputer(runId: string): Promise<{
  version: string;
  runId: string;
  available: boolean;
  control: string;
  viewport: { width: number; height: number };
  imageDataUrl: string;
  teach: { state: string };
}> {
  const deadline = Date.now() + timeoutMs - 30_000;
  let diagnostic = 'computer endpoint has not been called';
  while (Date.now() < deadline) {
    try {
      return await signedApi(`/v1/runs/${runId}/computer`, 'GET');
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    const run = await signedApi<PublicRunRecord>(`/v1/runs/${runId}`, 'GET');
    if (['failed', 'cancelled', 'succeeded'].includes(run.status)) {
      throw new Error(`run ${runId} became ${run.status} before its browser was available: ${diagnostic}`);
    }
    await delay(1_000);
  }
  throw new Error(`run ${runId} browser did not become available: ${diagnostic}`);
}

async function waitForScheduledThing(
  thingId: string,
): Promise<ScheduledThingState> {
  const deadline = Date.now() + timeoutMs - 30_000;
  let latest: ScheduledThingState | undefined;
  while (Date.now() < deadline) {
    latest = await signedApi<ScheduledThingState>(`/v1/things/${thingId}`, 'GET');
    if (latest.lastRunAt && latest.lastRunId) return latest;
    if (latest.status !== 'active') {
      throw new Error(`scheduled Thing ${thingId} unexpectedly entered ${latest.status}`);
    }
    await delay(2_000);
  }
  throw new Error(
    `EventBridge Scheduler did not submit Thing ${thingId}; last state ${JSON.stringify(latest)}`,
  );
}

async function waitForStoredRun(store: DynamoRunStore, runId: string): Promise<RunRecord> {
  return waitForRun(async () => {
    const run = await store.get(runId);
    if (!run) throw new Error(`run ${runId} was not found`);
    return run;
  });
}

async function waitForStoredRunWhere(
  store: DynamoRunStore,
  runId: string,
  predicate: (run: RunRecord) => boolean,
): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs - 30_000;
  let latest: RunRecord | undefined;
  while (Date.now() < deadline) {
    latest = await store.get(runId);
    if (latest && predicate(latest)) return latest;
    if (latest && ['failed', 'cancelled', 'succeeded'].includes(latest.status)) {
      throw new Error(`run ${runId} became ${latest.status} before the expected state`);
    }
    await delay(1_000);
  }
  throw new Error(`run ${runId} did not reach the expected state: ${JSON.stringify(latest)}`);
}

async function forceStaleHeartbeat(
  clients: ReturnType<typeof createAwsClients>,
  runId: string,
  microvmId: string,
  generation: string,
  heartbeatAt: string,
): Promise<void> {
  await clients.dynamodb.send(new UpdateCommand({
    TableName: required('RUNS_TABLE_NAME'),
    Key: { runId },
    UpdateExpression: 'SET #heartbeatAt = :heartbeatAt REMOVE #liveness',
    ConditionExpression: [
      '#status = :running',
      '#execution.#id = :microvmId',
      '#execution.#generation = :generation',
    ].join(' AND '),
    ExpressionAttributeNames: {
      '#status': 'status',
      '#heartbeatAt': 'heartbeatAt',
      '#liveness': 'liveness',
      '#execution': 'execution',
      '#id': 'id',
      '#generation': 'generation',
    },
    ExpressionAttributeValues: {
      ':running': 'running',
      ':heartbeatAt': heartbeatAt,
      ':microvmId': microvmId,
      ':generation': generation,
    },
  }));
}

async function invokeReconciler(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'rat-things-reconciler-'));
  const output = join(directory, 'response.json');
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile(
        'aws',
        [
          'lambda',
          'invoke',
          '--region',
          required('AWS_REGION'),
          '--function-name',
          required('RECONCILER_FUNCTION_NAME'),
          '--cli-binary-format',
          'raw-in-base64-out',
          '--payload',
          '{}',
          output,
        ],
        { encoding: 'utf8', env: process.env },
        (error, stdout, stderr) => {
          if (error) {
            rejectPromise(new Error(
              `reconciler invocation failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ));
            return;
          }
          resolvePromise();
        },
      );
    });
    const response = await readFile(output, 'utf8');
    if (response.trim() && response.trim() !== 'null') {
      throw new Error(`reconciler returned an unexpected payload: ${response.slice(0, 1_000)}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

async function waitForRun<T extends { status: string }>(load: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs - 30_000;
  let latest: T | undefined;
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

function assertSuccessfulPublicMicrovmRun(run: PublicRunRecord): void {
  expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
  expect(run.execution).toMatchObject({ backend: 'microvm' });
  expect(run.execution).not.toHaveProperty('id');
  expect(run.execution).not.toHaveProperty('generation');
  expect(run.result).toMatchObject({ exitCode: 0 });
  expect(run.result).not.toHaveProperty('agentThreadId');
  expect(run.result).not.toHaveProperty('output');
  expect(run.result).not.toHaveProperty('events');
  expect(run).not.toHaveProperty('ownerId');
  expect(run).not.toHaveProperty('input');
  expect(run).not.toHaveProperty('conversation');
}

function assertSuccessfulRun(run: RunRecord, backend: 'microvm'): void {
  expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
  expect(run.execution?.backend).toBe(backend);
  expect(run.execution?.id).toBeTruthy();
  expect(run.result).toMatchObject({ exitCode: 0, agentThreadId: expect.any(String) });
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

async function artifactBytes(
  s3: ReturnType<typeof createAwsClients>['s3'],
  reference: { bucket: string; key: string },
): Promise<Buffer> {
  const response = await s3.send(new GetObjectCommand({
    Bucket: reference.bucket,
    Key: reference.key,
  }));
  return response.Body ? Buffer.from(await response.Body.transformToByteArray()) : Buffer.alloc(0);
}

async function waitForSharedResource(url: string, path?: string): Promise<Response> {
  const deadline = Date.now() + 120_000;
  let diagnostic = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetchSharedResource(url, 30_000, path);
      if (response.status === 200) return response;
      diagnostic = `HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`;
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    await delay(3_000);
  }
  throw new Error(`shared browser resource did not become available: ${diagnostic}`);
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

async function requiredWorkspacePatchText(
  s3: ReturnType<typeof createAwsClients>['s3'],
  run: RunRecord,
): Promise<string> {
  if (run.result?.workspacePatch) return resultArtifactText(s3, run, 'workspacePatch');
  const [output, events] = await Promise.all([
    outputText(s3, run).catch((error: unknown) => `unavailable: ${String(error)}`),
    run.result?.events
      ? resultArtifactText(s3, run, 'events')
        .catch((error: unknown) => `unavailable: ${String(error)}`)
      : Promise.resolve('unavailable: no events artifact'),
  ]);
  throw new Error([
    `run ${run.runId} has no workspacePatch artifact`,
    `output: ${output.slice(-2_000)}`,
    `events: ${events.slice(-4_000)}`,
  ].join('\n'));
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

async function expectFixtureAudit(
  sqs: ReturnType<typeof createAwsClients>['sqs'],
  marker: string,
): Promise<void> {
  const queueUrl = required('INTEGRATION_FIXTURE_AUDIT_QUEUE_URL');
  const deadline = Date.now() + 60_000;
  let matching = 0;
  while (matching === 0 && Date.now() < deadline) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 20,
    }));
    for (const message of response.Messages ?? []) {
      const value = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
      if (value.name === marker) {
        expect(value).toMatchObject({
          version: '1',
          operation: 'records.create',
          account: 'beta',
          name: marker,
        });
        matching += 1;
      }
      if (message.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }));
      }
    }
  }
  expect(matching, 'fixture provider write was not observed').toBe(1);

  const repeated = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 5,
  }));
  const duplicates = (repeated.Messages ?? []).filter((message) => {
    const value = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
    return value.name === marker;
  });
  expect(duplicates, 'fixture provider observed a duplicate write').toEqual([]);
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
    'THING_SCHEDULE_FAILURE_QUEUE_URL',
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

function liveThingSpec(
  name: string,
  goal: string,
  connectionSet: string,
  personalAccount: string,
  businessAccount: string,
) {
  return {
    version: '1',
    name,
    goal,
    trigger: { kind: 'manual' },
    agent: {
      driver: 'mock',
      sandbox: 'danger-full-access',
      capabilities: {
        profile: 'small-business',
        networkAccess: true,
        computerUse: 'disabled',
      },
    },
    connections: {
      set: connectionSet,
      accounts: [
        { account: personalAccount, access: 'full' },
        { account: businessAccount, access: 'read-only' },
      ],
    },
    deliver: [{ kind: 'none' }],
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
