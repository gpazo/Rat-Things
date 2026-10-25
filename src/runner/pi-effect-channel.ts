import type { PiEffects, PiToolEffect } from './pi/protocol.js';
import { parsePiManagedOperation } from './pi-managed-tools.js';

/** One channel belongs to one native engine run, independently of workspace generation. */
export function piEffectChannel(effects: PiEffects, identity: { runId: string; epoch: number; sessionId: string; environmentId: string; generation: string }) {
  const invocations = new Map<string, { abort: AbortController; settled?: Promise<unknown> }>();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    for (const invocation of invocations.values()) invocation.abort.abort();
    await effects.close();
    await Promise.all([...invocations.values()].map(invocation => invocation.settled));
  })();
  return {
    close,
    async call(value: unknown): Promise<unknown> {
      if (!record(value) || value.version !== 1 || value.runId !== identity.runId || value.epoch !== identity.epoch) throw new Error('Invalid Pi effect owner');
      if (value.operation === 'close') { await close(); return { stopped: true }; }
      if (closing) throw new Error('Pi effect channel is closed');
      if (value.operation === 'ready') return identity;
      if (value.operation !== 'execute' && value.operation !== 'cancel') throw new Error('Invalid Pi effect operation');
      if (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) throw new Error('Invalid Pi effect invocation');
      let invocation = invocations.get(value.id);
      if (value.operation === 'cancel') {
        if (!invocation) {
          if (invocations.size >= 4096) throw new Error('Pi effect channel is exhausted');
          invocation = { abort: new AbortController() }; invocations.set(value.id, invocation);
        }
        invocation.abort.abort();
        await invocation.settled;
        return { stopped: true };
      }
      if (invocation || invocations.size >= 4096) throw new Error('Pi effect invocation was already used or cancelled');
      if (!record(value.effect) || value.effect.kind !== 'managed' || typeof value.effect.name !== 'string'
        || !record(value.effect.arguments) || typeof value.effect.callId !== 'string'
        || !Number.isSafeInteger(value.effect.taskId) || !Number.isSafeInteger(value.effect.conversationId)) throw new Error('Invalid Pi effect');
      const effect = value.effect as unknown as PiToolEffect;
      parsePiManagedOperation(effect);
      invocation = { abort: new AbortController() }; invocations.set(value.id, invocation);
      invocation.settled = effects.execute(effect, invocation.abort.signal);
      return invocation.settled;
    },
  };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
