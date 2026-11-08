import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { afterAll, expect, it, vi } from 'vitest';
import { createRunnerControlBridge } from '../../src/runner/control.js';

const runtime = vi.hoisted(() => ({
  handler: undefined as ((request: unknown, response: unknown) => Promise<void>) | undefined,
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  sequence: [] as string[],
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
  spawn: (...args: unknown[]) => { runtime.sequence.push(`spawn:${String(args[0])}`); return runtime.spawn(...args); },
  spawnSync: (...args: unknown[]) => { runtime.sequence.push(`sync:${String(args[0])}`); return runtime.spawnSync(...args); },
}));
vi.mock('node:fs', () => ({
  chownSync: vi.fn(), chmodSync: vi.fn(), copyFileSync: vi.fn(), existsSync: vi.fn(() => true),
  lstatSync: vi.fn(() => ({ isDirectory: () => true, isSymbolicLink: () => false })), mkdirSync: (...args: unknown[]) => { runtime.sequence.push(`mkdir:${String(args[0])}`); }, rmSync: vi.fn(),
}));
vi.mock('../../microvm/runtime-network-policy.mjs', () => ({
  ensureUntrustedUidCannotReachPort: vi.fn(),
}));
vi.mock('../../microvm/runtime-process-policy.mjs', () => ({
  trustedRunnerOptions: ({ uid, gid, environment, startupGate }: { uid: number; gid: number; environment: Record<string, string>; startupGate?: boolean }) => ({
    uid, gid, env: environment,
    stdio: startupGate ? ['inherit', 'inherit', 'inherit', 'ipc', 'pipe'] : ['inherit', 'inherit', 'inherit', 'ipc'],
  }),
}));

const runId = 'response-gate-run';
const channel = 'rat-things-agent-control';
const ipc = new EventEmitter();
const actualProcess = process;
let runnerChild: EventEmitter & {
  connected: boolean;
  pid: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  send(message: Record<string, unknown>, callback?: (error?: Error | null) => void): boolean;
  kill?(signal: NodeJS.Signals): boolean;
  stdio?: Array<PassThrough | undefined>;
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

async function startRuntimeWithRunner(options: { storage?: boolean; checkpoint?: boolean; failMount?: boolean } = {}) {
  vi.resetModules();
  ipc.removeAllListeners();
  vi.stubEnv('AGENT_RUNNER_ENTRY', '/fixture/runner.mjs');
  vi.stubEnv('AGENT_TERMINATOR_ENTRY', '/fixture/terminator.mjs');
  vi.stubEnv('RUN_AGENT_UID', '10001');
  vi.stubEnv('RUN_AGENT_GID', '10001');
  vi.stubGlobal('process', processProxy);
  runtime.sequence.length = 0;
  runtime.spawnSync.mockReset().mockImplementation((command: string) => command === 'findmnt'
    ? { status: options.failMount ? 1 : 0, stdout: options.failMount ? '' : '/mnt/state', stderr: '' }
    : { status: options.failMount ? 1 : 0, stdout: '', stderr: options.failMount ? 'mount failed' : '' });

  runnerChild = Object.assign(new EventEmitter(), {
    connected: true,
    pid: 42,
    exitCode: null,
    signalCode: null,
    stdio: [undefined, undefined, undefined, undefined, createGateStream()],
    kill(signal: NodeJS.Signals) {
      queueMicrotask(() => {
        runnerChild.signalCode = signal;
        runnerChild.emit('exit', null, signal);
      });
      return true;
    },
    send(message: Record<string, unknown>, callback?: (error?: Error | null) => void) {
      callback?.(null);
      queueMicrotask(() => ipc.emit('message', message));
      return true;
    },
  });
  runtime.spawn.mockReset().mockReturnValue(runnerChild);
  await import('../../microvm/runtime-server.mjs');
  const handler = runtime.handler;
  if (!handler) throw new Error('runtime HTTP handler was not installed');

  const post = async (url: string, body: unknown, method = 'POST') => {
    const encoded = Buffer.from(JSON.stringify(body));
    const request = Object.assign(Readable.from([encoded]), {
      method, url, headers: { 'content-length': String(encoded.length) },
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

  const runId = 'worker-exit-run';
  const hookPayload = {
    version: 1,
    runId,
    executionGeneration: 'b'.repeat(64),
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
    ...(options.storage ? {
      s3FilesFileSystemId: 'fs-abc123',
      s3FilesAccessPointId: 'fsap-abc123',
      s3FilesMountTargetIp: '192.0.2.20',
      sessionStorageKey: 'c'.repeat(64),
      sessionCheckpointsEnabled: options.checkpoint ?? false,
    } : {}),
  };
  const started = await post('/aws/lambda-microvms/runtime/v1/run', {
    microvmId: 'microvm-worker-exit-test', runHookPayload: JSON.stringify(hookPayload),
  });
  expect(started.status).toBe(options.failMount ? 500 : 200);
  return { post };
}

function createGateStream() {
  const stream = new PassThrough();
  const write = stream.write.bind(stream);
  stream.write = ((...args: Parameters<typeof write>) => {
    runtime.sequence.push('gate:release');
    return write(...args);
  }) as typeof stream.write;
  return stream;
}

it('spawns before mount and releases storage-backed workers only after legacy preparation', async () => {
  await startRuntimeWithRunner({ storage: true });
  const runnerOptions = runtime.spawn.mock.calls.find(call => call[0] === process.execPath)?.[2] as { env?: Record<string, string>; stdio?: unknown[] };
  expect(runnerOptions.env).toMatchObject({ RT_STARTUP_GATE_FD: '4', SESSION_STATE_ROOT: '/mnt/rat-things-state/' + 'c'.repeat(64) });
  expect(runnerOptions.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc', 'pipe']);
  expect(runtime.sequence.indexOf(`spawn:${process.execPath}`)).toBeLessThan(runtime.sequence.indexOf('sync:findmnt'));
  expect(runtime.sequence.some(item => item === `mkdir:/mnt/rat-things-state/${'c'.repeat(64)}`)).toBe(true);
  expect(runtime.sequence.indexOf('gate:release')).toBeGreaterThan(runtime.sequence.indexOf('sync:findmnt'));
  expect(runtime.sequence.indexOf('gate:release')).toBeGreaterThan(runtime.sequence.indexOf(`mkdir:/mnt/rat-things-state/${'c'.repeat(64)}`));
});

it('mounts checkpoint storage before release without legacy Session preparation', async () => {
  await startRuntimeWithRunner({ storage: true, checkpoint: true });
  const runnerOptions = runtime.spawn.mock.calls.find(call => call[0] === process.execPath)?.[2] as { stdio?: unknown[] };
  expect(runnerOptions.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc', 'pipe']);
  expect(runtime.sequence.indexOf(`spawn:${process.execPath}`)).toBeLessThan(runtime.sequence.indexOf('sync:findmnt'));
  expect(runtime.sequence).not.toContain(`mkdir:/mnt/rat-things-state/${'c'.repeat(64)}`);
});

it('closes the private gate and leaves no active runner when mount fails', async () => {
  await startRuntimeWithRunner({ storage: true, failMount: true });
  expect(runtime.sequence).not.toContain('gate:release');
  expect(runnerChild.stdio?.[4]?.destroyed).toBe(true);
  expect(runtime.spawn.mock.calls.some(call => call[0] === process.execPath && (call[2] as { stdio?: unknown[] })?.stdio?.[4] === 'pipe')).toBe(true);
  expect(runtime.spawn).toHaveBeenCalledTimes(2);
});

it('stops a runner when the private gate reports an asynchronous write error', async () => {
  await startRuntimeWithRunner({ storage: true });
  runnerChild.stdio?.[4]?.destroy(new Error('EPIPE'));
  await new Promise(resolve => setImmediate(resolve));
  expect(runnerChild.signalCode).toBe('SIGTERM');
  expect(runtime.spawn).toHaveBeenCalledTimes(1);
});

it('routes a response through the installed runner controller and waits for its acknowledgement', async () => {
  vi.resetModules();
  ipc.removeAllListeners();
  runtime.spawnSync.mockReset().mockReturnValue({ status: 0, stdout: '', stderr: '' });
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

it('self-terminates after a persistent-session runner exits without checkpoints', async () => {
  await startRuntimeWithRunner();

  expect(runtime.spawn).toHaveBeenCalledTimes(1);
  runnerChild.emit('exit', 0, null);
  expect(runtime.spawn).toHaveBeenNthCalledWith(
    2,
    process.execPath,
    ['/fixture/terminator.mjs'],
    expect.objectContaining({
      cwd: '/opt/agent-runtime',
      env: expect.objectContaining({ MICROVM_ID: 'microvm-worker-exit-test' }),
      stdio: 'inherit',
    }),
  );
  expect(runtime.spawn).toHaveBeenCalledTimes(2);
});

it('does not self-terminate after service-requested runner termination', async () => {
  const { post } = await startRuntimeWithRunner();

  expect(await post('/aws/lambda-microvms/runtime/v1/terminate', {})).toEqual({
    status: 200,
    body: { ok: true, operation: 'terminate' },
  });
  expect(runtime.spawn).toHaveBeenCalledTimes(1);
});

it('carries only definitive steer rejection through runner IPC and the HTTP response', async () => {
  const { post } = await startRuntimeWithRunner();
  const { SessionSteerRejectedError } = await import('../../src/domain/session-errors.js');
  const { createRunnerControlBridge: bridgeFactory } = await import('../../src/runner/control.js');
  const bridge = bridgeFactory('worker-exit-run')!;
  let definitive = true;
  await bridge.hooks.onTurnStarted?.({ threadId: 'root', turnId: 'first', sessionItems: async () => [], interrupt: async () => {},
    steer: async () => { if (definitive) throw new SessionSteerRejectedError(); throw new Error('Unknown delivery outcome'); },
  });
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }];
  try {
    expect(await post('/agent-runtime/v1/runs/worker-exit-run/steer', { turnId: 'first', operationId: 'definitive', prompt: 'Continue', input }))
      .toMatchObject({ status: 409, body: { code: 'session_steer_rejected' } });
    definitive = false;
    const uncertain = await post('/agent-runtime/v1/runs/worker-exit-run/steer', { turnId: 'first', operationId: 'uncertain', prompt: 'Continue', input });
    expect(uncertain.status).toBe(409);
    expect(uncertain.body).not.toHaveProperty('code');
  } finally { bridge.close(); }
});
