import { openPiStorage } from './pi/storage.js';
import { createPiModels } from './pi/provider.js';
import { openPiEngine, type PiEngine, type PiRootCheckpoint } from './pi/engine.js';
import type { PiEffectTool, PiToolEffect } from './pi-effect-broker.js';
import type { NativeLease, NativeImage, NativeHead } from '../core/session-native-store.js';
import type { SessionLaunch, SessionReplayCommand } from '../domain/session-execution.js';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';

if (!process.send || process.getuid?.() === 0) throw new Error('Pi child requires an isolated non-root IPC process');
let sequence = 0;
let engine: PiEngine | undefined;
const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const send = (message: unknown) => { if (process.connected) process.send!(message as Record<string, unknown>); };
function request<T>(method: string, value?: unknown, signal?: AbortSignal): Promise<T> {
  const id = String(++sequence);
  return new Promise<T>((resolve, reject) => {
    if (!process.connected) return reject(new Error('Host disconnected'));
    const cancel = () => { send({ kind: 'request', id: String(++sequence), method: 'effect_cancel', value: id }); };
    signal?.addEventListener('abort', cancel, { once: true });
    waiting.set(id, { resolve: result => { signal?.removeEventListener('abort', cancel); resolve(result as T); }, reject: error => { signal?.removeEventListener('abort', cancel); reject(error); } });
    send({ kind: 'request', id, method, value });
  });
}
const lease: NativeLease = {
  load: () => request<NativeImage>('load'),
  reserveIds: (count, requestId) => request('reserve', { count, requestId }),
  commit: change => request<NativeHead>('commit', change),
  assertActive: async () => { throw new Error('Effects require the host broker'); },
};
let commands: Promise<unknown> = Promise.resolve();
process.on('message', (message: unknown) => {
  if (!record(message)) return;
  if (message.kind === 'response' && typeof message.id === 'string') {
    const waiter = waiting.get(message.id); waiting.delete(message.id);
    if (message.ok) waiter?.resolve(message.value); else waiter?.reject(new Error('Host denied Pi operation'));
    return;
  }
  if (message.kind !== 'command' || typeof message.id !== 'string') return;
  commands = commands.then(async () => {
    let value: unknown;
    if (message.method === 'initialize') {
      if (engine || !record(message.value)) throw new Error('Invalid Pi initialization');
      const { launch, tools, mode, allowedModelIds } = message.value as unknown as { launch: SessionLaunch; tools: PiEffectTool[]; mode: 'persistent' | 'bounded'; allowedModelIds: string[] };
      if (launch.runtime?.kind !== 'pi') throw new Error('Pi runtime pin is required');
      const image = await lease.load();
      engine = await openPiEngine({ nativeSeq: image.head?.seq ?? 0, storage: await openPiStorage({ ...lease, load: async () => image }), models: createPiModels(launch.runtime, () => request<string>('token'), allowedModelIds),
        launch, effectTools: tools, effect: (effect: PiToolEffect, signal: AbortSignal) => request<ToolExecutionResult>('effect', effect, signal),
        changed: (snapshot, seq) => request<void>('projection', { snapshot, seq }), mode,
        ...(launch.piForkContext ? { seed: launch.piForkContext as PiRootCheckpoint } : {}),
      });
      void engine.finished.then(() => send({ kind: 'finished' }), () => process.exit(1));
    } else {
      if (!engine) throw new Error('Pi is not initialized');
      switch (message.method) {
        case 'replay': {
          const command = message.value as SessionReplayCommand;
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
        default: throw new Error('Invalid Pi command');
      }
    }
    send({ kind: 'result', id: message.id, ok: true, value });
  }).catch(() => { send({ kind: 'result', id: message.id, ok: false }); process.exitCode = 1; });
});
process.once('disconnect', () => { for (const waiter of waiting.values()) waiter.reject(new Error('Host disconnected')); process.exit(0); });
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
