import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexAppServerExecution, CodexAppServerRequest } from '../../src/runner/codex-app-server.js';

const runServer = vi.hoisted(() => vi.fn<(request: CodexAppServerRequest) => Promise<CodexAppServerExecution>>());
vi.mock('../../src/runner/codex-app-server.js', () => ({ runCodexAppServer: runServer }));

import { CodexDriver } from '../../src/runner/agent-driver.js';

beforeEach(() => {
  runServer.mockReset();
  vi.stubEnv('CODEX_AUTH_MODE', 'chatgpt');
  vi.stubEnv('DEFAULT_SANDBOX_MODE', 'read-only');
  vi.stubEnv('PERSISTENT_SESSION', 'false');
  vi.stubEnv('AGENT_THREAD_ID', undefined);
  vi.stubEnv('RUN_AGENT_UID', undefined);
  vi.stubEnv('RUN_AGENT_GID', undefined);
});

afterEach(() => vi.unstubAllEnvs());

function execution(): CodexAppServerExecution {
  return { fullText: 'done', durationMs: 17, events: Buffer.from('{}\n'), threadId: 'thread-1' };
}

describe('agent launch effects', () => {
  it('rejects invalid launch settings in the existing order before calling app-server', async () => {
    vi.stubEnv('CODEX_AUTH_MODE', 'invalid');
    vi.stubEnv('DEFAULT_SANDBOX_MODE', 'invalid');
    vi.stubEnv('AGENT_THREAD_ID', 'thread-resume');
    vi.stubEnv('RUN_AGENT_UID', '0');
    const driver = new CodexDriver();
    const launch = () => driver.execute({ version: '1', prompt: '' }, '/workspace', 0);

    await expect(launch()).rejects.toThrow('CODEX_AUTH_MODE must be bedrock or chatgpt');
    vi.stubEnv('CODEX_AUTH_MODE', 'chatgpt');
    await expect(launch()).rejects.toThrow('DEFAULT_SANDBOX_MODE is invalid');
    vi.stubEnv('DEFAULT_SANDBOX_MODE', 'read-only');
    await expect(launch()).rejects.toThrow('Codex thread resume requires a persistent MicroVM session');
    vi.stubEnv('PERSISTENT_SESSION', 'true');
    await expect(launch()).rejects.toThrow('RUN_AGENT_UID and RUN_AGENT_GID must both be positive integers');
    expect(runServer).not.toHaveBeenCalled();
  });

  it('bypasses an invalid default sandbox when the request supplies one', async () => {
    vi.stubEnv('DEFAULT_SANDBOX_MODE', 'invalid');
    runServer.mockResolvedValue(execution());
    await new CodexDriver().execute({ version: '1', prompt: '', agent: { sandbox: 'read-only' } }, '/workspace', 0);
    expect(runServer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sandbox: 'read-only', timeoutMs: 0 }));
  });

  it('forwards control and cancellation references without invoking them or mutating the execution', async () => {
    const signal = AbortSignal.abort();
    const control = {
      onEvent: vi.fn(), onServerRequest: vi.fn(), onTurnStarted: vi.fn(), dynamicTools: [],
    };
    const completed = Object.freeze(execution());
    runServer.mockResolvedValue(completed);

    const result = await new CodexDriver().execute({ version: '1', prompt: 'work' }, '/workspace', 123, signal, control);
    const planned = runServer.mock.calls[0]![0];
    expect(runServer).toHaveBeenCalledTimes(1);
    expect(planned.signal).toBe(signal);
    expect(planned.onEvent).toBe(control.onEvent);
    expect(planned.onServerRequest).toBe(control.onServerRequest);
    expect(planned.onTurnStarted).toBe(control.onTurnStarted);
    expect(planned.dynamicTools).toBe(control.dynamicTools);
    expect(control.onEvent).not.toHaveBeenCalled();
    expect(control.onServerRequest).not.toHaveBeenCalled();
    expect(control.onTurnStarted).not.toHaveBeenCalled();
    expect(result).toEqual({ ...completed, exitCode: 0 });
    expect(result).not.toBe(completed);
    expect(result.events).toBe(completed.events);
    expect(completed).not.toHaveProperty('exitCode');
  });

  it('propagates the exact process failure without discarding its partial execution', async () => {
    const cause = Object.assign(new Error('turn failed'), { execution: execution() });
    runServer.mockRejectedValue(cause);
    await expect(new CodexDriver().execute({ version: '1', prompt: 'work' }, '/workspace', 1_000)).rejects.toBe(cause);
    expect(runServer).toHaveBeenCalledTimes(1);
  });

  it('reads deployment settings for every execution and passes fresh child environments', async () => {
    vi.stubEnv('CODEX_CHATGPT_MODEL', 'chat-model');
    vi.stubEnv('DEFAULT_MODEL', 'bedrock-model');
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'deployment-token');
    vi.stubEnv('AGENT_PASSTHROUGH_ENV', '');
    vi.stubEnv('AGENT_PUBLICATION_ENABLED', 'false');
    runServer.mockResolvedValue(execution());
    const driver = new CodexDriver();
    const request = { version: '1', prompt: 'work' } as const;
    await driver.execute(request, '/workspace', 1_000);
    const first = runServer.mock.calls[0]![0];
    first.environment.PATH = 'changed by executor';

    vi.stubEnv('CODEX_AUTH_MODE', 'bedrock');
    vi.stubEnv('AGENT_PUBLICATION_ENABLED', 'true');
    await driver.execute(request, '/workspace', 1_000);
    const second = runServer.mock.calls[1]![0];

    expect(first).toMatchObject({ modelProvider: 'openai', model: 'chat-model' });
    expect(first.environment).not.toHaveProperty('AWS_BEARER_TOKEN_BEDROCK');
    expect(first.prompt).not.toContain('share.json');
    expect(second).toMatchObject({ modelProvider: 'amazon-bedrock', model: 'bedrock-model' });
    expect(second.environment.AWS_BEARER_TOKEN_BEDROCK).toBe('deployment-token');
    expect(second.environment.PATH).toBe(process.env.PATH);
    expect(second.prompt).toContain('share.json');
    expect(second.environment).not.toBe(first.environment);
    expect(second).not.toHaveProperty('binaryArguments');
  });
});
