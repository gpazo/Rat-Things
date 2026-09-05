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
let threadKey = 'release-review';
const conversationName = 'Release readiness review';
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
  computerControl: 'agent' | 'human';
  computerJourneyDone: boolean;
  computerReads: number;
  computerActions: unknown[];
  teachRecording: boolean;
  teachSteps: number;
  connections: Array<Record<string, any>>;
  connectionSets: Array<Record<string, any>>;
  sourceBindings: Array<Record<string, any>>;
  routines: Array<Record<string, any>>;
  oauthStarts: number;
  oauthReconnects: number;
  routineRuns: number;
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
    computerControl: 'agent',
    computerJourneyDone: false,
    computerReads: 0,
    computerActions: [],
    teachRecording: false,
    teachSteps: 0,
    connections: [
      connectionBundle('connection-slack', 'slack-work', 'Slack Workspace', 'slack', 'read-only'),
      connectionBundle('connection-slack-secondary', 'slack-secondary', 'Slack Workspace Secondary', 'slack', 'read-only'),
    ],
    connectionSets: [],
    sourceBindings: [],
    routines: [routineFixture('routine-daily', 'Daily account health', 'enabled')],
    oauthStarts: 0,
    oauthReconnects: 0,
    routineRuns: 0,
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
  const threadKeyInput = page.locator('#thread-key');
  await threadKeyInput.fill('Release readiness review');
  expect(await threadKeyInput.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
  await threadKeyInput.fill(conversationName);
  expect(await threadKeyInput.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
  await demoPause(page, 600);
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(page.getByRole('heading', { name: conversationName })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
  await page.locator('.composer-options summary').click();
  await page.getByLabel('Isolated browser').check();
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
  const pollsBeforeAnswer = state.eventReads;
  await expect.poll(() => state.eventReads).toBeGreaterThan(pollsBeforeAnswer + 1);
  await expect(page.getByLabel('Staging')).toBeChecked();
  await page.getByRole('button', { name: 'Send response' }).click();
  await expect(page.getByText('Response delivered to the isolated agent.', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1_280, height: 800 });
  await expect(page.locator('#run-progress-title')).toHaveText('Reviewing the release candidate');
  await expect(page.locator('#status-badge')).toHaveText('Working');
  await expect(page.locator('#run-strip')).toBeVisible();
  await expect(page.locator('#run-strip-phase')).toHaveText(/Working|Answering/);
  if (!await page.locator('.work-details').evaluate((details: HTMLDetailsElement) => details.open)) {
    await page.locator('.work-details > summary').click();
  }
  const transcriptPhases = page.locator('.work-details > .work-activity .phase-card');
  await expect(transcriptPhases.filter({ hasText: 'Rat started working' })).toBeVisible();
  await expect(transcriptPhases.filter({ hasText: 'Preparing the answer' })).toContainText('2 related updates');
  await expect(transcriptPhases.filter({ hasText: 'Using the workspace' })).toBeVisible();
  await expect(transcriptPhases.filter({ hasText: 'Keeping context focused' })).toBeVisible();
  await expect(page.getByText(/Some early live activity expired/)).toBeVisible();
  await expect(page.getByText('turn/started', { exact: true })).toHaveCount(0);

  const sidebarWidth = Number(await page.locator('#sidebar-resizer').getAttribute('aria-valuenow'));
  await page.locator('#sidebar-resizer').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#sidebar-resizer')).toHaveAttribute('aria-valuenow', String(sidebarWidth + 16));
  const sidebarDivider = await page.locator('#sidebar-resizer').boundingBox();
  expect(sidebarDivider).toBeTruthy();
  await page.mouse.move(sidebarDivider!.x + 3, sidebarDivider!.y + 120);
  await page.mouse.down();
  await page.mouse.move(sidebarDivider!.x + 27, sidebarDivider!.y + 120);
  await page.mouse.up();
  expect(Number(await page.locator('#sidebar-resizer').getAttribute('aria-valuenow'))).toBeGreaterThan(sidebarWidth + 30);

  await page.getByRole('button', { name: 'Open computer' }).click();
  await expect(page.locator('#context-pane')).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Browser/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#computer-loading')).toContainText('Starting the isolated screen');
  await expect(page.locator('#computer-screen')).toBeVisible();
  await expect(page.locator('#computer-owner-label')).toHaveText('Rat has control');
  const contextWidth = Number(await page.locator('#context-resizer').getAttribute('aria-valuenow'));
  await page.locator('#context-resizer').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#context-resizer')).toHaveAttribute('aria-valuenow', String(contextWidth + 16));
  await page.getByRole('button', { name: 'Take control' }).click();
  await expect(page.getByRole('button', { name: 'Return control' })).toBeVisible();
  await expect(page.locator('#computer-owner-label')).toHaveText('You have control');
  await expect(page.locator('#computer-lease-label')).toContainText('remaining');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('#computer-zoom-label')).toHaveText('125%');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.locator('#computer-inputs summary').click();
  await page.locator('#computer-url').fill('https://example.com/report');
  await page.locator('#computer-navigation').getByRole('button', { name: 'Go' }).click();
  await page.locator('#teach-name').fill('Submit weekly report');
  await page.locator('#teach-goal').fill('Submit the prepared weekly report.');
  await page.getByRole('button', { name: 'Start teaching' }).click();
  await expect(page.locator('#computer-recording-badge')).toBeVisible();
  await page.locator('#computer-text').fill('sensitive demonstrated value');
  await page.locator('#computer-type').getByRole('button', { name: 'Type' }).click();
  await expect(page.locator('#teach-step-count')).toContainText('1 action demonstrated');
  await page.getByRole('button', { name: 'Stop & save draft' }).click();
  await expect(page.locator('#notice')).toContainText('Draft Thing');
  await page.getByRole('tab', { name: /^Sources/ }).click();
  await expect(page.locator('#context-sources')).toContainText('example.com');
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.locator('#context-activity .phase-card').filter({ hasText: 'Using the workspace' })).toBeVisible();
  await page.getByRole('tab', { name: /^Browser/ }).click();
  if (process.env.RAT_THINGS_CONSOLE_SCREENSHOTS === 'on') {
    await page.screenshot({ path: 'test-results/rat-things-console-three-pane-browser.png' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const contextBox = await page.locator('#context-pane').boundingBox();
  expect(contextBox?.x).toBe(0);
  expect(contextBox?.width).toBe(390);
  await expect(page.locator('#workspace')).toHaveAttribute('inert', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.RAT_THINGS_CONSOLE_SCREENSHOTS === 'on') {
    await page.screenshot({ path: 'test-results/rat-things-console-mobile-browser.png' });
  }
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.getByRole('button', { name: 'Close context pane' }).click();
  await expect.poll(() => state.computerControl).toBe('agent');
  expect(state.computerActions).toEqual(expect.arrayContaining([
    { type: 'navigate', url: 'https://example.com/report' },
    { type: 'type', text: 'sensitive demonstrated value', clear: false, submit: false },
  ]));

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
    await page.getByRole('button', { name: new RegExp(conversationName) }).click();
  }
  await demoPause(page, 1_400);

  await expect(page.locator('#transcript').getByText(finalReply, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.code-block code')).toHaveText('npm test');
  await expect(page.getByRole('link', { name: 'Open the runbook' })).toHaveAttribute('href', 'https://example.com/runbook');
  await expect(page.locator('#status-badge')).toHaveText('Ready');
  await expect(progress).toBeVisible();
  await expect(page.locator('#run-progress-title')).toHaveText('Work completed');
  await expect(page.locator('.work-details')).not.toHaveAttribute('open', '');
  await page.locator('.work-details > summary').click();
  await expect(page.locator('.work-details > .work-activity .phase-card').filter({ hasText: 'Using the workspace' })).toBeVisible();
  await expect(page.locator('.conversation-list .conversation-name', { hasText: conversationName })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: conversationName })).toBeVisible();
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
    agent: {
      driver: 'codex',
      capabilities: {
        profile: 'small-business',
        networkAccess: true,
        computerUse: 'browser',
      },
    },
    thread: {
      key: expect.stringMatching(/^thread-[0-9a-f-]{36}$/),
      title: conversationName,
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
  expect(consoleErrors).toHaveLength(2);
  expect(consoleErrors.some((entry) => entry.includes('502 (Bad Gateway)'))).toBe(true);
  expect(consoleErrors.some((entry) => entry.includes('503 (Service Unavailable)'))).toBe(true);

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
  await expect(
    page.getByRole('region', { name: 'Conversation transcript' })
      .getByText('The previous release completed successfully.', { exact: true }),
  ).toBeVisible();
  await demoPause(page, 900);
});

test('submits from an empty workspace and reuses the exact file-bearing request after a lost response and reload', async ({ page }) => {
  const submissions: Array<{key: string | undefined; body: any}> = [];
  const id = 'e'.repeat(64);
  const createdAt = new Date().toISOString();
  const summary = () => ({conversationId: id, threadKey: submissions[0]?.body.thread.key,
    title: 'Review this attached fixture', status: 'running', sourceKind: 'api', createdAt, updatedAt: createdAt});
  await page.route('**/api/v1/conversations?**', route => route.fulfill({json: {items: submissions.length ? [summary()] : []}}));
  await page.route(`**/api/v1/conversations/${id}`, route => route.fulfill({json: {
    ...summary(), activeRunId: 'run-retry', transcript: {messages: [{role: 'user', content: 'Review this attached fixture'}], compactedMessages: 0},
  }}));
  await page.route('**/api/v1/conversations/*/artifacts', route => route.fulfill({json: {files: []}}));
  await page.route('**/api/v1/runs', async route => {
    const request = route.request();
    submissions.push({key: request.headers()['idempotency-key'], body: request.postDataJSON()});
    await route.fulfill(submissions.length === 1
      ? {status: 502, json: {error: {message: 'Response lost after acceptance'}}}
      : {status: 202, json: {runId: 'run-retry', status: 'queued', createdAt: new Date().toISOString()}});
  });
  await page.route('**/api/v1/runs/run-retry**', route => route.fulfill({json: {runId: 'run-retry', status: 'queued', createdAt: new Date().toISOString(), events: [], ready: false}}));
  await page.goto(consoleUrl);
  await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');
  await expect(page.getByRole('textbox', {name: 'Message', exact: true})).toBeEnabled();
  await page.getByRole('textbox', {name: 'Message', exact: true}).fill('Review this attached fixture');
  await page.locator('#file-input').setInputFiles({name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('retry fixture')});
  await page.getByRole('button', {name: 'Send message'}).click();
  await expect(page.locator('#notice')).toContainText('Response lost');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');
  await expect(page.getByRole('heading', {name: 'Review this attached fixture', exact: true})).toBeVisible();
  await expect(page.getByRole('textbox', {name: 'Message', exact: true})).toHaveValue('Review this attached fixture');
  await expect(page.locator('.composer-attachment')).toContainText('notes.txt');
  await page.getByRole('button', {name: 'Send message'}).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0]?.body.thread.key).toMatch(/^thread-[0-9a-f-]{36}$/);
  await expect(page.getByRole('textbox', {name: 'Message', exact: true})).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Review this attached fixture', exact: true})).toBeVisible();
  await expect(page.getByRole('textbox', {name: 'Message', exact: true})).toHaveValue('');
});

test('keeps tracking the first accepted Run before the conversation projects its active Run', async ({page}) => {
  let body: any;
  let projected = false;
  const id = 'f'.repeat(64);
  const createdAt = new Date().toISOString();
  const summary = () => ({conversationId: id, threadKey: body?.thread.key, title: 'First accepted task',
    status: 'running', sourceKind: 'api', createdAt, updatedAt: createdAt});
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/conversations') return route.fulfill({json: {items: body ? [summary()] : []}});
    if (path.endsWith('/artifacts')) return route.fulfill({json: {files: []}});
    if (path === `/api/v1/conversations/${id}`) return route.fulfill({json: {
      ...summary(), ...(projected ? {activeRunId: 'run-first'} : {}),
      transcript: {messages: [{role: 'user', content: 'First accepted task'}], compactedMessages: 0},
    }});
    if (path === '/api/v1/runs') {
      body = route.request().postDataJSON();
      return route.fulfill({status: 202, json: {runId: 'run-first', status: 'queued', createdAt}});
    }
    if (path.endsWith('/events')) return route.fulfill({json: {events: [], pendingRequests: [], ready: true}});
    if (path === '/api/v1/runs/run-first') return route.fulfill({json: {runId: 'run-first', status: 'running', createdAt}});
    return route.fulfill({json: {}});
  });
  await page.goto(consoleUrl);
  await page.getByRole('textbox', {name: 'Message', exact: true}).fill('First accepted task');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'First accepted task', exact: true})).toBeVisible();
  await expect(page.locator('#run-strip-title')).toHaveText('Agent is working');
  await expect(page.locator('#stop-run')).toBeVisible();
  projected = true;
  await page.reload();
  await expect(page.getByRole('heading', {name: 'First accepted task', exact: true})).toBeVisible();
  await expect(page.locator('#run-strip-title')).toHaveText('Agent is working');
});

test('uses runtime readiness and server timestamps, and freezes the final browser frame', async ({page}) => {
  let done = false;
  let ready = false;
  let computerReads = 0;
  const id = 'd'.repeat(64);
  const start = new Date(Date.now() - 75_000).toISOString();
  const summary = () => ({conversationId: id, threadKey: 'state-test', title: 'State test', status: done ? 'idle' : 'running', createdAt: start, updatedAt: new Date().toISOString(), sourceKind: 'api'});
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/conversations') return route.fulfill({json: {items: [summary()]}});
    if (path.endsWith('/artifacts')) return route.fulfill({json: {files: []}});
    if (path === `/api/v1/conversations/${id}`) return route.fulfill({json: {
      ...summary(), ...(!done ? {activeRunId: 'run-state'} : {}),
      executionPolicy: {capabilities: {computerUse: 'browser'}},
      transcript: {messages: [{role: 'user', content: 'Check state'}, ...(done ? [{role: 'assistant', content: 'Done'}] : [])], compactedMessages: 0},
    }});
    if (path.endsWith('/events')) return route.fulfill({json: {events: [], pendingRequests: [], ready}});
    if (path.endsWith('/computer')) {
      computerReads += 1;
      return route.fulfill({json: {...computerSnapshot(), runId: 'run-state', control: 'agent'}});
    }
    if (path === '/api/v1/runs/run-state') return route.fulfill({json: {
      runId: 'run-state', status: done ? 'succeeded' : 'running', createdAt: start, updatedAt: new Date().toISOString(),
    }});
    return route.fulfill({json: {}});
  });
  await page.goto(consoleUrl);
  await expect(page.locator('#run-strip-title')).toHaveText('Starting isolated environment');
  await expect(page.locator('#status-badge')).toHaveText('Starting');
  await expect(page.locator('#run-strip-elapsed')).toHaveText(/^1m /);
  await expect(page.getByLabel('Isolated browser')).toBeChecked();
  await expect(page.getByLabel('Isolated browser')).toBeDisabled();
  await page.reload();
  await expect(page.locator('#run-strip-elapsed')).toHaveText(/^1m /);
  ready = true;
  await expect(page.locator('#status-badge')).toHaveText('Working');
  await page.getByRole('button', {name: 'Open computer', exact: true}).click();
  await expect(page.locator('#computer-screen')).toBeVisible();
  done = true;
  await expect(page.locator('#computer-owner-label')).toHaveText('Final browser frame');
  await expect(page.getByRole('button', {name: 'Take control', exact: true})).toBeDisabled();
  await expect(page.locator('#computer-loading')).toBeHidden();
  const finalReads = computerReads;
  await page.waitForTimeout(2_500);
  expect(computerReads).toBe(finalReads);
});

test('manages verified connections and durable routines from the product navigation', async ({ page }) => {
  await page.goto(consoleUrl);
  await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');

  await page.getByRole('button', { name: 'Connections' }).click();
  await expect(page.getByRole('heading', { name: 'Connected services' })).toBeVisible();
  const slack = page.locator('.management-card').filter({ hasText: 'slack-work ·' });
  await expect(slack).toContainText('Rat access read-only');
  await expect(slack).toContainText('Health not tested');
  await slack.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(slack).toContainText('Healthy');
  await slack.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByRole('dialog', { name: 'Slack Workspace' })).toContainText('Credentials stay in the host-side vault');
  await expect(page.getByRole('dialog', { name: 'Slack Workspace' })).toContainText('Support triage');
  await expect(page.getByRole('dialog', { name: 'Slack Workspace' })).toContainText('Post message');
  await page.getByLabel('Display name').fill('Acme support Slack');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('heading', { name: 'Acme support Slack' })).toBeVisible();
  const reconnectPopupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  const reconnectPopup = await reconnectPopupPromise;
  await reconnectPopup.close();
  await expect(page.getByRole('dialog', { name: 'Acme support Slack' })).toBeHidden();
  expect(state.oauthReconnects).toBe(1);
  expect(state.connections[0]?.grant.preset).toBe('read-only');
  await expect(slack).toContainText('Acme support Slack');
  page.once('dialog', (dialog) => void dialog.accept());
  await slack.getByRole('button', { name: 'Enable mentions' }).click();
  await expect(slack).toContainText('mentions on');
  await expect(slack.getByRole('button', { name: 'Mentions enabled' })).toBeDisabled();
  const secondarySlack = page.locator('.management-card').filter({ hasText: 'slack-secondary ·' });
  await expect(secondarySlack).toContainText('mentions use another connection');
  await expect(
    secondarySlack.getByRole('button', { name: 'Another connection handles mentions' }),
  ).toBeDisabled();
  await slack.getByLabel('Rat access for slack-work').selectOption('read-write');
  await expect(slack).toContainText('Rat access read-write');

  const stripe = page.locator('.management-card').filter({ hasText: 'Stripe payments and billing' });
  await stripe.getByRole('button', { name: 'Secret API key' }).click();
  await page.getByLabel('Secret key').fill('sk_test_console_fixture');
  await page.getByLabel('Connection name').fill('stripe-shop');
  await page.getByRole('button', { name: 'Verify & connect' }).click();
  const stripeAccount = page.locator('.management-card').filter({ hasText: 'Fixture Shop' });
  await expect(stripeAccount).toContainText('stripe-shop');
  await stripeAccount.getByRole('button', { name: 'Details' }).click();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  const reconnectDialog = page.getByRole('dialog', { name: 'Reconnect Fixture Shop' });
  await expect(reconnectDialog).toBeVisible();
  await expect(reconnectDialog.getByLabel('Connection name')).toBeHidden();
  await expect(reconnectDialog.getByLabel('Rat access')).toBeHidden();
  await reconnectDialog.getByLabel('Secret key').fill('sk_test_console_reconnected');
  await page.getByRole('button', { name: 'Verify & reconnect' }).click();
  await expect(stripeAccount).toContainText('Healthy');
  if (process.env.RAT_THINGS_CONSOLE_SCREENSHOTS === 'on') {
    await page.screenshot({ path: 'test-results/rat-things-console-connections.png' });
  }

  const slackProvider = page.locator('.management-card').filter({ hasText: 'Slack messages and reactions' });
  const popupPromise = page.waitForEvent('popup');
  await slackProvider.getByRole('button', { name: 'Connect with Slack' }).click();
  const popup = await popupPromise;
  await popup.close();
  expect(state.oauthStarts).toBe(1);

  const connectionSearch = page.getByLabel('Search connections');
  await connectionSearch.fill('refund');
  await expect(stripe).toBeVisible();
  await expect(slack).toBeHidden();
  await connectionSearch.fill('');

  await page.getByRole('button', { name: 'Routines' }).click();
  await expect(page.getByRole('heading', { name: 'Routines', exact: true })).toBeVisible();
  const daily = page.locator('.management-card').filter({ hasText: 'Daily account health' });
  await daily.getByRole('button', { name: 'Pause' }).click();
  await expect(page.locator('.management-card').filter({ hasText: 'Daily account health' })).toContainText('Paused');

  await page.getByRole('button', { name: 'New routine' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Weekly billing review');
  await page.getByLabel('Instructions').fill('Review billing anomalies and return a linked summary.');
  await page.getByLabel('Repeat every').fill('10080');
  await page.getByRole('button', { name: 'Create routine' }).click();
  const weekly = page.locator('.management-card').filter({ hasText: 'Weekly billing review' });
  await expect(weekly).toContainText('Every 1 week');
  if (process.env.RAT_THINGS_CONSOLE_SCREENSHOTS === 'on') {
    await page.screenshot({ path: 'test-results/rat-things-console-routines.png' });
  }
  await weekly.getByRole('button', { name: 'Run now' }).click();
  expect(state.routineRuns).toBe(1);
  page.once('dialog', (dialog) => void dialog.accept());
  await weekly.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.management-card').filter({ hasText: 'Weekly billing review' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Conversations' }).click();
  await expect(page.locator('#transcript')).toBeVisible();
  await expect(page.locator('#management-view')).toBeHidden();
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

  if (request.method === 'GET' && url.pathname === '/v1/integrations/plugins') {
    return sendJson(response, 200, { plugins: integrationPlugins() });
  }
  if (request.method === 'GET' && url.pathname === '/v1/integrations/connections') {
    return sendJson(response, 200, { connections: state.connections });
  }
  if (request.method === 'GET' && url.pathname === '/v1/integrations/connection-sets') {
    return sendJson(response, 200, { connectionSets: state.connectionSets });
  }
  if (request.method === 'POST' && url.pathname === '/v1/integrations/connection-sets') {
    const body = await readJson(request) as Record<string, unknown>;
    const { connections, ...rest } = body;
    const set = {
      ...rest,
      version: '1',
      ownerId,
      connectionSetId: `set-${state.connectionSets.length + 1}`,
      connectionIds: connections,
    };
    state.connectionSets.push(set);
    return sendJson(response, 201, set);
  }
  if (request.method === 'GET' && url.pathname === '/v1/integrations/source-bindings') {
    return sendJson(response, 200, { sourceBindings: state.sourceBindings });
  }
  if (request.method === 'POST' && url.pathname === '/v1/integrations/source-bindings') {
    const body = await readJson(request) as Record<string, unknown>;
    const binding = {
      ...body,
      version: '1',
      ownerId,
      bindingId: `binding-${state.sourceBindings.length + 1}`,
    };
    state.sourceBindings.push(binding);
    return sendJson(response, 201, binding);
  }
  if (request.method === 'POST' && url.pathname === '/v1/integrations/oauth/authorizations') {
    const body = await readJson(request) as { pluginId?: string };
    if (body.pluginId !== 'slack') throw new Error('unexpected OAuth plugin');
    state.oauthStarts += 1;
    return sendJson(response, 201, {
      version: '1',
      pluginId: 'slack',
      authorizationUrl: 'https://provider.example.test/oauth?state=console-fixture-state',
      callbackUrl: 'https://api.example.test/v1/integrations/oauth/callback',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  }
  if (request.method === 'POST' && url.pathname === '/v1/integrations/connections') {
    const body = await readJson(request) as {
      pluginId?: string;
      alias?: string;
      credential?: Record<string, unknown>;
      grant?: { preset?: string };
    };
    if (body.pluginId !== 'stripe' || body.credential?.api_key !== 'sk_test_console_fixture') {
      throw new Error('unexpected manual connection');
    }
    const bundle = connectionBundle(
      'connection-stripe',
      body.alias ?? 'stripe-fixture-shop',
      'Fixture Shop',
      'stripe',
      body.grant?.preset ?? 'read-only',
    );
    state.connections.push(bundle);
    return sendJson(response, 201, bundle);
  }
  const connectionReconnectMatch = url.pathname.match(
    /^\/v1\/integrations\/connections\/([^/]+)\/oauth\/reconnect$/,
  );
  if (request.method === 'POST' && connectionReconnectMatch) {
    const bundle = state.connections.find(
      (item) => item.connection.connectionId === connectionReconnectMatch[1],
    );
    if (!bundle) throw new Error('connection not found');
    state.oauthReconnects += 1;
    bundle.connection.updatedAt = new Date(Date.now() + state.oauthReconnects * 1_000).toISOString();
    bundle.connection.status = 'active';
    bundle.health = {
      version: '1',
      ownerId,
      connectionId: bundle.connection.connectionId,
      status: 'healthy',
      code: 'verified',
      checkedAt: bundle.connection.updatedAt,
    };
    return sendJson(response, 201, {
      version: '1',
      pluginId: bundle.connection.pluginId,
      connectionId: bundle.connection.connectionId,
      authorizationUrl: 'https://slack.example/authorize?state=reconnect',
      callbackUrl: `${controlUrl}/v1/integrations/oauth/callback`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
  }
  const connectionDetailMatch = url.pathname.match(/^\/v1\/integrations\/connections\/([^/]+)$/);
  if (connectionDetailMatch && (request.method === 'GET' || request.method === 'PATCH')) {
    const selector = decodeURIComponent(connectionDetailMatch[1] ?? '');
    const bundle = state.connections.find((item) => (
      item.connection.connectionId === selector || item.connection.alias === selector
    ));
    if (!bundle) throw new Error('connection not found');
    if (request.method === 'PATCH') {
      const body = await readJson(request) as { displayName?: string };
      bundle.connection.displayName = body.displayName;
      bundle.connection.updatedAt = new Date().toISOString();
      return sendJson(response, 200, bundle.connection);
    }
    return sendJson(response, 200, bundle);
  }
  const connectionTestMatch = url.pathname.match(/^\/v1\/integrations\/connections\/([^/]+)\/test$/);
  if (request.method === 'POST' && connectionTestMatch) {
    const bundle = state.connections.find((item) => item.connection.connectionId === connectionTestMatch[1]);
    if (!bundle) throw new Error('connection not found');
    bundle.health = {
      version: '1',
      ownerId,
      connectionId: bundle.connection.connectionId,
      status: 'healthy',
      code: 'verified',
      checkedAt: new Date().toISOString(),
    };
    return sendJson(response, 200, { connection: bundle.connection, health: bundle.health });
  }
  const connectionCredentialMatch = url.pathname.match(
    /^\/v1\/integrations\/connections\/([^/]+)\/credential$/,
  );
  if (request.method === 'POST' && connectionCredentialMatch) {
    const body = await readJson(request) as { credential?: { api_key?: string } };
    if (body.credential?.api_key !== 'sk_test_console_reconnected') {
      throw new Error('unexpected replacement credential');
    }
    const bundle = state.connections.find(
      (item) => item.connection.connectionId === connectionCredentialMatch[1],
    );
    if (!bundle) throw new Error('connection not found');
    bundle.connection.status = 'active';
    bundle.connection.updatedAt = new Date().toISOString();
    bundle.health = {
      version: '1', ownerId, connectionId: bundle.connection.connectionId,
      status: 'healthy', code: 'verified', checkedAt: bundle.connection.updatedAt,
    };
    return sendJson(response, 200, { connection: bundle.connection, health: bundle.health });
  }
  const connectionConsumersMatch = url.pathname.match(/^\/v1\/integrations\/connections\/([^/]+)\/consumers$/);
  if (request.method === 'GET' && connectionConsumersMatch) {
    return sendJson(response, 200, {
      version: '1',
      connectionId: connectionConsumersMatch[1],
      complete: true,
      consumers: [{
        kind: 'thing',
        id: 'thing-support',
        name: 'Support triage',
        status: 'active',
        stage: 'active',
      }],
    });
  }
  const connectionGrantMatch = url.pathname.match(/^\/v1\/integrations\/connections\/([^/]+)\/grant$/);
  if (request.method === 'POST' && connectionGrantMatch) {
    const body = await readJson(request) as { version?: string; preset?: string };
    const bundle = state.connections.find((item) => item.connection.connectionId === connectionGrantMatch[1]);
    if (!bundle) throw new Error('connection not found');
    bundle.grant.preset = body.preset;
    return sendJson(response, 200, bundle.grant);
  }
  const connectionRevokeMatch = url.pathname.match(/^\/v1\/integrations\/connections\/([^/]+)\/revoke$/);
  if (request.method === 'POST' && connectionRevokeMatch) {
    const bundle = state.connections.find((item) => item.connection.connectionId === connectionRevokeMatch[1]);
    if (!bundle) throw new Error('connection not found');
    bundle.connection.status = 'revoked';
    return sendJson(response, 200, bundle.connection);
  }
  if (request.method === 'GET' && url.pathname === '/v1/routines') {
    return sendJson(response, 200, { items: state.routines.filter((routine) => routine.status !== 'deleted') });
  }
  if (request.method === 'POST' && url.pathname === '/v1/routines') {
    const body = await readJson(request) as {
      name?: string;
      enabled?: boolean;
      schedule?: { everyMinutes?: number };
    };
    const routine = routineFixture(
      `routine-${state.routines.length + 1}`,
      body.name ?? 'Untitled routine',
      body.enabled === false ? 'paused' : 'enabled',
      body.schedule?.everyMinutes ?? 60,
    );
    state.routines.push(routine);
    return sendJson(response, 201, routine);
  }
  const routineActionMatch = url.pathname.match(/^\/v1\/routines\/([^/]+)\/(run|pause|resume|delete)$/);
  if (request.method === 'POST' && routineActionMatch) {
    const routine = state.routines.find((item) => item.routineId === routineActionMatch[1]);
    if (!routine) throw new Error('routine not found');
    const operation = routineActionMatch[2];
    if (operation === 'run') {
      state.routineRuns += 1;
      return sendJson(response, 202, {
        runId: `run-routine-${state.routineRuns}`,
        status: 'queued',
        createdAt,
        updatedAt: createdAt,
        expiresAt: 1_800_000_000,
        sourceKind: 'api',
      });
    }
    routine.status = operation === 'pause' ? 'paused' : operation === 'resume' ? 'enabled' : 'deleted';
    routine.updatedAt = new Date().toISOString();
    return sendJson(response, 200, routine);
  }

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
    threadKey = (state.submission as {thread: {key: string}}).thread.key;
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
    const status = state.runReads >= 2 && !state.computerJourneyDone
      ? 'running'
      : statuses[Math.min(state.runReads, statuses.length - 1)]!;
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
  if (request.method === 'GET' && url.pathname === `/v1/runs/${runId}/computer`) {
    state.computerReads += 1;
    if (state.computerReads === 1) {
      return sendJson(response, 502, {
        error: { code: 'computer_starting', message: 'control endpoint returned HTTP 502' },
      });
    }
    return sendJson(response, 200, computerSnapshot());
  }
  if (request.method === 'POST' && url.pathname === `/v1/runs/${runId}/computer/takeover`) {
    const body = await readJson(request) as { control: 'agent' | 'human' };
    state.computerControl = body.control;
    if (body.control === 'agent') state.computerJourneyDone = true;
    return sendJson(response, 200, {
      version: '1',
      runId,
      control: state.computerControl,
      ...(state.computerControl === 'human' ? { takeover: takeoverWindow() } : {}),
    });
  }
  if (request.method === 'POST' && url.pathname === `/v1/runs/${runId}/computer/action`) {
    const body = await readJson(request) as { action: unknown };
    state.computerActions.push(body.action);
    if (state.teachRecording) state.teachSteps += 1;
    return sendJson(response, 200, computerSnapshot());
  }
  if (request.method === 'POST' && url.pathname === `/v1/runs/${runId}/computer/teach`) {
    const body = await readJson(request) as { action: 'start' | 'stop'; discard?: boolean };
    if (body.action === 'start') {
      state.teachRecording = true;
      state.teachSteps = 0;
      return sendJson(response, 200, computerSnapshot());
    }
    state.teachRecording = false;
    return sendJson(response, body.discard ? 200 : 201, body.discard ? {
      recording: teachRecording(true),
    } : {
      recording: teachRecording(false),
      thing: {
        version: '1',
        thingId: 'thing-taught-console-e2e',
        status: 'draft',
        draft: { revision: 1, name: 'Submit weekly report' },
      },
    });
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

function integrationPlugins(): Array<Record<string, unknown>> {
  return [
    {
      id: 'slack',
      version: '1',
      title: 'Slack',
      description: 'Slack messages and reactions',
      authentication: [{
        scheme: 'oauth2',
        title: 'Install with Slack OAuth',
        fields: [
          { key: 'access_token', label: 'Access token', secret: true },
          { key: 'refresh_token', label: 'Refresh token', secret: true, computed: true, required: false },
        ],
        oauth2: {
          authorizationUrl: 'https://provider.example.test/authorize',
          tokenUrl: 'https://provider.example.test/token',
          scopes: ['chat:write'],
          tokenEndpointAuthMethod: 'client-secret-post',
        },
      }],
      oauthInstallation: {
        status: 'configured',
        callbackUrl: 'https://api.example.test/v1/integrations/oauth/callback',
      },
      operations: [
        { id: 'slack.messages.post', title: 'Post message', kind: 'action', access: 'write', risk: 'consequential' },
        { id: 'slack.reactions.add', title: 'Add reaction', kind: 'action', access: 'write', risk: 'routine' },
      ],
    },
    {
      id: 'stripe',
      version: '1',
      title: 'Stripe',
      description: 'Stripe payments and billing',
      authentication: [{
        scheme: 'api-key',
        title: 'Secret API key',
        fields: [{ key: 'api_key', label: 'Secret key', secret: true }],
      }],
      operations: [
        { id: 'stripe.customers.search', title: 'Search customers', kind: 'search', access: 'read', risk: 'routine' },
        { id: 'stripe.invoices.list', title: 'List invoices', kind: 'search', access: 'read', risk: 'routine' },
        { id: 'stripe.refunds.create', title: 'Create refund', kind: 'action', access: 'write', risk: 'destructive' },
      ],
    },
  ];
}

function connectionBundle(
  connectionId: string,
  alias: string,
  label: string,
  pluginId: string,
  preset: string,
): Record<string, any> {
  return {
    connection: {
      version: '1',
      connectionId,
      ownerId,
      pluginId,
      alias,
      label,
      authorization: {
        scheme: pluginId === 'slack' ? 'oauth2' : 'api-key',
        access: 'full',
        scopeModel: pluginId === 'slack' ? 'granular' : 'unknown',
        scopes: pluginId === 'slack' ? ['chat:write'] : [],
      },
      status: 'active',
      ...(pluginId === 'slack' ? { externalTenantId: 'T0BTAANBY9H', externalSubjectId: 'U0RATBOT' } : {}),
      createdAt,
      updatedAt: createdAt,
    },
    grant: {
      version: '1',
      grantId: `grant-${connectionId}`,
      ownerId,
      connectionId,
      preset,
    },
    health: {
      version: '1',
      ownerId,
      connectionId,
      status: 'unknown',
      code: 'not-tested',
    },
  };
}

function routineFixture(
  routineId: string,
  name: string,
  status: 'enabled' | 'paused' | 'deleted',
  everyMinutes = 1_440,
): Record<string, any> {
  return {
    version: '1',
    routineId,
    name,
    status,
    schedule: { kind: 'interval', everyMinutes },
    nextRunAt: new Date(Date.now() + everyMinutes * 60_000).toISOString(),
    requestHash: 'f'.repeat(64),
    createdAt,
    updatedAt: createdAt,
  };
}

function conversationSummary(): Record<string, unknown> {
  return {
    conversationId,
    title: conversationName,
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
    title: conversationName,
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

function computerSnapshot(): Record<string, unknown> {
  return {
    version: '1',
    runId,
    available: true,
    control: state.computerControl,
    viewport: { width: 1280, height: 720 },
    observedAt: new Date().toISOString(),
    page: { url: 'https://example.com/report', title: 'Weekly report' },
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ...(state.computerControl === 'human' ? { takeover: takeoverWindow() } : {}),
    teach: state.teachRecording ? {
      state: 'recording',
      recordingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Submit weekly report',
      startedAt: new Date().toISOString(),
      maximumDurationMs: 600_000,
      demonstratedSteps: state.teachSteps,
    } : { state: 'idle' },
  };
}

function takeoverWindow(): Record<string, unknown> {
  return {
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

function teachRecording(discarded: boolean): Record<string, unknown> {
  return {
    version: '1',
    recordingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Submit weekly report',
    startedAt: createdAt,
    stoppedAt: new Date().toISOString(),
    demonstratedSteps: state.teachSteps,
    discarded,
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
