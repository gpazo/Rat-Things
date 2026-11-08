import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  handler: undefined as ((request: unknown, response: unknown) => Promise<void>) | undefined,
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  rmSync: vi.fn(),
  server: { on: vi.fn().mockReturnThis(), listen: vi.fn((_port: number, _host: string, callback?: () => void) => callback?.()), close: vi.fn() },
}));

vi.mock('node:http', () => ({ createServer: (handler: typeof runtime.handler) => { runtime.handler = handler; return runtime.server; } }));
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => runtime.spawn(...args), spawnSync: () => runtime.spawnSync() }));
vi.mock('node:fs', () => ({
  chownSync: vi.fn(), chmodSync: vi.fn(), copyFileSync: vi.fn(), existsSync: vi.fn(() => true),
  lstatSync: vi.fn(), mkdirSync: vi.fn(), rmSync: () => runtime.rmSync(),
}));
vi.mock('../../microvm/runtime-network-policy.mjs', () => ({ ensureUntrustedUidCannotReachPort: vi.fn() }));
vi.mock('../../microvm/runtime-process-policy.mjs', () => ({ trustedRunnerOptions: () => ({}) }));

const actualProcess = process;
const ipc = new EventEmitter();
let groupKilled = false;
let groupRequiresKill = false;
const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
  if (signal === 'SIGKILL') groupKilled = true;
  if (signal === 'SIGTERM' && groupRequiresKill) return true;
  if (signal === 0 && groupRequiresKill && !groupKilled) return true;
  throw Object.assign(new Error('process group is absent'), { code: 'ESRCH' });
});
const processProxy = new Proxy(actualProcess, {
  get(target, property) {
    if (property === 'getuid') return () => 0;
    if (property === 'kill') return killProcess;
    if (property === 'on' || property === 'once' || property === 'removeListener' || property === 'emit') return Reflect.get(ipc, property, ipc).bind(ipc);
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function runtimeHandler() {
  vi.resetModules();
  vi.stubEnv('AGENT_RUNNER_ENTRY', '/fixture/runner.mjs');
  vi.stubEnv('AGENT_TERMINATOR_ENTRY', '/fixture/terminator.mjs');
  vi.stubEnv('RUN_AGENT_UID', '10001');
  vi.stubEnv('RUN_AGENT_GID', '10001');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'must-not-be-inherited');
  vi.stubGlobal('process', processProxy);
  await import('../../microvm/runtime-server.mjs');
  if (!runtime.handler) throw new Error('runtime HTTP handler was not installed');
  return runtime.handler;
}

async function post(handler: NonNullable<typeof runtime.handler>, url: string, body: unknown = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  const request = Object.assign(Readable.from([encoded]), { method: 'POST', url, headers: { 'content-length': String(encoded.length) } });
  const response = { statusCode: 0, body: '', setHeader() {}, end(value: string) { this.body = value; } };
  await handler(request, response);
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

function childProcess(pid: number | null = 423) {
  return Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });
}

beforeEach(() => {
  runtime.spawn.mockReset(); runtime.spawnSync.mockClear(); runtime.rmSync.mockReset(); ipc.removeAllListeners();
  killProcess.mockClear(); groupKilled = false; groupRequiresKill = false;
});

it('keeps ready cheap and returns validate success only after an isolated Codex initialize process exits', async () => {
  const child = childProcess();
  runtime.spawn.mockReturnValue(child);
  const handler = await runtimeHandler();

  expect(await post(handler, '/aws/lambda-microvms/runtime/v1/ready')).toMatchObject({ status: 200 });
  expect(runtime.spawn).not.toHaveBeenCalled();

  expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 503 });
  await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce());
  const [binary, args, options] = runtime.spawn.mock.calls[0]!;
  expect(binary).toBe('/usr/bin/unshare');
  expect(args).toEqual([
    '--net', '--pid', '--mount-proc', '--fork', '--kill-child=KILL', '--',
    '/usr/bin/setpriv', '--reuid=10001', '--regid=10001', '--clear-groups',
    process.execPath, '/opt/agent-runtime/image-validation.mjs',
  ]);
  expect(options).toMatchObject({ detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    CODEX_BINARY: '/opt/codex-runtime/bin/codex',
  } });
  expect(Object.keys(options.env).sort()).toEqual(['CODEX_BINARY', 'CODEX_HOME', 'HOME', 'PATH']);
  expect(options.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();

  expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 503 });
  groupRequiresKill = true;
  child.exitCode = 0;
  child.emit('close', 0, null);
  await vi.waitFor(async () => expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 200 }), { timeout: 3_000 });
  expect(killProcess).toHaveBeenCalledWith(-423, 'SIGTERM');
  expect(killProcess).toHaveBeenCalledWith(-423, 'SIGKILL');
  expect(runtime.rmSync).toHaveBeenCalledOnce();
  expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 200 });
  expect(runtime.spawn).toHaveBeenCalledOnce();
});

it('keeps a failed validation closed and does not retry the Codex process', async () => {
  const child = childProcess();
  runtime.spawn.mockReturnValue(child);
  const handler = await runtimeHandler();
  expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 503 });
  await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce());
  child.exitCode = 1;
  child.emit('close', 1, null);

  await vi.waitFor(async () => expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 500 }));
  await expect(post(handler, '/aws/lambda-microvms/runtime/v1/validate')).resolves.toMatchObject({ status: 500 });
  expect(runtime.spawn).toHaveBeenCalledOnce();
});

it('refuses validation while an actual Run is active', async () => {
  runtime.spawn.mockReturnValue(childProcess());
  const handler = await runtimeHandler();
  const run = {
    version: 1,
    runId: 'active-validation-test',
    executionGeneration: 'b'.repeat(64),
    region: 'us-east-1',
    timeoutSeconds: 60,
    inputBucket: 'rat-things-inputs',
    inputKey: 'runs/input.json',
    runsTableName: 'rat-things-runs',
    integrationsTableName: 'rat-things-integrations',
    artifactBucket: 'rat-things-artifacts',
    heartbeatIntervalMs: 1_000,
    persistentSession: false,
    allowedRepositoryHosts: 'github.com',
    allowedSandboxModes: 'read-only',
    defaultSandboxMode: 'read-only',
    defaultAgentNetworkAccess: false,
    allowAgentAwsCredentialChain: false,
  };

  expect(await post(handler, '/aws/lambda-microvms/runtime/v1/run', {
    microvmId: 'active-validation-test-vm', runHookPayload: JSON.stringify(run),
  })).toMatchObject({ status: 200 });
  expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 409 });
  expect(runtime.spawn).toHaveBeenCalledOnce();
});

it('fails closed when the unshare process cannot start and has no pid', async () => {
  const child = childProcess(null);
  runtime.spawn.mockReturnValue(child);
  const handler = await runtimeHandler();

  expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 503 });
  child.emit('error', new Error('unshare could not start'));
  await vi.waitFor(async () => expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 500 }));
  expect(killProcess).not.toHaveBeenCalled();
  expect(runtime.rmSync).toHaveBeenCalledOnce();
});

it('does not report validation success when disposable-home cleanup fails', async () => {
  const child = childProcess();
  runtime.spawn.mockReturnValue(child);
  runtime.rmSync.mockImplementationOnce(() => { throw new Error('cleanup failed'); });
  const handler = await runtimeHandler();

  expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 503 });
  child.exitCode = 0;
  child.emit('close', 0, null);
  await vi.waitFor(async () => expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 500 }));
  expect(runtime.rmSync).toHaveBeenCalledOnce();
});

it('fails a timed out initialize and tears down its process group', async () => {
  const child = childProcess();
  runtime.spawn.mockReturnValue(child);
  const handler = await runtimeHandler();
  vi.useFakeTimers();
  try {
    expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(180_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(await post(handler, '/aws/lambda-microvms/runtime/v1/validate')).toMatchObject({ status: 500 });
    expect(killProcess).toHaveBeenCalledWith(-423, 'SIGTERM');
    expect(runtime.rmSync).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
