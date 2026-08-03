import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/runner/process.js', () => ({
  runProcess: runProcessMock,
}));

import {
  CodexDriver,
  driverFor,
  MockDriver,
} from '../../src/runner/agent-driver.js';

beforeEach(() => {
  runProcessMock.mockReset();
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

    expect(execution).toEqual({
      fullText: 'mock-agent: return the marker',
      exitCode: 0,
      durationMs: 0,
      events: Buffer.from(
        `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'mock-agent: return the marker' },
        })}\n`,
      ),
      threadId: 'mock-thread',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });
});

describe('CodexDriver', () => {
  it('uses an argument array, writes the output schema, and parses JSONL events', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'runtime-codex-driver-'));
    vi.stubEnv('CODEX_BINARY', '/opt/runtime/bin/codex');
    const eventLines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'The review is complete.' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 11,
          cached_input_tokens: 3,
          output_tokens: 5,
          reasoning_output_tokens: 2,
        },
      }),
    ];
    let capturedSchema: unknown;
    runProcessMock.mockImplementation(async (_command, _args, options) => {
      capturedSchema = JSON.parse(
        await readFile(join(workspace, '.agent-output-schema.json'), 'utf8'),
      ) as unknown;
      for (const line of eventLines) options.onStdoutLine?.(line);
      return {
        exitCode: 0,
        stdout: Buffer.from(eventLines.join('\n')),
        stderr: Buffer.alloc(0),
        durationMs: 321,
      };
    });

    try {
      const execution = await new CodexDriver().execute(
        {
          version: '1',
          prompt: 'Review; $(touch /tmp/not-a-shell-command)',
          agent: {
            model: 'openai.gpt-5.6-terra',
            sandbox: 'workspace-write',
            reasoningEffort: 'high',
            outputSchema: { type: 'object', required: ['summary'] },
          },
        },
        workspace,
        45_000,
      );

      expect(runProcessMock).toHaveBeenCalledTimes(1);
      const [command, args, options] = runProcessMock.mock.calls[0]!;
      expect(command).toBe('/opt/runtime/bin/codex');
      expect(args).toEqual([
        '--ask-for-approval',
        'never',
        '--config',
        'model_provider="amazon-bedrock"',
        'exec',
        '--ephemeral',
        '--json',
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        '--cd',
        workspace,
        '--model',
        'openai.gpt-5.6-terra',
        '--config',
        'model_reasoning_effort="high"',
        '--output-schema',
        join(workspace, '.agent-output-schema.json'),
        'Review; $(touch /tmp/not-a-shell-command)',
      ]);
      expect(options).toMatchObject({ cwd: workspace, timeoutMs: 45_000 });
      expect(capturedSchema).toEqual({
        type: 'object',
        required: ['summary'],
      });
      await expect(readFile(join(workspace, '.agent-output-schema.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(execution).toEqual({
        fullText: 'The review is complete.',
        exitCode: 0,
        durationMs: 321,
        events: Buffer.from(`${eventLines.join('\n')}\n`),
        threadId: 'thread-123',
        usage: {
          inputTokens: 11,
          cachedInputTokens: 3,
          outputTokens: 5,
          reasoningOutputTokens: 2,
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects successful processes that produce no agent message', async () => {
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      durationMs: 1,
    });

    await expect(
      new CodexDriver().execute({ version: '1', prompt: 'hello' }, process.cwd(), 1_000),
    ).rejects.toThrow('Codex completed without an agent message (exit 0)');
  });

  it('uses cached ChatGPT authentication without passing a stale Bedrock token', async () => {
    vi.stubEnv('CODEX_AUTH_MODE', 'chatgpt');
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'must-not-be-exposed');
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'account-authenticated' },
    });
    runProcessMock.mockImplementation(async (_command, _args, options) => {
      options.onStdoutLine?.(line);
      return {
        exitCode: 0,
        stdout: Buffer.from(`${line}\n`),
        stderr: Buffer.alloc(0),
        durationMs: 1,
      };
    });

    const execution = await new CodexDriver().execute(
      { version: '1', prompt: 'return the marker' },
      process.cwd(),
      1_000,
    );

    const [, args, options] = runProcessMock.mock.calls[0]!;
    expect(args.slice(0, 5)).toEqual([
      '--ask-for-approval',
      'never',
      '--config',
      'model_provider="openai"',
      'exec',
    ]);
    expect(options.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(execution.fullText).toBe('account-authenticated');
  });

  it('enables command network access only with the workspace-write sandbox', async () => {
    vi.stubEnv('CODEX_AUTH_MODE', 'chatgpt');
    vi.stubEnv('CODEX_TOOL_NETWORK_ACCESS', 'true');
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'network-tested' },
    });
    runProcessMock.mockImplementation(async (_command, _args, options) => {
      options.onStdoutLine?.(line);
      return {
        exitCode: 0,
        stdout: Buffer.from(`${line}\n`),
        stderr: Buffer.alloc(0),
        durationMs: 1,
      };
    });

    await new CodexDriver().execute(
      {
        version: '1',
        prompt: 'test network',
        agent: { sandbox: 'workspace-write' },
      },
      process.cwd(),
      1_000,
    );

    const [, args] = runProcessMock.mock.calls[0]!;
    expect(args.slice(0, 7)).toEqual([
      '--ask-for-approval',
      'never',
      '--config',
      'model_provider="openai"',
      '--config',
      'sandbox_workspace_write.network_access=true',
      'exec',
    ]);

    await expect(
      new CodexDriver().execute(
        { version: '1', prompt: 'test network', agent: { sandbox: 'read-only' } },
        process.cwd(),
        1_000,
      ),
    ).rejects.toThrow('Codex tool network access requires the workspace-write sandbox');
  });
});
