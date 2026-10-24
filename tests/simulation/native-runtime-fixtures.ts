import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { sessionAgent } from '../../src/core/session-planning.js';
import type { LocalStartRequest } from '../../src/core/local-runtime-ports.js';
import type { NativeHostFacts } from '../../src/domain/local-native-admission.js';
import type { NativeMachine } from '../../src/adapters/local-native-runtime.js';
import { NativeProofRuntime } from '../../testing/local-runtime/native-vm/worker/runtime.js';

export const supportedHost: NativeHostFacts = { supported: true, architecture: 'arm64', physicalMemoryBytes: 8 * 1024 ** 3,
  minimumCPUCount: 1, maximumCPUCount: 8, minimumMemoryBytes: 512 * 1024 ** 2, maximumMemoryBytes: 8 * 1024 ** 3, memoryPressure: 'normal' };

export function startRequest(sessionId = 'sess_identity'): LocalStartRequest {
  return { workspace: { kind: 'create', identity: { version: 1, sessionId, generation: randomUUID(), setupDigest: 'a'.repeat(64) } },
    worker: { sessionId, ownerId: 'test', environmentId: 'env_test', executorKey: 'test-executor', harnessKey: 'test-harness',
      launch: { sessionId, turnId: '', agent: sessionAgent({ model: 'test' }, 'agent', 1), environment: { type: 'none' }, input: [] } } };
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

export class FixtureMachine implements NativeMachine {
  readonly started = Promise.resolve(3211);
  readonly exited: Promise<void>;
  private resolveExit!: () => void;
  private live = true;
  private registered = false;
  beforeStop: (() => Promise<void>) | undefined;
  beforeControl: ((operation: string) => Promise<void>) | undefined;
  stopError: Error | undefined;
  unconfirmedStopError: Error | undefined;
  constructor(readonly configuration: { workspace: string; disk: string; cpuCount: number; memoryMiB: number }) {
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
  }
  alive() { return this.live; }
  kill() { this.live = false; this.resolveExit(); }
  stop = vi.fn(async () => {
    await this.beforeStop?.();
    if (this.unconfirmedStopError) throw this.unconfirmedStopError;
    this.kill();
    if (this.stopError) throw this.stopError;
  });
  control = vi.fn(async (request: Parameters<NativeMachine['control']>[0], _timeoutMs?: number) => {
    await this.beforeControl?.(request.operation);
    if (request.operation === 'snapshot') return [];
    if (request.operation === 'start') this.registered = true;
    if (request.operation === 'health') return { ready: this.live && this.registered };
    return { ready: true };
  });
}

export async function nativeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rat-native-fixture-'));
  const assets = join(directory, 'assets');
  await mkdir(assets);
  const digest = createHash('sha256').update('fixture').digest('hex');
  for (const file of ['worker-initramfs.gz', 'Image', 'rat-native-worker']) await writeFile(join(assets, file), 'fixture');
  await writeFile(join(assets, 'manifest.json'), JSON.stringify({ initrdSha256: digest, kernelSha256: digest, helperSha256: digest }));
  const machines: FixtureMachine[] = [];
  let maximumLive = 0;
  const facts = { ...supportedHost };
  const disk = { available: 1024 ** 3 };
  const onMachine = vi.fn<(machine: FixtureMachine) => void>();
  const runtime = new NativeProofRuntime(directory, assets, 1, { configuredCapacity: 2, hostFacts: async () => ({ ...facts }), availableDiskBytes: async () => disk.available,
    machine: (_binary, path) => {
      const machine = new FixtureMachine(JSON.parse(readFileSync(path, 'utf8')));
      machines.push(machine);
      maximumLive = Math.max(maximumLive, machines.filter(vm => vm.alive()).length);
      onMachine(machine);
      return machine;
    } });
  return { directory, assets, runtime, facts, disk, machines, onMachine, maximumLive: () => maximumLive,
    async close() { for (const vm of machines) vm.unconfirmedStopError = undefined; await runtime.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); } };
}
