import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { expect, test, type Page } from '@playwright/test';

const enabled = process.env.AWS_E2E_NVIDIA_DEMO === 'true';
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
const reportUrl = 'https://nvidianews.nvidia.com/news/' +
  'nvidia-announces-financial-results-for-second-quarter-fiscal-2027';
const threadKey = 'nvidia-q2-live-ux2';
const prompt = [
  'Read NVIDIA’s official earnings report published today, August 26, 2026, in the isolated browser.',
  `Open the official report at ${reportUrl}.`,
  'If its cookie banner appears, leave it for me to dismiss in the live view.',
  'Read the Q2 FY27 financial highlights and outlook, then keep the report open for about 45 seconds so I can follow along.',
  'After that, give me a concise factual summary covering revenue growth, Data Center, EPS, gross margin, Q3 outlook, and the China assumption.',
  'Include the official source URL and clearly say this is not investment advice.',
].join(' ');

let consoleProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
let consoleUrl = '';
let consoleOutput = '';

test.describe('live AWS NVIDIA earnings client demo', () => {
  test.skip(!enabled, 'set AWS_E2E_NVIDIA_DEMO=true against a fresh live AWS stack');

  test.beforeAll(async () => {
    test.setTimeout(timeoutMs);
    const consolePort = await availablePort();
    consoleUrl = `http://127.0.0.1:${consolePort}`;
    const tsx = resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    consoleProcess = spawn(tsx, ['scripts/console-server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RAT_THINGS_API_URL: required('RAT_THINGS_API_URL'),
        RAT_THINGS_CONSOLE_PORT: String(consolePort),
        AGENT_RUNTIME_UNSIGNED: undefined,
        RAT_THINGS_LOCAL_OWNER: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    consoleProcess.stdout.on('data', (chunk: Buffer) => { consoleOutput += chunk.toString(); });
    consoleProcess.stderr.on('data', (chunk: Buffer) => { consoleOutput += chunk.toString(); });
    await waitForConsole();
    await hideEarlierDemoConversations();
  });

  test.afterAll(async () => {
    await stopProcess(consoleProcess);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    await testInfo.attach('console-server-output.txt', {
      body: Buffer.from(consoleOutput),
      contentType: 'text/plain',
    });
    await testInfo.attach('client-view.txt', {
      body: Buffer.from(await page.locator('body').innerText().catch(() => 'page unavailable')),
      contentType: 'text/plain',
    });
  });

  test('records the client watching, taking over, and receiving the live earnings summary', async ({ page }) => {
    test.setTimeout(timeoutMs);
    await page.goto(consoleUrl);
    await page.setViewportSize({ width: 1_440, height: 900 });
    await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');
    await pause(page, 1_200);

    await page.getByRole('button', { name: 'New conversation' }).click();
    await page.locator('#thread-key').fill(threadKey);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('heading', { name: threadKey })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
    await page.locator('.composer-options summary').click();
    await page.getByLabel('Isolated browser').check();
    await pause(page, 1_600);

    const accepted = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/runs');
    await page.getByRole('button', { name: 'Send message' }).click();
    expect((await accepted).status()).toBe(202);
    await expect(page.locator('#transcript').getByText(prompt, { exact: true })).toBeVisible();
    await expect(page.locator('#run-progress')).toBeVisible();
    await expect(page.locator('#run-strip')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open computer' })).toBeVisible();
    await pause(page, 1_200);

    await page.locator('#watch-run').click();
    await expect(page.getByRole('heading', { name: 'Work context' })).toBeVisible();
    await expect(page.locator('#computer-screen')).toBeVisible({ timeout: timeoutMs - 90_000 });
    await expect(page.locator('#computer-url')).toHaveValue(/nvidianews\.nvidia\.com\/news\//, {
      timeout: timeoutMs - 90_000,
    });
    await expect(page.locator('#computer-owner-label')).toContainText('Rat has control');
    await pause(page, 5_000);

    const divider = await page.locator('#context-resizer').boundingBox();
    if (divider) {
      await page.mouse.move(divider.x + divider.width / 2, divider.y + 180);
      await page.mouse.down();
      await page.mouse.move(divider.x - 100, divider.y + 180, { steps: 12 });
      await page.mouse.up();
      await pause(page, 1_200);
    }

    await page.getByRole('button', { name: 'Take control' }).click();
    await expect(page.getByRole('button', { name: 'Return control' })).toBeVisible();
    await expect(page.locator('#computer-owner-label')).toHaveText('You have control');
    await expect(page.locator('#computer-lease-label')).toContainText('remaining');
    await pause(page, 2_000);
    await clickBrowserCoordinate(page, 878, 363);
    await pause(page, 2_400);
    await wheelBrowser(page, 620);
    await pause(page, 2_400);
    await wheelBrowser(page, 620);
    await pause(page, 2_400);
    await wheelBrowser(page, -520);
    await pause(page, 2_000);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await pause(page, 1_200);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await pause(page, 900);
    await page.getByRole('button', { name: 'Return control' }).click();
    await expect(page.getByRole('button', { name: 'Take control' })).toBeVisible();
    await pause(page, 1_800);
    await page.getByRole('tab', { name: /^Sources/ }).click();
    await expect(page.locator('#context-sources')).toContainText('nvidianews.nvidia.com');
    await pause(page, 2_000);
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(page.locator('#context-activity .phase-card').filter({ hasText: /browser|workspace|Rat started/i }).first()).toBeVisible();
    await pause(page, 2_600);
    await page.getByRole('button', { name: 'Close context pane' }).click();

    const assistant = page.locator('.message-row[data-role="assistant"]').last();
    await expect(assistant).toBeVisible({ timeout: timeoutMs - 60_000 });
    await expect(assistant).toContainText(/\$96\.2(?:B| billion)/, { timeout: 30_000 });
    await expect(assistant).toContainText(/\$89\.0(?:B| billion)/);
    await expect(assistant).toContainText(/\$108\.0(?:B| billion)/);
    await expect(assistant).toContainText('not investment advice', { ignoreCase: true });
    await expect(page.locator('#status-badge')).toHaveText('Ready');
    await pause(page, 2_500);

    const workDetails = page.locator('.work-details');
    if (!await workDetails.evaluate((node: HTMLDetailsElement) => node.open)) {
      await workDetails.locator(':scope > summary').click();
    }
    await expect(page.locator('.work-details > .work-activity .phase-card').filter({ hasText: /browser|workspace/i }).first()).toBeVisible();
    await pause(page, 3_800);
  });
});

async function pause(page: Page, milliseconds: number): Promise<void> {
  if (process.env.RAT_THINGS_CONSOLE_VIDEO === 'on') await page.waitForTimeout(milliseconds);
}

async function clickBrowserCoordinate(page: Page, x: number, y: number): Promise<void> {
  const screen = page.locator('#computer-screen');
  const box = await screen.boundingBox();
  if (!box) throw new Error('live browser screen is not visible');
  const viewport = await page.evaluate(() => {
    const image = document.querySelector('#computer-screen');
    if (!(image instanceof HTMLImageElement)) throw new Error('live browser screen is unavailable');
    return { width: image.naturalWidth || 1280, height: image.naturalHeight || 720 };
  });
  const scale = Math.min(box.width / viewport.width, box.height / viewport.height);
  const renderedWidth = viewport.width * scale;
  const renderedHeight = viewport.height * scale;
  await page.mouse.click(
    box.x + (box.width - renderedWidth) / 2 + x * scale,
    box.y + (box.height - renderedHeight) / 2 + y * scale,
  );
}

async function wheelBrowser(page: Page, deltaY: number): Promise<void> {
  const screen = page.locator('#computer-screen');
  const box = await screen.boundingBox();
  if (!box) throw new Error('live browser screen is not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

async function hideEarlierDemoConversations(): Promise<void> {
  const response = await consoleJson<{ items?: Array<{ conversationId?: string; threadKey?: string }> }>(
    '/api/v1/conversations?limit=100',
  );
  for (const item of response.items ?? []) {
    if (!item.conversationId || !item.threadKey?.startsWith('nvidia-')) continue;
    await consoleJson(`/api/v1/conversations/${encodeURIComponent(item.conversationId)}/organization`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rat-console-request': '1',
      },
      body: JSON.stringify({ hidden: true }),
    });
  }
}

async function consoleJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${consoleUrl}${path}`, init);
  const body = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `console request returned HTTP ${response.status}`);
  return body;
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
      // The signed loopback proxy is still starting.
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
  if (!value) throw new Error(`${name} is required for the live AWS NVIDIA demo`);
  return value;
}
