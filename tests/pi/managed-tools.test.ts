import { expect, it } from 'vitest';
import { parsePiManagedOperation, piManagedCommand } from '../../src/runner/pi-managed-tools.js';
import type { PiToolEffect } from '../../src/runner/pi/protocol.js';

const effect = (name: string, args: PiToolEffect['arguments']): PiToolEffect => ({ kind: 'managed', name, arguments: args, callId: 'one', taskId: 1, conversationId: 1 });

it('preserves argument boundaries, caller inputs, cwd and empty file content', () => {
  const request = effect('exec_command', { command: ['printf', '%s', '$(touch /outside)'], cwd: '/workspace/sub' });
  const before = structuredClone(request);
  expect(piManagedCommand(parsePiManagedOperation(request), '/bin/node', '/workspace')).toEqual({ command: ['printf', '%s', '$(touch /outside)'], cwd: '/workspace/sub' });
  expect(request).toEqual(before);
  const write = piManagedCommand(parsePiManagedOperation(effect('write_file', { path: 'empty', content: '' })), '/bin/node', '/workspace');
  expect(write.command.slice(-3)).toEqual(['write', 'empty', '']);
  expect(write.cwd).toBe('/workspace');
});

it.each([
  effect('exec_command', { command: [] }), effect('exec_command', { command: [''] }),
  effect('exec_command', { command: ['true'], permissionProfile: 'danger-full-access' }),
  effect('write_file', { path: 'x' }), effect('read_file', { path: 'x', content: 'extra' }),
  effect('exec_command', { command: Array.from({ length: 101 }, () => 'x') }),
  { ...effect('exec_command', { command: ['true'] }), kind: 'mcp' as const }, effect('unknown', {}),
])('rejects operations outside the fixed capability envelope', request => {
  expect(() => parsePiManagedOperation(request)).toThrow('capability envelope');
});
