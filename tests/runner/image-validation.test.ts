import { beforeEach, expect, it, vi } from 'vitest';

const protocol = vi.hoisted(() => ({ initialize: vi.fn(), close: vi.fn(), options: undefined as unknown }));

vi.mock('../../src/adapters/codex-rpc.js', () => ({
  CodexRpcClient: class {
    constructor(options: unknown) { protocol.options = options; }
    initialize = protocol.initialize;
    close = protocol.close;
  },
}));

beforeEach(() => {
  vi.resetModules();
  protocol.initialize.mockReset().mockResolvedValue(undefined);
  protocol.close.mockReset().mockResolvedValue(undefined);
  protocol.options = undefined;
  vi.stubEnv('CODEX_BINARY', '/opt/codex-runtime/bin/codex');
  vi.stubEnv('HOME', '/tmp/image-validation/home');
  vi.stubEnv('CODEX_HOME', '/tmp/image-validation/home/.codex');
});

it('performs only the bounded initialize handshake with a scrubbed environment, then closes', async () => {
  await import('../../src/runner/image-validation.js');

  expect(protocol.options).toMatchObject({
    binary: '/opt/codex-runtime/bin/codex',
    cwd: '/tmp/image-validation/home',
    environment: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp/image-validation/home',
      CODEX_HOME: '/tmp/image-validation/home/.codex',
    },
  });
  expect(Object.keys((protocol.options as { environment: Record<string, string> }).environment).sort())
    .toEqual(['CODEX_HOME', 'HOME', 'PATH']);
  expect(protocol.initialize).toHaveBeenCalledExactlyOnceWith(120_000);
  expect(protocol.close).toHaveBeenCalledOnce();
});

it('closes the Codex process when initialization fails', async () => {
  protocol.initialize.mockRejectedValueOnce(new Error('initialization failed'));

  await expect(import('../../src/runner/image-validation.js')).rejects.toThrow('initialization failed');
  expect(protocol.close).toHaveBeenCalledOnce();
});
