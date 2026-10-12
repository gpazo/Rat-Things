import { expect, it } from 'vitest';
import { CodexRpcClient } from '../../src/adapters/codex-rpc.js';

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
