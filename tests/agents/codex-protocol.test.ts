import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { rpcClient } from './codex-protocol.js';

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); });
function start(program: string) {
  const child = spawn(process.execPath, ['-e', program]);
  children.push(child);
  child.stderr.resume();
  return rpcClient(child);
}

it('rejects pending and later requests when the process exits before initialization', async () => {
  const client = start('process.exitCode = 65');
  await expect(client.call('initialize', {})).rejects.toThrow('RPC process closed (exit 65)');
  await expect(client.call('initialize', {})).rejects.toThrow('RPC process closed (exit 65)');
  client.close();
}, 3000);

it('consumes a final falsey response before the process closes', async () => {
  const client = start(`require('node:readline').createInterface({input:process.stdin}).once('line', line => {
    const {id} = JSON.parse(line);
    process.stdout.write(JSON.stringify({id,result:false})+'\\n', () => process.exit(0));
  })`);
  expect(await client.call('initialize', {})).toBe(false);
  client.close();
});

it('settles pending calls when the caller closes the client', async () => {
  const client = start('process.stdin.resume()');
  const result = expect(client.call('initialize', {})).rejects.toThrow('RPC client closed');
  client.close();
  await result;
});

it('rejects failed process startup without exposing arguments', async () => {
  const child = spawn('/nonexistent/rat-rpc-test-binary', ['private-argument']);
  children.push(child);
  const client = rpcClient(child);
  await expect(client.call('initialize', {})).rejects.toThrow('RPC process failed to start');
  client.close();
});
