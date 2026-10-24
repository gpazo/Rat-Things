import { constants } from 'node:fs';
import { copyFile, lstat, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { gate, nativeFixture, startRequest } from './native-runtime-fixtures.js';

const noClaim = async () => {};

it.each(['uncreated', 'missing', 'replaced'] as const)('rejects %s resume storage twice before starting a VM or stopping the prior worker', async failure => {
  const fixture = await nativeFixture();
  const { runtime, directory, machines } = fixture;
  const create = startRequest();
  const request = { ...create, workspace: { ...create.workspace, kind: 'resume' as const } };
  const disk = join(directory, 'native-proof', request.worker.sessionId, 'workspace.raw');
  try {
    if (failure !== 'uncreated') {
      await runtime.start(create, noClaim);
      if (failure === 'missing') await unlink(disk);
      else { await rename(disk, `${disk}.original`); await copyFile(`${disk}.original`, disk, constants.COPYFILE_FICLONE); }
    }
    const boots = runtime.boots.length;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (failure === 'replaced') await expect(runtime.start(request, noClaim)).rejects.toThrow('disk was replaced');
      else await expect(runtime.start(request, noClaim)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(runtime.boots).toHaveLength(boots);
    for (const machine of machines) expect(machine.stop).not.toHaveBeenCalled();
    if (failure !== 'replaced') await expect(lstat(disk)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(String((await lstat(disk, { bigint: true })).ino)).not.toBe(JSON.parse(await readFile(join(directory, 'native-proof', request.worker.sessionId, 'binding.json'), 'utf8')).inode);
  } finally { await fixture.close(); }
});

it('does not allocate a replacement when create encounters a retained binding', async () => {
  const fixture = await nativeFixture();
  const request = startRequest();
  const disk = join(fixture.directory, 'native-proof', request.worker.sessionId, 'workspace.raw');
  try {
    await fixture.runtime.start(request, noClaim);
    await unlink(disk);
    await expect(fixture.runtime.start(request, noClaim)).rejects.toThrow('binding already exists');
    await expect(lstat(disk)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.runtime.boots).toHaveLength(1);
    expect(fixture.machines[0]!.stop).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it('refuses critical or unknown pressure before the claim, disk allocation or helper creation', async () => {
  const fixture = await nativeFixture();
  const request = startRequest();
  const claim = vi.fn(noClaim);
  try {
    for (const memoryPressure of ['critical', 'unknown'] as const) {
      fixture.facts.memoryPressure = memoryPressure;
      await expect(fixture.runtime.start(request, claim)).rejects.toMatchObject({ decision: { kind: 'wait', code: 'local_memory_pressure' } });
      await expect(lstat(join(fixture.directory, 'native-proof', request.worker.sessionId))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(claim).not.toHaveBeenCalled();
    expect(fixture.machines).toHaveLength(0);
    fixture.facts.memoryPressure = 'normal';
    await fixture.runtime.start(request, claim);
    expect(claim).toHaveBeenCalledOnce();
    expect(fixture.machines[0]!.configuration).toMatchObject({ cpuCount: 1, memoryMiB: 2048 });
  } finally { await fixture.close(); }
});

it('holds the one native slot across an awaited claim and serializes a snapshot until start finishes', async () => {
  const fixture = await nativeFixture();
  const request = startRequest();
  const paused = gate();
  const claim = vi.fn(async () => paused.promise);
  try {
    const starting = fixture.runtime.start(request, claim);
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
    const secondClaim = vi.fn(noClaim);
    await expect(fixture.runtime.start(startRequest('sess_other'), secondClaim)).rejects.toMatchObject({ decision: { code: 'local_capacity' } });
    expect(secondClaim).not.toHaveBeenCalled();
    expect((await fixture.runtime.status()).native).toMatchObject({ configuredCapacity: 2, effectiveCapacity: 1, occupied: true, admission: { code: 'local_capacity' } });
    const snapshot = fixture.runtime.snapshot(request.worker.sessionId);
    expect(fixture.machines).toHaveLength(0);
    paused.release();
    await starting;
    await expect(snapshot).resolves.toEqual([]);
    expect(fixture.maximumLive()).toBe(1);
    expect(fixture.machines.every(vm => !vm.alive())).toBe(true);
  } finally { paused.release(); await fixture.close(); }
});

it('releases a rejected claim and preserves the live worker when a replacement claim fails', async () => {
  const fixture = await nativeFixture();
  const first = startRequest();
  try {
    await expect(fixture.runtime.start(first, async () => { throw new Error('Claim failed'); })).rejects.toThrow('Claim failed');
    expect(fixture.machines).toHaveLength(0);
    await expect(lstat(join(fixture.directory, 'native-proof', first.worker.sessionId))).rejects.toMatchObject({ code: 'ENOENT' });
    await fixture.runtime.start(first, noClaim);
    await expect(fixture.runtime.start({ ...first, workspace: { ...first.workspace, kind: 'resume' } }, async () => { throw new Error('Replacement claim failed'); })).rejects.toThrow('Replacement claim failed');
    expect(fixture.machines).toHaveLength(1);
    expect(fixture.machines[0]!.stop).not.toHaveBeenCalled();
    expect(await fixture.runtime.running(first.worker.sessionId)).toBe(true);
  } finally { await fixture.close(); }
});

it('retains an ambiguous claim and rejects the resulting missing-disk resume without allocation', async () => {
  const fixture = await nativeFixture();
  const request = startRequest();
  let persisted: unknown;
  try {
    await expect(fixture.runtime.start(request, async () => { persisted = request.workspace.identity; throw new Error('Ambiguous write'); })).rejects.toThrow('Ambiguous write');
    expect(persisted).toEqual(request.workspace.identity);
    await expect(fixture.runtime.start({ ...request, workspace: { ...request.workspace, kind: 'resume' } }, noClaim)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.machines).toHaveLength(0);
    await fixture.runtime.start(startRequest('sess_other'), noClaim);
    expect(fixture.machines).toHaveLength(1);
  } finally { await fixture.close(); }
});

it('releases failed registration after helper exit and retries the retained disk as resume', async () => {
  const fixture = await nativeFixture();
  const request = startRequest();
  fixture.onMachine.mockImplementationOnce(machine => { machine.beforeControl = async operation => { if (operation === 'start') throw new Error('Registration failed'); }; });
  try {
    await expect(fixture.runtime.start(request, noClaim)).rejects.toThrow('Registration failed');
    expect(fixture.machines[0]!.alive()).toBe(false);
    const disk = join(fixture.directory, 'native-proof', request.worker.sessionId, 'workspace.raw');
    const inode = (await lstat(disk)).ino;
    await fixture.runtime.start({ ...request, workspace: { ...request.workspace, kind: 'resume' } }, noClaim);
    expect((await lstat(disk)).ino).toBe(inode);
    expect(fixture.machines[1]!.configuration.workspace).toBe('existing');
    expect(fixture.maximumLive()).toBe(1);
  } finally { await fixture.close(); }
});

it.each(['snapshot', 'readiness'] as const)('accounts for %s in the same slot and releases it after confirmed exit', async operation => {
  const fixture = await nativeFixture();
  const request = startRequest();
  const paused = gate();
  const held = vi.fn();
  try {
    if (operation === 'snapshot') { await fixture.runtime.start(request, noClaim); await fixture.runtime.stop(request.worker.sessionId); }
    fixture.onMachine.mockImplementation(machine => { machine.beforeControl = async command => {
      if (command === (operation === 'snapshot' ? 'snapshot' : 'ping')) { held(); await paused.promise; }
    }; });
    const active = operation === 'snapshot' ? fixture.runtime.snapshot(request.worker.sessionId) : fixture.runtime.setup();
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce());
    const claim = vi.fn(noClaim);
    await expect(fixture.runtime.start(startRequest('sess_other'), claim)).rejects.toMatchObject({ decision: { code: 'local_capacity' } });
    expect(claim).not.toHaveBeenCalled();
    paused.release(); await active;
    fixture.onMachine.mockReset();
    await fixture.runtime.start(startRequest('sess_other'), noClaim);
    expect(fixture.maximumLive()).toBe(1);
  } finally { paused.release(); await fixture.close(); }
});

it('refuses readiness and another Session snapshot while a worker owns the slot', async () => {
  const fixture = await nativeFixture();
  try {
    await fixture.runtime.start(startRequest(), noClaim);
    await expect(fixture.runtime.setup()).rejects.toMatchObject({ decision: { code: 'local_capacity' } });
    await expect(fixture.runtime.snapshot('sess_other')).rejects.toMatchObject({ decision: { code: 'local_capacity' } });
    expect(fixture.machines).toHaveLength(1);
    expect(fixture.machines[0]!.stop).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it('retains capacity on unconfirmed stop and releases it when helper exit is confirmed', async () => {
  const fixture = await nativeFixture();
  const request = startRequest();
  try {
    await fixture.runtime.start(request, noClaim);
    const machine = fixture.machines[0]!;
    machine.unconfirmedStopError = new Error('Exit unknown');
    await expect(fixture.runtime.stop(request.worker.sessionId)).rejects.toThrow('Exit unknown');
    await expect(fixture.runtime.start(startRequest('sess_other'), noClaim)).rejects.toMatchObject({ decision: { code: 'local_capacity' } });
    machine.unconfirmedStopError = undefined;
    machine.stopError = new Error('Unmount failed');
    await expect(fixture.runtime.stop(request.worker.sessionId)).rejects.toThrow('Unmount failed');
    await fixture.runtime.start(startRequest('sess_other'), noClaim);
    expect(fixture.maximumLive()).toBe(1);
  } finally { await fixture.close(); }
});

it('drains an admitted claim through shutdown before stopping its helper', async () => {
  const fixture = await nativeFixture();
  const paused = gate();
  const claim = vi.fn(async () => paused.promise);
  try {
    const starting = fixture.runtime.start(startRequest(), claim);
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
    let closed = false;
    const closing = fixture.runtime.close().then(() => { closed = true; });
    await expect(fixture.runtime.start(startRequest('sess_other'), noClaim)).rejects.toThrow('shutting down');
    expect(closed).toBe(false);
    paused.release(); await starting; await closing;
    expect(fixture.machines.every(vm => !vm.alive())).toBe(true);
  } finally { paused.release(); await fixture.close(); }
});

it.each(['snapshot', 'readiness'] as const)('releases the slot after %s fails and its helper exits', async operation => {
  const fixture = await nativeFixture();
  const request = startRequest();
  try {
    if (operation === 'snapshot') { await fixture.runtime.start(request, noClaim); await fixture.runtime.stop(request.worker.sessionId); }
    fixture.onMachine.mockImplementationOnce(machine => { machine.beforeControl = async command => {
      if (command === (operation === 'snapshot' ? 'snapshot' : 'ping')) { machine.kill(); throw new Error('Fixture operation failed'); }
    }; });
    const result = operation === 'snapshot' ? fixture.runtime.snapshot(request.worker.sessionId) : fixture.runtime.setup();
    await expect(result).rejects.toThrow();
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
    await fixture.runtime.start(startRequest('sess_other'), noClaim);
    expect(fixture.maximumLive()).toBe(1);
  } finally { await fixture.close(); }
});
