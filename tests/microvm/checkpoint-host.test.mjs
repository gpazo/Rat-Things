import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { withFrozenCgroup, checkpointHostEnabled } from '../../microvm/checkpoint-host.mjs';

async function fakeCgroup(test) {
  const root = await mkdtemp(join(tmpdir(), 'rat-freezer-contract-'));
  await writeFile(join(root, 'cgroup.freeze'), '0'); await writeFile(join(root, 'cgroup.events'), 'frozen 0\n');
  let stopped = false; let mirrored = '0';
  const mirror = (async () => { while (!stopped) { const value = await readFile(join(root, 'cgroup.freeze'), 'utf8'); if ((value === '0' || value === '1') && value !== mirrored) { await writeFile(join(root, 'cgroup.events'), `frozen ${value}\n`); mirrored = value; } await delay(2); } })();
  try { await test(root); }
  finally { stopped = true; await mirror; await rm(root, { recursive: true, force: true }); }
}

describe('host freezer lifecycle contract (simulated kernel events)', () => {
  it('enables only configured persistent EC2 workers with durable storage', () => {
    expect(checkpointHostEnabled('true', 'ec2', true, {})).toBe(true);
    for (const input of [['false', 'ec2', true, {}], ['true', 'microvm', true, {}], ['true', 'ec2', false, {}], ['true', 'ec2', true, undefined]]) expect(checkpointHostEnabled(...input)).toBe(false);
  });
  it('verifies freezing before capture and confirms thaw on a failed capture', async () => fakeCgroup(async root => {
    const failure = new Error('unsupported file');
    await expect(withFrozenCgroup(root, async () => { expect(await readFile(join(root, 'cgroup.events'), 'utf8')).toContain('frozen 1'); throw failure; })).rejects.toBe(failure);
    expect(failure.checkpointThawed).toBe(true);
    expect(await readFile(join(root, 'cgroup.freeze'), 'utf8')).toBe('0');
  }));
  it('thaws at the deadline while a filesystem operation is still blocked', async () => fakeCgroup(async root => {
    let complete; const blocked = new Promise(resolve => { complete = resolve; });
    try {
      await expect(withFrozenCgroup(root, () => blocked, { timeoutMs: 60 })).rejects.toThrow('deadline');
      expect(await readFile(join(root, 'cgroup.freeze'), 'utf8')).toBe('0');
    } finally { complete('too late to commit'); }
  }));
  it('kills an unsafe restore before thawing and never thaws when kill fails', async () => fakeCgroup(async root => {
    let killed = false;
    await expect(withFrozenCgroup(root, () => new Promise(() => {}), { timeoutMs: 60, onAbort: async () => { expect(await readFile(join(root, 'cgroup.freeze'), 'utf8')).toBe('1'); killed = true; } })).rejects.toThrow('deadline');
    expect(killed).toBe(true); expect(await readFile(join(root, 'cgroup.freeze'), 'utf8')).toBe('0');
    await expect(withFrozenCgroup(root, () => new Promise(() => {}), { timeoutMs: 60, onAbort: async () => { throw new Error('kill failed'); } })).rejects.toThrow('kill failed');
    expect(await readFile(join(root, 'cgroup.freeze'), 'utf8')).toBe('1');
  }));
});
