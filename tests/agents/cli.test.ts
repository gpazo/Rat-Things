import { iamApiPrincipal } from '../../src/domain/api-permissions.js';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileService } from '../../src/core/file-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import { runAgentsCli } from '../../src/agents-cli.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from './fixtures.js';
import { MemoryArtifacts } from '../runner/artifact-fixtures.js';

const transport = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/agents-client.js', () => ({ createAgentsClient: transport.create }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('standard Files CLI', () => {
  it('exports every Session trace page as an OTLP payload to a local file', async () => {
    const requests: URL[] = [];
    transport.create.mockReturnValue(new OpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', maxRetries: 0, fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url); requests.push(url);
      expect(request.headers.get('OpenAI-Beta')).toBe('agents=v1');
      const id = url.searchParams.has('after') ? 'trace_2' : 'trace_1';
      return Response.json({ object: 'list', data: [{ id, otlp: { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [] }] } }], has_more: id === 'trace_1', first_id: id, last_id: id });
    } }));
    vi.stubEnv('RAT_THINGS_AGENTS_API_URL', 'https://fixture.invalid/v1');
    vi.stubEnv('AWS_REGION', 'us-west-2');
    const root = await mkdtemp(join(tmpdir(), 'rat-traces-cli-'));
    try {
      const target = join(root, 'traces.json');
      await runAgentsCli(['sessions', 'traces', 'sess_1', '--output', target, '--limit', '1']);
      expect(JSON.parse(await readFile(target, 'utf8')).resourceSpans).toHaveLength(2);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.pathname).toBe('/v1/agents/sessions/sess_1/traces');
      expect(requests[1]!.searchParams.get('after')).toBe('trace_1');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses SDK multipart uploads and streams the exact retained binary to a chosen destination', async () => {
    const store = new MemoryAgentsStore();
    const files = new FileService({ store, artifacts: new MemoryArtifacts() });
    const agents = new AgentService({ store });
    const requests: string[] = [];
    transport.create.mockReturnValue(new OpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', maxRetries: 0, fetch: (input, init) => {
      const request = new Request(input, init); requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return routeAgentsRequest(request, iamApiPrincipal('owner'), { agents, files });
    } }));
    vi.stubEnv('RAT_THINGS_AGENTS_API_URL', 'https://fixture.invalid/v1');
    vi.stubEnv('AWS_REGION', 'us-west-2');
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const root = await mkdtemp(join(tmpdir(), 'rat-files-cli-'));
    const input = join(root, 'source.bin'), target = join(root, 'download.bin');
    const bytes = Buffer.from([0, 255, 129, 13, 10]);
    try {
      await writeFile(input, bytes);
      await runAgentsCli(['files', 'create', '--file', input]);
      const uploaded = JSON.parse(String(output.mock.calls.at(-1)![0])) as { id: string };
      expect(uploaded.id).toMatch(/^file-/);
      await runAgentsCli(['files', 'list']);
      expect(JSON.parse(String(output.mock.calls.at(-1)![0])).data).toHaveLength(1);
      await runAgentsCli(['files', 'content', uploaded.id, '--output', target]);
      expect(await readFile(target)).toEqual(bytes);
      await expect(runAgentsCli(['files', 'content', uploaded.id])).rejects.toThrow('--output');
      expect(requests.filter((request) => request.endsWith('/content'))).toHaveLength(1);
      await runAgentsCli(['files', 'delete', uploaded.id]);
      await expect(runAgentsCli(['files', 'get', uploaded.id])).rejects.toMatchObject({ status: 404 });
      expect(requests.every((request) => / \/v1\/files(?:\/|$)/.test(request))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('runtime selection CLI', () => {
  const setup = () => {
    const requests: { path: string; body: unknown }[] = [];
    transport.create.mockReturnValue(new OpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', maxRetries: 0, fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ path: new URL(request.url).pathname, body: request.method === 'GET' ? undefined : await request.json() });
      return Response.json({ kind: 'pi' });
    } }));
    vi.stubEnv('RAT_THINGS_AGENTS_API_URL', 'https://fixture.invalid/v1');
    vi.stubEnv('AWS_REGION', 'us-west-2');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    return requests;
  };

  it('merges runtime and model into existing Session configuration', async () => {
    const requests = setup();
    const root = await mkdtemp(join(tmpdir(), 'rat-runtime-cli-'));
    try {
      const file = join(root, 'request.json');
      await writeFile(file, JSON.stringify({ environment: { type: 'none' }, metadata: { name: 'Kept' }, agent: { model: 'old', instructions: 'Keep me', tools: [{ type: 'function', name: 'lookup', description: 'Look up a record', parameters: { type: 'object', properties: {} }, defer_loading: false }] } }));
      await runAgentsCli(['sessions', 'create', '--file', file, '--runtime', 'pi', '--model', 'amazon.nova-micro-v1:0']);
      expect(requests[0]).toMatchObject({ path: '/v1/agents/sessions', body: { metadata: { name: 'Kept', rat_things_runtime: 'pi' }, agent: { model: 'amazon.nova-micro-v1:0', instructions: 'Keep me', tools: [{ type: 'function', name: 'lookup' }] } } });
      await runAgentsCli(['sessions', 'runtime', 'session/one']);
      expect(requests[1]!.path).toBe('/v1/agents/sessions/session%2Fone/runtime');
      await expect(runAgentsCli(['sessions', 'create', '--runtime', 'other'])).rejects.toThrow('--runtime must be codex or pi');
      await expect(runAgentsCli(['sessions', 'get', 'id', '--runtime', 'pi'])).rejects.toThrow('applies only');
      expect(requests).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps saved Agent metadata when runtime changes', async () => {
    const requests = setup();
    const root = await mkdtemp(join(tmpdir(), 'rat-agent-runtime-cli-'));
    try {
      const file = join(root, 'request.json');
      await writeFile(file, JSON.stringify({ name: 'Example', model: 'old', metadata: { team: 'engineering' }, instructions: 'Keep me' }));
      await runAgentsCli(['agents', 'create', '--file', file, '--runtime', 'pi', '--model', 'amazon.nova-micro-v1:0']);
      expect(requests[0]!.body).toMatchObject({ metadata: { team: 'engineering', rat_things_runtime: 'pi' }, instructions: 'Keep me', model: 'amazon.nova-micro-v1:0' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
