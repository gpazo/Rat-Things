import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCodexAppServerMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/runner/codex-app-server.js', () => ({
  runCodexAppServer: runCodexAppServerMock,
}));

import {
  CodexDriver,
  driverFor,
  MockDriver,
} from '../../src/runner/agent-driver.js';

beforeEach(() => {
  runCodexAppServerMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('agent driver selection and mock execution', () => {
  it('selects each supported driver', () => {
    expect(driverFor('codex')).toBeInstanceOf(CodexDriver);
    expect(driverFor('mock')).toBeInstanceOf(MockDriver);
  });

  it('returns deterministic structured output from the mock driver', async () => {
    const execution = await new MockDriver().execute({ version: '1', prompt: 'return the marker' });

    expect(execution).toMatchObject({
      fullText: 'mock-agent: return the marker',
      exitCode: 0,
      events: Buffer.from(
        `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'mock-agent: return the marker' },
        })}\n`,
      ),
      threadId: 'mock-thread',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(execution.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('CodexDriver', () => {
  it('resumes a persisted Codex app-server thread inside a conversation MicroVM', async () => {
    vi.stubEnv('PERSISTENT_SESSION', 'true');
    vi.stubEnv('AGENT_THREAD_ID', 'thread-persisted-1');
    runCodexAppServerMock.mockResolvedValue(execution('continued', 'thread-persisted-1'));

    const result = await new CodexDriver().execute(
      { version: '1', prompt: 'continue the task', agent: { sandbox: 'read-only' } },
      '/tmp/persistent-workspace',
      30_000,
    );

    expect(runCodexAppServerMock).toHaveBeenCalledWith(expect.objectContaining({
      workspace: '/tmp/persistent-workspace',
      binaryArguments: ['-c', 'cli_auth_credentials_store=file', 'app-server'],
      prompt: expect.stringContaining('User request:\n\ncontinue the task'),
      sandbox: 'read-only',
      persistent: true,
      resumeThreadId: 'thread-persisted-1',
      modelProvider: 'openai',
    }));
    expect(result).toMatchObject({ fullText: 'continued', threadId: 'thread-persisted-1', exitCode: 0 });
  });

  it('passes model, reasoning, schema, capability, and sandbox controls to app-server', async () => {
    vi.stubEnv('CODEX_BINARY', '/opt/runtime/bin/codex');
    runCodexAppServerMock.mockResolvedValue({
      ...execution('The review is complete.', 'thread-123'),
      durationMs: 321,
      usage: {
        inputTokens: 11,
        cachedInputTokens: 3,
        outputTokens: 5,
        reasoningOutputTokens: 2,
      },
    });

    const result = await new CodexDriver().execute(
      {
        version: '1',
        prompt: 'Review; $(touch /tmp/not-a-shell-command)',
        agent: {
          model: 'openai.gpt-5.6-terra',
          sandbox: 'workspace-write',
          reasoningEffort: 'high',
          reasoningSummary: 'concise',
          personality: 'pragmatic',
          capabilities: {
            networkAccess: true,
            webSearch: 'live',
            skills: ['support-triage'],
            apps: ['gmail', 'google-calendar'],
            mcpServers: ['inventory'],
          },
          outputSchema: { type: 'object', required: ['summary'] },
        },
      },
      '/tmp/workspace',
      45_000,
    );

    expect(runCodexAppServerMock).toHaveBeenCalledWith(expect.objectContaining({
      binary: '/opt/runtime/bin/codex',
      workspace: '/tmp/workspace',
      timeoutMs: 45_000,
      prompt: expect.stringContaining('User request:\n\nReview; $(touch /tmp/not-a-shell-command)'),
      model: 'openai.gpt-5.6-terra',
      reasoningEffort: 'high',
      reasoningSummary: 'concise',
      personality: 'pragmatic',
      outputSchema: { type: 'object', required: ['summary'] },
      sandbox: 'workspace-write',
      networkAccess: true,
      webSearch: 'live',
      skills: ['support-triage'],
      apps: ['gmail', 'google-calendar'],
      mcpServers: ['inventory'],
      persistent: false,
    }));
    expect(result).toEqual(expect.objectContaining({
      fullText: 'The review is complete.',
      exitCode: 0,
      durationMs: 321,
      threadId: 'thread-123',
    }));
  });

  it('surfaces app-server failures', async () => {
    runCodexAppServerMock.mockRejectedValue(new Error('model access is not enabled'));

    await expect(
      new CodexDriver().execute({ version: '1', prompt: 'hello' }, process.cwd(), 1_000),
    ).rejects.toThrow('model access is not enabled');
  });

  it('uses cached ChatGPT authentication without passing a stale Bedrock token', async () => {
    vi.stubEnv('CODEX_AUTH_MODE', 'chatgpt');
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'must-not-be-exposed');
    runCodexAppServerMock.mockResolvedValue(execution('account-authenticated', 'thread-account'));

    const result = await new CodexDriver().execute(
      { version: '1', prompt: 'return the marker' },
      process.cwd(),
      1_000,
    );

    const options = runCodexAppServerMock.mock.calls[0]?.[0];
    expect(options.modelProvider).toBe('openai');
    expect(options.environment.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(result.fullText).toBe('account-authenticated');
  });

  it('uses CODEX_HOME auth.json instead of forwarding a standalone access token', async () => {
    vi.stubEnv('CODEX_AUTH_MODE', 'chatgpt');
    vi.stubEnv('CODEX_HOME', '/tmp/cloud-codex-home');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'workspace-agent-token');
    runCodexAppServerMock.mockResolvedValue(execution('cloud-handoff', 'thread-cloud'));

    await new CodexDriver().execute(
      { version: '1', prompt: 'continue this work in the cloud' },
      process.cwd(),
      1_000,
    );

    const options = runCodexAppServerMock.mock.calls[0]?.[0];
    expect(options.modelProvider).toBe('openai');
    expect(options.environment.CODEX_HOME).toBe('/tmp/cloud-codex-home');
    expect(options.environment.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(options.environment.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  it('passes network access independently from the inner sandbox mode', async () => {
    vi.stubEnv('CODEX_AUTH_MODE', 'chatgpt');
    vi.stubEnv('CODEX_TOOL_NETWORK_ACCESS', 'true');
    runCodexAppServerMock.mockResolvedValue(execution('network-tested', 'thread-network'));

    await new CodexDriver().execute(
      {
        version: '1',
        prompt: 'test network',
        agent: { sandbox: 'workspace-write' },
      },
      process.cwd(),
      1_000,
    );

    expect(runCodexAppServerMock).toHaveBeenCalledWith(expect.objectContaining({
      networkAccess: true,
      sandbox: 'workspace-write',
    }));

    await new CodexDriver().execute(
      { version: '1', prompt: 'test network', agent: { sandbox: 'read-only' } },
      process.cwd(),
      1_000,
    );
    expect(runCodexAppServerMock).toHaveBeenLastCalledWith(expect.objectContaining({
      networkAccess: true,
      sandbox: 'read-only',
    }));
  });

  it('downgrades danger-full-access when command networking is explicitly disabled', async () => {
    vi.stubEnv('CODEX_AUTH_MODE', 'chatgpt');
    runCodexAppServerMock.mockResolvedValue(execution('network-disabled', 'thread-network-off'));

    await new CodexDriver().execute(
      {
        version: '1',
        prompt: 'work without network access',
        agent: {
          sandbox: 'danger-full-access',
          capabilities: { networkAccess: false },
        },
      },
      '/tmp/workspace',
      1_000,
    );

    expect(runCodexAppServerMock).toHaveBeenCalledWith(expect.objectContaining({
      networkAccess: false,
      sandbox: 'workspace-write',
    }));
  });
});

function execution(fullText: string, threadId: string) {
  return {
    fullText,
    durationMs: 1,
    events: Buffer.from('{}\n'),
    threadId,
  };
}
