import { mkdirSync, lstatSync, existsSync, chownSync, chmodSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';

export const checkpointHostEnabled = (enabled, backend, persistent, storage) => enabled === 'true' && backend === 'ec2' && persistent === true && Boolean(storage);
export const checkpointStagingRoot = '/tmp/rat-workspace-checkpoints';
export function prepareCheckpointStateRoot(stateRoot) {
  for (const directory of [dirname(dirname(stateRoot)), dirname(stateRoot), stateRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o711 });
    const state = lstatSync(directory);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Checkpoint backing directory is invalid');
    chownSync(directory, 0, 0); chmodSync(directory, 0o711);
  }
}

export function prepareCheckpointHost(generation, root = '/sys/fs/cgroup/rat-checkpoints') {
  if (process.getuid?.() !== 0 || !/^[a-f0-9]{64}$/.test(generation) || !existsSync('/sys/fs/cgroup/cgroup.controllers')) throw new Error('Checkpoints require a root-owned cgroup v2 host');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, generation);
  mkdirSync(path, { mode: 0o700 });
  if (!existsSync(join(path, 'cgroup.freeze')) || !existsSync(join(path, 'cgroup.kill'))) throw new Error('Kernel checkpoint freezer is unavailable');
  mkdirSync(checkpointStagingRoot, { recursive: true, mode: 0o700 });
  const stage = lstatSync(checkpointStagingRoot);
  if (!stage.isDirectory() || stage.isSymbolicLink() || stage.uid !== 0 || (stage.mode & 0o077)) throw new Error('Checkpoint staging is not private');
  return path;
}

/** The host stays runnable; the runner and every descendant pause together. */
export async function withFrozenCgroup(group, operation, { timeoutMs = 15_000, signal, onAbort } = {}) {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let safeToThaw = true;
  let entered = false;
  let failure;
  const abort = () => controller.abort(new Error('Checkpoint capture was cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Checkpoint freeze deadline exceeded')), timeoutMs);
  const wait = async (expected, bounded) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (bounded) controller.signal.throwIfAborted();
      const events = await readFile(join(group, 'cgroup.events'), 'utf8');
      if (new RegExp(`^frozen ${expected}$`, 'm').test(events)) return;
      if (Date.now() > deadline) throw new Error('Checkpoint freezer transition failed');
      await delay(10);
    }
  };
  try {
    if (signal?.aborted) abort();
    controller.signal.throwIfAborted();
    await writeFile(join(group, 'cgroup.freeze'), '1');
    await wait(1, true);
    entered = true;
    const interrupted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const result = await Promise.race([operation(controller.signal), interrupted]);
    if (Date.now() >= deadline) controller.abort(new Error('Checkpoint freeze deadline exceeded'));
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    failure = error;
    if (controller.signal.aborted && onAbort) { safeToThaw = false; await onAbort(); safeToThaw = true; }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (safeToThaw) {
      await writeFile(join(group, 'cgroup.freeze'), '0'); await wait(0, false);
      if (entered && failure instanceof Error) failure.checkpointThawed = true;
    }
  }
}

export async function checkpointOperation(run, message) {
  if (!run.checkpointGroup || run.checkpointBusy || !/^[a-f0-9-]{36}$/.test(message.checkpointId ?? '') || !['capture', 'restore', 'discard'].includes(message.action)) throw new Error('Checkpoint request is unavailable');
  const file = join(checkpointStagingRoot, `${run.generation}-${message.checkpointId}.gz`);
  if (message.action === 'discard') { await rm(file, { force: true }); return {}; }
  run.checkpointBusy = true;
  run.checkpointAction = message.action;
  const controller = new AbortController();
  run.checkpointAbort = controller;
  try {
    // Filesystem calls and compression run off the host event loop, keeping the
    // freezer watchdog responsive even during a large archive or blocked NFS IO.
    let worker;
    try {
      return await withFrozenCgroup(run.checkpointGroup, () => new Promise((resolve, reject) => {
        worker = new Worker(new URL('./checkpoint-worker.mjs', import.meta.url), { workerData: {
          action: message.action, file, workspace: run.checkpointWorkspace, sha256: message.sha256,
        } });
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(new Error('Checkpoint filesystem worker failed')); });
      }), { signal: controller.signal, ...(message.action === 'restore' ? {
        // A blocked restore might still mutate this new generation. No runner
        // is allowed to resume into it after the deadline.
        onAbort: async () => { run.checkpointUnsafe = true; await writeFile(join(run.checkpointGroup, 'cgroup.kill'), '1'); },
      } : {}) });
    } finally { if (worker) void worker.terminate(); }

  } catch (error) {
    await rm(file, { force: true });
    if (message.action === 'capture' && error instanceof Error && error.checkpointThawed) return { skipped: true };
    throw error;
  } finally { run.checkpointBusy = false; run.checkpointAbort = undefined; run.checkpointAction = undefined; }
}
