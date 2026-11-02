import { access, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecurityProof } from '../../testing/aws/super-security-proof.js';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(() => {}, { [promisify.custom]: invoke }) };
});

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

function response(body: string, metadata = { StatusCode: 200, FunctionError: undefined as string | undefined }) {
  vi.stubEnv('AWS_E2E_WATCHDOG_FUNCTION_NAME', 'rat-things-test-watchdog');
  let path = '';
  invoke.mockImplementation(async (_command: string, args: string[]) => {
    path = args[args.indexOf('--cli-binary-format') + 2]!;
    await writeFile(path, body);
    return { stdout: JSON.stringify(metadata), stderr: '' };
  });
  return {
    tick: () => SecurityProof.prototype.tick.call({ region: 'us-west-2' } as SecurityProof),
    path: () => path,
  };
}

describe('live watchdog invocation evidence', () => {
  it.each([
    { candidates: 0, reports: 0, errors: 0, partial: false },
    { candidates: 1, reports: 0, errors: 0, partial: true },
    { candidates: 1, reports: 0, errors: 1, partial: false },
  ])('retains scan completion and error evidence %j', async scan => {
    const f = response(JSON.stringify(scan));
    expect(await f.tick()).toEqual(scan);
    expect(invoke.mock.calls[0]?.[0]).toBe('aws');
    await expect(access(f.path())).rejects.toThrow();
  });

  it.each(['', '{}', 'null', '{"partial":false,"candidates":0,"reports":0,"errors":-1}', '{"partial":"false","candidates":0,"reports":0,"errors":0}', 'x'.repeat(4097)])('rejects invalid or oversized response %#', async body => {
    const f = response(body);
    await expect(f.tick()).rejects.toThrow();
    await expect(access(f.path())).rejects.toThrow();
  });

  it('rejects a Lambda function error even when the transport succeeds', async () => {
    const f = response('{}', { StatusCode: 200, FunctionError: 'Unhandled' });
    await expect(f.tick()).rejects.toThrow('deployed watchdog invocation');
    await expect(access(f.path())).rejects.toThrow();
  });
});
