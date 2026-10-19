import { openPiStorage } from './pi/storage.js';
import { createPiModels } from './pi/provider.js';
import { openPiEngine, type PiEngine, type PiRootCheckpoint } from './pi/engine.js';
import type { PiToolEffect } from './pi/protocol.js';
import { decodePiHostMessage, decodePiRequestResult, type PiChildMessage, type PiRequestOperation, type PiRequestResults } from './pi/ipc.js';
import type { NativeLease } from '../core/session-native-store.js';
import type { SessionLaunch } from '../domain/session-execution.js';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';

if (!process.send || process.getuid?.() === 0) throw new Error('Pi child requires an isolated non-root IPC process');
let sequence = 0;
let engine: PiEngine | undefined;
const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const send = (message: PiChildMessage) => { if (process.connected) process.send!(message); };
function request<O extends PiRequestOperation>(operation: O, signal?: AbortSignal): Promise<PiRequestResults[O['method']]> {
  const id = String(++sequence);
  return new Promise<PiRequestResults[O['method']]>((resolve, reject) => {
    if (!process.connected) return reject(new Error('Host disconnected'));
    const cancel = () => { send({ kind: 'request', id: String(++sequence), method: 'effect_cancel', value: id }); };
    signal?.addEventListener('abort', cancel, { once: true });
    waiting.set(id, { resolve: result => { signal?.removeEventListener('abort', cancel); try { resolve(decodePiRequestResult<O['method']>(operation.method, result)); } catch { reject(new Error('Invalid Pi operation result')); } }, reject: error => { signal?.removeEventListener('abort', cancel); reject(error); } });
    send({ kind: 'request', id, ...operation });
  });
}
const lease: NativeLease = {
  load: () => request({ method: 'load' }),
  reserveIds: (count, requestId) => request({ method: 'reserve', value: { count, requestId } }),
  commit: change => request({ method: 'commit', value: change }),
  assertActive: async () => { throw new Error('Effects require the host broker'); },
};
let commands: Promise<unknown> = Promise.resolve();
process.on('message', (raw: unknown) => {
  const message = decodePiHostMessage(raw);
  if (message.kind === 'ignored') return;
  if (message.kind === 'response' || message.kind === 'invalid-response') {
    const waiter = waiting.get(message.id); waiting.delete(message.id);
    if (message.kind === 'response' && message.ok) waiter?.resolve(message.value); else waiter?.reject(new Error('Host denied Pi operation'));
    return;
  }
  commands = commands.then(async () => {
    if (message.kind === 'invalid-command') throw new Error('Invalid Pi command');
    let value: unknown;
    if (message.method === 'initialize') {
      if (engine) throw new Error('Invalid Pi initialization');
      const { tools, mode, allowedModelIds } = message.value;
      const launch = message.value.launch as SessionLaunch;
      if (launch.runtime?.kind !== 'pi') throw new Error('Pi runtime pin is required');
      const image = await lease.load();
      engine = await openPiEngine({ nativeSeq: image.head?.seq ?? 0, storage: await openPiStorage({ ...lease, load: async () => image }), models: createPiModels(launch.runtime, () => request({ method: 'token' }), allowedModelIds),
        launch, effectTools: tools, effect: (effect: PiToolEffect, signal: AbortSignal) => request({ method: 'effect', value: effect }, signal) as Promise<ToolExecutionResult>,
        changed: (snapshot, seq) => request({ method: 'projection', value: { snapshot, seq } }), mode,
        ...(launch.piForkContext ? { seed: launch.piForkContext as PiRootCheckpoint } : {}),
      });
      void engine.finished.then(() => send({ kind: 'finished' }), () => process.exit(1));
    } else {
      if (!engine) throw new Error('Pi is not initialized');
      switch (message.method) {
        case 'replay': {
          const command = message.value;
          switch (command.type) {
            case 'start': await engine.start(command.turn, command.input, command.settings); break;
            case 'steer': await engine.steer(command.turnId, command.input, command.operationId); break;
            case 'cancel': await engine.cancel(command.turnId); break;
            case 'tool_result': await engine.toolResult(command.callId, { output: command.output, success: command.success }); break;
          }
          break;
        }
        case 'resume': engine.resume(); break;
        case 'checkpoint': value = await engine.checkpoint(); break;
        case 'close': await engine.close(); send({ kind: 'result', id: message.id, ok: true }); process.disconnect(); return;
      }
    }
    send({ kind: 'result', id: message.id, ok: true, value });
  }).catch(() => { send({ kind: 'result', id: message.id, ok: false }); process.exitCode = 1; });
});
process.once('disconnect', () => { for (const waiter of waiting.values()) waiter.reject(new Error('Host disconnected')); process.exit(0); });
