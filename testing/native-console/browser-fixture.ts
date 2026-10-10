import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import type { AgentSessionItem } from '../../src/domain/agents-api.js';
import type { SessionExecution, SavedSessionArtifact, SessionTurnObservation } from '../../src/core/session-ports.js';
import { SessionArtifactCapture } from '../../src/core/session-artifact-capture.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import worker from '../../src/runner/environment-mcp-worker-source.json' with { type: 'json' };
import browserTool from '../../examples/browser/tool.json' with { type: 'json' };
import { browserRpc } from './browser-rpc.js';

const allowedTools = browserTool.allowed_tools;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const text = (result: ToolResult) => result.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');

/** Real browser and production artifact capture; only model decisions, VM and storage ports are local fixtures. */
export async function createBrowserFixture() {
  const provider = join(dirname(createRequire(import.meta.url).resolve('@playwright/mcp/package.json')), 'cli.js');
  const executable = process.env.RAT_BROWSER_EXECUTABLE ?? chromium.executablePath();
  await stat(executable).catch(() => { throw new Error('Install the test browser with npx playwright install chromium, or set RAT_BROWSER_EXECUTABLE'); });
  const root = await mkdtemp(join(tmpdir(), 'rat-browser-e2e-'));
  const marker = `browser-${randomUUID()}`;
  const submitted: string[] = [];
  let forbiddenRequests = 0;
  const page = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/forbidden') { forbiddenRequests++; response.end('Unexpected navigation'); return; }
    if (url.pathname === '/submit') submitted.push(url.searchParams.get('name') ?? '');
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html lang="en"><title>Rat Things browser validation</title><style>body{font:16px system-ui;background:#08090a;color:#f7f8f8;max-width:640px;margin:100px auto}input,button{font:inherit;padding:12px;margin:12px 0}label{display:block}h1{font-size:28px}</style><h1>Browser validation</h1>${url.pathname === '/submit' ? `<p role="status">Submitted: ${marker}</p><p>Navigation, typing and click completed in Chromium.</p>` : '<form action="/submit"><label for="name">Validation code</label><input id="name" name="name"><button>Submit validation</button></form>'}</html>`);
  });
  page.listen(0, '127.0.0.1'); await once(page, 'listening');
  const address = page.address(); assert(address && typeof address !== 'string');
  const pageURL = `http://127.0.0.1:${address.port}`;
  const observations = new Map<string, SessionTurnObservation>();
  const items = new Map<string, AgentSessionItem[]>();
  const artifacts = new Map<string, SavedSessionArtifact[]>();
  const bytes = new Map<string, Uint8Array>();
  const running = new Map<string, Promise<void>>();
  const connections = new Map<string, ReturnType<typeof browserRpc>>();
  const evidence = { marker, submitted, calls: [] as string[], denied: false, forbiddenRequests: 0, screenshotSha256: '', closed: false, error: '' };
  // This declaration is persisted via the normal create form and used below unchanged.
  const tool = {
    ...browserTool,
    transport: { ...browserTool.transport, command: process.execPath,
      args: browserTool.transport.args.map(value => value === '/opt/rat-browser/node_modules/@playwright/mcp/cli.js' ? provider : value === '/opt/rat-browser/chromium' ? executable : value === '/workspace/.browser' ? '.browser' : value).concat(['--allowed-origins', pageURL, '--viewport-size', '1000x700']), cwd: root },
  };
  const request = {
    metadata: { name: 'Browser validation' }, agent: { model: 'fixture-browser', tools: [tool] },
    environment: { type: 'openai_hosted' }, input: 'Run the deterministic browser validation and save a screenshot.',
  };
  const execution: SessionExecution = {
    prepare: async (_owner, id, environment, agent) => {
      assert.equal(environment.type, 'openai_hosted');
      assert.deepEqual(agent.tools[0]?.type === 'mcp' && agent.tools[0].allowed_tools, allowedTools);
      assert.equal(agent.tools.length, 1);
      const declared = agent.tools[0];
      assert(declared?.type === 'mcp' && declared.transport.type === 'stdio');
      assert.equal(declared.transport.command, tool.transport.command);
      assert.deepEqual(declared.transport.args, tool.transport.args);
      assert.equal(declared.transport.cwd, root);
      return { id: `env_${id}`, type: 'openai_hosted', capability_directories: [], files: [], skills: [], plugins: [], packages: { npm: [], python: [], system: [] }, network: { access: 'restricted', allowed_domains: ['127.0.0.1'] } };
    },
    start: async (owner, session, binding) => {
      if (running.has(binding.turn.id)) return;
      const id = binding.turn.id;
      observations.set(id, { turn: { ...binding.turn, started_at: binding.turn.created_at, status: 'in_progress' }, requiredActions: [] });
      items.set(id, []);
      const job = (async () => {
        const directory = join(root, id); await mkdir(join(directory, 'outputs'), { recursive: true });
        const declared = session.agent.tools.find(candidate => candidate.type === 'mcp');
        assert(declared?.type === 'mcp' && declared.transport.type === 'stdio');
        // Local environment adapter maps the admitted workspace into a temporary directory.
        const rpc = browserRpc(process.execPath, ['--input-type=module', '-e', worker, JSON.stringify({ transport: { ...declared.transport, cwd: directory }, allowedTools: declared.allowed_tools, metadata: declared.request_metadata, headerEnv: {} })], directory);
        connections.set(id, rpc);
        const call = async (name: string, args: object): Promise<ToolResult> => {
          const result = await rpc.call('tools/call', { name, arguments: args }) as ToolResult;
          assert(!result.isError, text(result));
          // This provider writes accessibility snapshots to files. Consume only the
          // concrete snapshot path it returned inside this fixture's output directory.
          const snapshot = text(result).match(/\[Snapshot\]\((\.browser\/page-[A-Za-z0-9_.-]+\.yml)\)/)?.[1];
          if (snapshot) result.content.push({ type: 'text', text: await readFile(join(directory, snapshot), 'utf8') });
          evidence.calls.push(name);
          items.get(id)!.push({ id: `call_${id}_${evidence.calls.length}`, turn_id: id, type: 'mcp_call', server_label: 'browser', name, arguments: args, output: { text: text(result) }, error: null, status: 'completed' });
          return result;
        };
        try {
          await rpc.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'rat-browser-e2e', version: '1' } });
          rpc.notify('notifications/initialized');
          const inventory = await rpc.call('tools/list', {}) as { tools: Array<{ name: string }> };
          for (const name of allowedTools) assert(inventory.tools.some(tool => tool.name === name), `Missing ${name}`);
          // browser_run_code would navigate to /forbidden if the bridge forwarded it.
          await assert.rejects(rpc.call('tools/call', { name: 'browser_run_code', arguments: { code: `async (page) => { await page.goto('${pageURL}/forbidden'); }` } }), /Environment MCP request failed/);
          evidence.denied = true;
          const loaded = text(await call('browser_navigate', { url: pageURL }));
          const field = loaded.match(/textbox "Validation code".*?\[ref=(\w+)\]/)?.[1];
          assert(field, `No textbox in real page snapshot: ${loaded}`);
          await call('browser_type', { target: field, text: marker });
          const button = loaded.match(/button "Submit validation".*?\[ref=(\w+)\]/)?.[1];
          assert(button, 'No submit button in real page snapshot');
          await call('browser_click', { target: button });
          const result = text(await call('browser_snapshot', {}));
          assert(result.includes(`Submitted: ${marker}`)); assert(submitted.includes(marker));
          await call('browser_take_screenshot', { filename: 'outputs/browser.png', fullPage: true, type: 'png', scale: 'css' });
          const screenshot = await readFile(join(directory, 'outputs/browser.png'));
          assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
          evidence.screenshotSha256 = hash(screenshot);
          await call('browser_close', {});
          const turn = { ...binding.turn, status: 'completed' as const, completed_at: Math.floor(Date.now() / 1000) };
          const capture = new SessionArtifactCapture({ ownerId: owner, launch: { sessionId: session.id, turnId: id, agent: session.agent, environment: session.environment, input: [] },
            files: { execute: async (_env, _credential, operation) => {
              if (operation.operation === 'list') return [{ path: '/workspace/outputs/browser.png', size_bytes: screenshot.length }];
              assert.equal(operation.operation, 'read'); if (operation.operation !== 'read') throw new Error('Unsupported file operation');
              assert.equal(operation.path, '/workspace/outputs/browser.png');
              return { data: screenshot.subarray(operation.offset, operation.offset + operation.length).toString('base64'), version: hash(screenshot), size_bytes: screenshot.length };
            } },
            artifacts: { putBytes: async (key, value) => { bytes.set(key, value.slice()); return { bucket: 'browser-fixture', key, sha256: hash(value) }; } },
          });
          const captured = await capture.capture({ ...initialSessionRuntime(session.id, session.agent.id, 'browser-test'), turns: [{ threadId: 'browser-test', nativeTurnId: id, turn, items: items.get(id)! }] });
          artifacts.set(id, captured.turns[0]!.artifacts!);
          // Saved artifact must survive live output removal, just as it does after worker loss.
          await rm(join(directory, 'outputs'), { recursive: true });
          items.get(id)!.push({ id: `answer_${id}`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', turn_id: id, content: [{ type: 'output_text', text: `Browser validation passed.\n\nSubmitted: ${marker}\n\nReal Chromium navigation, typing and click verified. Open Files to save browser.png.\n\nThis test uses deterministic actions; no model was invoked.` }] });
          observations.set(id, { turn, requiredActions: [] });
        } finally { await rpc.close(); connections.delete(id); evidence.closed = true; }
      })().catch(error => {
        evidence.error = String(error); console.error(error);
        observations.set(id, { turn: { ...binding.turn, status: 'failed', completed_at: Math.floor(Date.now() / 1000), error: { code: 'internal_error', message: String(error) } }, requiredActions: [] });
      });
      running.set(id, job);
    },
    steer: async () => { throw new Error('This browser fixture runs a fixed journey'); },
    cancel: async (_owner, _session, id) => { await connections.get(id)?.close(); },
    toolResult: async () => { throw new Error('This browser fixture only uses MCP'); },
    observe: async (_owner, _session, turn) => observations.get(turn.id) ?? { turn, requiredActions: [] },
    items: async (_owner, _session, id) => items.get(id) ?? [],
    artifacts: async (_owner, _session, id) => artifacts.get(id) ?? [],
    artifactContent: async (_owner, _session, artifact) => new ReadableStream({ start(controller) { controller.enqueue(bytes.get(artifact.content.key)!); controller.close(); } }),
  };
  return { execution, request, state: () => ({ ...evidence, forbiddenRequests }), close: async () => {
    await Promise.all([...connections.values()].map(rpc => rpc.close()));
    await Promise.all(running.values());
    page.closeAllConnections(); await new Promise<void>(resolve => page.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}
