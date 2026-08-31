import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { expect, test, type Page } from '@playwright/test';

const enabled = process.env.AWS_E2E_LINEAR_DEMO === 'true';
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
const recording = process.env.RAT_THINGS_CONSOLE_VIDEO === 'on';
const screenshotDirectory = process.env.AWS_E2E_LINEAR_SCREENSHOT_DIR;

let consoleProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
let consoleUrl = '';
let consoleOutput = '';

test.describe('live AWS Linear demo', () => {
  test.skip(!enabled, 'set AWS_E2E_LINEAR_DEMO=true through the Linear demo script');

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
  });

  test.afterAll(async () => {
    await stopProcess(consoleProcess);
  });

  test('shows the verified Linear account and completed bounded Run', async ({ page }) => {
    test.setTimeout(timeoutMs);
    const alias = required('AWS_E2E_LINEAR_CONNECTION_ALIAS');
    const marker = required('AWS_E2E_LINEAR_MARKER');
    const promptSnippet = process.env.AWS_E2E_LINEAR_PROMPT_SNIPPET ?? 'Call team-list exactly once';
    const readOnlyPromptSnippet = process.env.AWS_E2E_LINEAR_READ_ONLY_PROMPT_SNIPPET
      ?? 'Confirm that issue creation is unavailable';

    await page.goto(consoleUrl);
    await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');
    await demoPause(page, 1_200);

    await page.getByRole('button', { name: 'Connections' }).click();
    await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
    const linear = page.locator('.management-card').filter({ hasText: alias });
    await expect(linear).toContainText('Indubitably — Rat Things');
    await expect(linear).toContainText('Healthy');
    await linear.scrollIntoViewIfNeeded();
    await screenshot(page, 'linear-live-connection.png');
    await demoPause(page, 1_600);

    await linear.getByRole('button', { name: 'Details' }).click();
    const details = page.getByRole('dialog');
    await expect(details).toContainText('Credentials stay in the host-side vault');
    await expect(details).toContainText(/read-write/i);
    await screenshot(page, 'linear-live-connection-details.png');
    await demoPause(page, 1_800);
    await page.locator('#connection-detail-cancel').click();

    await page.getByRole('button', { name: 'Conversations' }).click();
    const search = page.getByPlaceholder('Search conversations');
    await search.fill(marker);
    const result = page.locator('.conversation-search-result')
      .filter({ hasText: marker })
      .filter({ hasText: promptSnippet })
      .first();
    await expect(result).toBeVisible();
    await result.locator('.conversation-item').click();
    await expect(page.locator('#transcript')).toContainText(marker);
    await expect(page.locator('#transcript')).toContainText(/IND-\d+/);
    await search.fill('');

    const work = page.locator('.work-details');
    if (await work.count() > 0 && !await work.evaluate((node: HTMLDetailsElement) => node.open)) {
      await work.locator('summary').click();
    }
    await expect(page.locator('#status-badge')).toHaveText('Ready');
    await screenshot(page, 'linear-live-write-run.png');
    await demoPause(page, 3_200);

    await search.fill(readOnlyPromptSnippet);
    const readOnly = page.locator('.conversation-search-result')
      .filter({ hasText: marker })
      .filter({ hasText: readOnlyPromptSnippet })
      .first();
    await expect(readOnly).toBeVisible();
    await readOnly.locator('.conversation-item').click();
    await expect(page.locator('#transcript')).toContainText(marker);
    await expect(page.locator('#transcript')).toContainText(/Issue creation is unavailable/i);
    await search.fill('');
    await screenshot(page, 'linear-live-read-only.png');
    await demoPause(page, 2_400);
  });
});

async function screenshot(page: Page, name: string): Promise<void> {
  if (!screenshotDirectory) return;
  await page.screenshot({ path: resolve(screenshotDirectory, name), fullPage: false });
}

async function demoPause(page: Page, milliseconds: number): Promise<void> {
  if (recording) await page.waitForTimeout(milliseconds);
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
  if (!value) throw new Error(`${name} is required for the live AWS Linear demo`);
  return value;
}
