import { describe, expect, it } from 'vitest';
import { projectPublicAgentEvent } from '../../src/core/agent-activity-projection.js';
import type { JsonValue } from '../../src/domain/contracts.js';

describe('saved agent event projection', () => {
  it('copies only completed assistant commentary as bounded progress, never drafts or reasoning', () => {
    const items = [
      {type: 'agentMessage', phase: 'commentary', text: 'Opening the page.\nCapturing its title.\u001b'},
      {type: 'agentMessage', phase: 'commentary', text: 'x'.repeat(2_000)},
      {type: 'agentMessage', phase: 'final_answer', text: 'private final draft'},
      {type: 'agentMessage', text: 'private unspecified message'},
      {type: 'reasoning', text: 'private reasoning'},
      {type: 'userMessage', phase: 'commentary', text: 'private prompt'},
    ];
    const projected = [event(0, 'item/started', {item: items[0]!}), ...items.map((item, index) => event(index + 1, 'item/completed', {item}))].map(projectPublicAgentEvent);
    expect(projected.filter(item => item.kind === 'commentary')).toEqual([
      expect.objectContaining({detail: 'Opening the page. Capturing its title.', status: 'completed'}),
      expect.objectContaining({detail: 'x'.repeat(500)}),
    ]);
    expect(JSON.stringify(projected)).not.toContain('private');
  });

  it('produces typed cards without leaking App Server methods, native IDs, commands, or results', () => {
    const events = [
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
    ];

    const projected = events.map(projectPublicAgentEvent);

    expect(projected).toEqual([
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
    expect(JSON.stringify(projected)).not.toMatch(
      /turn\/started|item\/completed|native-|Authorization|provider-secret|private@example|Reveal a secret/,
    );
  });

  it('preserves event sequences while mapping noisy delta families into safe diagnostics', () => {
    const events = [
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
    ];

    const projected = events.map(projectPublicAgentEvent);

    expect(projected.map(({ sequence }) => sequence)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28]);
    expect(projected.map(({ kind, status, title }) => ({ kind, status, title }))).toEqual([
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
    expect(projected[6]?.detail).toBe('1,250 input · 42 output');
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
