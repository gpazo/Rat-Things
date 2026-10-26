import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import type { LocalRuntime } from '../../src/core/local-runtime-ports.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';
import { developmentLocalCodexHost } from '../../src/runner/local-codex.js';
import { managedCodexConfiguration } from '../../src/domain/codex-managed-policy.js';

afterEach(() => vi.unstubAllEnvs());

function fixtureRuntime(): LocalRuntime {
  const status = { ready: true, engine: 'unknown' as const, image: 'fixture', checks: [] };
  return { status: async () => status, setup: async () => status,
    start: async (_request, claim) => { await claim(); return 'http://127.0.0.1:3211'; },
    admitTurn: async () => {}, stop: async () => {}, running: async () => true,
    snapshot: async () => [], close: async () => {} };
}

async function fixtureHost(directory: string) {
  const binary = join(directory, 'fixture-codex');
  const log = join(directory, 'calls.jsonl');
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: request.method, binary: process.argv[1], path: process.env.PATH }) + '\\n');
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'config/read') result = ${JSON.stringify({
    config: managedCodexConfiguration({ workspace: '/workspace', network: { access: 'disabled', allowed_domains: [] }, credentialProxy: false }),
    layers: [{ name: { type: 'sessionFlags' }, config: {} },
      ...['user', 'system'].map(type => ({ name: { type, file: join(directory, type, 'config.toml') }, config: {} }))],
  })};
  if (request.method === 'configRequirements/read') result = { requirements: null };
  if (request.method === 'account/read') result = { account: null };
  if (request.method === 'model/list') result = { data: [{ id: 'fixture-model', isDefault: true }] };
  if (request.method === 'thread/start' || request.method === 'thread/resume') result = { thread: { id: 'fixture-thread' } };
  if (request.method === 'turn/start') result = { turn: { id: 'fixture-turn' } };
  if (request.method === 'mcpServer/tool/call') result = { content: [{ type: 'text', text: '[]' }] };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});
`, { mode: 0o700 });
  return { binary, log, hostCodex: developmentLocalCodexHost(directory, { CODEX_BINARY: binary, PATH: '/fixture/companions' }) };
}

it('pins account, model, Session and file callers to one host despite ambient binary changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-host-selection-'));
  const host = await fixtureHost(directory);
  const services = createLocalServices({ directory, runtime: fixtureRuntime(), hostCodex: host.hostCodex });
  vi.stubEnv('CODEX_BINARY', '/unadmitted/ambient-codex');
  vi.stubEnv('PATH', '/unadmitted/ambient-path');
  try {
    expect((await services.subscription.status()).signed_in).toBe(false);
    expect(await services.models()).toBeDefined();
    const session = await services.sessions.create(LOCAL_OWNER, { agent: { model: 'fixture-model' },
      environment: { type: 'openai_hosted' }, input: 'Fixture input' });
    if (session.environment.type !== 'openai_hosted') throw new Error('Missing fixture environment');
    const environmentId = session.environment.id;
    await expect.poll(async () => (await services.environments.retrieve(LOCAL_OWNER, environmentId)).status).toBe('connected');
    expect((await services.environments.files(LOCAL_OWNER, environmentId)).data).toEqual([]);
    const calls = (await readFile(host.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; binary: string; path: string });
    expect(calls.map(call => call.method)).toEqual(expect.arrayContaining(['account/read', 'model/list', 'turn/start', 'mcpServer/tool/call']));
    expect(new Set(calls.map(call => call.binary))).toEqual(new Set([host.binary]));
    expect(new Set(calls.map(call => call.path))).toEqual(new Set(['/fixture/companions']));
  } finally { await services.close(); await rm(directory, { recursive: true, force: true }); }
});

it('does not create an account home or launch Codex before a host is selected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-host-wait-'));
  const host = await fixtureHost(directory);
  let selected = false;
  const services = createLocalServices({ directory, runtime: fixtureRuntime(), hostCodex: () => {
    if (!selected) throw new AgentsApiError(503, 'Local runtime is starting.', 'local_runtime_starting');
    return host.hostCodex();
  } });
  try {
    await expect(services.subscription.status()).rejects.toMatchObject({ code: 'local_runtime_starting' });
    await expect(services.models()).rejects.toMatchObject({ code: 'local_runtime_starting' });
    await expect(services.sessions.create(LOCAL_OWNER, { agent: { model: 'fixture-model' }, environment: { type: 'none' }, input: 'Wait' }))
      .rejects.toMatchObject({ code: 'local_runtime_starting' });
    await expect(stat(join(directory, 'codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(host.log)).rejects.toMatchObject({ code: 'ENOENT' });
    selected = true;
    expect((await services.subscription.status()).signed_in).toBe(false);
  } finally { await services.close(); await rm(directory, { recursive: true, force: true }); }
});
