import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { installBedrockTokenFile } from '../../src/runner/bedrock-token-file.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it('rotates a read-only token atomically and stops refresh before removing it', async () => {
  vi.useFakeTimers();
  vi.stubEnv('TMPDIR', '/guest-writable-workspace');
  const token = vi.fn().mockResolvedValueOnce('first').mockResolvedValue('second');
  const failed = vi.fn();
  const session = await installBedrockTokenFile({ token, onFailure: failed });
  try {
    expect(session.path.startsWith('/tmp/rat-bedrock-auth-')).toBe(true);
    expect((await stat(session.path)).mode & 0o777).toBe(0o440);
    expect((await stat(dirname(session.path))).mode & 0o777).toBe(0o750);
    expect(await readFile(session.path, 'utf8')).toBe('first');
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(async () => expect(await readFile(session.path, 'utf8')).toBe('second'));
    expect(failed).not.toHaveBeenCalled();
  } finally { await session.close(); }
  await vi.advanceTimersByTimeAsync(600_000);
  expect(token).toHaveBeenCalledTimes(2);
  await expect(stat(session.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fails closed once when token refresh fails', async () => {
  vi.useFakeTimers();
  const token = vi.fn().mockResolvedValueOnce('first').mockRejectedValue(new Error('private failure'));
  const failed = vi.fn();
  const session = await installBedrockTokenFile({ token, onFailure: failed });
  try {
    await vi.advanceTimersByTimeAsync(900_000);
    expect(failed).toHaveBeenCalledExactlyOnceWith();
    expect(token).toHaveBeenCalledTimes(2);
  } finally { await session.close(); }
});

it('selects native command authentication without copying bearer or AWS credentials to the child', () => {
  const plan = planCodexLaunch({ version: '1', prompt: 'proof' }, '/workspace', 900_000, {
    CODEX_AUTH_MODE: 'bedrock', RAT_BEDROCK_AUTH_FILE: '/tmp/host-auth/token',
    AWS_BEARER_TOKEN_BEDROCK: 'stale', AWS_SECRET_ACCESS_KEY: 'private',
  });
  expect(plan.binaryArguments).toEqual(['-c', expect.stringContaining('model_providers.amazon-bedrock.auth'), 'app-server']);
  expect(plan.environment).not.toHaveProperty('AWS_BEARER_TOKEN_BEDROCK');
  expect(plan.environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  expect(plan.environment).not.toHaveProperty('RAT_BEDROCK_AUTH_FILE');
});
