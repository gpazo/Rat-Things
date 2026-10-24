import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalNativeProbeStorage } from '../../src/adapters/local-native-probe-storage.js';

async function fixture(body: string, deadlineMs = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'rat-probe-storage-'));
  const probes = join(directory, 'probes'); await mkdir(probes, { mode: 0o700 });
  const probe = join(probes, `probe-${randomUUID()}`); await mkdir(probe, { mode: 0o700 });
  const executable = join(directory, 'recovery');
  const evidence = join(directory, 'calls');
  await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(evidence)}, JSON.stringify({args:process.argv.slice(2),env:process.env})+'\\n');\n${body}\n`, { mode: 0o700 });
  const storage = new LocalNativeProbeStorage({ trustedExecutable: executable, deadlineMs });
  return { directory, probes, probe, executable, evidence, storage,
    close: () => rm(directory, { recursive: true, force: true }) };
}

it('uses only the trusted fixed helper with no inherited environment and bounded disposable paths', async () => {
  const test = await fixture(`process.stdout.write(JSON.stringify({schemaVersion:1,status:'absent'}));`);
  try {
    await writeFile(join(test.probe, 'binding.json'), '{}', { mode: 0o600 });
    await test.storage.recover(test.probes);
    const call = JSON.parse((await readFile(test.evidence, 'utf8')).trim());
    expect(call.args).toEqual(['--dispose-probe-disk', test.probe]);
    expect(Object.keys(call.env).filter(name => name !== '__CF_USER_TEXT_ENCODING')).toEqual([]);
    expect(await readdir(test.probe)).toEqual(['binding.json']);
  } finally { await test.close(); }
});

it('accepts the fixed sparse probe disk size independently of immutable payload inventory limits', async () => {
  const test = await fixture(`fs.unlinkSync(require('node:path').join(process.argv[3], 'workspace.raw')); process.stdout.write(JSON.stringify({schemaVersion:1,status:'disposed'}));`);
  try {
    const disk = await open(join(test.probe, 'workspace.raw'), 'wx', 0o600);
    try { await disk.truncate(256 * 1024 ** 2); } finally { await disk.close(); }
    await test.storage.dispose(test.probe);
    await expect(lstat(join(test.probe, 'workspace.raw'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await test.close(); }
});

it('retains a locked disk after bounded retries', async () => {
  const test = await fixture(`process.stdout.write(JSON.stringify({schemaVersion:1,status:'locked'})); process.exitCode=2;`, 150);
  try {
    await writeFile(join(test.probe, 'workspace.raw'), 'held', { mode: 0o600 });
    await expect(test.storage.recover(test.probes)).rejects.toThrow();
    expect(await readFile(join(test.probe, 'workspace.raw'), 'utf8')).toBe('held');
    expect((await readFile(test.evidence, 'utf8')).trim().split('\n').length).toBeGreaterThan(0);
  } finally { await test.close(); }
});

it.each(['foreign-name', 'symlink', 'oversized-log', 'oversized-metadata', 'too-many-directories'])('rejects %s before starting any helper', async invalid => {
  const test = await fixture(`process.stdout.write(JSON.stringify({schemaVersion:1,status:'absent'}));`);
  try {
    if (invalid === 'foreign-name') await writeFile(join(test.probe, 'helper-path'), '/untrusted/executable', { mode: 0o600 });
    if (invalid === 'symlink') await symlink(test.executable, join(test.probe, 'binding.json'));
    if (invalid === 'too-many-directories') for (let index = 0; index < 16; index++) await mkdir(join(test.probes, `probe-${randomUUID()}`), { mode: 0o700 });
    if (invalid === 'oversized-metadata' || invalid === 'oversized-log') {
      const folder = invalid === 'oversized-log' ? join(test.probe, 'boot-abcdef') : test.probe;
      if (folder !== test.probe) await mkdir(folder, { mode: 0o700 });
      const file = await open(join(folder, invalid === 'oversized-log' ? 'serial.log' : 'binding.json'), 'wx', 0o600);
      try { await file.truncate(invalid === 'oversized-log' ? 1024 ** 2 + 1 : 16 * 1024 ** 2 + 1); } finally { await file.close(); }
    }
    await expect(test.storage.recover(test.probes)).rejects.toThrow();
    await expect(lstat(test.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await test.close(); }
});

it('refuses a recovery helper inside the candidate bundle or writable by other users', async () => {
  const test = await fixture(`process.stdout.write(JSON.stringify({schemaVersion:1,status:'absent'}));`);
  try {
    await expect(test.storage.dispose(test.probe, test.directory)).rejects.toThrow('not trusted');
    await chmod(test.executable, 0o777);
    await expect(test.storage.dispose(test.probe)).rejects.toThrow('not trusted');
    await expect(lstat(test.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await test.close(); }
});

it('kills and reaps a timed-out recovery helper before rejecting', async () => {
  const test = await fixture(`setInterval(()=>{},1000);`, 50);
  try {
    await expect(test.storage.dispose(test.probe)).rejects.toThrow('timed out');
    expect((await readFile(test.evidence, 'utf8')).trim().split('\n')).toHaveLength(1);
  } finally { await test.close(); }
});
