import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCodexAppServer } from '../../src/runner/codex-app-server.js';

const live = process.env.CODEX_APP_SERVER_E2E === 'true' ? describe : describe.skip;

live('real Codex App Server', () => {
  it('calls a host dynamic tool and returns its marker through the real protocol', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rat-codex-app-server-'));
    const marker = `RAT_THINGS_DYNAMIC_TOOL_${Date.now()}`;
    let calls = 0;
    try {
      const execution = await runCodexAppServer({
        binary: process.env.CODEX_BINARY ?? resolve('node_modules/.bin/codex'),
        workspace,
        environment: process.env,
        timeoutMs: 120_000,
        prompt: [
          'Call the rat_test.get_marker tool exactly once.',
          'Then reply with exactly the marker returned by the tool and nothing else.',
          'Do not guess or construct the marker yourself.',
        ].join(' '),
        sandbox: 'read-only',
        persistent: false,
        modelProvider: 'openai',
        networkAccess: false,
        dynamicTools: [{
          type: 'namespace',
          name: 'rat_test',
          description: 'A deterministic Rat Things protocol canary.',
          tools: [{
            type: 'function',
            name: 'get_marker',
            description: 'Return the exact E2E marker.',
            inputSchema: { type: 'object', additionalProperties: false },
          }],
        }],
        onServerRequest: (request) => {
          if (request.method !== 'item/tool/call') {
            throw new Error(`unexpected App Server request ${request.method}`);
          }
          expect(request.params).toMatchObject({
            namespace: 'rat_test',
            tool: 'get_marker',
          });
          calls += 1;
          return {
            success: true,
            contentItems: [{ type: 'inputText', text: marker }],
          };
        },
      });

      expect(calls).toBe(1);
      expect(execution.fullText.trim()).toBe(marker);
      expect(execution.events.toString('utf8')).toContain('item/tool/call');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 130_000);

  it('resumes and compacts a persisted native thread from a fresh app-server process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rat-codex-persistence-'));
    const workspace = join(root, 'workspace');
    const codexHome = join(root, 'codex-home');
    const marker = `RAT_NATIVE_COMPACTION_${Date.now()}`;
    try {
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(codexHome, { recursive: true }),
      ]);
      await copyFile(join(homedir(), '.codex', 'auth.json'), join(codexHome, 'auth.json'));
      await writeFile(join(codexHome, 'config.toml'), [
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'model_auto_compact_token_limit = 1',
        '',
      ].join('\n'));

      const environment = { ...process.env, CODEX_HOME: codexHome };
      const first = await runCodexAppServer({
        binary: process.env.CODEX_BINARY ?? resolve('node_modules/.bin/codex'),
        workspace,
        environment,
        timeoutMs: 180_000,
        prompt: `Remember this exact marker for the next turn: ${marker}. Reply only STORED.`,
        sandbox: 'read-only',
        persistent: true,
        modelProvider: 'openai',
        networkAccess: false,
      });
      expect(first.fullText.trim()).toBe('STORED');

      const second = await runCodexAppServer({
        binary: process.env.CODEX_BINARY ?? resolve('node_modules/.bin/codex'),
        workspace,
        environment,
        timeoutMs: 240_000,
        prompt: 'Reply with only the exact marker I asked you to remember in the previous turn.',
        sandbox: 'read-only',
        persistent: true,
        modelProvider: 'openai',
        resumeThreadId: first.threadId,
        networkAccess: false,
      });

      expect(second.threadId).toBe(first.threadId);
      expect(second.fullText.trim()).toBe(marker);
      expect(second.events.toString('utf8')).toContain('contextCompaction');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 430_000);
});
