import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { chmod, chown, stat, copyFile, mkdtemp, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { prepareCheckpointHost, withFrozenCgroup, prepareCheckpointStateRoot } from '../../microvm/checkpoint-host.mjs';
import { captureWorkspace, checkpointHash, restoreWorkspace } from '../../src/runner/workspace-checkpoint.js';

it.runIf(process.env.RAT_CHECKPOINT_FREEZER_TEST === 'true')('freezes detached descendants through the actual bootstrap and restores consistent bytes', async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Freezer conformance requires root on Linux with writable cgroup v2');
  const generation = randomBytes(32).toString('hex');
  const group = prepareCheckpointHost(generation);
  const root = await mkdtemp('/tmp/rat-real-freezer-');
  await chmod(root, 0o777);
  const backing = join(root, 'session', 'generations', generation);
  prepareCheckpointStateRoot(backing);
  expect((await stat(backing)).mode & 0o777).toBe(0o711);
  expect((await stat(backing)).uid).toBe(0);
  const source = join(backing, 'workspace');
  const { mkdir } = await import('node:fs/promises'); await mkdir(source, { mode: 0o777 }); await chmod(source, 0o700); await chown(source, 10001, 10001);
  const proof = join(source, 'proof'); const pidfile = join(root, 'detached-pid');
  await copyFile(new URL('../../microvm/runner-bootstrap.mjs', import.meta.url), join(root, 'runner-bootstrap.mjs'));
  const writer = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(proof)},'x'),5)`;
  await writeFile(join(root, 'runner.mjs'), `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e',${JSON.stringify(writer)}],{detached:true,stdio:'ignore',uid:10001,gid:10001});
    child.unref();writeFileSync(${JSON.stringify(pidfile)},String(child.pid));setInterval(()=>{},1000);`);
  const runner = spawn(process.execPath, [join(root, 'runner-bootstrap.mjs')], { env: { PATH: process.env.PATH, RAT_CHECKPOINT_CGROUP: group }, stdio: 'ignore' });
  try {
    for (let n = 0; n < 200; n++) { if ((await readFile(proof).catch(() => Buffer.alloc(0))).length > 4) break; await delay(10); }
    expect((await readFile(proof)).length).toBeGreaterThan(4);
    const child = await readFile(pidfile, 'utf8');
    expect((await readFile(join(group, 'cgroup.procs'), 'utf8')).split('\n')).toContain(child);
    let captured; let frozenBytes;
    await withFrozenCgroup(group, async () => {
      frozenBytes = await readFile(proof);
      await delay(100);
      expect(await readFile(proof)).toEqual(frozenBytes);
      captured = await captureWorkspace(source);
    });
    for (let n = 0; n < 100 && (await readFile(proof)).length === frozenBytes.length; n++) await delay(10);
    expect((await readFile(proof)).length).toBeGreaterThan(frozenBytes.length);
    const restored = join(root, 'restored'); await mkdir(restored);
    await restoreWorkspace(restored, captured, checkpointHash(captured));
    expect(await readFile(join(restored, 'proof'))).toEqual(frozenBytes);
    await expect(withFrozenCgroup(group, async () => { throw new Error('intentional capture failure'); })).rejects.toThrow('intentional');
    expect(await readFile(join(group, 'cgroup.freeze'), 'utf8')).toContain('0');
  } finally {
    await writeFile(join(group, 'cgroup.kill'), '1');
    await writeFile(join(group, 'cgroup.freeze'), '0');
    if (runner.exitCode === null && runner.signalCode === null) await once(runner, 'exit');
    for (let n = 0; n < 100; n++) { try { await rmdir(group); break; } catch (error) { if (n === 99) throw error; await delay(10); } }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
