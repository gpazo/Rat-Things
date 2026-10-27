import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each(['runtime/native/init.sh', 'testing/local-runtime/linux-kvm/init.sh'])('bootstraps a locally resolvable guest identity after archive scrubbing: %s', async script => {
  const source = await readFile(script, 'utf8');
  await promisify(execFile)('bash', ['-n', script]);
  const start = source.indexOf('mount -t proc proc /proc\n') + 'mount -t proc proc /proc\n'.length;
  const end = source.indexOf('mount -t sysfs sysfs /sys', start);
  expect(start).toBeGreaterThan('mount -t proc proc /proc\n'.length);
  expect(end).toBeGreaterThan(start);
  expect(end).toBeLessThan(source.indexOf('exec python3 /opt/rat-things/native-guest.py'));
  const root = await mkdtemp(join(tmpdir(), 'rat-guest-hostname-'));
  try {
    const files = ['/proc/sys/kernel/hostname', '/etc/hostname', '/etc/hosts'];
    await mkdir(join(root, 'proc/sys/kernel'), { recursive: true });
    await mkdir(join(root, 'etc'));
    for (const file of files) await writeFile(join(root, file), '', { mode: 0o644 });
    // Execute the actual boot assignments against an empty disposable filesystem;
    // never write the test host's /etc or kernel hostname.
    let bootstrap = source.slice(start, end);
    expect([...bootstrap.matchAll(/>\s*(\S+)/g)].map(match => match[1]).sort()).toEqual([...files].sort());
    for (const file of files) bootstrap = bootstrap.replaceAll(file, `'${join(root, file)}'`);
    await promisify(execFile)('bash', ['-eu', '-c', bootstrap]);
    const hostname = (await readFile(join(root, '/proc/sys/kernel/hostname'), 'utf8')).trim();
    expect(hostname).toBe('rat-things-worker');
    expect((await readFile(join(root, '/etc/hostname'), 'utf8')).trim()).toBe(hostname);
    const addresses = (await readFile(join(root, '/etc/hosts'), 'utf8')).trim().split('\n').map(line => {
      const [address, ...names] = line.trim().split(/\s+/);
      expect(names).toContain(hostname);
      expect(names).toContain('localhost');
      return address;
    });
    expect(addresses.sort()).toEqual(['127.0.0.1', '::1']);
    for (const file of ['/etc/hostname', '/etc/hosts']) expect((await stat(join(root, file))).mode & 0o777).toBe(0o644);
  } finally { await rm(root, { recursive: true, force: true }); }
});
