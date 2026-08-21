import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCodexAppServer,
  sandboxPolicyFor,
  terminalNotificationError,
} from '../../src/runner/codex-app-server.js';

describe('Codex app-server notifications', () => {
  it('lets app-server recover from retryable stream errors', () => {
    expect(terminalNotificationError({
      error: { message: 'Reconnecting... 1/5' },
      willRetry: true,
      threadId: 'thread-1',
      turnId: 'turn-1',
    })).toBeUndefined();
  });

  it('surfaces terminal turn errors', () => {
    expect(terminalNotificationError({
      error: { message: 'model access is not enabled' },
      willRetry: false,
      threadId: 'thread-1',
      turnId: 'turn-1',
    })?.message).toBe('model access is not enabled');
  });

  it('constructs explicit sandbox policies for every supported mode', () => {
    expect(sandboxPolicyFor('read-only', '/workspace', true)).toEqual({
      type: 'readOnly',
      networkAccess: true,
    });
    expect(sandboxPolicyFor('workspace-write', '/workspace', false)).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/workspace'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(sandboxPolicyFor('danger-full-access', '/workspace', true)).toEqual({
      type: 'dangerFullAccess',
    });
  });

  it('bridges events, approvals, capabilities, and steering bidirectionally', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-app-server-test-'));
    const fakeServer = join(directory, 'fake-app-server.mjs');
    await writeFile(fakeServer, FAKE_APP_SERVER);
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    try {
      const execution = await runCodexAppServer({
        binary: process.execPath,
        binaryArguments: [fakeServer],
        workspace: directory,
        environment: process.env,
        timeoutMs: 5_000,
        prompt: 'Run the integration test',
        sandbox: 'workspace-write',
        persistent: false,
        modelProvider: 'openai',
        model: 'gpt-test',
        reasoningEffort: 'high',
        reasoningSummary: 'concise',
        personality: 'pragmatic',
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto-review',
        webSearch: 'live',
        skills: ['test-skill'],
        apps: ['gmail'],
        mcpServers: ['calendar'],
        dynamicTools: [{
          type: 'namespace',
          name: 'slack',
          description: 'Slack tools',
          tools: [{
            type: 'function',
            name: 'messages_search',
            description: 'Search Slack messages',
            inputSchema: { type: 'object' },
          }],
        }],
        onEvent: (event) => { events.push(event); },
        onServerRequest: async (request) => {
          expect(request.method).toBe('item/commandExecution/requestApproval');
          return { decision: 'accept' };
        },
        onTurnStarted: async (controller) => {
          expect(controller).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' });
          await controller.steer('Focus on the failing test');
        },
      });

      expect(execution).toMatchObject({
        fullText: 'bridge-complete',
        threadId: 'thread-1',
      });
      expect(events.find((event) => event.method === 'test/initializeParams')?.params)
        .toMatchObject({
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
      const thread = events.find((event) => event.method === 'test/threadParams')?.params;
      expect(thread).toMatchObject({
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write',
        personality: 'pragmatic',
        dynamicTools: [{
          type: 'namespace',
          name: 'slack',
          tools: [{ type: 'function', name: 'messages_search' }],
        }],
        config: {
          sandbox_workspace_write: { network_access: true },
          web_search: 'live',
          apps: {
            _default: { enabled: false },
            gmail: { enabled: true, destructive_enabled: true },
          },
          mcp_servers: { calendar: { enabled: true } },
        },
      });
      const turn = events.find((event) => event.method === 'test/turnParams')?.params;
      expect(turn).toMatchObject({
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        effort: 'high',
        summary: 'concise',
        personality: 'pragmatic',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [directory],
          networkAccess: true,
        },
        input: [
          { type: 'text', text: '$test-skill\n\nRun the integration test' },
          { type: 'skill', name: 'test-skill', path: '/skills/test-skill/SKILL.md' },
        ],
      });
      expect(events.find((event) => event.method === 'test/steer')?.params).toMatchObject({
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'Focus on the failing test' }],
      });
      expect(events.find((event) => event.method === 'test/approvalResponse')?.params)
        .toEqual({ decision: 'accept' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const FAKE_APP_SERVER = String.raw`
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
let approvalAnswered = false;
let steerAnswered = false;
let completed = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const finish = () => {
  if (completed || !approvalAnswered || !steerAnswered) return;
  completed = true;
  send({ method: 'item/completed', params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'agentMessage', text: 'bridge-complete' },
  } });
  send({ method: 'turn/completed', params: {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'completed' },
  } });
};

input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake' } });
    send({ method: 'test/initializeParams', params: message.params });
    return;
  }
  if (message.method === 'skills/list') {
    send({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], skills: [{
      name: 'test-skill',
      path: '/skills/test-skill/SKILL.md',
      enabled: true,
    }], errors: [] }] } });
    return;
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-1' } } });
    send({ method: 'test/threadParams', params: message.params });
    return;
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
    send({ method: 'test/turnParams', params: message.params });
    send({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        startedAtMs: Date.now(),
        environmentId: null,
        command: 'npm test',
      },
    });
    return;
  }
  if (message.method === 'turn/steer') {
    send({ id: message.id, result: { turnId: 'turn-1' } });
    send({ method: 'test/steer', params: message.params });
    steerAnswered = true;
    finish();
    return;
  }
  if (message.id === 'approval-1' && message.result) {
    send({ method: 'test/approvalResponse', params: message.result });
    approvalAnswered = true;
    finish();
  }
});
`;
