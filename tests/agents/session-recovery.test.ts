import { describe, expect, it } from 'vitest';
import type { AgentSessionItem } from '../../src/domain/agents-api.js';
import { sessionRecoveryItems } from '../../src/runner/session-recovery-planning.js';

const call = (turn_id: string, status: 'completed' | 'incomplete' = 'completed'): AgentSessionItem => ({ id: `call_${turn_id}`, type: 'function_call', turn_id, call_id: 'reused', name: 'lookup', arguments: { key: turn_id }, status });
const output = (turn_id: string): AgentSessionItem => ({ id: `output_${turn_id}`, type: 'function_call_output', turn_id, call_id: 'reused', output: '', error: null, status: 'completed' });

describe('checkpoint fallback context', () => {
  it('pairs functions within a Turn and preserves empty successes without sharing mutable inputs', () => {
    const items = [call('one'), output('one'), call('two'), output('two')];
    const before = structuredClone(items);
    const recovered = sessionRecoveryItems(items);
    expect(recovered.map((item) => item.call_id)).toEqual(['recovered_call_0', 'recovered_call_0', 'recovered_call_2', 'recovered_call_2']);
    expect(recovered[1]).toMatchObject({ output: '' });
    expect(items).toEqual(before);
    expect(sessionRecoveryItems([])).toEqual([]);
  });

  it('keeps orphaned, incomplete, duplicated and out-of-order calls as historical data', () => {
    const items = [call('orphan'), output('other_turn'), call('partial', 'incomplete'), output('partial'), output('reversed'), call('reversed'), call('duplicate'), call('duplicate'), output('duplicate')];
    const recovered = sessionRecoveryItems(items);
    expect(recovered).toHaveLength(items.length);
    expect(recovered.every((item) => item.type === 'message')).toBe(true);
    recovered.forEach((item, index) => {
      const content = item.content as Array<{ text: string }>;
      expect(JSON.parse(content[0]!.text.split('\n').slice(1).join('\n'))).toEqual(items[index]);
    });
  });

  it('retains command, MCP and closed-child facts without requesting their execution', () => {
    const items: AgentSessionItem[] = [
      { id: 'cmd', turn_id: 'one', type: 'command_execution', command: 'write invoice', cwd: '/workspace', duration_ms: null, exit_code: null, output: 'invoice created', status: 'incomplete' },
      { id: 'mcp', turn_id: 'one', type: 'mcp_call', server_label: 'crm', name: 'save', arguments: { value: false }, output: { saved: 0 }, error: null, status: 'completed' },
      { id: 'close', turn_id: 'one', type: 'close_subagent_call', sender_agent_id: 'root', recipient_agent_id: 'child', status: 'completed' },
    ];
    const recovered = sessionRecoveryItems(items);
    expect(recovered.every((item) => item.type === 'message' && item.role === 'assistant')).toBe(true);
    recovered.forEach((item, index) => {
      const content = item.content as Array<{ text: string }>;
      expect(content[0]!.text).toContain('Incomplete operations may already have produced effects');
      expect(JSON.parse(content[0]!.text.split('\n').slice(1).join('\n'))).toEqual(items[index]);
    });
  });
});
