import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { constants, createReadStream } from 'node:fs';
import { appendFile, copyFile, lstat, mkdtemp, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { NativeProofRuntime } from './runtime.js';
import type { LocalStartRequest } from '../../../../src/core/local-runtime-ports.js';
import { EnvironmentService } from '../../../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../../../src/core/environment-template-service.js';
import { sessionAgent } from '../../../../src/core/session-planning.js';
import { workspaceDigests } from '../../../../src/domain/workspace-checkpoint.js';
import { MemoryAgentsStore } from '../../../../tests/agents/fixtures.js';

if (process.env.RAT_NATIVE_VM_FAULTS !== '1') throw new Error('Set RAT_NATIVE_VM_FAULTS=1 to run real native fault injection');

if (process.argv[2] === '--controller') {
  const request = JSON.parse(await readFile(process.argv[5]!, 'utf8')) as LocalStartRequest;
  const runtime = new NativeProofRuntime(process.argv[3]!, process.argv[4]!);
  await runtime.start(request, async () => {});
  const machine = machines(runtime).get(request.worker.sessionId)!;
  console.log(JSON.stringify({ ready: true, helperPid: machine.child.pid }));
  setInterval(() => {}, 1000);
} else await acceptance();

interface Machine { child: ChildProcess; exited: Promise<unknown>; control(input: unknown): Promise<unknown> }
function machines(runtime: NativeProofRuntime): Map<string, Machine> { return Reflect.get(runtime, 'machines') as Map<string, Machine>; }

async function acceptance() {
  const directory = await mkdtemp(resolve('.runtime/local-vm-worker/faults-'));
  const assets = await faultAssets(directory);
  const results: Array<{ case: string; elapsedMs: number }> = [];
  const runtimes: NativeProofRuntime[] = [];
  const runtime = () => { const result = new NativeProofRuntime(directory, assets); runtimes.push(result); return result; };
  let current = runtime();
  const request = await configuration('once');
  const sessionId = request.worker.sessionId;
  const resume: LocalStartRequest = { ...request, workspace: { ...request.workspace, kind: 'resume' } };
  const record = async (name: string, run: () => Promise<void>) => {
    const started = performance.now(); await run(); results.push({ case: name, elapsedMs: Math.round(performance.now() - started) });
    console.log(`Passed ${name}`);
    await writeFile(join(directory, 'progress.json'), JSON.stringify({ results }, null, 2), { mode: 0o600 });
  };
  console.log(`Native fault evidence: ${directory}`);
  try {
    await record('fresh workspace and executor health', async () => { await current.start(request, async () => {}); assert(await current.running(sessionId)); });
    for (const target of ['executor', 'supervisor']) for (const signal of ['stop', 'kill']) {
      await record(`${target} ${signal} detection and same-disk recovery`, async () => {
        const machine = machines(current).get(sessionId)!;
        assert.deepEqual(await machine.control({ operation: 'fault', target, signal }), { injected: true });
        const deadline = Date.now() + 6000;
        while (await current.running(sessionId)) { assert(Date.now() < deadline, 'Unresponsive worker remained ready'); await delay(100); }
        await current.start(resume, async () => {});
        assert(await current.running(sessionId));
        const files = await current.snapshot(sessionId);
        assert.equal(content(files, 'setup-count'), 'once');
        await current.start(resume, async () => {});
      });
    }
    await record('abrupt VM death after durable setup', async () => {
      const machine = machines(current).get(sessionId)!;
      machine.child.kill('SIGKILL'); await machine.exited;
      assert.equal(await current.running(sessionId), false);
      await assert.rejects(current.snapshot(sessionId), /Native/);
      await current.close(); current = runtime();
      await current.start(resume, async () => {});
      assert.equal(content(await current.snapshot(sessionId), 'setup-count'), 'once');
    });
    await record('controller death releases the disk before replacement', async () => {
      const input = join(directory, 'controller-input.json');
      await writeFile(input, JSON.stringify(resume), { mode: 0o600 });
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('testing/local-runtime/native-vm/worker/faults.ts'), '--controller', directory, assets, input], {
        env: { PATH: process.env.PATH, RAT_NATIVE_VM_FAULTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      });
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      let helperPid: number | undefined;
      const deadline = setTimeout(() => child.kill('SIGKILL'), 60_000);
      try {
        for await (const line of lines) { const value = JSON.parse(line) as { ready?: boolean; helperPid?: number }; if (value.ready) { helperPid = value.helperPid; break; } }
        assert(helperPid, 'Child controller did not reach readiness');
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        const stoppedBy = Date.now() + 10_000;
        while (alive(helperPid)) { assert(Date.now() < stoppedBy, 'VM helper survived its controller'); await delay(100); }
        await current.start(resume, async () => {});
        assert.equal(content(await current.snapshot(sessionId), 'setup-count'), 'once');
      } finally { clearTimeout(deadline); child.kill('SIGKILL'); lines.close(); }
    });
    await record('concurrent resume and snapshot preserve one setup generation', async () => {
      await Promise.all([current.start(resume, async () => {}), current.start(resume, async () => {})]);
      assert.equal(machines(current).size, 1);
      const [files] = await Promise.all([current.snapshot(sessionId), current.start(resume, async () => {})]);
      assert.equal(content(files, 'setup-count'), 'once'); assert(await current.running(sessionId));
      await current.stop(sessionId);
    });
    await record('replaced and missing prepared disks reject twice without allocation', async () => {
      const disk = join(directory, 'native-proof', sessionId, 'workspace.raw');
      const boots = current.boots.length;
      await rename(disk, `${disk}.original`);
      await copyFile(`${disk}.original`, disk, constants.COPYFILE_FICLONE);
      for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(current.start(resume, async () => {}), /disk was replaced/);
      await unlink(disk);
      for (let attempt = 0; attempt < 2; attempt++) { await assert.rejects(current.start(resume, async () => {}), { code: 'ENOENT' }); await assert.rejects(lstat(disk), { code: 'ENOENT' }); }
      assert.equal(current.boots.length, boots);
      await rename(`${disk}.original`, disk);
    });
    await record('interrupted setup is retained without replay', async () => {
      const interrupted = await configuration('interrupted');
      await assert.rejects(current.start(interrupted, async () => {}));
      const retry: LocalStartRequest = { ...interrupted, workspace: { ...interrupted.workspace, kind: 'resume' } };
      for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(current.start(retry, async () => {}));
      assert.equal(content(await current.snapshot(interrupted.worker.sessionId), 'setup-count'), 'once');
    });
    await writeFile(join(directory, 'result.json'), JSON.stringify({ inference: 'none', assets: 'isolated fault-control overlay over current prepared image', results,
      boots: runtimes.flatMap(item => item.boots), unverified: ['host sleep/wake', 'memory pressure admission', 'signed installation and updates'] }, null, 2), { mode: 0o600 });
  } finally { for (const item of runtimes) await item.close(); }
}

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }
function content(files: Array<{ path: string; data: string }>, path: string) { const file = files.find(item => item.path === path); assert(file, `${path} missing`); return Buffer.from(file.data, 'base64').toString(); }

async function configuration(mode: 'once' | 'interrupted'): Promise<LocalStartRequest> {
  const sessionId = `sess_${randomUUID().replaceAll('-', '')}`;
  const ownerId = 'native-fault-acceptance';
  const store = new MemoryAgentsStore();
  const environments = new EnvironmentService({ store, templates: new EnvironmentTemplateService({ store }),
    managedFiles: async () => { throw new Error('Fault acceptance exports through the native snapshot port'); }, credentials: {
    create: async () => { throw new Error('No external credentials in native fault acceptance'); }, read: async () => { throw new Error('No external credentials'); }, revoke: async () => {},
  } });
  const environment = await environments.prepare(ownerId, sessionId, { type: 'openai_hosted', network: { access: 'disabled' },
    setup_commands: [{ command: `node -e "require('node:fs').appendFileSync('/workspace/setup-count','once');${mode === 'interrupted' ? 'process.exit(73)' : ''}"` }],
  });
  assert(environment.type === 'openai_hosted');
  const launch = { sessionId, turnId: '', agent: sessionAgent({ model: 'gpt-5.4' }, 'agent', 1), environment, input: [], ...await environments.managedLaunch(ownerId, environment.id) };
  return { workspace: { kind: 'create', identity: { version: 1, sessionId, generation: randomUUID(), setupDigest: workspaceDigests(launch).setupDigest } },
    worker: { ownerId, sessionId, environmentId: environment.id, executorKey: randomUUID(), harnessKey: randomUUID(), launch } };
}

async function faultAssets(directory: string) {
  const assets = await mkdtemp(join(directory, 'assets-'));
  const source = resolve('.runtime/local-vm-worker');
  for (const file of ['Image', 'rat-native-worker', 'worker-initramfs.gz']) await copyFile(join(source, file), join(assets, file), constants.COPYFILE_FICLONE);
  const original = await readFile(resolve('runtime/native/guest.py'), 'utf8');
  const anchor = '            if operation == "ping":';
  assert.equal(original.split(anchor).length, 2);
  const injection = `            if operation == "fault" and not readonly:
                target = request["target"]
                selected = signal.SIGKILL if request["signal"] == "kill" else signal.SIGSTOP
                if target == "supervisor":
                    os.kill(worker.pid, selected)
                elif target == "executor":
                    found = []
                    for entry in os.listdir("/proc"):
                        if not entry.isdigit(): continue
                        try:
                            command = open("/proc/" + entry + "/cmdline", "rb").read().split(b"\\0")
                            if len(command) > 1 and command[1] == b"exec-server": found.append(int(entry))
                        except OSError: pass
                    if len(found) != 1: raise RuntimeError("Expected one executor")
                    os.kill(found[0], selected)
                else: raise ValueError("Invalid fault target")
                result = {"injected": True}
            elif operation == "ping":`;
  const guest = Buffer.from(original.replace(anchor, injection));
  await appendFile(join(assets, 'worker-initramfs.gz'), gzipSync(Buffer.concat([cpio('opt/rat-things/native-guest.py', guest), cpio('TRAILER!!!', Buffer.alloc(0))])));
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const hash = createHash('sha256'); for await (const chunk of createReadStream(join(assets, 'worker-initramfs.gz'))) hash.update(chunk);
  await writeFile(join(assets, 'manifest.json'), JSON.stringify({ ...manifest, initrdSha256: hash.digest('hex') }), { mode: 0o600 });
  return assets;
}

function cpio(name: string, data: Buffer) {
  const filename = Buffer.from(`${name}\0`);
  const fields = [1, 0o100644, 0, 0, 1, 0, data.length, 0, 0, 0, 0, filename.length, 0];
  const header = Buffer.from(`070701${fields.map(value => value.toString(16).padStart(8, '0')).join('')}`);
  const pad = (length: number) => Buffer.alloc((4 - length % 4) % 4);
  return Buffer.concat([header, filename, pad(header.length + filename.length), data, pad(data.length)]);
}
