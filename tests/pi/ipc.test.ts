import { describe, expect, it } from 'vitest';
import { nativeDigest } from '../../src/core/session-native-store.js';
import { decodePiChildMessage, decodePiHostMessage, decodePiRequestResult, decodePiCommandResult } from '../../src/runner/pi/ipc.js';

const head = { seq: 1, commitId: 'parent', digest: 'a'.repeat(64), extra: false };
const commit = { schema: 1 as const, commitId: 'next', parent: head, seq: 2, idHighWater: 7, writes: [{ opaque: 0 }], extra: { preserved: true } };
const effect = { kind: 'mcp', name: 'remote', arguments: { false: false, zero: 0, empty: '', array: [null] }, callId: '', taskId: 1, conversationId: 1 };
const turn = { id: 'turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null, status: 'queued', created_at: 1, started_at: null, completed_at: null, error: null, usage: null };
const input = [{ role: 'user', content: [{ type: 'input_text', text: '' }] }];

describe('Pi IPC boundary decoding', () => {
  it.each([
    { method: 'load' },
    { method: 'reserve', value: { count: 256, requestId: 'block' } },
    { method: 'commit', value: commit },
    { method: 'projection', value: { snapshot: { sessionId: 'session', agentId: 'agent', turns: [], opaque: false }, seq: 0 } },
    { method: 'token' },
    { method: 'effect', value: effect },
    { method: 'effect_cancel', value: '' },
  ])('decodes the %s request without mutating its payload', operation => {
    const message = { kind: 'request', id: '', ...operation };
    const before = structuredClone(message);
    expect(decodePiChildMessage(message)).toEqual(message);
    expect(message).toEqual(before);
  });

  it('preserves extra native fields that participate in canonical digest identity', () => {
    const message = decodePiChildMessage({ kind: 'request', id: 'id', method: 'commit', value: commit });
    expect(message.kind).toBe('request');
    if (message.kind === 'request' && message.method === 'commit') expect(nativeDigest(message.value)).toBe(nativeDigest(commit));
    expect(decodePiRequestResult('commit', head)).toEqual(head);
    expect(decodePiRequestResult('load', { head, highWater: 7, commits: [commit], extra: false })).toEqual({ head, highWater: 7, commits: [commit], extra: false });
  });

  it.each([
    ['reserve', { count: 0, requestId: 'id' }], ['reserve', { count: 1, requestId: '../id' }],
    ['commit', { ...commit, parent: {} }], ['commit', { ...commit, seq: 3 }],
    ['projection', { snapshot: {}, seq: 0 }], ['projection', { snapshot: { sessionId: 's', agentId: 'a' }, seq: -1 }],
    ['effect', { ...effect, kind: 'other' }], ['effect', { ...effect, taskId: 1.5 }],
    ['effect', { ...effect, arguments: { nested: [undefined] } }], ['effect', { ...effect, callId: 2 }],
    ['effect_cancel', 1], ['secret method', {}],
  ])('rejects malformed %s fields with a fixed operation classification', (method, value) => {
    expect(decodePiChildMessage({ kind: 'request', id: 'id', method, value })).toEqual({ kind: 'invalid-request', id: 'id', operation: method === 'secret method' ? 'unsupported' : method });
  });

  it.each([
    { method: 'initialize', value: { launch: { runtime: { kind: 'pi' } }, mode: 'bounded', allowedModelIds: [], tools: [{ kind: 'mcp', name: 'remote', description: '', parameters: { type: 'object' }, serverLabel: 'server', toolName: 'tool' }] } },
    { method: 'replay', value: { type: 'start', turn, input } },
    { method: 'replay', value: { type: 'steer', turnId: '', operationId: '', input } },
    { method: 'replay', value: { type: 'cancel', turnId: '' } },
    { method: 'resume' }, { method: 'checkpoint' }, { method: 'close' },
  ])('decodes the %s command', operation => {
    expect(JSON.parse(JSON.stringify(decodePiHostMessage({ kind: 'command', id: 'id', ...operation })))).toEqual({ kind: 'command', id: 'id', ...operation });
  });

  it.each([false, 0, '', null, undefined])('preserves falsey live function output %j without requiring a Turn ID', output => {
    const value = { type: 'tool_result', callId: 'call', success: false, output };
    expect(decodePiHostMessage({ kind: 'command', id: 'id', method: 'replay', value })).toEqual({ kind: 'command', id: 'id', method: 'replay', value });
    expect(decodePiRequestResult('effect', { output, isError: false, opaque: 0 })).toEqual({ output, isError: false, opaque: 0 });
  });

  it.each([
    { method: 'replay', value: { type: 'unknown' } },
    { method: 'replay', value: { type: 'tool_result', callId: 'call', success: 'true' } },
    { method: 'initialize', value: { launch: { runtime: { kind: 'pi' } }, mode: 'bounded', allowedModelIds: [], tools: [{ kind: 'mcp', name: 'remote', description: '', parameters: {} }] } },
  ])('rejects malformed known command %j', operation => {
    expect(decodePiHostMessage({ kind: 'command', id: 'id', ...operation })).toEqual({ kind: 'invalid-command', id: 'id' });
  });

  it('requires boolean reply status and retains generic negative envelopes', () => {
    for (const ok of ['true', 1, undefined, null]) {
      expect(decodePiChildMessage({ kind: 'result', id: 'id', ok })).toEqual({ kind: 'invalid-result', id: 'id' });
      expect(decodePiHostMessage({ kind: 'response', id: 'id', ok })).toEqual({ kind: 'invalid-response', id: 'id' });
    }
    expect(decodePiChildMessage({ kind: 'result', id: 'id', ok: false, value: 'secret' })).toEqual({ kind: 'result', id: 'id', ok: false });
    expect(decodePiHostMessage({ kind: 'response', id: 'id', ok: true })).toEqual({ kind: 'response', id: 'id', ok: true, value: undefined });
    expect(decodePiChildMessage(null)).toEqual({ kind: 'invalid', kill: true });
    expect(decodePiChildMessage({ kind: 'unrecognized' })).toEqual({ kind: 'invalid', kill: false });
    expect(decodePiHostMessage(null)).toEqual({ kind: 'ignored' });
  });

  it('decodes method-specific replies while accepting omitted void values', () => {
    expect(decodePiRequestResult('reserve', { first: 2, last: 3, count: 2 })).toEqual({ first: 2, last: 3, count: 2 });
    expect(decodePiRequestResult('token', '')).toBe('');
    expect(decodePiRequestResult('projection', undefined)).toBeUndefined();
    expect(decodePiRequestResult('effect_cancel', undefined)).toBeUndefined();
    expect(decodePiCommandResult('checkpoint', { opaque: false })).toEqual({ opaque: false });
    for (const method of ['initialize', 'resume', 'replay', 'close'] as const) expect(decodePiCommandResult(method, undefined)).toBeUndefined();
    expect(() => decodePiRequestResult('token', 0)).toThrow('Invalid Pi protocol');
    expect(() => decodePiRequestResult('reserve', { first: 2, last: 1 })).toThrow('Invalid Pi protocol');
    expect(() => decodePiRequestResult('load', { head: null, highWater: 1, commits: [null] })).toThrow('Invalid Pi protocol');
  });
});
