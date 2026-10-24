import { createServer, get } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { startLocalServer } from '../../src/local-server.js';
import { createLocalAgentsClient, createLocalAgentsFetch, readLocalConnection } from '../../src/local-workspace.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import { localCodexArguments, localCodexClient, localCodexEnvironment, planLocalCodexEnvironment } from '../../src/runner/local-codex.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';

describe('local workspace using the production API and native harness', () => {
  it('keeps ambient credentials and billing endpoints out of local login and inference', () => {
    const ambient = Object.freeze({ PATH: '/usr/bin', LANG: '', HTTPS_PROXY: 'http://proxy.example', SSL_CERT_FILE: '/etc/organization.pem', OPENAI_API_KEY: 'billing-sentinel',
      CODEX_API_KEY: 'codex-sentinel', AWS_ACCESS_KEY_ID: 'aws-sentinel', OPENAI_BASE_URL: 'https://billing.example',
      CODEX_HOME: '/personal', CODEX_SQLITE_HOME: '/personal/database', AGENT_PASSTHROUGH_ENV: 'OPENAI_API_KEY' });
    const login = planLocalCodexEnvironment('/rat', ambient);
    const inference = planCodexLaunch({ version: '1', prompt: '' }, '/rat/workspace', 1000, login).environment;
    expect(login).toMatchObject({ PATH: '/usr/bin', LANG: '', HTTPS_PROXY: 'http://proxy.example', HOME: '/rat/codex',
      CODEX_HOME: '/rat/codex', CODEX_AUTH_MODE: 'chatgpt' });
    for (const environment of [login, inference]) {
      expect(environment).toMatchObject({ HTTPS_PROXY: 'http://proxy.example', SSL_CERT_FILE: '/etc/organization.pem' });
      for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'AWS_ACCESS_KEY_ID', 'OPENAI_BASE_URL', 'CODEX_SQLITE_HOME']) expect(environment).not.toHaveProperty(name);
    }
    expect(ambient.CODEX_HOME).toBe('/personal');
  });

  it('enforces ChatGPT login in the real Codex app-server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-auth-policy-'));
    const rpc = localCodexClient({ binary: resolve('node_modules/.bin/codex'), binaryArguments: localCodexArguments(['app-server']),
      cwd: directory, environment: localCodexEnvironment(directory, { PATH: process.env.PATH }) });
    try {
      await rpc.initialize();
      const configuration = await rpc.call('config/read', { includeLayers: false }) as { config: { forced_login_method?: string } };
      expect(configuration.config.forced_login_method).toBe('chatgpt');
      await expect(rpc.call('account/login/start', { type: 'apiKey', apiKey: 'fixture-not-a-real-key' })).rejects.toThrow();
      expect(await rpc.call('account/read', { refreshToken: false })).toMatchObject({ account: null });
      await expect(stat(join(directory, 'codex', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rpc.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('streams a real native Turn, resumes saved history after restart, and protects loopback authentication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-local-api-'));
    const ambientMarker = join(directory, 'unadmitted-mcp-started');
    await writeFile(join(directory, 'config.toml'), `[mcp_servers.unadmitted]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify(['-e', `require('node:fs').writeFileSync(${JSON.stringify(ambientMarker)}, 'started')`])}\n`);
    const requests: Array<Record<string, unknown>> = [];
    const model = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (requests.length === 3) return;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { type: 'response.created', response: { id: `response_${requests.length}` } },
        { type: 'response.output_item.done', item: { type: 'message', id: `message_${requests.length}`, role: 'assistant',
          content: [{ type: 'output_text', text: `Local reply ${requests.length}` }], phase: 'final_answer' } },
        { type: 'response.completed', response: { id: `response_${requests.length}` } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    const address = model.address(); if (!address || typeof address === 'string') throw new Error('Missing model fixture address');
    const launch = () => startLocalServer({ directory, model: 'gpt-5.4',
      execution: store => new LocalSessionExecution({ store, directory, maxSessions: 2,
        environment: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory, CODEX_BINARY: resolve('node_modules/.bin/codex') },
        request: request => ({ ...request, modelProvider: 'fixture', sessionConfig: { ...request.sessionConfig,
          'model_providers.fixture': { name: 'fixture', base_url: `http://127.0.0.1:${address.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } } }),
      }),
    });
    let server = await launch();
    try {
      const connection = await readLocalConnection(directory);
      const client = createLocalAgentsClient(connection);
      expect((await stat(join(directory, 'connection.json'))).mode & 0o777).toBe(0o600);
      expect((await fetch(`${server.baseURL}/agents`)).status).toBe(403);
      expect((await fetch(`${server.baseURL}/agents`, { headers: { authorization: `Bearer ${server.token}`, origin: 'https://evil.example' } })).status).toBe(403);
      expect(await new Promise<number | undefined>((resolveStatus, reject) => {
        get(`${server.baseURL}/agents`, { headers: { authorization: `Bearer ${server.token}`, host: 'evil.example' } }, response => {
          response.resume(); resolveStatus(response.statusCode);
        }).on('error', reject);
      })).toBe(403);
      await expect(createLocalAgentsFetch(connection)('https://evil.example/v1/agents')).rejects.toThrow('another destination');
      const events = [];
      for await (const event of await client.beta.agents.sessions.create({ agent: { model: 'gpt-5.4', multi_agent: { enabled: false } },
        environment: { type: 'none' }, input: 'Remember the acorn.', stream: true })) events.push(event);
      expect(JSON.stringify(events)).toContain('Local reply 1');
      const sessions = await client.beta.agents.sessions.list();
      const id = sessions.data[0]!.id;
      expect((await client.beta.agents.sessions.turns.list(id)).data[0]!.status).toBe('completed');
      expect(JSON.stringify(requests[0]?.tools)).not.toContain('exec_command');
      await expect(stat(ambientMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(join(directory, 'codex'))).mode & 0o777).toBe(0o700);
      await expect(client.beta.agents.sessions.create({ agent: { model: 'gpt-5.4' }, environment: { type: 'openai_hosted' }, input: 'no' })).rejects.toMatchObject({ status: 400 });
      await server.close();
      server = await launch();
      const resumed = createLocalAgentsClient(await readLocalConnection(directory));
      expect(JSON.stringify(await resumed.beta.agents.sessions.items.list(id))).toContain('Local reply 1');
      await resumed.beta.agents.sessions.events.create(id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'What did I ask you to remember?' }] }] }] });
      await expect.poll(async () => JSON.stringify(await resumed.beta.agents.sessions.items.list(id)), { timeout: 15_000 }).toContain('Local reply 2');
      expect(JSON.stringify(requests[1]?.input)).toContain('Remember the acorn.');
      expect((await resumed.beta.agents.sessions.turns.list(id)).data).toHaveLength(2);
      expect((await fetch(`${server.baseURL}/agents`, { headers: { authorization: `Bearer ${connection.token}` } })).status).toBe(403);
      const interrupted = await resumed.beta.agents.sessions.create({ agent: { model: 'gpt-5.4', multi_agent: { enabled: false } },
        environment: { type: 'none' }, input: 'Wait for interruption.' });
      await expect.poll(() => requests.length, { timeout: 10_000 }).toBe(3);
      const queued = await resumed.beta.agents.sessions.create({ agent: { model: 'gpt-5.4', multi_agent: { enabled: false } },
        environment: { type: 'none' }, input: 'Run when a slot opens.' });
      expect((await resumed.beta.agents.sessions.turns.list(queued.id)).data[0]?.status).toBe('queued');
      expect(requests).toHaveLength(3);
      await resumed.beta.agents.sessions.delete(id);
      await expect.poll(async () => JSON.stringify(await resumed.beta.agents.sessions.items.list(queued.id)), { timeout: 10_000 }).toContain('Local reply 4');
      await server.close();
      server = await launch();
      const recovered = createLocalAgentsClient(await readLocalConnection(directory));
      await expect.poll(async () => (await recovered.beta.agents.sessions.turns.list(interrupted.id)).data[0]?.status).toBe('failed');
      expect(requests).toHaveLength(4);
    } finally {
      await server.close();
      model.closeAllConnections(); await new Promise<void>(resolveClose => model.close(() => resolveClose()));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 40_000);

  it('rejects host MCP configuration before starting any tool process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-local-admission-'));
    const environment = localCodexEnvironment(directory, { PATH: process.env.PATH });
    const marker = join(directory, 'unadmitted-tool');
    await writeFile(join(environment.CODEX_HOME!, 'config.toml'), `[mcp_servers.unadmitted]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify(['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`])}\n`);
    const rpc = localCodexClient({ binary: resolve('node_modules/.bin/codex'), binaryArguments: localCodexArguments(['app-server']), cwd: directory, environment });
    try {
      await expect(rpc.initialize()).rejects.toThrow('Host MCP configuration is not admitted');
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rpc.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
