import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const gateModule = fileURLToPath(new URL('../../src/runner/startup-gate.ts', import.meta.url));
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

function startGateChild(source = `
  import { awaitStartupRelease } from ${JSON.stringify(gateModule)};
  process.stdout.write('waiting\\n');
  await awaitStartupRelease('4', 500);
  process.stdout.write('entered');
`) {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'],
  });
  children.push(child as ChildProcessWithoutNullStreams);
  return child;
}

it('holds a real Node child behind fd 4 until the parent releases the pipe', async () => {
  const child = startGateChild();
  let output = '';
  let sawWaiting!: () => void;
  const waiting = new Promise<void>(resolve => { sawWaiting = resolve; });
  child.stdout!.on('data', chunk => {
    output += chunk.toString();
    if (output.includes('waiting\n')) sawWaiting();
  });
  await waiting;
  expect(output).toBe('waiting\n');

  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`gate child exited ${code}`)));
  });
  const gate = child.stdio[4] as Writable;
  gate.write(Buffer.from([0x52]));
  gate.end();
  await exited;
  expect(output).toBe('waiting\nentered');
});

it.each<[string, (stream: Writable) => void]>([
  ['EOF', stream => stream.end()],
  ['malformed token', stream => { stream.write(Buffer.from([0x58])); stream.end(); }],
  ['extra data', stream => { stream.write(Buffer.from([0x52, 0x52])); stream.end(); }],
  ['late extra data', stream => { stream.write(Buffer.from([0x52])); setTimeout(() => { stream.write(Buffer.from([0x52])); stream.end(); }, 30); }],
])('fails closed on %s', async (_label, release) => {
  const child = startGateChild(`
    import { awaitStartupRelease } from ${JSON.stringify(gateModule)};
    await awaitStartupRelease('4', 500).then(() => process.exit(0), () => process.exit(9));
  `);
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? -1));
  });
  release(child.stdio[4] as Writable);
  expect(await exited).toBe(9);
});

it('does not release on a valid byte until the parent closes the pipe', async () => {
  const child = startGateChild();
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk.toString(); });
  await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`gate child exited ${code}`)));
  });
  const gate = child.stdio[4] as Writable;
  gate.write(Buffer.from([0x52]));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(output).toBe('waiting\n');
  gate.end();
  await exited;
  expect(output).toBe('waiting\nentered');
});

it('fails closed when the private gate times out', async () => {
  const child = startGateChild(`
    import { awaitStartupRelease } from ${JSON.stringify(gateModule)};
    await awaitStartupRelease('4', 20).then(() => process.exit(0), () => process.exit(9));
  `);
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? -1));
  });
  expect(await exited).toBe(9);
});
