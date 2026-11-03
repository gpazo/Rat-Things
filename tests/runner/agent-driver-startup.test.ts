import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionLaunch } from '../../src/domain/session-execution.js';
import { sessionAgent } from '../../src/core/session-planning.js';

const runtime = vi.hoisted(() => ({
  initialize: vi.fn(async (_timeoutMs?: number) => {}),
  finished: Promise.resolve(),
  close: vi.fn(async () => {}),
  assertSuccessfulShutdown: vi.fn(),
  snapshot: vi.fn(() => ({ rootThreadId: 'thread-1', turns: [] })),
  sandboxExpired: vi.fn(() => false),
}));

vi.mock('../../src/runner/session-runtime.js', () => ({
  SessionRuntime: class {
    public get finished() { return runtime.finished; }
    public initialize(timeoutMs?: number) { return runtime.initialize(timeoutMs); }
    public assertSuccessfulShutdown() { runtime.assertSuccessfulShutdown(); }
    public close() { return runtime.close(); }
    public snapshot() { return runtime.snapshot(); }
    public sandboxExpired() { return runtime.sandboxExpired(); }
  },
}));

import { CodexDriver } from '../../src/runner/agent-driver.js';

beforeEach(() => {
  runtime.initialize.mockClear();
  runtime.close.mockClear();
  runtime.assertSuccessfulShutdown.mockClear();
  runtime.snapshot.mockClear();
  runtime.sandboxExpired.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('persistent session initialization deadlines', () => {
  const environments: Array<{ environment: SessionLaunch['environment']; timeoutMs: number }> = [
    { environment: { type: 'none' }, timeoutMs: 120_000 },
    { environment: { type: 'openai_hosted', id: 'environment', capability_directories: [], network: { access: 'disabled', allowed_domains: [] }, files: [], plugins: [], skills: [], packages: { npm: [], python: [], system: [] } }, timeoutMs: 30_000 },
  ];

  it.each(environments)('uses the startup budget for environment $environment.type', async ({ environment, timeoutMs }) => {
    const session: SessionLaunch = {
      sessionId: 'session-1', turnId: 'turn-1', environment,
      agent: sessionAgent({ model: 'fixture' }, 'agent-1', 0), input: [],
    };

    await new CodexDriver().execute({ version: '1', prompt: 'unused' }, '/workspace', 90_000, undefined, {
      session,
      sessionRuntime: { changed: vi.fn(), flush: vi.fn(async () => {}) },
    });

    expect(runtime.initialize).toHaveBeenCalledExactlyOnceWith(timeoutMs);
  });
});
