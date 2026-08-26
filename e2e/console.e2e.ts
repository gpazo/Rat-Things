import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { expect, test } from '@playwright/test';

const ownerId = 'console-e2e-owner';
const conversationId = 'a'.repeat(64);
const existingConversationId = 'b'.repeat(64);
const archivedConversationId = 'c'.repeat(64);
const runId = 'run-console-e2e';
const threadKey = 'release-review';
const prompt = 'Inspect the release candidate and stop before publishing.';
const finalReply = 'Release review complete. No changes were published.';
const richFinalReply = `${finalReply}\n\n\`\`\`sh\nnpm test\n\`\`\`\n\n[Open the runbook](https://example.com/runbook)`;
const inputArtifactId = 'input-specification';
const outputArtifactId = 'release-report';
const createdAt = new Date().toISOString();
const completedAt = new Date(Date.parse(createdAt) + 5_000).toISOString();

interface FakeControlState {
  created: boolean;
  completed: boolean;
  listRequests: number;
  runReads: number;
  eventReads: number;
  eventAfterValues: number[];
  completedDetailReads: number;
  listTokens: Array<string | null>;
  artifactReads: number;
  ownerHeaders: string[];
  idempotencyKey: string | undefined;
  organization: Record<string, { pinned: boolean; hidden: boolean; unread: boolean }>;
  searchQueries: string[];
  visibilityValues: string[];
  submission?: unknown;
  questionResponse?: unknown;
  questionResponded: boolean;
  reactions: Record<string, boolean>;
}

let controlServer: Server;
let consoleProcess: ChildProcessByStdio<null, Readable, Readable>;
let consoleUrl: string;
let controlUrl: string;
let consoleOutput = '';
let state: FakeControlState;

test.beforeAll(async () => {
  state = {
    created: false,
    completed: false,
    listRequests: 0,
    runReads: 0,
    eventReads: 0,
    eventAfterValues: [],
    completedDetailReads: 0,
    listTokens: [],
    artifactReads: 0,
    ownerHeaders: [],
    idempotencyKey: undefined,
    organization: {
      [conversationId]: { pinned: false, hidden: false, unread: false },
      [existingConversationId]: { pinned: true, hidden: false, unread: true },
      [archivedConversationId]: { pinned: false, hidden: false, unread: false },
    },
    searchQueries: [],
    visibilityValues: [],
    questionResponded: false,
    reactions: {},
  };
  controlServer = createServer((request, response) => {
    void handleControlRequest(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: { code: 'fake_control_error', message } });
    });
  });
  await listen(controlServer);
  controlUrl = `http://127.0.0.1:${(controlServer.address() as AddressInfo).port}`;

  const consolePort = await availablePort();
  consoleUrl = `http://127.0.0.1:${consolePort}`;
  const tsx = resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  consoleProcess = spawn(tsx, ['scripts/console-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAT_THINGS_API_URL: controlUrl,
      RAT_THINGS_CONSOLE_PORT: String(consolePort),
      RAT_THINGS_LOCAL_OWNER: ownerId,
      AGENT_RUNTIME_UNSIGNED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  consoleProcess.stdout.on('data', (chunk: Buffer) => { consoleOutput += chunk.toString(); });
  consoleProcess.stderr.on('data', (chunk: Buffer) => { consoleOutput += chunk.toString(); });
  await waitForConsole();
});

test.afterAll(async () => {
  await stopProcess(consoleProcess);
  controlServer.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => {
    controlServer.close((error) => error ? reject(error) : resolveClose());
  });
});

test('creates, observes autonomous work, and completes a durable API conversation', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(consoleUrl);
  await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');

  await expect(page.locator('.conversation-name', { hasText: 'Previous release summary' })).toBeVisible();
  await expect(page.locator('.conversation-section').filter({ has: page.getByRole('heading', { name: 'Pinned' }) })
    .getByText('Previous release summary')).toBeVisible();
  await page.getByPlaceholder('Search conversations').fill('credential rotation');
  await expect(page.locator('.conversation-name', { hasText: 'Archived security audit' })).toBeVisible();
  await expect(page.locator('.conversation-name', { hasText: 'Previous release summary' })).toHaveCount(0);
  await expect(page.locator('.conversation-search-match')
    .getByText('Credential rotation evidence was verified.', { exact: true })).toBeVisible();

  await page.getByPlaceholder('Search conversations').fill('requirements.md');
  await expect(page.locator('.conversation-name', { hasText: 'Previous release summary' })).toBeVisible();
  await page.locator('.conversation-search-match').filter({ hasText: 'inputs/requirements.md' }).click();
  await expect(page.locator(`[data-artifact-id="${inputArtifactId}"].search-target`)).toBeVisible();
  await page.getByPlaceholder('Search conversations').fill('');
  await page.getByRole('button', { name: 'Load more conversations' }).click();
  await expect(page.locator('.conversation-name', { hasText: 'Archived security audit' })).toBeVisible();

  let existingRow = page.locator('.conversation-row').filter({ hasText: 'Previous release summary' });
  await existingRow.locator('summary').click();
  await existingRow.getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pinned' })).toHaveCount(0);
  existingRow = page.locator('.conversation-row').filter({ hasText: 'Previous release summary' });
  await existingRow.locator('summary').click();
  await existingRow.getByRole('button', { name: 'Pin', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.conversation-section').filter({ has: page.getByRole('heading', { name: 'Pinned' }) })
    .getByText('Previous release summary')).toBeVisible();

  let archivedRow = page.locator('.conversation-row').filter({ hasText: 'Archived security audit' });
  await archivedRow.locator('summary').click();
  await archivedRow.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.locator('.conversation-name', { hasText: 'Archived security audit' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show hidden conversations' }).click();
  await expect(page.getByRole('heading', { name: 'Hidden' })).toBeVisible();
  await expect(page.locator('.conversation-name', { hasText: 'Archived security audit' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  archivedRow = page.locator('.conversation-row').filter({ hasText: 'Archived security audit' });
  await archivedRow.locator('summary').click();
  await archivedRow.getByRole('button', { name: 'Unhide', exact: true }).click();
  await expect(page.getByText('No hidden conversations.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to conversations' }).click();

  await page.getByPlaceholder('Search conversations').fill('credential rotation');
  await page.waitForTimeout(300);
  await page.getByPlaceholder('Search conversations').fill('requirements.md');
  await expect(page.locator('.conversation-name', { hasText: 'Previous release summary' })).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.locator('.conversation-name', { hasText: 'Archived security audit' })).toHaveCount(0);
  await page.getByPlaceholder('Search conversations').fill('');

  await page.getByRole('button', { name: 'New conversation' }).click();
  const threadKeyInput = page.getByLabel('Name');
  await threadKeyInput.fill('invalid thread key');
  expect(await threadKeyInput.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await threadKeyInput.fill(threadKey);
  expect(await threadKeyInput.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
  await demoPause(page, 600);
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(page.getByRole('heading', { name: threadKey })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Attach files' }).click();
  await page.locator('#file-input').setInputFiles({
    name: 'release-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('durable upload marker: cobalt-orchid'),
  });
  await expect(page.locator('.composer-attachment')).toContainText('release-notes.txt');
  await demoPause(page, 800);
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.locator('#transcript').getByText(prompt, { exact: true })).toBeVisible();
  const progress = page.locator('#run-progress');
  await expect(progress).toBeVisible();
  await expect(page.locator('#run-progress-title')).toHaveText('Queued for isolated execution');
  await expect(page.locator('#run-progress-detail')).toContainText('message is durable');
  await expect(page.locator('#run-progress-elapsed')).toHaveText(/^\d+s$/);
  await expect(page.locator('#run-progress-title')).toHaveText('Starting isolated environment');
  await expect(page.locator('#run-progress-detail')).toContainText('First-use storage can take tens of seconds');
  await expect(page.locator('#status-badge')).toHaveText('Starting');
  await expect(page.locator('#run-progress-title')).toHaveText('Agent needs input');
  await expect(page.locator('#status-badge')).toHaveText('Needs input');
  await expect(page.getByText('Release channel', { exact: true })).toBeVisible();
  await expect(page.getByText('Choose the release channel for this review.', { exact: true })).toBeVisible();
  await expect(page.getByText('Staging', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const questionCard = page.locator('.pending-request');
  await questionCard.scrollIntoViewIfNeeded();
  const questionBox = await questionCard.boundingBox();
  expect(questionBox).toBeTruthy();
  expect((questionBox?.x ?? -1) + (questionBox?.width ?? 10_000)).toBeLessThanOrEqual(390);
  if (process.env.RAT_THINGS_CONSOLE_SCREENSHOTS === 'on') {
    await page.screenshot({ path: 'test-results/rat-things-console-mobile-question.png' });
  }
  await page.getByLabel('Staging').check();
  await page.getByRole('button', { name: 'Send response' }).click();
  await expect(page.getByText('Response delivered to the isolated agent.', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1_280, height: 800 });
  await expect(page.locator('#run-progress-title')).toHaveText('Reviewing the release candidate');
  await expect(page.locator('#status-badge')).toHaveText('Working');
  await expect(page.getByText('Agent turn started', { exact: true })).toBeVisible();
  await expect(page.getByText('Writing response', { exact: true })).toBeVisible();
  await expect(page.getByText('2 updates', { exact: true })).toBeVisible();
  if (!await page.locator('.work-details').evaluate((details: HTMLDetailsElement) => details.open)) {
    await page.locator('.work-details summary').click();
  }
  await expect(page.getByText('Command completed', { exact: true })).toBeVisible();
  await expect(page.getByText('Context compacted', { exact: true })).toBeVisible();
  await expect(page.getByText(/Some early live activity expired/)).toBeVisible();
  await expect(page.getByText('turn/started', { exact: true })).toHaveCount(0);

  if (process.env.RAT_THINGS_CONSOLE_VIDEO !== 'on') {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.waitForTimeout(250);
    await expect(page.getByRole('button', { name: 'Open conversations' })).toBeVisible();
    expect((await page.locator('#sidebar').boundingBox())?.x ?? 0).toBeLessThan(0);
    await expect(page.locator('#sidebar')).toHaveAttribute('inert', '');
    await expect(page.locator('#sidebar')).toHaveAttribute('aria-hidden', 'true');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    await expect(progress).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const progressBox = await progress.boundingBox();
    expect(progressBox).toBeTruthy();
    expect((progressBox?.x ?? -1) + (progressBox?.width ?? 10_000)).toBeLessThanOrEqual(390);
    expect((await page.locator('#sidebar').boundingBox())?.x ?? 0).toBeLessThan(0);
    if (process.env.RAT_THINGS_CONSOLE_SCREENSHOTS === 'on') {
      await page.screenshot({ path: 'test-results/rat-things-console-mobile-work.png' });
    }
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.waitForTimeout(250);
    expect((await page.locator('#sidebar').boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
    await expect(page.getByPlaceholder('Search conversations')).toBeFocused();
    await expect(page.locator('#workspace')).toHaveAttribute('inert', '');
    await expect(page.locator('#sidebar')).toHaveAttribute('aria-hidden', 'false');
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.querySelector('#sidebar')?.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open conversations' })).toBeFocused();
    await expect(page.locator('#workspace')).not.toHaveAttribute('inert', '');
    await expect(page.locator('#sidebar')).toHaveAttribute('aria-hidden', 'true');
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await expect(page.getByPlaceholder('Search conversations')).toBeFocused();
    if (process.env.RAT_THINGS_CONSOLE_SCREENSHOTS === 'on') {
      await page.screenshot({ path: 'test-results/rat-things-console-mobile-drawer.png' });
    }
    await page.getByRole('button', { name: /Previous release summary/ }).click();
    await expect(page.getByRole('heading', { name: 'Previous release summary' })).toBeVisible();
    await page.waitForTimeout(250);
    expect((await page.locator('#sidebar').boundingBox())?.x ?? 0).toBeLessThan(0);
    await page.setViewportSize({ width: 1_280, height: 800 });
    await page.getByRole('button', { name: new RegExp(threadKey) }).click();
  }
  await demoPause(page, 1_400);

  await expect(page.locator('#transcript').getByText(finalReply, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.code-block code')).toHaveText('npm test');
  await expect(page.getByRole('link', { name: 'Open the runbook' })).toHaveAttribute('href', 'https://example.com/runbook');
  await expect(page.locator('#status-badge')).toHaveText('Ready');
  await expect(progress).toBeVisible();
  await expect(page.locator('#run-progress-title')).toHaveText('Work completed');
  await expect(page.locator('.work-details')).not.toHaveAttribute('open', '');
  await page.locator('.work-details summary').click();
  await expect(page.getByText('Command completed', { exact: true })).toBeVisible();
  await expect(page.locator('.conversation-list .conversation-name', { hasText: threadKey })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conversation files' })).toBeVisible();
  const artifactButton = page.getByRole('button', { name: /reports\/release-review\.md/ });
  await expect(artifactButton).toBeVisible();
  const contentResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/artifacts/${outputArtifactId}/content`),
  );
  await artifactButton.click();
  await expect(page.locator('#artifact-viewer')).toBeVisible();
  expect((await contentResponse).status()).toBe(200);
  await expect(page.locator('.viewer-text')).toContainText('Release report fixture');
  if (process.env.RAT_THINGS_CONSOLE_SCREENSHOTS === 'on') {
    await page.screenshot({ path: 'test-results/rat-things-console-desktop-viewer.png' });
  }
  await expect(page.getByRole('link', { name: 'Open in new tab' })).toHaveAttribute(
    'href',
    new RegExp(`/artifacts/${outputArtifactId}/content$`),
  );
  await page.getByRole('button', { name: 'Close viewer' }).click();

  const assistantMessage = page.locator('[data-message-id="assistant-console-e2e"]');
  await assistantMessage.getByRole('button', { name: 'Add 👍 reaction' }).click();
  await expect(assistantMessage.getByRole('button', { name: 'Remove 👍 reaction' })).toContainText('1');
  await assistantMessage.getByRole('button', { name: 'Reply' }).click();
  await expect(page.locator('#composer-context')).toContainText('Replying to Rat Things');
  await page.getByRole('button', { name: 'Cancel reply' }).click();
  await expect(page.locator('#composer-context')).toBeHidden();
  if (process.env.RAT_THINGS_CONSOLE_SCREENSHOTS === 'on') {
    await page.screenshot({ path: 'test-results/rat-things-console-desktop-complete.png' });
  }
  await demoPause(page, 1_500);

  existingRow = page.locator('.conversation-row').filter({ hasText: 'Previous release summary' });
  await existingRow.locator('summary').click();
  await existingRow.getByRole('button', { name: 'Mark as unread', exact: true }).click();
  await expect(page.getByRole('button', { name: /Previous release summary, New/ })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');
  await expect(page.getByRole('heading', { name: threadKey })).toBeVisible();
  await expect(page.locator('.conversation-section').filter({ has: page.getByRole('heading', { name: 'Pinned' }) })
    .getByRole('button', { name: /Previous release summary, New/ })).toBeVisible();
  existingRow = page.locator('.conversation-row').filter({ hasText: 'Previous release summary' });
  await existingRow.locator('summary').click();
  await existingRow.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: /Previous release summary, Ready/ })).toBeVisible();

  expect(state.submission).toMatchObject({
    version: '1',
    prompt,
    thread: {
      key: threadKey,
      delivery: 'interrupt',
      attachments: [{
        name: 'release-notes.txt',
        mediaType: 'text/plain',
        base64: Buffer.from('durable upload marker: cobalt-orchid').toString('base64'),
      }],
    },
  });
  expect(state.questionResponse).toEqual({ result: { answers: { channel: { answers: ['Staging'] } } } });
  expect(state.reactions['assistant-console-e2e:👍']).toBe(true);
  expect(state.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(state.listTokens).toContain('older-list');
  expect(state.eventAfterValues.slice(0, 4)).toEqual([0, 0, 3, 4]);
  expect(state.eventAfterValues).toContain(8);
  expect(state.completedDetailReads).toBeGreaterThan(1);
  expect(state.artifactReads).toBeGreaterThan(0);
  expect(state.searchQueries).toEqual(expect.arrayContaining(['credential rotation', 'requirements.md']));
  expect(state.visibilityValues).toEqual(expect.arrayContaining(['visible', 'hidden']));
  expect(state.ownerHeaders.length).toBeGreaterThan(0);
  expect(new Set(state.ownerHeaders)).toEqual(new Set([ownerId]));

  const foreignOrigin = await fetch(`${consoleUrl}/api/v1/conversations`, {
    headers: { origin: 'https://attacker.invalid' },
  });
  expect(foreignOrigin.status).toBe(403);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(consoleErrors).toHaveLength(1);
  expect(consoleErrors[0]).toContain('503 (Service Unavailable)');

  await page.locator('.conversation-list .conversation-name', { hasText: 'Previous release summary' }).click();
  await expect(page.getByRole('button', { name: /requirements\.md/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toBeVisible();
  const anchor = page.locator('#transcript').getByText('Summarize the previous release.', { exact: true });
  await page.getByRole('button', { name: 'Load earlier messages' }).scrollIntoViewIfNeeded();
  const beforeAnchor = await anchor.boundingBox();
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await expect(page.locator('#transcript').getByText('Initial release request.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
  await expect.poll(async () => {
    const afterAnchor = await anchor.boundingBox();
    return Math.abs((afterAnchor?.y ?? 0) - (beforeAnchor?.y ?? 0));
  }).toBeLessThanOrEqual(2);

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Preserve this local draft while I inspect another thread.');
  await page.getByRole('button', { name: 'Load more conversations' }).click();
  await page.locator('.conversation-list .conversation-name', { hasText: 'Archived security audit' }).click();
  await page.locator('.conversation-list .conversation-name', { hasText: 'Previous release summary' }).click();
  await expect(composer).toHaveValue('Preserve this local draft while I inspect another thread.');
  await expect(page.getByText('The previous release completed successfully.', { exact: true })).toBeVisible();
  await demoPause(page, 900);
});

async function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', controlUrl);
  if (request.method === 'GET' && url.pathname === '/fixture-artifact-content') {
    if (request.headers['x-runtime-owner']) {
      return sendJson(response, 403, { error: { code: 'leaked_header', message: 'owner header reached artifact storage' } });
    }
    return sendText(response, 200, '# Release report fixture\n\nNo changes were published.\n', 'text/markdown; charset=utf-8');
  }
  const owner = request.headers['x-runtime-owner'];
  state.ownerHeaders.push(typeof owner === 'string' ? owner : '');

  if (request.method === 'GET' && url.pathname === '/v1/conversations') {
    const token = url.searchParams.get('nextToken');
    const visibility = url.searchParams.get('visibility') ?? 'visible';
    state.listTokens.push(token);
    state.visibilityValues.push(visibility);
    if (state.listRequests++ === 0) await delay(450);
    if (visibility === 'hidden') {
      return sendJson(response, 200, {
        items: allConversationSummaries().filter((item) => item.hidden),
      });
    }
    if (token === 'older-list') {
      return sendJson(response, 200, {
        items: state.organization[archivedConversationId]?.hidden ? [] : [archivedConversationSummary()],
      });
    }
    return sendJson(response, 200, {
      items: state.created
        ? [conversationSummary(), existingConversationSummary()].filter((item) => !item.hidden)
        : [existingConversationSummary()].filter((item) => !item.hidden),
      nextToken: 'older-list',
    });
  }
  if (request.method === 'GET' && url.pathname === '/v1/conversations/search') {
    const query = (url.searchParams.get('q') ?? '').toLocaleLowerCase('en-US');
    state.searchQueries.push(query);
    if (query.includes('credential')) await delay(500);
    const hit = query.includes('credential')
      ? {
          conversation: archivedConversationSummary(),
          matches: [{
            kind: 'message',
            role: 'assistant',
            snippet: 'Credential rotation evidence was verified.',
            occurredAt: '2026-08-20T12:10:00.000Z',
          }],
        }
      : query.includes('requirements')
        ? {
            conversation: existingConversationSummary(),
            matches: [{
              kind: 'file',
              artifactId: inputArtifactId,
              snippet: 'inputs/requirements.md',
              occurredAt: '2026-08-24T16:00:00.000Z',
            }],
          }
        : query.includes('previous release')
          ? {
              conversation: existingConversationSummary(),
              matches: [{
                kind: 'message',
                role: 'assistant',
                snippet: 'The previous release completed successfully.',
                occurredAt: '2026-08-24T16:00:01.000Z',
              }],
            }
          : undefined;
    return sendJson(response, 200, { items: hit ? [hit] : [] });
  }
  const organizationMatch = url.pathname.match(/^\/v1\/conversations\/([a-f0-9]{64})\/organization$/);
  if (request.method === 'POST' && organizationMatch) {
    const targetId = organizationMatch[1]!;
    const current = state.organization[targetId];
    if (!current) return sendJson(response, 404, { error: { code: 'not_found', message: 'conversation not found' } });
    const body = await readJson(request) as { pinned?: unknown; hidden?: unknown; read?: unknown };
    if (typeof body.pinned === 'boolean') current.pinned = body.pinned;
    if (typeof body.hidden === 'boolean') current.hidden = body.hidden;
    if (typeof body.read === 'boolean') current.unread = !body.read;
    return sendJson(response, 200, summaryFor(targetId));
  }
  if (request.method === 'GET' && url.pathname === `/v1/conversations/${conversationId}`) {
    const projectionReady = state.completed && state.completedDetailReads > 0;
    if (state.completed) state.completedDetailReads += 1;
    return sendJson(response, 200, conversationDetail(projectionReady));
  }
  if (request.method === 'GET' && url.pathname === `/v1/conversations/${existingConversationId}`) {
    return sendJson(
      response,
      200,
      url.searchParams.get('nextToken') === 'older-existing'
        ? existingConversationOlderDetail()
        : existingConversationDetail(),
    );
  }
  if (request.method === 'GET' && url.pathname === `/v1/conversations/${archivedConversationId}`) {
    return sendJson(response, 200, archivedConversationDetail());
  }
  if (request.method === 'GET' && url.pathname === '/v1/conversations/existing-thread/artifacts') {
    state.artifactReads += 1;
    return sendJson(response, 200, { files: [inputArtifact()] });
  }
  if (request.method === 'GET' && url.pathname === `/v1/conversations/existing-thread/artifacts/${inputArtifactId}`) {
    state.artifactReads += 1;
    return sendJson(response, 200, { ...inputArtifact(), url: 'about:blank#input-specification' });
  }
  if (request.method === 'GET' && url.pathname === `/v1/conversations/${threadKey}/artifacts`) {
    state.artifactReads += 1;
    return sendJson(response, 200, { files: state.completed ? [outputArtifact()] : [] });
  }
  if (request.method === 'GET' && url.pathname === `/v1/conversations/${threadKey}/artifacts/${outputArtifactId}`) {
    state.artifactReads += 1;
    return sendJson(response, 200, { ...outputArtifact(), url: 'about:blank#release-report' });
  }
  if (request.method === 'GET' && url.pathname === `/v1/conversations/${threadKey}/artifacts/${outputArtifactId}/content`) {
    state.artifactReads += 1;
    response.statusCode = 302;
    response.setHeader('location', '/fixture-artifact-content');
    response.end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/conversations/archived-thread/artifacts') {
    state.artifactReads += 1;
    return sendJson(response, 200, { files: [] });
  }
  if (request.method === 'POST' && url.pathname === '/v1/runs') {
    state.created = true;
    state.submission = await readJson(request);
    state.idempotencyKey = stringHeader(request.headers['idempotency-key']);
    return sendJson(response, 202, runProjection('queued'));
  }
  if (request.method === 'GET' && url.pathname === `/v1/runs/${runId}`) {
    const statuses = [
      'queued',
      'dispatching',
      'running',
      'running',
      'running',
      'running',
      'running',
      'running',
      'succeeded',
    ] as const;
    const status = statuses[Math.min(state.runReads, statuses.length - 1)]!;
    state.runReads += 1;
    state.completed = status === 'succeeded';
    return sendJson(response, 200, runProjection(status));
  }
  if (request.method === 'GET' && url.pathname === `/v1/runs/${runId}/events`) {
    const after = Number(url.searchParams.get('after') ?? '0');
    state.eventAfterValues.push(after);
    if (state.eventReads++ === 0) return sendJson(response, 503, {
      error: { code: 'temporarily_unavailable', message: 'runtime proxy is still starting' },
    });
    return sendJson(response, 200, runtimeSnapshot(after));
  }
  if (request.method === 'POST' && url.pathname === `/v1/runs/${runId}/requests/request-console-e2e/respond`) {
    state.questionResponse = await readJson(request);
    state.questionResponded = true;
    return sendJson(response, 202, { ok: true, operation: 'respond' });
  }
  const reactionMatch = url.pathname.match(/^\/v1\/conversations\/([a-f0-9]{64})\/messages\/([^/]+)\/reactions$/);
  if (request.method === 'POST' && reactionMatch) {
    const body = await readJson(request) as { emoji: string; reacted: boolean };
    state.reactions[`${decodeURIComponent(reactionMatch[2]!)}:${body.emoji}`] = body.reacted;
    return sendJson(response, 200, body);
  }
  return sendJson(response, 404, { error: { code: 'not_found', message: 'fake route not found' } });
}

function conversationSummary(): Record<string, unknown> {
  return {
    conversationId,
    title: threadKey,
    threadKey,
    status: state.completed ? 'idle' : 'running',
    pendingCount: 0,
    sourceKind: 'api',
    createdAt,
    updatedAt: state.completed ? completedAt : createdAt,
    lastMessagePreview: state.completed ? finalReply : prompt,
    latestProgress: state.completed ? undefined : {
      eventId: 'progress-console-e2e',
      text: 'Reviewing the release candidate',
      reportedAt: createdAt,
    },
    ...state.organization[conversationId],
  };
}

function conversationDetail(projectionReady = state.completed): Record<string, unknown> {
  const summary = projectionReady ? conversationSummary() : {
    conversationId,
    title: threadKey,
    threadKey,
    status: 'running',
    pendingCount: 0,
    sourceKind: 'api',
    createdAt,
    updatedAt: createdAt,
    lastMessagePreview: prompt,
  };
  return {
    ...summary,
    ...(!projectionReady ? { activeRunId: runId } : {}),
    transcript: {
      messages: [
        { role: 'user', content: prompt, messageId: 'message-console-e2e', receivedAt: createdAt },
        ...(projectionReady ? [{
          role: 'assistant',
          content: richFinalReply,
          messageId: 'assistant-console-e2e',
          receivedAt: completedAt,
          ...(state.reactions['assistant-console-e2e:👍']
            ? { reactions: [{ emoji: '👍', count: 1, reacted: true }] }
            : {}),
        }] : []),
      ],
      compactedMessages: 0,
    },
  };
}

function existingConversationSummary(): Record<string, unknown> {
  return {
    conversationId: existingConversationId,
    title: 'Previous release summary',
    threadKey: 'existing-thread',
    status: 'idle',
    pendingCount: 0,
    sourceKind: 'api',
    createdAt: '2026-08-24T16:00:00.000Z',
    updatedAt: '2026-08-24T16:00:05.000Z',
    lastMessagePreview: 'The previous release completed successfully.',
    ...state.organization[existingConversationId],
  };
}

function existingConversationDetail(): Record<string, unknown> {
  return {
    ...existingConversationSummary(),
    transcript: {
      messages: [
        {
          role: 'user',
          content: 'Summarize the previous release.',
          receivedAt: '2026-08-24T16:00:00.000Z',
          attachments: [{ id: inputArtifactId }],
        },
        { role: 'assistant', content: 'The previous release completed successfully.', receivedAt: '2026-08-24T16:00:01.000Z' },
        ...recentTranscriptMessages(),
      ],
      compactedMessages: 0,
      nextToken: 'older-existing',
    },
  };
}

function existingConversationOlderDetail(): Record<string, unknown> {
  return {
    ...existingConversationSummary(),
    transcript: {
      messages: [
        ...olderTranscriptMessages(),
        { role: 'user', content: 'Initial release request.', receivedAt: '2026-08-23T15:00:00.000Z' },
        { role: 'assistant', content: 'Initial release completed.', receivedAt: '2026-08-23T15:00:01.000Z' },
      ],
      compactedMessages: 0,
    },
  };
}

function archivedConversationSummary(): Record<string, unknown> {
  return {
    conversationId: archivedConversationId,
    title: 'Archived security audit',
    threadKey: 'archived-thread',
    status: 'idle',
    pendingCount: 0,
    sourceKind: 'api',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:10:00.000Z',
    lastMessagePreview: 'Credential rotation evidence was verified.',
    ...state.organization[archivedConversationId],
  };
}

function allConversationSummaries(): Array<Record<string, unknown> & { hidden?: boolean }> {
  return [
    ...(state.created ? [conversationSummary()] : []),
    existingConversationSummary(),
    archivedConversationSummary(),
  ];
}

function summaryFor(targetId: string): Record<string, unknown> {
  if (targetId === conversationId) return conversationSummary();
  if (targetId === existingConversationId) return existingConversationSummary();
  if (targetId === archivedConversationId) return archivedConversationSummary();
  throw new Error(`unknown conversation ${targetId}`);
}

function archivedConversationDetail(): Record<string, unknown> {
  return {
    ...archivedConversationSummary(),
    transcript: {
      messages: [
        { role: 'user', content: 'Verify credential rotation evidence.' },
        { role: 'assistant', content: 'Credential rotation evidence was verified.' },
      ],
      compactedMessages: 7,
    },
  };
}

function recentTranscriptMessages(): Array<Record<string, unknown>> {
  return Array.from({ length: 12 }, (_, index) => [
    { role: 'user', content: `Recent release question ${index + 1}.` },
    { role: 'assistant', content: `Recent release answer ${index + 1}.` },
  ]).flat();
}

function olderTranscriptMessages(): Array<Record<string, unknown>> {
  return Array.from({ length: 10 }, (_, index) => [
    { role: 'user', content: `Historical release question ${index + 1}.` },
    { role: 'assistant', content: `Historical release answer ${index + 1}.` },
  ]).flat();
}

function inputArtifact(): Record<string, unknown> {
  return {
    id: inputArtifactId,
    path: 'inputs/requirements.md',
    mediaType: 'text/markdown',
    bytes: 2_048,
    createdAt: '2026-08-24T16:00:00.000Z',
    sourceRunId: 'run-existing',
    sha256: 'd'.repeat(64),
  };
}

function outputArtifact(): Record<string, unknown> {
  return {
    id: outputArtifactId,
    path: 'reports/release-review.md',
    mediaType: 'text/markdown',
    bytes: 4_096,
    createdAt: completedAt,
    sourceRunId: runId,
    sha256: 'e'.repeat(64),
  };
}

function runProjection(status: 'queued' | 'dispatching' | 'running' | 'succeeded'): Record<string, unknown> {
  return {
    runId,
    status,
    createdAt,
    updatedAt: status === 'succeeded' ? completedAt : createdAt,
    expiresAt: 1_800_000_000,
    sourceKind: 'api',
    ...(['running', 'succeeded'].includes(status)
      ? { execution: { backend: 'microvm', startedAt: createdAt } }
      : {}),
    ...(status === 'succeeded' ? {
      result: { preview: finalReply, exitCode: 0, durationMs: 5_000 },
    } : {}),
  };
}

function runtimeSnapshot(after: number): Record<string, unknown> {
  const snapshots: Record<number, { events: Array<Record<string, unknown>>; pendingRequests: Array<Record<string, unknown>> }> = {
    0: {
      events: [
        activity(1, 'agent', 'started', 'Agent turn started'),
        activity(2, 'message', 'updated', 'Writing response'),
        activity(3, 'message', 'updated', 'Writing response'),
      ],
      pendingRequests: [],
    },
    3: {
      events: [activity(4, 'plan', 'updated', 'Plan updated', '3 steps')],
      pendingRequests: [],
    },
    4: state.questionResponded ? {
      events: [
        activity(5, 'command', 'started', 'Command started'),
        activity(6, 'command', 'completed', 'Command completed', 'exit 0 · 1.2 s'),
        activity(7, 'file', 'completed', 'File changes applied', '2 files'),
        activity(8, 'compaction', 'completed', 'Context compacted'),
      ],
      pendingRequests: [],
    } : {
      events: [],
      pendingRequests: [{
        requestId: 'request-console-e2e',
        kind: 'input',
        title: 'Agent needs input',
        receivedAt: '2026-08-24T17:00:04.000Z',
        questions: [{
          id: 'channel',
          header: 'Release channel',
          question: 'Choose the release channel for this review.',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Staging', description: 'Review the staging candidate.' },
            { label: 'Production', description: 'Review the production candidate.' },
          ],
        }],
      }],
    },
  };
  const snapshot = snapshots[after] ?? { events: [], pendingRequests: [] };
  return {
    runId,
    active: !state.completed,
    ready: true,
    oldestSequence: after === 4 ? 6 : 1,
    nextSequence: 9,
    ...snapshot,
  };
}

function activity(
  sequence: number,
  kind: string,
  status: string,
  title: string,
  detail?: string,
): Record<string, unknown> {
  return {
    sequence,
    occurredAt: `2026-08-24T17:00:0${sequence}.000Z`,
    kind,
    status,
    title,
    ...(detail ? { detail } : {}),
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) as unknown : {};
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', body.byteLength);
  response.end(body);
}

function sendText(response: ServerResponse, status: number, value: string, mediaType: string): void {
  const body = Buffer.from(value);
  response.statusCode = status;
  response.setHeader('content-type', mediaType);
  response.setHeader('content-length', body.byteLength);
  response.end(body);
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

async function availablePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function waitForConsole(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (consoleProcess.exitCode !== null) {
      throw new Error(`console server exited with ${consoleProcess.exitCode}\n${consoleOutput}`);
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

function stringHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function demoPause(page: import('@playwright/test').Page, milliseconds = 900): Promise<void> {
  if (process.env.RAT_THINGS_CONSOLE_VIDEO === 'on') await page.waitForTimeout(milliseconds);
}
