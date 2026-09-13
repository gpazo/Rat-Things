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
  it('uses SDK multipart uploads and streams the exact retained binary to a chosen destination', async () => {
    const store = new MemoryAgentsStore();
    const files = new FileService({ store, artifacts: new MemoryArtifacts() });
    const agents = new AgentService({ store });
    const requests: string[] = [];
    transport.create.mockReturnValue(new OpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', maxRetries: 0, fetch: (input, init) => {
      const request = new Request(input, init); requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return routeAgentsRequest(request, 'owner', { agents, files });
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
