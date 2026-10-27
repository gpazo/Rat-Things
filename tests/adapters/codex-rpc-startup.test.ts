import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexRpcClient } from '../../src/adapters/codex-rpc.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));

function fixture(signal?: AbortSignal, purpose?: 'setup' | 'session') {
  const child = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null as number | null, signalCode: null as string | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((signal: string) => { child.signalCode = signal; child.emit('exit', null, signal); child.emit('close', null, signal); return true; }),
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  const client = new CodexRpcClient({ binary: '/fixture/codex', cwd: '/', environment: {}, ...(signal ? { signal } : {}), ...(purpose ? { startupPurpose: purpose } : {}) });
  const requests: Array<{ id?: number; method: string }> = [];
  child.stdin.on('data', data => requests.push(JSON.parse(String(data))));
  return { child, client, requests };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('allows a bounded cold initialize without extending subsequent RPC deadlines', async () => {
  const { child, client, requests } = fixture();
  try {
    const initialized = client.initialize(120_000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(requests.map(request => request.method)).toEqual(['initialize']);
    child.stdout.write(`${JSON.stringify({ id: requests[0]!.id, result: {} })}\n`);
    await initialized;
    expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized']);
    const ordinary = expect(client.call('config/read', {})).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await ordinary;
  } finally { await client.close(); }
});

it.each([undefined, 120_000])('rejects initialize at its exact deadline (%s)', async timeout => {
  const { client, requests } = fixture();
  try {
    let settled = false;
    const rejected = expect(client.initialize(timeout).finally(() => { settled = true; })).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync((timeout ?? 30_000) - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(requests.map(request => request.method)).toEqual(['initialize']);
  } finally { await client.close(); }
});

it.each(['abort', 'exit'] as const)('interrupts cold initialization promptly on %s', async reason => {
  const abort = new AbortController();
  const { child, client, requests } = fixture(abort.signal);
  try {
    const rejected = expect(client.initialize(120_000)).rejects.toThrow('closed');
    await vi.advanceTimersByTimeAsync(40_000);
    if (reason === 'abort') abort.abort();
    else { child.exitCode = 1; child.emit('exit', 1, null); child.emit('close', 1, null); }
    await rejected;
    expect(requests.map(request => request.method)).toEqual(['initialize']);
    if (reason === 'abort') expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  } finally { await client.close(); }
});

it('reports only fixed startup labels and bounded elapsed time after successful initialization', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const { child, client, requests } = fixture(undefined, 'setup');
  try {
    const initialized = client.initialize(120_000);
    clock.mockReturnValue(40_000);
    child.stdout.write(`${JSON.stringify({ id: requests[0]!.id, result: { private: 'native-output-must-not-be-logged' } })}\n`);
    await initialized;
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0]![0] as string)).toEqual({
      message: 'Native harness initialized', purpose: 'setup', ordinal: expect.any(Number), elapsedMs: 40_000,
    });
  } finally { await client.close(); }
});
