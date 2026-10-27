import { expect, it } from 'vitest';
import { parsePiManagedOperation, piManagedCommand, piManagedResult } from '../../src/runner/pi-managed-tools.js';
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

const runtimeWarning = '(node:2) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental\n';

it.each([
  { name: 'read_file', args: { path: 'file' }, stdout: 'file content\n[UNDICI-EHPA] is also valid file data\0é' },
  { name: 'read_file', args: { path: 'empty' }, stdout: '' },
  { name: 'write_file', args: { path: 'file', content: 'data' }, stdout: 'Written\n' },
  { name: 'list_files', args: { path: '.' }, stdout: '[{"name":"file","directory":false}]\n' },
])('keeps successful $name data exact when the runtime writes a warning', ({ name, args, stdout }) => {
  const operation = parsePiManagedOperation(effect(name, args));
  const response = Object.freeze({ stdout, stderr: runtimeWarning, exitCode: 0 });
  expect(piManagedResult(operation, response)).toEqual({ output: [{ type: 'text', text: stdout }], isError: false });
});

it.each([
  effect('read_file', { path: 'missing' }),
  effect('write_file', { path: '/outside', content: 'denied' }),
  effect('list_files', { path: 'missing' }),
  effect('exec_command', { command: ['false'] }),
])('retains stdout and stderr for a failed $name operation', request => {
  const stdout = 'partial output\n'; const stderr = `operation failed\n${runtimeWarning}`;
  expect(piManagedResult(parsePiManagedOperation(request), { stdout, stderr, exitCode: 1 }))
    .toEqual({ output: [{ type: 'text', text: stdout + stderr }], isError: true });
});

it('retains successful command diagnostics', () => {
  expect(piManagedResult(parsePiManagedOperation(effect('exec_command', { command: ['true'] })), { stdout: 'result\n', stderr: runtimeWarning, exitCode: 0 }))
    .toEqual({ output: [{ type: 'text', text: `result\n${runtimeWarning}` }], isError: false });
});
