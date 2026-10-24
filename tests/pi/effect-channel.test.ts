import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { piEffectChannel } from '../../src/runner/pi-effect-channel.js';
import type { PiEffects, PiToolEffect } from '../../src/runner/pi/protocol.js';

const identity = { runId: randomUUID(), epoch: 3, sessionId: 'sess_one', environmentId: 'env_one', generation: 'persistent-workspace' };
const effect: PiToolEffect = { kind: 'managed', name: 'exec_command', arguments: { command: ['true'] }, callId: 'one', taskId: 1, conversationId: 1 };
const request = (operation: string, id = randomUUID()) => ({ version: 1, ...identity, operation, id, effect });

it('remembers cancellation before execute and rejects repeated invocation identities', async () => {
  const execute = vi.fn(async () => ({ output: [], isError: false }));
  const channel = piEffectChannel({ tools: [], execute, close: async () => {} }, identity);
  const id = randomUUID();
  expect(await channel.call(request('cancel', id))).toEqual({ stopped: true });
  await expect(channel.call(request('execute', id))).rejects.toThrow('already used or cancelled');
  expect(execute).not.toHaveBeenCalled();
  const another = randomUUID();
  await channel.call(request('execute', another));
  await expect(channel.call(request('execute', another))).rejects.toThrow('already used or cancelled');
  expect(execute).toHaveBeenCalledTimes(1);
  await channel.close();
});

it('acknowledges cancellation only after execution settles and binds the native epoch separately from workspace generation', async () => {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const effects: PiEffects = { tools: [], execute: async (_effect, invocation) => {
    signal = invocation;
    await new Promise<void>(resolve => { finish = resolve; });
    return { output: [], isError: true };
  }, close: async () => {} };
  const channel = piEffectChannel(effects, identity);
  const id = randomUUID();
  const executing = channel.call(request('execute', id));
  let acknowledged = false;
  const cancelling = channel.call(request('cancel', id)).then(value => { acknowledged = true; return value; });
  await Promise.resolve();
  expect(signal?.aborted).toBe(true); expect(acknowledged).toBe(false);
  await expect(channel.call({ ...request('ready'), epoch: 4 })).rejects.toThrow('owner');
  finish(); await executing;
  expect(await cancelling).toEqual({ stopped: true });
  expect(await channel.call(request('ready'))).toEqual(identity);
  await channel.close();
});

it('does not acknowledge an uncertain termination and retains a failed closed state', async () => {
  const channel = piEffectChannel({ tools: [], execute: async () => { throw new Error('termination failed'); },
    close: async () => { throw new Error('cleanup failed'); } }, identity);
  const id = randomUUID();
  await expect(channel.call(request('execute', id))).rejects.toThrow('termination failed');
  await expect(channel.call(request('cancel', id))).rejects.toThrow('termination failed');
  await expect(channel.close()).rejects.toThrow('cleanup failed');
  await expect(channel.call(request('execute'))).rejects.toThrow('closed');
});
