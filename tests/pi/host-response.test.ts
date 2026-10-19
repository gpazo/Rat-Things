import { describe, expect, it } from 'vitest';
import { piToolResultCommand } from '../../src/runner/pi-host.js';

describe('Pi tool result replay command', () => {
  it('keeps the operation and target fixed while copying only the supported result fields', () => {
    expect(piToolResultCommand('pi_call_15', {
      success: true,
      output: 'durable result',
      type: 'cancel',
      callId: 'other-call',
      turnId: 'other-turn',
    })).toEqual({
      type: 'tool_result',
      callId: 'pi_call_15',
      success: true,
      output: 'durable result',
    });
    expect(piToolResultCommand('pi_call_16', { success: false, output: 'failed' })).toEqual({
      type: 'tool_result', callId: 'pi_call_16', success: false, output: 'failed',
    });
  });

  it.each([null, [], 'result', { success: 1 }, { success: 'true' }])('rejects malformed result %j', value => {
    expect(() => piToolResultCommand('pi_call_15', value)).toThrow('Invalid Pi function result');
  });
});
