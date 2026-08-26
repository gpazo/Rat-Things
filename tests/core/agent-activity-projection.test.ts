import { describe, expect, it } from 'vitest';
import { projectPublicAgentRuntime } from '../../src/core/agent-activity-projection.js';
import type { AgentRuntimeSnapshot } from '../../src/domain/interaction.js';
import type { JsonValue } from '../../src/domain/contracts.js';

describe('public agent activity projection', () => {
  it('projects bounded structured questions without exposing native turn coordinates', () => {
    const snapshot: AgentRuntimeSnapshot = {
      runId: 'run-question',
      active: true,
      ready: true,
      oldestSequence: 0,
      nextSequence: 1,
      events: [],
      pendingRequests: [{
        requestId: 'request-question',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'native-thread-private',
          turnId: 'native-turn-private',
          questions: [{
            id: 'channel',
            header: 'Release channel',
            question: 'Where should this run?',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'Staging', description: 'Use the staging environment.' },
              { label: 'Production', description: 'Use the production environment.' },
            ],
          }],
        },
        receivedAt: '2026-08-25T10:00:00.000Z',
      }],
    };

    expect(projectPublicAgentRuntime(snapshot).pendingRequests).toEqual([{
      requestId: 'request-question',
      kind: 'input',
      title: 'Agent needs input',
      receivedAt: '2026-08-25T10:00:00.000Z',
      questions: [{
        id: 'channel',
        header: 'Release channel',
        question: 'Where should this run?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Staging', description: 'Use the staging environment.' },
          { label: 'Production', description: 'Use the production environment.' },
        ],
      }],
    }]);
    expect(JSON.stringify(projectPublicAgentRuntime(snapshot))).not.toContain('native-thread-private');
  });

  it('produces typed cards without leaking App Server methods, native IDs, commands, or results', () => {
    const snapshot: AgentRuntimeSnapshot = {
      runId: 'run-1',
      active: true,
      ready: true,
      oldestSequence: 4,
      nextSequence: 8,
      turn: { threadId: 'native-thread-secret', turnId: 'native-turn-secret' },
      events: [
        event(4, 'turn/started', { threadId: 'native-thread-secret' }),
        event(5, 'item/completed', {
          item: {
            type: 'commandExecution',
            command: 'curl -H Authorization:secret https://private.invalid',
            aggregatedOutput: 'provider-secret-result',
            status: 'completed',
            exitCode: 0,
            durationMs: 1_240,
          },
        }),
        event(6, 'item/completed', {
          item: {
            type: 'dynamicToolCall',
            tool: 'crm.lookup_customer',
            arguments: { email: 'private@example.com' },
            contentItems: [{ text: 'private customer record' }],
            status: 'failed',
            durationMs: 90,
          },
        }),
        event(7, 'item/completed', { item: { type: 'contextCompaction', id: 'private-id' } }),
      ],
      pendingRequests: [
        {
          requestId: 'request-1',
          method: 'item/tool/requestUserInput',
          params: { questions: [{ question: 'Reveal a secret?' }] },
          receivedAt: '2026-08-25T10:00:04.000Z',
        },
      ],
    };

    const projected = projectPublicAgentRuntime(snapshot);

    expect(projected.events).toEqual([
      expect.objectContaining({ kind: 'agent', status: 'started', title: 'Agent turn started' }),
      expect.objectContaining({
        kind: 'command',
        status: 'completed',
        title: 'Command completed',
        detail: 'exit 0 · 1.2 s',
      }),
      expect.objectContaining({
        kind: 'tool',
        status: 'failed',
        title: 'Integration tool: crm.lookup_customer failed',
        detail: '90 ms',
      }),
      expect.objectContaining({
        kind: 'compaction',
        status: 'completed',
        title: 'Context compacted',
      }),
    ]);
    expect(projected.pendingRequests).toEqual([{
      requestId: 'request-1',
      kind: 'input',
      title: 'Agent needs input',
      receivedAt: '2026-08-25T10:00:04.000Z',
    }]);
    expect(JSON.stringify(projected)).not.toMatch(
      /turn\/started|item\/completed|native-|Authorization|provider-secret|private@example|Reveal a secret/,
    );
  });

  it('preserves ring cursors while mapping noisy delta families into safe product activity', () => {
    const snapshot: AgentRuntimeSnapshot = {
      runId: 'run-deltas',
      active: true,
      ready: false,
      oldestSequence: 20,
      nextSequence: 29,
      events: [
        event(20, 'item/agentMessage/delta', { delta: 'private response text' }),
        event(21, 'item/reasoning/summaryTextDelta', { delta: 'private reasoning text' }),
        event(22, 'item/commandExecution/outputDelta', { delta: 'private command output' }),
        event(23, 'item/mcpToolCall/progress', { message: 'private tool progress' }),
        event(24, 'turn/plan/updated', { plan: [{ step: 'private plan step' }] }),
        event(25, 'turn/diff/updated', { diff: 'private source diff' }),
        event(26, 'thread/tokenUsage/updated', {
          tokenUsage: { last: { inputTokens: 1_250, outputTokens: 42 } },
        }),
        event(27, 'item/started', {
          item: { type: 'webSearch', query: 'private search query' },
        }),
        event(28, 'error', { message: 'private runtime failure' }),
      ],
      pendingRequests: [
        request('auth-1', 'oauth/authentication'),
        request('tool-1', 'item/tool/needsData'),
        request('other-1', 'custom/input'),
      ],
    };

    const projected = projectPublicAgentRuntime(snapshot);

    expect(projected).toMatchObject({
      runId: 'run-deltas',
      active: true,
      ready: false,
      oldestSequence: 20,
      nextSequence: 29,
    });
    expect(projected.events.map(({ kind, status, title }) => ({ kind, status, title }))).toEqual([
      { kind: 'message', status: 'updated', title: 'Writing response' },
      { kind: 'reasoning', status: 'updated', title: 'Reasoning updated' },
      { kind: 'command', status: 'updated', title: 'Command running' },
      { kind: 'tool', status: 'updated', title: 'Tool call running' },
      { kind: 'plan', status: 'updated', title: 'Plan updated' },
      { kind: 'file', status: 'updated', title: 'File changes updated' },
      { kind: 'usage', status: 'updated', title: 'Context usage updated' },
      { kind: 'web_search', status: 'started', title: 'Web search started' },
      { kind: 'error', status: 'failed', title: 'Agent runtime error' },
    ]);
    expect(projected.events[6]?.detail).toBe('1,250 input · 42 output');
    expect(projected.pendingRequests.map(({ kind, title }) => ({ kind, title }))).toEqual([
      { kind: 'authentication', title: 'Authentication required' },
      { kind: 'tool', title: 'Tool needs input' },
      { kind: 'other', title: 'Agent needs input' },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(
      /private response|private reasoning|private command|private tool|private plan|private source|private search|private runtime/,
    );
  });
});

function event(
  sequence: number,
  method: string,
  params: Record<string, JsonValue>,
) {
  return {
    sequence,
    method,
    params,
    occurredAt: `2026-08-25T10:00:${String(sequence).padStart(2, '0')}.000Z`,
  };
}

function request(requestId: string, method: string) {
  return {
    requestId,
    method,
    params: {},
    receivedAt: '2026-08-25T10:01:00.000Z',
  };
}
