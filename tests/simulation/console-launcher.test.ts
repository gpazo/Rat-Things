import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

function capture(child: ChildProcess) {
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  return { stdout: () => stdout, stderr: () => stderr };
}

it('isolates native signer instances, rejects browser access, and exits on parent EOF', async () => {
  const children: ChildProcess[] = [];
  const upstream = createServer((request, response) => {
    if (request.url?.endsWith('/content')) { response.writeHead(302, { location: 'https://example.com/private' }); response.end(); return; }
    response.end(JSON.stringify({ owner: request.headers['x-runtime-owner'], authorization: request.headers.authorization ?? null }));
  });
  const foreign = createServer((_request, response) => response.end('unrelated listener'));
  const listen = (server: ReturnType<typeof createServer>) => new Promise<number>(resolvePort => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') resolvePort(address.port);
  }));
  const apiPort = await listen(upstream);
  const occupiedPort = await listen(foreign);
  try {
    const launch = async (port: number, owner: string) => {
      const token = randomBytes(32).toString('hex');
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/console-server.ts'], {
        env: { ...process.env, RAT_THINGS_API_URL: `http://127.0.0.1:${apiPort}`, RAT_THINGS_CONSOLE_TOKEN: token,
          RAT_THINGS_CONSOLE_PORT: String(port), RAT_THINGS_CONSOLE_LAUNCHER: '1', AGENT_RUNTIME_UNSIGNED: 'true', RAT_THINGS_LOCAL_OWNER: owner },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      const output = capture(child);
      await expect.poll(output.stdout, { timeout: 10_000 }).toMatch(/^\{"port":\d+\}\n$/);
      const value = JSON.parse(output.stdout()) as { port: number };
      expect(output.stderr()).toBe('');
      expect(value.port).not.toBe(port);
      return { child, token, url: `http://127.0.0.1:${value.port}`, output };
    };
    const first = await launch(occupiedPort, 'first-owner');
    const second = await launch(Number(new URL(first.url).port), 'second-owner');
    const headers = { authorization: `Bearer ${first.token}` };
    expect(await (await fetch(`${first.url}/api/v1/identity`, { headers })).json()).toEqual({ owner: 'first-owner', authorization: null });
    expect(await (await fetch(`${second.url}/api/v1/identity`, { headers: { authorization: `Bearer ${second.token}` } })).json()).toEqual({ owner: 'second-owner', authorization: null });
    expect((await fetch(`${second.url}/api/v1/identity`, { headers })).status).toBe(403);
    expect((await fetch(`${first.url}/api/v1/identity`)).status).toBe(403);
    expect((await fetch(`${first.url}/api/v1/identity`, { headers: { ...headers, origin: first.url } })).status).toBe(403);
    expect((await fetch(`${first.url}/api/v1/identity`, { headers: { ...headers, origin: '' } })).status).toBe(403);
    expect((await fetch(`${first.url}/api/v1/agents`, { method: 'POST', headers })).status).toBe(403);
    expect((await fetch(`${first.url}/api/v1/agents`, { method: 'POST', headers: { ...headers, 'x-rat-console-request': '1' }, body: '{}' })).status).toBe(200);
    expect((await fetch(`${first.url}/`, { headers })).status).toBe(404);
    expect((await fetch(`${first.url}/api/v1/agents/sessions/s/artifacts/a/content`, { headers })).status).toBe(500);
    expect(await (await fetch(`http://127.0.0.1:${occupiedPort}`)).text()).toBe('unrelated listener');
    first.child.stdin!.end();
    await expect.poll(() => first.child.exitCode).toBe(0);
    expect(first.output.stdout()).not.toContain(first.token);
    expect(first.output.stderr()).not.toContain(first.token);
  } finally {
    for (const child of children) { child.stdin?.end(); if (child.exitCode === null) child.kill(); }
    for (const server of [upstream, foreign]) {
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  }
}, 30_000);

it.skipIf(process.platform === 'win32')('launches a native binary with the bundled signer contract and reports startup failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-native-launch-'));
  const binary = join(directory, 'native-console');
  try {
    await writeFile(binary, `#!${process.execPath}\nif (!process.env.RAT_THINGS_CONSOLE_SERVER?.endsWith('console-server.ts') || process.env.RAT_THINGS_CONSOLE_NODE !== process.execPath) process.exit(2);\nconsole.log(JSON.stringify({ready:true}));\n`, { mode: 0o700 });
    const launch = () => spawn(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), 'console'], {
      env: { ...process.env, RAT_THINGS_CONSOLE_BIN: binary, RAT_THINGS_API_URL: 'https://api.example.com' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = launch();
    const output = capture(child);
    await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(0);
    expect(output.stdout()).toBe('Rat Things native console opened\n');
    expect(output.stderr()).toBe('');
    await writeFile(binary, `#!${process.execPath}\nprocess.exit(2);\n`, { mode: 0o700 });
    const failed = launch();
    const failure = capture(failed);
    await expect.poll(() => failed.exitCode, { timeout: 10_000 }).toBe(1);
    expect(failure.stderr()).toContain('native console exited before opening a window');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
