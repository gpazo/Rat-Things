import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const protocol = vi.hoisted(() => ({ initialize: vi.fn(), call: vi.fn(), close: vi.fn(), warm: vi.fn(), options: undefined as unknown }));

vi.mock('../../src/runner/image-storage-warmup.js', () => ({
  warmImageStorageUtilities: protocol.warm,
}));

vi.mock('../../src/adapters/codex-rpc.js', () => ({
  CodexRpcClient: class {
    constructor(options: { environment: { CODEX_HOME: string } }) {
      expect(protocol.warm).toHaveBeenCalledOnce();
      expect(statSync(options.environment.CODEX_HOME).isDirectory()).toBe(true);
      expect(statSync(options.environment.CODEX_HOME).mode & 0o777).toBe(0o700);
      protocol.options = options;
    }
    initialize = protocol.initialize;
    call = protocol.call;
    close = protocol.close;
  },
}));

let home: string;
beforeEach(async () => {
  vi.resetModules();
  protocol.initialize.mockReset().mockResolvedValue(undefined);
  protocol.call.mockReset().mockResolvedValue({ thread: { id: 'ephemeral-thread' } });
  protocol.close.mockReset().mockResolvedValue(undefined);
  protocol.warm.mockReset().mockResolvedValue(undefined);
  protocol.options = undefined;
  home = await mkdtemp(join(tmpdir(), 'rat-image-validation-'));
  vi.stubEnv('CODEX_BINARY', '/opt/codex-runtime/bin/codex');
  vi.stubEnv('HOME', home);
  vi.stubEnv('CODEX_HOME', join(home, '.codex'));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

it('prepares storage utilities, initializes Codex, starts one bounded ephemeral thread, then closes', async () => {
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
  expect(protocol.warm).toHaveBeenCalledExactlyOnceWith(home);
  expect(Object.keys((protocol.options as { environment: Record<string, string> }).environment).sort())
    .toEqual(['CODEX_HOME', 'HOME', 'PATH']);
  expect(protocol.initialize).toHaveBeenCalledExactlyOnceWith(120_000);
  expect(protocol.call).toHaveBeenCalledExactlyOnceWith('thread/start', {
    cwd: home,
    model: 'rat-image-warmup',
    modelProvider: 'rat-image-warmup',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    selectedCapabilityRoots: [],
    dynamicTools: [],
    config: {
      'features.shell_tool': false,
      'features.view_image': false,
      web_search: 'disabled',
      'features.default_mode_request_user_input': false,
      'tools.experimental_request_user_input.enabled': false,
      'orchestrator.skills.enabled': false,
      'skills.bundled.enabled': false,
      'features.goals': false,
    },
  }, 30_000);
  expect((protocol.options as { environment: Record<string, string> }).environment.CODEX_HOME)
    .toBe(join(home, '.codex'));
  const { readFile } = await import('node:fs/promises');
  await expect(readFile(join(home, '.codex', 'config.toml'), 'utf8'))
    .resolves.toContain('base_url = "http://127.0.0.1:9/v1"');
  expect(protocol.close).toHaveBeenCalledOnce();
});

it('does not launch Codex when its private home cannot be prepared', async () => {
  await writeFile(join(home, '.codex'), 'not a directory');
  await expect(import('../../src/runner/image-validation.js')).rejects.toThrow();
  expect(protocol.warm).not.toHaveBeenCalled();
  expect(protocol.options).toBeUndefined();
  expect(protocol.initialize).not.toHaveBeenCalled();
  expect(protocol.call).not.toHaveBeenCalled();
});

it('does not launch Codex when storage utility warmup fails', async () => {
  protocol.warm.mockRejectedValueOnce(new Error('warmup failed'));

  await expect(import('../../src/runner/image-validation.js')).rejects.toThrow('warmup failed');
  expect(protocol.options).toBeUndefined();
  expect(protocol.initialize).not.toHaveBeenCalled();
  expect(protocol.call).not.toHaveBeenCalled();
});

it('closes the Codex process when initialization fails', async () => {
  protocol.initialize.mockRejectedValueOnce(new Error('initialization failed'));

  await expect(import('../../src/runner/image-validation.js')).rejects.toThrow('initialization failed');
  expect(protocol.call).not.toHaveBeenCalled();
  expect(protocol.close).toHaveBeenCalledOnce();
});

it('closes Codex if the ephemeral thread response has no nonempty id', async () => {
  protocol.call.mockResolvedValueOnce({ thread: { id: ' ' } });

  await expect(import('../../src/runner/image-validation.js')).rejects.toThrow('could not start its ephemeral Codex thread');
  expect(protocol.call).toHaveBeenCalledOnce();
  expect(protocol.close).toHaveBeenCalledOnce();
});

it('closes Codex if ephemeral thread startup fails', async () => {
  protocol.call.mockRejectedValueOnce(new Error('thread start failed'));

  await expect(import('../../src/runner/image-validation.js')).rejects.toThrow('thread start failed');
  expect(protocol.call).toHaveBeenCalledOnce();
  expect(protocol.close).toHaveBeenCalledOnce();
});
