import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { verifyManagedExecutor } from '../../src/runner/managed-executor-verification.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));

type Request = { id?: number; method: string };

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null as number | null, signalCode: null as string | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((signal: string) => { child.signalCode = signal; child.emit('exit', null, signal); child.emit('close', null, signal); return true; }),
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  const requests: Request[] = [];
  const received = new EventEmitter();
  child.stdin.on('data', data => {
    const request = JSON.parse(String(data)) as Request;
    requests.push(request);
    received.emit(request.method, request);
  });
  const request = (method: string): Promise<Request> => {
    const existing = requests.find(candidate => candidate.method === method);
    return existing ? Promise.resolve(existing) : new Promise(resolve => received.once(method, resolve));
  };
  const reply = (request: Request, result: unknown) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  const workspace = tmpdir();
  const plan = planCodexLaunch({ version: '1', prompt: 'unused' }, workspace, 1000, {
    CODEX_BINARY: '/fixture/codex', CODEX_AUTH_MODE: 'chatgpt', PATH: process.env.PATH,
  });
  const verify = (signal?: AbortSignal) => verifyManagedExecutor({
    plan, workspace, network: { access: 'disabled', allowed_domains: [] }, credentialProxy: false, ...(signal ? { signal } : {}),
  });
  const home = () => vi.mocked(spawn).mock.calls[0]![2]!.env!.CODEX_HOME!;
  return { child, requests, request, reply, verify, home };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('waits beyond 30 seconds for the managed handshake before checking policy and refusing an invalid executor', async () => {
  const f = fixture();
  const refused = expect(f.verify()).rejects.toThrow('Managed executor policy could not be verified');
  const initialize = await f.request('initialize');
  await vi.advanceTimersByTimeAsync(40_000);
  expect(f.requests.map(request => request.method)).toEqual(['initialize']);
  expect(f.child.kill).not.toHaveBeenCalled();
  f.reply(initialize, {});
  f.reply(await f.request('config/read'), {});
  f.reply(await f.request('configRequirements/read'), {});
  await refused;
  expect(f.requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'config/read', 'configRequirements/read']);
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  await expect(access(f.home())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses managed startup at 120 seconds without running policy or sandbox commands', async () => {
  const f = fixture();
  let settled = false;
  const refused = expect(f.verify().finally(() => { settled = true; })).rejects.toThrow('timed out');
  await f.request('initialize');
  await vi.advanceTimersByTimeAsync(119_999);
  expect(settled).toBe(false);
  expect(f.child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await refused;
  expect(f.requests.map(request => request.method)).toEqual(['initialize']);
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  await expect(access(f.home())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels managed startup promptly without running policy or sandbox commands', async () => {
  const f = fixture();
  const abort = new AbortController();
  const refused = expect(f.verify(abort.signal)).rejects.toThrow('closed');
  await f.request('initialize');
  await vi.advanceTimersByTimeAsync(40_000);
  abort.abort();
  await refused;
  expect(f.requests.map(request => request.method)).toEqual(['initialize']);
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  await expect(access(f.home())).rejects.toMatchObject({ code: 'ENOENT' });
});
