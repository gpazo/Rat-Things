import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterAll, expect, it, vi } from 'vitest';
import { createRunnerControlBridge } from '../../src/runner/control.js';

const runtime = vi.hoisted(() => ({
  handler: undefined as ((request: unknown, response: unknown) => Promise<void>) | undefined,
  spawn: vi.fn(),
  server: {
    on: vi.fn().mockReturnThis(),
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => callback?.()),
    close: vi.fn(),
  },
}));

vi.mock('node:http', () => ({
  createServer: (handler: typeof runtime.handler) => {
    runtime.handler = handler;
    return runtime.server;
  },
}));
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => runtime.spawn(...args),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));
vi.mock('node:fs', () => ({
  chownSync: vi.fn(), chmodSync: vi.fn(), copyFileSync: vi.fn(), existsSync: vi.fn(() => true),
  lstatSync: vi.fn(), mkdirSync: vi.fn(), rmSync: vi.fn(),
}));
vi.mock('../../microvm/runtime-network-policy.mjs', () => ({
  ensureUntrustedUidCannotReachPort: vi.fn(),
}));
vi.mock('../../microvm/runtime-process-policy.mjs', () => ({
  trustedRunnerOptions: () => ({}),
}));

const runId = 'response-gate-run';
const channel = 'rat-things-agent-control';
const ipc = new EventEmitter();
const actualProcess = process;
let runnerChild: EventEmitter & {
  connected: boolean;
  pid: number;
  send(message: Record<string, unknown>, callback?: (error?: Error | null) => void): boolean;
};

const processProxy = new Proxy(actualProcess, {
  get(target, property) {
    if (property === 'getuid') return () => 0;
    if (property === 'connected') return true;
    if (property === 'send') return (message: Record<string, unknown>) => {
      runnerChild.emit('message', message);
      return true;
    };
    if (property === 'on' || property === 'once' || property === 'removeListener' || property === 'emit') {
      return Reflect.get(ipc, property, ipc).bind(ipc);
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('routes a response through the installed runner controller and waits for its acknowledgement', async () => {
  vi.stubEnv('AGENT_RUNNER_ENTRY', '/fixture/runner.mjs');
  vi.stubEnv('AGENT_TERMINATOR_ENTRY', '/fixture/terminator.mjs');
  vi.stubEnv('RUN_AGENT_UID', '10001');
  vi.stubEnv('RUN_AGENT_GID', '10001');
  vi.stubGlobal('process', processProxy);

  runnerChild = Object.assign(new EventEmitter(), {
    connected: true,
    pid: 42,
    send(message: Record<string, unknown>, callback?: (error?: Error | null) => void) {
      callback?.(null);
      queueMicrotask(() => ipc.emit('message', message));
      return true;
    },
  });
  runtime.spawn.mockReturnValue(runnerChild);
  await import('../../microvm/runtime-server.mjs');
  const handler = runtime.handler;
  if (!handler) throw new Error('runtime HTTP handler was not installed');

  const post = async (url: string, body: unknown) => {
    const encoded = Buffer.from(JSON.stringify(body));
    const request = Object.assign(Readable.from([encoded]), {
      method: 'POST', url, headers: { 'content-length': String(encoded.length) },
    });
    const response = {
      statusCode: 0,
      headers: new Map<string, string>(),
      setHeader(name: string, value: string) { this.headers.set(name, value); },
      end(value: string) { this.body = value; },
      body: '',
    };
    await handler(request, response);
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };

  const hookPayload = {
    version: 1,
    runId,
    executionGeneration: 'a'.repeat(64),
    region: 'us-east-1',
    timeoutSeconds: 60,
    inputBucket: 'rat-things-inputs',
    inputKey: 'runs/input.json',
    runsTableName: 'rat-things-runs',
    integrationsTableName: 'rat-things-integrations',
    artifactBucket: 'rat-things-artifacts',
    heartbeatIntervalMs: 1_000,
    persistentSession: true,
    allowedRepositoryHosts: 'github.com',
    allowedSandboxModes: 'read-only',
    defaultSandboxMode: 'read-only',
    defaultAgentNetworkAccess: false,
    allowAgentAwsCredentialChain: false,
  };
  const started = await post('/aws/lambda-microvms/runtime/v1/run', {
    microvmId: 'microvm-response-test', runHookPayload: JSON.stringify(hookPayload),
  });
  expect(started.status).toBe(200);

  const respond = (callId: string) => post(`/agent-runtime/v1/runs/${runId}/requests/${callId}/respond`, {
    result: { success: true, output: 'result' },
  });

  expect((await respond('pi_call_before_ready')).status).toBe(409);
  runnerChild.emit('message', {
    channel: 'forged-channel', runId, type: 'turn-ready', session: true,
    responseAuthority: 'runner-controller', turn: { threadId: 'pi-root', turnId: 'turn-1' },
  });
  expect((await respond('pi_call_forged')).status).toBe(409);
  runnerChild.emit('message', {
    channel, runId, type: 'turn-ready', session: true,
    responseAuthority: { forged: true }, turn: { threadId: 'pi-root', turnId: 'turn-1' },
  });
  expect((await respond('pi_call_malformed')).status).toBe(409);

  const bridge = createRunnerControlBridge(runId);
  if (!bridge) throw new Error('runner control bridge was not created');
  await bridge.hooks.onTurnStarted?.({
    threadId: 'pi-root', turnId: 'turn-1',
    steer: async () => {}, interrupt: async () => {}, sessionItems: async () => [],
  });
  expect((await respond('pi_call_legacy')).status).toBe(409);

  let acknowledge!: () => void;
  let entered!: () => void;
  const enteredResponse = new Promise<void>(resolve => { entered = resolve; });
  const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
  const delivered: Array<{ callId: string; result: unknown }> = [];
  const controller = {
    threadId: 'pi-root', turnId: 'turn-2',
    steer: async () => {}, interrupt: async () => {}, sessionItems: async () => [],
    respondSessionTool: async (callId: string, result: unknown) => {
      delivered.push({ callId, result });
      entered();
      await acknowledgement;
    },
  };
  await bridge.hooks.onTurnStarted?.(controller);
  let responseSettled = false;
  const responsePromise = respond('pi_call_15').finally(() => { responseSettled = true; });
  const early = await Promise.race([
    enteredResponse.then(() => undefined),
    responsePromise,
  ]);
  if (early) expect(early.status).toBe(202);
  expect(responseSettled).toBe(false);
  await bridge.hooks.onTurnStarted?.({
    threadId: 'codex-thread', turnId: 'turn-3',
    steer: async () => {}, interrupt: async () => {}, sessionItems: async () => [],
  });
  acknowledge();
  expect(await responsePromise).toMatchObject({ status: 202 });
  expect(delivered).toEqual([{ callId: 'pi_call_15', result: { success: true, output: 'result' } }]);
  expect((await respond('pi_call_15')).status).toBe(409);

  const rejectedController = {
    threadId: 'pi-root', turnId: 'turn-4',
    steer: async () => {}, interrupt: async () => {}, sessionItems: async () => [],
    respondSessionTool: async () => { throw new Error('Unknown Pi function call'); },
  };
  await bridge.hooks.onTurnStarted?.(rejectedController);
  expect((await respond('pi_call_unknown')).status).toBe(409);
  await bridge.hooks.onTurnStarted?.({
    threadId: 'codex-thread', turnId: 'turn-5',
    steer: async () => {}, interrupt: async () => {}, sessionItems: async () => [],
  });
  expect((await respond('pi_call_unknown')).status).toBe(409);

  const codexRequest = bridge.hooks.onServerRequest?.({
    requestId: 'codex-request-1', method: 'item/tool/call', params: { tool: 'lookup' },
  });
  const codexResult = { success: true, output: 'codex-result' };
  expect((await post(`/agent-runtime/v1/runs/${runId}/requests/codex-request-1/respond`, { result: codexResult })).status).toBe(202);
  expect(await codexRequest).toEqual(codexResult);
  expect((await post(`/agent-runtime/v1/runs/${runId}/requests/codex-request-1/respond`, { result: codexResult })).status).toBe(202);
  expect((await post(`/agent-runtime/v1/runs/${runId}/requests/codex-request-1/respond`, { result: { success: true, output: 'different' } })).status).toBe(409);
  bridge.close();
});
