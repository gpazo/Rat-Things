import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
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
});
