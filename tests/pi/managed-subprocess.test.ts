import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionAgent } from '../../src/core/session-planning.js';
import { publicTemplate } from '../../src/domain/environment-planning.js';
import type { SessionLaunch } from '../../src/domain/session-execution.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { createPiEffectBroker } from '../../src/runner/pi-effect-broker.js';
import { nodeSubprocessStdioProbe, restrictedNetworkSocketProbe } from '../../testing/local-runtime/subprocess-fixtures.js';

// Non-strict and non-Linux runs skip the installed runtime contract. Strict parity
// requires an explicitly selected executable; missing prerequisites never pass.
describe.skipIf(process.platform !== 'linux' || process.env.CODEX_REQUIRE_PARITY !== 'true')('official managed subprocess compatibility', () => {
  it.each([
    { name: 'captures Node subprocess stdin/stdout/stderr and preserves failures', command: [process.execPath, '--disable-warning=UNDICI-EHPA', '-e', nodeSubprocessStdioProbe], output: 'local-subprocess-stdio-ok\n' },
    { name: 'permits anonymous socketpairs while denying external and named socket connections', command: ['python3', '-c', restrictedNetworkSocketProbe], output: 'local-socket-only-ok\n' },
  ])('$name', async ({ command, output }) => {
    const binary = process.env.CODEX_CONFORMANCE_BINARY;
    if (!binary) throw new Error('Strict subprocess parity requires CODEX_CONFORMANCE_BINARY to select the official executable');
    await access(binary, constants.X_OK);
    const workspace = await mkdtemp(join(tmpdir(), 'rat-managed-subprocess-'));
    let broker: Awaited<ReturnType<typeof createPiEffectBroker>> | undefined;
    const signal = AbortSignal.timeout(20_000);
    try {
      const launch: SessionLaunch = {
        sessionId: 'subprocess-session', turnId: 'subprocess-turn', input: [],
        agent: sessionAgent({ model: 'no-inference-fixture' }, 'subprocess-agent', 1),
        environment: { ...publicTemplate({ network: { access: 'disabled', allowed_domains: [] } }, { id: 'subprocess-env', created_at: 1, updated_at: 1 }), type: 'openai_hosted', files: [], skills: [] },
      };
      const plan = planCodexLaunch({ version: '1', prompt: 'unused' }, workspace, 20_000, { CODEX_BINARY: binary, PATH: process.env.PATH });
      // The real broker uses a private temporary HOME/CODEX_HOME and a fixed
      // fake executor key. No MCP tools, live credentials, or model Turn starts.
      broker = await createPiEffectBroker({ launch, plan, lease: { assertActive: async () => {} }, signal });
      const result = await broker.execute({ kind: 'managed', name: 'exec_command', arguments: { command, cwd: workspace }, callId: 'stdio-check', taskId: 1, conversationId: 1 }, signal);
      expect(result.isError, JSON.stringify(result.output)).toBe(false);
      expect(result.output).toEqual([{ type: 'text', text: output }]);
    } finally {
      try { await broker?.close(); } finally { await rm(workspace, { recursive: true, force: true }); }
    }
  }, 30_000);
});
