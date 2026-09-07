import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32')('reopens on an available port without reusing another identity or printing duplicate URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-console-launch-'));
  const children: ChildProcess[] = [];
  const upstream = createServer((request, response) => response.end(JSON.stringify({owner: request.headers['x-runtime-owner']})));
  const foreign = createServer((_request, response) => response.end('unrelated listener'));
  const listen = (server: ReturnType<typeof createServer>) => new Promise<number>(resolvePort => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') resolvePort(address.port);
  }));
  const apiPort = await listen(upstream);
  const occupiedPort = await listen(foreign);
  try {
    // Capture launches without opening a user's browser during ordinary tests.
    await writeFile(join(directory, process.platform === 'darwin' ? 'open' : 'xdg-open'), '#!/bin/sh\nexit 0\n', {mode: 0o700});
    const launch = async (port: number, owner: string, command = 'console') => {
      const child = spawn(resolve('node_modules/.bin/tsx'), ['src/cli.ts', command, ...(command === 'computer' ? ['open', 'run-1'] : ['--thread', 'review']), '--port', String(port)], {
        env: {...process.env, PATH: `${directory}:${process.env.PATH}`, RAT_THINGS_API_URL: `http://127.0.0.1:${apiPort}`, AGENT_RUNTIME_UNSIGNED: 'true', RAT_THINGS_LOCAL_OWNER: owner},
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let output = '';
      let errors = '';
      child.stdout!.on('data', chunk => { output += chunk.toString(); });
      child.stderr!.on('data', chunk => { errors += chunk.toString(); });
      await expect.poll(() => output, {timeout: 10_000}).toContain('Rat Things console: http://');
      const url = output.trim().split('Rat Things console: ')[1]!;
      expect(output.trim().split('\n')).toHaveLength(1);
      expect(errors).toBe('');
      expect(await (await fetch(new URL('/api/v1/identity', url))).json()).toEqual({owner});
      return new URL(url);
    };
    const first = await launch(occupiedPort, 'first-owner');
    expect(first.port).not.toBe(String(occupiedPort));
    expect(first.searchParams.get('thread')).toBe('review');
    const reopened = await launch(Number(first.port), 'second-owner', 'computer');
    expect(reopened.port).not.toBe(first.port);
    expect(reopened.searchParams.get('run')).toBe('run-1');
    expect(await (await fetch(new URL('/api/v1/identity', first))).json()).toEqual({owner: 'first-owner'});
    expect(await (await fetch(`http://127.0.0.1:${occupiedPort}`)).text()).toBe('unrelated listener');
  } finally {
    for (const child of children) {
      if (child.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
    for (const server of [upstream, foreign]) {
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
    await rm(directory, {recursive: true, force: true});
  }
}, 30_000);
