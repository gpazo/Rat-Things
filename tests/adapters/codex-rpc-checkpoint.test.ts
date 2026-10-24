import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexRpcClient } from '../../src/adapters/codex-rpc.js';

it('reaps a still-live native process after its stdin closes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-things-rpc-'));
  const marker = join(directory, 'child.pid');
  const source = `const fs = require('node:fs'); fs.closeSync(0); fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const client = new CodexRpcClient({ binary: process.execPath, binaryArguments: ['-e', source], cwd: directory, environment: {} });
  let pid = 0;
  try {
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      pid = Number(await readFile(marker, 'utf8').catch(() => '0'));
      if (!pid) await delay(10);
    }
    expect(pid).toBeGreaterThan(0);
    await expect(client.initialize()).rejects.toThrow('closed');
    await client.close();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects a missing executable without an uncaught broken-pipe error in the host', async () => {
  const client = new CodexRpcClient({ binary: '/missing/rat-codex-executable', cwd: process.cwd(), environment: {} });
  await expect(client.initialize()).rejects.toThrow('closed');
  await client.close();
});

it.each([0, 7])('requires native process exit zero after EOF (exit=%s)', async code => {
  const source = `const reader = require('readline').createInterface({ input: process.stdin });
    reader.on('line', line => { const value = JSON.parse(line); if (value.id) process.stdout.write(JSON.stringify({ id: value.id, result: {} }) + '\\n'); });
    reader.on('close', () => process.exit(${code}));`;
  const client = new CodexRpcClient({ binary: process.execPath, binaryArguments: ['-e', source], cwd: process.cwd(), environment: process.env });
  try {
    await client.initialize();
    if (code === 0) await expect(client.closeCheckpoint()).resolves.toBeUndefined();
    else await expect(client.closeCheckpoint()).rejects.toThrow('not clean');
    await expect(client.call('thread/start', {})).rejects.toThrow('unavailable');
  } finally { await client.close(); }
});

it('does not treat a process already closed by normal cancellation as checkpoint evidence', async () => {
  const client = new CodexRpcClient({ binary: process.execPath, binaryArguments: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), environment: process.env });
  await client.close();
  await expect(client.closeCheckpoint()).rejects.toThrow('before checkpoint');
});
