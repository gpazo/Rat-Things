import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { createAgentsClient } from '../src/agents-client.js';
import type { AgentSession } from '../src/domain/agents-api.js';

const enabled = process.env.AWS_E2E_CONSOLE === 'true';
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
let child: ChildProcess | undefined;
let consoleUrl = '';
let output = '';

test.describe('live AWS Session console', () => {
  test.skip(!enabled, 'Set AWS_E2E_CONSOLE=true for the opted-in AWS harness');
  test.beforeAll(async () => {
    if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Set AWS_E2E_REAL_CODEX=true to opt into the live model probe');
    required('RAT_THINGS_AGENTS_API_URL'); required('AWS_E2E_CODEX_MODEL_ID');
    child = spawn(process.execPath, ['--import', 'tsx', 'scripts/console-server.ts'], {
      env: { ...process.env, RAT_THINGS_CONSOLE_PORT: '0', RAT_THINGS_CONSOLE_LAUNCHER: '1', AGENT_RUNTIME_UNSIGNED: undefined, RAT_THINGS_LOCAL_OWNER: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await expect.poll(() => output.match(/"port":(\d+)/)?.[1]).toBeTruthy();
    consoleUrl = `http://127.0.0.1:${output.match(/"port":(\d+)/)![1]}`;
  });
  test.afterAll(() => { child?.kill('SIGTERM'); });
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) await info.attach('console-server.txt', { body: Buffer.from(output), contentType: 'text/plain' });
  });
  test('saves and reloads two real Turns in one Session', async ({ page }) => {
    test.setTimeout(timeoutMs * 2 + 60_000);
    const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region: required('AWS_REGION') });
    const marker = `console-${randomUUID()}`;
    let session: AgentSession | undefined;
    await page.goto(consoleUrl);
    await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');
    await page.locator('#new-resource').click();
    await page.getByLabel('Request JSON').fill(JSON.stringify({ agent: { model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] }, environment: { type: 'none' }, input: `Reply with exactly ${marker}`, metadata: { name: marker } }));
    const created = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/agents/sessions');
    await page.locator('#submit-editor').click();
    const response = await created;
    expect(response.ok()).toBe(true);
    session = await response.json() as AgentSession;
    try {
      await expect(page.locator('#turn-status')).toHaveText('Turn completed', { timeout: timeoutMs });
      await expect(page.locator('.item:not(.user)').filter({ hasText: marker })).toHaveCount(1);
      await page.getByLabel('Continue this session').fill(`Reply with exactly ${marker}-CONTINUED`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(async () => (await client.beta.agents.sessions.turns.list(session!.id)).data.filter((turn) => turn.status === 'completed').length, { timeout: timeoutMs }).toBe(2);
      await page.reload();
      await page.locator('.resource').filter({ hasText: marker }).click();
      await expect(page.locator('.item:not(.user)').filter({ hasText: `${marker}-CONTINUED` })).toHaveCount(1);
    } finally { await client.beta.agents.sessions.delete(session.id); }
  });
});
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
