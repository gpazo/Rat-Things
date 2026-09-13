import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { expect, test, type Page } from '@playwright/test';
import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import { AgentService } from '../src/core/agent-service.js';
import { SessionService } from '../src/core/session-service.js';
import { VaultService } from '../src/core/vault-service.js';
import { EnvironmentTemplateService } from '../src/core/environment-template-service.js';
import type { SessionExecution, SessionTurnObservation } from '../src/core/session-ports.js';
import type { AgentSessionItem } from '../src/domain/agents-api.js';
import { routeAgentsRequest } from '../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from '../tests/agents/fixtures.js';

const owner = 'console-owner';
const store = new MemoryAgentsStore();
const secrets = new Map<string, CredentialAuthCreateParam>();
const observations = new Map<string, SessionTurnObservation>();
const output = new Map<string, AgentSessionItem[]>();
const received: Array<{ path: string; method: string; body?: unknown; key?: string | null }> = [];
const execution: SessionExecution = {
  prepare: async (_owner, _id, environment) => {
    if (environment.type !== 'none') throw new Error('This fixture uses no environment');
    return environment;
  },
  start: async (_owner, _session, binding) => {
    if (!observations.has(binding.turn.id)) observations.set(binding.turn.id, { turn: { ...binding.turn, started_at: binding.turn.created_at, status: 'in_progress' }, requiredActions: [] });
  },
  steer: async () => {},
  cancel: async (_owner, _session, id) => {
    const current = observations.get(id)!;
    observations.set(id, { turn: { ...current.turn, status: 'cancelled', completed_at: Math.floor(Date.now() / 1000) }, requiredActions: [] });
  },
  toolResult: async (_owner, _session, event) => {
    const current = observations.get(event.turn_id)!;
    observations.set(event.turn_id, { turn: { ...current.turn, status: 'in_progress' }, requiredActions: [] });
  },
  observe: async (_owner, _session, turn) => observations.get(turn.id) ?? { turn, requiredActions: [] },
  items: async (_owner, _session, id) => output.get(id) ?? [],
  artifacts: async () => [],
  artifactContent: async () => new ReadableStream({ start(controller) { controller.close(); } }),
};
const agents = new AgentService({ store });
const sessions = new SessionService({ store, agents, execution, streamIntervalMs: 20 });
const templates = new EnvironmentTemplateService({ store });
const vaults = new VaultService({ store, secrets: {
  create: async (_owner, id, auth) => { const ref = `${id}/${crypto.randomUUID()}`; secrets.set(ref, structuredClone(auth)); return ref; },
  read: async (ref) => structuredClone(secrets.get(ref)!),
  revoke: async (ref) => { secrets.delete(ref); },
} });
let server: Server;
let consoleProcess: ChildProcess;
let consoleUrl: string;
let processOutput = '';

test.beforeAll(async () => {
  server = createServer((request, response) => void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    const input = new Request(`http://127.0.0.1${request.url}`, { method: request.method ?? 'GET', headers: request.headers as Record<string, string>, ...(body ? { body } : {}), signal: abort.signal });
    received.push({ path: new URL(input.url).pathname, method: input.method, ...(body ? { body: JSON.parse(body) } : {}), key: input.headers.get('idempotency-key') });
    const result = await routeAgentsRequest(input, request.headers['x-runtime-owner'] === owner ? owner : '', { agents, sessions, vaults, templates });
    const headers: Record<string, string> = {};
    result.headers.forEach((value, key) => { headers[key] = value; });
    response.writeHead(result.status, headers);
    response.flushHeaders();
    if (result.body) await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), response);
    else response.end();
  })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The launcher chooses a free port if the preferred one is occupied.
  consoleProcess = spawn(process.execPath, ['--import', 'tsx', 'scripts/console-server.ts'], {
    env: { ...process.env, AGENTS_API_BASE_URL: controlUrl, RAT_THINGS_CONSOLE_LAUNCHER: '1', RAT_THINGS_LOCAL_OWNER: owner, AGENT_RUNTIME_UNSIGNED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  consoleProcess.stdout!.on('data', (chunk: Buffer) => { processOutput += chunk.toString(); });
  consoleProcess.stderr!.on('data', (chunk: Buffer) => { processOutput += chunk.toString(); });
  await expect.poll(() => processOutput.match(/"port":(\d+)/)?.[1]).toBeTruthy();
  consoleUrl = `http://127.0.0.1:${processOutput.match(/"port":(\d+)/)![1]}`;
});
test.afterAll(async () => {
  consoleProcess?.kill('SIGTERM');
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});
test.beforeEach(() => { store.resources.clear(); observations.clear(); secrets.clear(); output.clear(); received.length = 0; });

async function submitEditor(page: Page, value: unknown) {
  await page.getByLabel('Request JSON').fill(JSON.stringify(value));
  await page.locator('#submit-editor').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}

test('uses canonical sessions, restores streamed output, submits results, and cancels a new turn', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(consoleUrl);
  await expect(page.locator('html')).toHaveAttribute('data-console-ready', 'true');
  await page.locator('#new-resource').click();
  await submitEditor(page, { agent: { model: 'fixture-model' }, environment: { type: 'none' }, input: 'Review this change', metadata: { name: 'Release review' } });
  await expect(page.getByRole('heading', { name: 'Release review', exact: true })).toBeVisible();
  const session = (await sessions.list(owner)).data[0]!;
  await sessions.dispatch(owner, session.id);
  const turn = (await sessions.turns(owner, session.id)).data[0]!;
  await expect(page.locator('#turn-status')).toHaveText('Turn in progress');
  output.set(turn.id, [{ id: 'output-one', type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', turn_id: turn.id, content: [{ type: 'output_text', text: 'Inspecting the **change**. [Unsafe](javascript:alert%281%29) <img src="https://invalid.test/tracker">' }] }]);
  await expect(page.locator('#transcript strong')).toHaveText('change');
  await expect(page.locator('#transcript a')).toHaveCount(0);
  await expect(page.locator('#transcript img')).toHaveCount(0);
  await page.getByLabel('Continue this session').fill('Include the deployment configuration.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await sessions.dispatch(owner, session.id);
  await expect(page.locator('#transcript')).toContainText('Include the deployment configuration.');
  observations.set(turn.id, { turn: { ...observations.get(turn.id)!.turn, status: 'waiting' }, requiredActions: [{ type: 'function_call', name: 'lookup', arguments: { name: 'release' }, call_id: 'call-lookup', turn_id: turn.id }] });
  await expect(page.getByLabel('Result for lookup')).toBeVisible();
  // Empty output is a legitimate function result.
  await page.getByRole('button', { name: 'Send tool result' }).click();
  await expect.poll(() => received.some((request) => (JSON.stringify(request.body) ?? "").includes('agent.session.input.tool_result'))).toBe(true);
  await sessions.dispatch(owner, session.id);
  await expect(page.getByLabel('Result for lookup')).toHaveCount(0);
  const toolRequest = received.find((request) => (JSON.stringify(request.body) ?? "").includes('agent.session.input.tool_result'))!;
  expect(toolRequest.body).toEqual({ events: [{ type: 'agent.session.input.tool_result', turn_id: turn.id, call_id: 'call-lookup', output: '', success: true }] });
  expect(toolRequest.key).toBeTruthy();
  output.set(turn.id, [...output.get(turn.id)!, { id: 'output-final', type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', turn_id: turn.id, content: [{ type: 'output_text', text: 'Review complete.\n\n```sh\nnpm run check\n```\n\n[Runbook](https://example.com/runbook)' }] }]);
  observations.set(turn.id, { turn: { ...turn, status: 'completed', completed_at: turn.created_at + 1 }, requiredActions: [] });
  await sessions.completeTurn(owner, session.id, turn.id);
  await expect(page.locator('#status')).toHaveText('idle');
  await page.reload();
  await page.locator('.resource').filter({ hasText: 'Release review' }).click();
  await expect(page.locator('#transcript')).toContainText('Review complete.');
  await expect(page.getByRole('link', { name: 'Runbook' })).toHaveAttribute('rel', 'noopener noreferrer');
  await page.getByLabel('Continue this session').fill('Start another review.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await sessions.turns(owner, session.id)).data.length).toBe(2);
  await sessions.dispatch(owner, session.id);
  await page.getByRole('button', { name: 'Cancel turn' }).click();
  await expect.poll(() => received.some((request) => (JSON.stringify(request.body) ?? "").includes('agent.session.input.cancel'))).toBe(true);
  await sessions.dispatch(owner, session.id);
  await expect(page.locator('#turn-status')).toHaveText('Turn cancelled');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/console/session-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/console/session-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(received.every((request) => /^\/v1\/(agents|vaults)/.test(request.path))).toBe(true);
  const denied = await page.request.post(`${consoleUrl}/api/v1/agents`, { data: { model: 'fixture' } });
  expect(denied.status()).toBe(403);
});

test('paginates saved agents and manages write-only vault credentials', async ({ page }) => {
  for (let index = 0; index < 26; index++) await agents.create(owner, { model: 'fixture-model', name: `Agent ${index}` });
  await page.goto(consoleUrl);
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.locator('.resource')).toHaveCount(25);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.locator('.resource')).toHaveCount(26);
  await page.locator('.resource').first().click();
  await page.getByRole('button', { name: 'Edit configuration' }).click();
  await submitEditor(page, { name: 'Review agent', instructions: 'Inspect changes.' });
  await expect(page.getByRole('heading', { name: 'Review agent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Vaults', exact: true }).click();
  await page.getByRole('button', { name: 'New vault', exact: true }).click();
  await submitEditor(page, { name: 'Service tools' });
  await page.getByRole('button', { name: 'Add credential', exact: true }).click();
  await submitEditor(page, { name: 'Internal MCP', auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.example.com', token: 'write-only-initial' } });
  await expect(page.getByRole('heading', { name: 'Internal MCP' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('write-only-initial');
  await expect(page.getByLabel('Request JSON')).toHaveValue('');
  await page.getByRole('button', { name: 'Rotate credential' }).click();
  await submitEditor(page, { auth: { type: 'static_bearer', token: 'write-only-replacement' } });
  await expect(page.locator('body')).not.toContainText('write-only-replacement');
  expect([...secrets.values()]).toEqual([{ type: 'static_bearer', mcp_server_url: 'https://mcp.example.com', token: 'write-only-replacement' }]);
  await page.getByRole('button', { name: 'Delete credential' }).click();
  await expect(page.getByRole('heading', { name: 'Internal MCP' })).toHaveCount(0);
  expect(secrets.size).toBe(0);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.resource')).toHaveCount(0);
  expect(processOutput).not.toContain('ERR_HTTP_HEADERS_SENT');
});
