import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const protocol = vi.hoisted(() => ({ initialize: vi.fn(), close: vi.fn(), options: undefined as unknown }));

vi.mock('../../src/adapters/codex-rpc.js', () => ({
  CodexRpcClient: class {
    constructor(options: { environment: { CODEX_HOME: string } }) {
      expect(statSync(options.environment.CODEX_HOME).isDirectory()).toBe(true);
      expect(statSync(options.environment.CODEX_HOME).mode & 0o777).toBe(0o700);
      protocol.options = options;
    }
    initialize = protocol.initialize;
    close = protocol.close;
  },
}));

let home: string;
beforeEach(async () => {
  vi.resetModules();
  protocol.initialize.mockReset().mockResolvedValue(undefined);
  protocol.close.mockReset().mockResolvedValue(undefined);
  protocol.options = undefined;
  home = await mkdtemp(join(tmpdir(), 'rat-image-validation-'));
  vi.stubEnv('CODEX_BINARY', '/opt/codex-runtime/bin/codex');
  vi.stubEnv('HOME', home);
  vi.stubEnv('CODEX_HOME', join(home, '.codex'));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

it('performs only the bounded initialize handshake with a scrubbed environment, then closes', async () => {
  await import('../../src/runner/image-validation.js');

  expect(protocol.options).toMatchObject({
    binary: '/opt/codex-runtime/bin/codex',
    cwd: home,
    environment: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
    },
  });
  expect(Object.keys((protocol.options as { environment: Record<string, string> }).environment).sort())
    .toEqual(['CODEX_HOME', 'HOME', 'PATH']);
  expect(protocol.initialize).toHaveBeenCalledExactlyOnceWith(120_000);
  expect(protocol.close).toHaveBeenCalledOnce();
});

it('does not launch Codex when its private home cannot be prepared', async () => {
  await writeFile(join(home, '.codex'), 'not a directory');
  await expect(import('../../src/runner/image-validation.js')).rejects.toThrow();
  expect(protocol.options).toBeUndefined();
  expect(protocol.initialize).not.toHaveBeenCalled();
});

it('closes the Codex process when initialization fails', async () => {
  protocol.initialize.mockRejectedValueOnce(new Error('initialization failed'));

  await expect(import('../../src/runner/image-validation.js')).rejects.toThrow('initialization failed');
  expect(protocol.close).toHaveBeenCalledOnce();
});
