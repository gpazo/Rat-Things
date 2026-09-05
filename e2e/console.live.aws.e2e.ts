import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { expect, test, type Page } from '@playwright/test';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { BatchWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createAwsClients, DynamoRunStore } from '../src/adapters/aws-runtime.js';
import { DynamoConversationStore } from '../src/adapters/dynamo-conversation-store.js';

const enabled = process.env.AWS_E2E_CONSOLE === 'true';
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
const recordingDemo = process.env.RAT_THINGS_CONSOLE_VIDEO === 'on';

let consoleProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
let consoleUrl = '';
let consoleOutput = '';
let diagnosticRunIds: string[] = [];
let diagnosticThreadKey: string | undefined;
let demoReferenceTitle = '';
let demoArchiveTitle = '';

test.describe('live AWS console journey', () => {
  test.skip(!enabled, 'set AWS_E2E_CONSOLE=true through scripts/aws-e2e-console-test.sh');

  test.beforeAll(async () => {
    test.setTimeout(timeoutMs);
    const apiUrl = required('RAT_THINGS_API_URL');
    const consolePort = await availablePort();
    consoleUrl = `http://127.0.0.1:${consolePort}`;
    const tsx = resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    consoleProcess = spawn(tsx, ['scripts/console-server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RAT_THINGS_API_URL: apiUrl,
        RAT_THINGS_CONSOLE_PORT: String(consolePort),
        AGENT_RUNTIME_UNSIGNED: undefined,
        RAT_THINGS_LOCAL_OWNER: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    consoleProcess.stdout.on('data', (chunk: Buffer) => { consoleOutput += chunk.toString(); });
    consoleProcess.stderr.on('data', (chunk: Buffer) => { consoleOutput += chunk.toString(); });
    await waitForConsole();
    if (recordingDemo) await seedLiveDemoData();
  });

  test.afterAll(async () => {
    await stopProcess(consoleProcess);
  });

  test.beforeEach(() => {
    diagnosticRunIds = [];
    diagnosticThreadKey = undefined;
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    await testInfo.attach('console-server-output.txt', {
      body: Buffer.from(consoleOutput),
      contentType: 'text/plain',
    });
    const diagnostics = await page.evaluate(async ({ runIds, threadKey }) => {
      async function read(path: string): Promise<unknown> {
        try {
          const response = await fetch(path);
          return { status: response.status, body: await response.json() as unknown };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }
      const conversations = await read('/api/v1/conversations?limit=100') as {
        body?: { items?: Array<{ conversationId?: string; threadKey?: string }> };
      };
      const summary = conversations.body?.items?.find((item) => item.threadKey === threadKey);
      return {
        selectedTitle: document.querySelector('#conversation-title')?.textContent,
        statusBadge: document.querySelector('#status-badge')?.textContent,
        notice: document.querySelector('#notice')?.textContent,
        transcript: document.querySelector('#transcript')?.textContent,
        runs: await Promise.all(runIds.map((runId) =>
          read(`/api/v1/runs/${encodeURIComponent(runId)}`))),
        conversations,
        detail: summary?.conversationId
          ? await read(`/api/v1/conversations/${encodeURIComponent(summary.conversationId)}`)
          : undefined,
      };
    }, { runIds: diagnosticRunIds, threadKey: diagnosticThreadKey }).catch((error: unknown) => ({
      diagnosticError: error instanceof Error ? error.message : String(error),
    }));
    await testInfo.attach('live-console-state.json', {
      body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
      contentType: 'application/json',
    });
  });

  test('continues two IAM-authenticated turns in one durable Lambda MicroVM conversation', async ({ page }) => {
    test.setTimeout(timeoutMs);
    const continuityMarker = `continuity-${randomUUID()}`;
    const secondTurnMarker = `second-turn-${randomUUID()}`;
    const uploadMarker = `upload-${randomUUID()}`;
    const conversationTitle = `Live release review ${randomUUID()}`;
    let threadKey: string;
    const structuredQuestion = process.env.AWS_E2E_DEFAULT_AGENT_DRIVER === 'codex'
      ? ' First use request_user_input exactly once to ask "Choose the validation channel" with options Staging and Production. After I answer, include the selected answer in your response.'
      : '';
    const firstPrompt = 'Find release-context.txt below .rat-things/artifacts/uploads and read it. ' +
      'Create .rat-things/artifacts/live-conversation-parity.md with a concise live AWS validation report that includes its exact upload marker. ' +
      `Remember continuity marker ${continuityMarker}. Reply with ACKNOWLEDGED, then include the exact filename.` +
      structuredQuestion + (recordingDemo
        ? ' Also include a Markdown heading named Live AWS demo, a short bullet list, and a fenced shell command containing npm test.'
        : '');
    const secondPrompt = 'Without being told it again, state the exact continuity marker you were asked to remember ' +
      `in the previous turn. Then state this fresh marker exactly: ${secondTurnMarker}`;

    await page.goto(consoleUrl);
    await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');
    await demoPause(page, 900);
    if (recordingDemo) {
      await expect(page.getByRole('button', { name: 'Load more conversations' })).toBeVisible();
      await page.getByRole('button', { name: 'Load more conversations' }).click();
      await expect(page.locator('.conversation-name', { hasText: demoArchiveTitle })).toBeVisible();
      await page.getByPlaceholder('Search conversations').fill(demoArchiveTitle);
      await expect(page.locator('.conversation-name', { hasText: demoArchiveTitle })).toBeVisible();
      await demoPause(page, 1_000);
      await page.getByPlaceholder('Search conversations').fill('');
      await page.locator('.conversation-name', { hasText: demoReferenceTitle }).first().click();
      await expect(page.getByRole('button', { name: 'Load earlier messages' })).toBeVisible();
      await expect(page.getByText(/older transcript items compacted into durable context/)).toBeVisible();
      await page.getByRole('button', { name: 'Load earlier messages' }).click();
      await expect(page.getByText('Seeded durable history 01', { exact: true })).toBeVisible();
      await demoPause(page, 1_200);
    }
    await page.getByRole('button', { name: 'New conversation' }).click();
    await page.locator('#thread-key').fill(conversationTitle);
    await demoPause(page, 650);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('heading', { name: conversationTitle })).toBeVisible();

    const firstRunId = await submitMessage(page, firstPrompt, {
      name: 'release-context.txt',
      mimeType: 'text/plain',
      body: `Live AWS durable attachment. Exact marker: ${uploadMarker}\n`,
    });
    diagnosticRunIds.push(firstRunId);
    await expect(page.locator('#transcript').getByText(firstPrompt, { exact: true })).toBeVisible();
    await expect(page.locator('#run-progress')).toBeVisible();
    await expect(page.locator('#run-progress-title')).toContainText(/Queued|Starting|Agent/);
    if (process.env.AWS_E2E_DEFAULT_AGENT_DRIVER === 'codex') {
      await expect(page.locator('#status-badge')).toHaveText('Needs input', { timeout: timeoutMs - 60_000 });
      await expect(page.locator('.pending-request')).toContainText(/validation channel/i);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(250);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const requestCard = page.locator('.pending-request');
      await requestCard.scrollIntoViewIfNeeded();
      const requestBox = await requestCard.boundingBox();
      expect(requestBox).toBeTruthy();
      expect((requestBox?.x ?? -1) + (requestBox?.width ?? 10_000)).toBeLessThanOrEqual(390);
      await page.getByLabel('Staging').check();
      await page.getByRole('button', { name: 'Send response' }).click();
      await expect(page.getByText('Response delivered to the isolated agent.', { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 1_280, height: 800 });
    }
    await expect(page.locator('.message-row[data-role="assistant"]').last()).toContainText('ACKNOWLEDGED', {
      timeout: timeoutMs - 30_000,
    });
    if (process.env.AWS_E2E_DEFAULT_AGENT_DRIVER === 'codex') {
      await expect(page.locator('.message-row[data-role="assistant"]').last()).toContainText('Staging');
    }
    await expect(page.locator('#status-badge')).toHaveText('Ready');
    await expect(page.locator('.conversation-list [aria-current="page"] .conversation-name')).toContainText(
      conversationTitle,
    );
    const generatedArtifact = page.locator('.artifact-card', { hasText: 'live-conversation-parity.md' });
    await expect(generatedArtifact).toBeVisible();
    await generatedArtifact.click();
    await expect(page.locator('#artifact-viewer')).toBeVisible();
    await expect(page.locator('.viewer-text')).toContainText(uploadMarker, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Close viewer' }).click();
    const uploadedArtifact = page.locator('.artifact-card', { hasText: 'release-context.txt' });
    await expect(uploadedArtifact).toBeVisible();
    await uploadedArtifact.click();
    await expect(page.locator('#artifact-viewer')).toBeVisible();
    await expect(page.locator('.viewer-text')).toContainText(uploadMarker, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Close viewer' }).click();
    if (recordingDemo) {
      await expect(page.locator('.code-block code')).toContainText('npm test');
      const workDetails = page.locator('.work-details');
      if (!await workDetails.evaluate((node: HTMLDetailsElement) => node.open)) {
        await workDetails.locator('summary').click();
      }
      await expect(page.locator('.activity-item').first()).toBeVisible();
      await demoPause(page, 1_400);

      const draft = 'Draft preserved while reviewing another durable conversation.';
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(draft);
      await page.locator('.conversation-name', { hasText: demoReferenceTitle }).first().click();
      await page.getByRole('button', { name: 'Load earlier messages' }).click();
      await expect(page.getByText('Seeded durable history 01', { exact: true })).toBeVisible();
      await page.locator('.conversation-name', { hasText: conversationTitle }).first().click();
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft);
      await demoPause(page, 1_000);
    }
    await demoPause(page, 1_500);

    const firstSummary = await conversationSummary(page, conversationTitle, true);
    threadKey = String(firstSummary.threadKey);
    diagnosticThreadKey = threadKey;
    expect(threadKey).toMatch(/^thread-[0-9a-f-]{36}$/);
    expect(firstSummary).toMatchObject({
      threadKey,
      status: 'idle',
      sourceKind: 'api',
      pinned: false,
      hidden: false,
    });
    expect(String(firstSummary.conversationId)).toMatch(/^[a-f0-9]{64}$/);
    const firstAssistant = page.locator('.message-row[data-role="assistant"]').last();
    const firstAssistantMessageId = await firstAssistant.getAttribute('data-message-id');
    expect(firstAssistantMessageId).toMatch(/^assistant-[a-f0-9]{32}$/);
    await firstAssistant.getByRole('button', { name: 'Add 👍 reaction' }).click();
    await expect(firstAssistant.getByRole('button', { name: 'Remove 👍 reaction' })).toContainText('1');

    let currentRow = page.locator('.conversation-row').filter({
      has: page.locator('.conversation-item[aria-current="page"]'),
    });
    await currentRow.locator('summary').click();
    await currentRow.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(page.locator('.conversation-section').filter({
      has: page.getByRole('heading', { name: 'Pinned' }),
    }).locator('.conversation-item[aria-current="page"]')).toContainText(conversationTitle);
    await expect(page.locator(`[data-message-id="${firstAssistantMessageId}"]`)
      .getByRole('button', { name: 'Remove 👍 reaction' })).toContainText('1');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');
    await expect(page.getByRole('heading', { name: conversationTitle })).toBeVisible();
    await expect(page.locator('.conversation-section').filter({
      has: page.getByRole('heading', { name: 'Pinned' }),
    }).locator('.conversation-item[aria-current="page"]')).toContainText(conversationTitle);

    currentRow = page.locator('.conversation-row').filter({
      has: page.locator('.conversation-item[aria-current="page"]'),
    });
    await currentRow.locator('summary').click();
    await currentRow.getByRole('button', { name: 'Mark as unread', exact: true }).click();
    await expect(currentRow.getByRole('button', { name: /New/ })).toBeVisible();
    expect(await conversationSummary(page, threadKey)).toMatchObject({ unread: true, pinned: true });

    const search = page.getByPlaceholder('Search conversations');
    await search.fill(continuityMarker);
    await expect(page.locator('.conversation-search-result').filter({ hasText: conversationTitle }))
      .toBeVisible();
    await search.fill('live-conversation-parity.md');
    const selectedSearchResult = page.locator('.conversation-search-result').filter({
      has: page.locator('.conversation-item[aria-current="page"]'),
    });
    const fileMatch = selectedSearchResult.getByRole('button', {
      name: /^File live-conversation-parity\.md$/,
    });
    await expect(fileMatch).toBeVisible();
    await fileMatch.click();
    await expect(page.locator('.artifact-card.search-target', { hasText: 'live-conversation-parity.md' }))
      .toBeVisible();
    await search.fill('');

    currentRow = page.locator('.conversation-row').filter({
      has: page.locator('.conversation-item[aria-current="page"]'),
    });
    await currentRow.locator('summary').click();
    await currentRow.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect(page.locator('.conversation-list .conversation-item[aria-current="page"]')).toHaveCount(0);
    const hiddenDetail = await conversationDetail(page, String(firstSummary.conversationId));
    expect(hiddenDetail).toMatchObject({ hidden: true, pinned: true, unread: false });
    await search.fill(continuityMarker);
    await expect(page.getByText('Hidden conversation', { exact: true })).toBeVisible();
    await search.fill('');
    await page.getByRole('button', { name: 'Show hidden conversations' }).click();
    await expect(page.getByRole('heading', { name: 'Hidden' })).toBeVisible();
    currentRow = page.locator('.conversation-row').filter({
      has: page.locator('.conversation-item[aria-current="page"]'),
    });
    await currentRow.locator('summary').click();
    await currentRow.getByRole('button', { name: 'Unhide', exact: true }).click();
    await page.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(page.locator('.conversation-section').filter({
      has: page.getByRole('heading', { name: 'Pinned' }),
    }).locator('.conversation-item[aria-current="page"]')).toContainText(conversationTitle);

    await page.locator(`[data-message-id="${firstAssistantMessageId}"]`)
      .getByRole('button', { name: 'Reply' }).click();
    await expect(page.locator('#composer-context')).toContainText('Replying to Rat Things');
    const secondRunId = await submitMessage(page, secondPrompt);
    diagnosticRunIds.push(secondRunId);
    await expect(page.locator('#transcript').getByText(secondPrompt, { exact: true })).toBeVisible();
    const continuedReply = page.locator('.message-row[data-role="assistant"]').last();
    await expect(page.locator('#status-badge')).toHaveText('Ready', { timeout: timeoutMs - 30_000 });
    await expect(continuedReply).toContainText(continuityMarker);
    await expect(continuedReply).toContainText(secondTurnMarker);
    await expect(page.locator('#conversation-title')).toContainText(conversationTitle);
    await expect(page.locator('.conversation-list [aria-current="page"] .conversation-name')).toContainText(
      conversationTitle,
    );
    if (recordingDemo) {
      const artifactButton = page.locator('.artifact-card', { hasText: 'live-conversation-parity.md' });
      await artifactButton.click();
      await expect(page.locator('#artifact-viewer')).toBeVisible();
      await expect(page.locator('.viewer-text')).toContainText(uploadMarker);
      await demoPause(page, 900);
      await page.getByRole('button', { name: 'Close viewer' }).click();

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('#run-progress')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.getByRole('button', { name: 'Open conversations' }).click();
      await expect(page.locator('#sidebar')).toHaveAttribute('data-open', 'true');
      await demoPause(page, 1_200);
      await page.getByRole('button', { name: new RegExp(conversationTitle) }).first().click();
      await expect(page.locator('#sidebar')).toHaveAttribute('data-open', 'false');
      await page.setViewportSize({ width: 1_280, height: 800 });
      await demoPause(page, 1_200);
    }
    await demoPause(page, 2_200);

    for (const runId of [firstRunId, secondRunId]) {
      const run = await runProjection(page, runId);
      expect(run).toMatchObject({
        runId,
        status: 'succeeded',
        sourceKind: 'api',
        execution: { backend: 'microvm' },
      });
      expect(JSON.stringify(run)).not.toMatch(/ownerId|capabilityOwnerId|bucket|agentThreadId|microvmId/);
    }

    const summary = await conversationSummary(page, threadKey);
    expect(summary).toMatchObject({
      conversationId: firstSummary.conversationId,
      threadKey,
      status: 'idle',
      sourceKind: 'api',
    });

    const detail = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/conversations/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`conversation detail returned HTTP ${response.status}`);
      return response.json() as Promise<{
        transcript?: { messages?: Array<{
          role?: unknown;
          content?: unknown;
          messageId?: unknown;
          replyToMessageId?: unknown;
          attachments?: unknown[];
          reactions?: unknown[];
        }> };
        [key: string]: unknown;
      }>;
    }, String(summary.conversationId));
    expect(detail.transcript?.messages).toHaveLength(4);
    expect(detail.transcript?.messages?.map((message) => message.role)).toEqual([
      'user', 'assistant', 'user', 'assistant',
    ]);
    expect(detail.transcript?.messages?.[0]?.attachments).toHaveLength(1);
    expect(detail.transcript?.messages?.[1]).toMatchObject({
      messageId: firstAssistantMessageId,
      reactions: [{ emoji: '👍', count: 1, reacted: true }],
    });
    expect(detail.transcript?.messages?.[2]).toMatchObject({
      replyToMessageId: firstAssistantMessageId,
    });
    expect(JSON.stringify(detail)).toContain(continuityMarker);
    expect(JSON.stringify(detail)).toContain(secondTurnMarker);
    expect(JSON.stringify(detail)).not.toMatch(/ownerId|capabilityOwnerId|bucket|agentThreadId|microvmId/);

    const runStore = new DynamoRunStore(createAwsClients().dynamodb, required('RUNS_TABLE_NAME'));
    const [storedFirst, storedSecond] = await Promise.all([
      runStore.get(firstRunId),
      runStore.get(secondRunId),
    ]);
    expect(storedFirst?.status).toBe('succeeded');
    expect(storedSecond?.status).toBe('succeeded');
    expect(storedFirst?.execution?.backend).toBe('microvm');
    expect(storedSecond?.execution?.backend).toBe('microvm');
    expect(Boolean(storedFirst?.execution?.id)).toBe(true);
    expect(storedSecond?.execution?.id === storedFirst?.execution?.id).toBe(true);
    expect(storedFirst?.conversation?.attachmentManifest).toEqual(expect.objectContaining({
      bucket: required('ARTIFACT_BUCKET'),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(storedSecond?.conversation?.replyToMessageId).toBe(firstAssistantMessageId);
    const storedConversation = await new DynamoConversationStore(
      createAwsClients().dynamodb,
      required('CONVERSATIONS_TABLE_NAME'),
    ).getConversation(storedFirst!.conversation!.conversationId);
    expect(storedConversation?.artifacts).toBeDefined();
    const catalogObject = await createAwsClients().s3.send(new GetObjectCommand({
      Bucket: storedConversation!.artifacts!.bucket,
      Key: storedConversation!.artifacts!.key,
    }));
    const catalog = JSON.parse(await catalogObject.Body!.transformToString('utf8')) as {
      files?: Array<{ path?: string; file?: { sha256?: string } }>;
    };
    expect(catalog.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringMatching(/^uploads\/[a-f0-9]{12}\/release-context\.txt$/),
        file: expect.objectContaining({
          sha256: createHash('sha256')
            .update(`Live AWS durable attachment. Exact marker: ${uploadMarker}\n`)
            .digest('hex'),
        }),
      }),
      expect.objectContaining({ path: 'live-conversation-parity.md' }),
    ]));
    if (process.env.AWS_E2E_DEFAULT_AGENT_DRIVER === 'codex') {
      expect(storedFirst?.result?.agentThreadId).not.toBe('mock-thread');
      expect(storedSecond?.result?.agentThreadId).toBe(storedFirst?.result?.agentThreadId);
    }
  });
});

async function seedLiveDemoData(): Promise<void> {
  demoReferenceTitle = 'Reference thread · durable history';
  demoArchiveTitle = 'Archive 30 · security evidence';
  const threadKey = `reference-${randomUUID()}`;
  const receipt = await consoleJson<{ runId?: unknown }>('/api/v1/runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'x-rat-console-request': '1',
    },
    body: JSON.stringify({
      version: '1',
      prompt: demoReferenceTitle,
      agent: { driver: 'mock' },
      thread: { key: threadKey, delivery: 'interrupt' },
    }),
  });
  const runId = String(receipt.runId ?? '');
  if (!runId) throw new Error('demo seed Run did not return a runId');
  await waitForSeedRun(runId);

  const clients = createAwsClients();
  const runStore = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
  const storedRun = await runStore.get(runId);
  const conversationId = storedRun?.conversation?.conversationId;
  if (!storedRun?.ownerId || !conversationId) throw new Error('demo seed Run lacks durable conversation identity');
  const conversationStore = new DynamoConversationStore(
    clients.dynamodb,
    required('CONVERSATIONS_TABLE_NAME'),
  );
  const reference = await conversationStore.getConversation(conversationId);
  if (!reference) throw new Error('demo reference conversation was not durable');

  const artifactBucket = required('ARTIFACT_BUCKET');
  const ownerHash = sha256Hex(storedRun.ownerId).slice(0, 32);
  const expiresAt = Math.max(reference.expiresAt, Math.floor(Date.now() / 1_000) + 3_600);
  const transcriptWrites: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 54; index += 1) {
    const sequence = index + 1;
    const label = `Seeded durable history ${String(sequence).padStart(2, '0')}`;
    const role = sequence % 2 === 0 ? 'assistant' : 'user';
    const bytes = Buffer.from(role === 'user' ? JSON.stringify({ text: label }) : label);
    const content = await putDemoObject(
      clients.s3,
      artifactBucket,
      `owners/${ownerHash}/demo-history/${String(sequence).padStart(2, '0')}.json`,
      bytes,
      role === 'user' ? 'application/json' : 'text/plain',
    );
    const occurredAt = new Date(Date.parse(reference.createdAt) - (55 - sequence) * 1_000).toISOString();
    const entryId = `demo-history-${String(sequence).padStart(2, '0')}`;
    transcriptWrites.push({
      version: '1',
      itemType: 'transcript',
      conversationId,
      entryId,
      role,
      contentKind: role === 'user' ? 'message' : 'text',
      content,
      occurredAt,
      expiresAt,
      pk: `CONVERSATION#${sha256Hex(conversationId)}`,
      sk: `TRANSCRIPT#${occurredAt}#${sha256Hex(entryId)}`,
    });
  }
  await batchPut(clients.dynamodb, required('CONVERSATIONS_TABLE_NAME'), transcriptWrites);

  const checkpoint = await putDemoObject(
    clients.s3,
    artifactBucket,
    `owners/${ownerHash}/demo-history/checkpoint.json`,
    Buffer.from(JSON.stringify({
      version: '1',
      messages: [],
      metadata: { compactedMessages: 12 },
    })),
    'application/json',
  );
  await clients.dynamodb.send(new UpdateCommand({
    TableName: required('CONVERSATIONS_TABLE_NAME'),
    Key: { pk: `CONVERSATION#${sha256Hex(conversationId)}`, sk: 'META' },
    UpdateExpression: 'SET #context = :context',
    ExpressionAttributeNames: { '#context': 'context' },
    ExpressionAttributeValues: { ':context': checkpoint },
  }));

  const archiveWrites = Array.from({ length: 30 }, (_, index) => {
    const sequence = index + 1;
    const createdAt = new Date(Date.parse(reference.createdAt) - sequence * 3_600_000).toISOString();
    const archiveConversationId = `api:${reference.ownerId}:demo-archive-${String(sequence).padStart(2, '0')}`;
    const title = `Archive ${String(sequence).padStart(2, '0')} · security evidence`;
    return {
      version: '1',
      itemType: 'conversation',
      conversationId: archiveConversationId,
      ownerId: reference.ownerId,
      ownerCreated: `${reference.ownerId}#${createdAt}#${sha256Hex(archiveConversationId)}`,
      status: 'idle',
      pendingCount: 0,
      title,
      lastMessagePreview: `Durable audit evidence ${String(sequence).padStart(2, '0')} is ready.`,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      source: { kind: 'api', requestId: `demo-archive-${sequence}` },
      destination: { kind: 'none' },
      actor: reference.actor,
      credentialSubject: reference.credentialSubject,
      pk: `CONVERSATION#${sha256Hex(archiveConversationId)}`,
      sk: 'META',
    };
  });
  const searchableArchive = archiveWrites.find((item) => item.title === demoArchiveTitle);
  if (!searchableArchive) throw new Error('searchable demo archive was not created');
  const archiveEntryId = 'demo-archive-search-message';
  const archiveSearchWrites = searchTokens(demoArchiveTitle).map((token) => ({
    version: '1',
    itemType: 'search',
    ownerId: reference.ownerId,
    conversationId: searchableArchive.conversationId,
    entryId: archiveEntryId,
    token,
    kind: 'message',
    role: 'user',
    snippet: demoArchiveTitle,
    occurredAt: searchableArchive.createdAt,
    expiresAt,
    pk: `SEARCH#${ownerHash}#${token}`,
    sk: `MATCH#${searchableArchive.createdAt}#${sha256Hex(searchableArchive.conversationId)}#` +
      `${sha256Hex(archiveEntryId)}#message`,
  }));
  await batchPut(
    clients.dynamodb,
    required('CONVERSATIONS_TABLE_NAME'),
    [...archiveWrites, ...archiveSearchWrites],
  );
  await waitForSeededList();
}

async function waitForSeedRun(runId: string): Promise<void> {
  const deadline = Date.now() + timeoutMs - 30_000;
  while (Date.now() < deadline) {
    const run = await consoleJson<{ status?: string }>(`/api/v1/runs/${encodeURIComponent(runId)}`);
    if (run.status === 'succeeded') return;
    if (run.status === 'failed' || run.status === 'cancelled') {
      throw new Error(`demo seed Run ended ${run.status}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error('demo seed Run did not complete before timeout');
}

async function waitForSeededList(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const list = await consoleJson<{ items?: Array<{ title?: string }>; nextToken?: string }>(
      '/api/v1/conversations?limit=25',
    );
    if (list.nextToken && list.items?.some((item) => item.title === demoReferenceTitle)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('demo conversation pagination did not become visible');
}

async function consoleJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${consoleUrl}${path}`, init);
  const body = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `console request returned HTTP ${response.status}`);
  return body;
}

async function putDemoObject(
  s3: ReturnType<typeof createAwsClients>['s3'],
  bucket: string,
  key: string,
  bytes: Buffer,
  contentType: string,
): Promise<{ bucket: string; key: string; sha256: string }> {
  const digest = createHash('sha256').update(bytes).digest();
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: bytes,
    ContentType: contentType,
    ChecksumSHA256: digest.toString('base64'),
  }));
  return { bucket, key, sha256: digest.toString('hex') };
}

async function batchPut(
  dynamodb: ReturnType<typeof createAwsClients>['dynamodb'],
  tableName: string,
  items: Array<Record<string, unknown>>,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += 25) {
    let pending = items.slice(offset, offset + 25);
    for (let attempt = 0; pending.length > 0 && attempt < 8; attempt += 1) {
      const result = await dynamodb.send(new BatchWriteCommand({
        RequestItems: {
          [tableName]: pending.map((Item) => ({ PutRequest: { Item } })),
        },
      }));
      pending = (result.UnprocessedItems?.[tableName] ?? [])
        .flatMap((request) => request.PutRequest?.Item ? [request.PutRequest.Item] : []);
      if (pending.length > 0) await new Promise((resolveWait) => setTimeout(resolveWait, 100 * 2 ** attempt));
    }
    if (pending.length > 0) throw new Error(`DynamoDB left ${pending.length} demo items unprocessed`);
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function searchTokens(value: string): string[] {
  return [...new Set(value.normalize('NFKC').toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])]
    .filter((token) => token.length >= 2)
    .map((token) => token.slice(0, 64))
    .slice(0, 8);
}

async function submitMessage(
  page: Page,
  prompt: string,
  attachment?: { name: string; mimeType: string; body: string },
): Promise<string> {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
  if (attachment) {
    await page.locator('#file-input').setInputFiles({
      name: attachment.name,
      mimeType: attachment.mimeType,
      buffer: Buffer.from(attachment.body),
    });
    await expect(page.locator('.composer-attachment')).toContainText(attachment.name);
  }
  await demoPause(page, 900);
  const acceptedResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/runs',
  );
  await page.getByRole('button', { name: 'Send message' }).click();
  const accepted = await acceptedResponse;
  expect(accepted.status()).toBe(202);
  const receipt = await accepted.json() as { runId?: unknown };
  expect(receipt.runId).toEqual(expect.any(String));
  return String(receipt.runId);
}

async function runProjection(page: Page, runId: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/runs/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`run projection returned HTTP ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  }, runId);
}

async function conversationSummary(page: Page, threadKey: string, byTitle = false): Promise<Record<string, unknown>> {
  const conversations = await page.evaluate(async () => {
    const response = await fetch('/api/v1/conversations?limit=100');
    if (!response.ok) throw new Error(`conversation list returned HTTP ${response.status}`);
    return response.json() as Promise<{ items?: Array<Record<string, unknown>> }>;
  });
  const summary = conversations.items?.find((item) => byTitle ? item.title === threadKey : item.threadKey === threadKey);
  if (!summary) throw new Error(`conversation ${threadKey} was not present in the public list`);
  return summary;
}

async function conversationDetail(page: Page, conversationId: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/conversations/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`conversation detail returned HTTP ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  }, conversationId);
}

async function demoPause(page: Page, milliseconds: number): Promise<void> {
  if (process.env.RAT_THINGS_CONSOLE_VIDEO === 'on') await page.waitForTimeout(milliseconds);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

async function waitForConsole(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (consoleProcess?.exitCode !== null) {
      throw new Error(`console server exited with ${consoleProcess?.exitCode ?? 'unknown'}\n${consoleOutput}`);
    }
    try {
      const response = await fetch(consoleUrl);
      if (response.ok) return;
    } catch {
      // The loopback listener is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`console server did not start\n${consoleOutput}`);
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live AWS console E2E`);
  return value;
}
