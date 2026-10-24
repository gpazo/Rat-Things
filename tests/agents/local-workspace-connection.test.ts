import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { connectLocalWorkspace, readLocalConnection } from '../../src/local-workspace.js';
import { NATIVE_PROTOCOL } from '../../src/domain/native-protocol.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function profile() {
  const directory = await mkdtemp(join(tmpdir(), 'rat-connection-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function service(directory: string, identity?: unknown) {
  const token = '1'.repeat(64);
  const authorized = vi.fn();
  const server = createServer((request, response) => {
    const valid = request.headers.authorization === `Bearer ${token}`;
    authorized(valid);
    response.writeHead(valid ? 200 : 403); response.end(JSON.stringify({ service: identity }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  const connection = { baseURL: `http://127.0.0.1:${address.port}/v1`, token };
  const close = vi.fn(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  cleanup.push(async () => { if (server.listening) await close(); });
  await writeFile(join(directory, 'connection.json'), JSON.stringify(connection), { mode: 0o600 });
  return { ...connection, close, authorized };
}

it('authenticates and reuses the existing service without owning its lifetime', async () => {
  const directory = await profile(); const existing = await service(directory);
  const start = vi.fn(async () => existing);
  const connected = await connectLocalWorkspace({ directory, start });
  expect(connected.owned).toBe(false);
  expect(connected.connection.baseURL).toBe(existing.baseURL);
  expect(existing.authorized).toHaveBeenCalledWith(true);
  expect(start).not.toHaveBeenCalled();
  await connected.close();
  expect(existing.close).not.toHaveBeenCalled();
});

it('drains the service it created when the caller closes', async () => {
  const directory = await profile();
  const owned = await connectLocalWorkspace({ directory, start: () => service(directory) });
  expect(owned.owned).toBe(true);
  await owned.close();
  await expect(fetch(`${owned.connection.baseURL}/workspace`)).rejects.toThrow();
});

it('re-reads the connection after another process wins startup ownership', async () => {
  const directory = await profile();
  let winner: Awaited<ReturnType<typeof service>> | undefined;
  const connected = await connectLocalWorkspace({ directory, start: async () => {
    winner = await service(directory);
    throw new Error('The local workspace is already running.');
  } });
  expect(connected.owned).toBe(false);
  expect(connected.connection.baseURL).toBe(winner!.baseURL);
  await connected.close();
  expect(winner!.close).not.toHaveBeenCalled();
});

it('preserves the startup failure when no authenticated owner becomes available', async () => {
  const directory = await profile();
  await expect(connectLocalWorkspace({ directory, start: async () => { throw new Error('Installer unavailable'); } })).rejects.toThrow('Installer unavailable');
});

const nativeIdentity = { kind: 'native' as const, protocol: NATIVE_PROTOCOL };

it.each([undefined, { kind: 'development' }, { kind: 'native', protocol: { ...NATIVE_PROTOCOL, workerProtocol: 999 } }])(
  'rejects an incompatible authenticated owner without starting or stopping any service', async identity => {
    const directory = await profile(); const existing = await service(directory, identity);
    const start = vi.fn(async () => existing);
    await expect(connectLocalWorkspace({ directory, requiredService: nativeIdentity, start })).rejects.toThrow('incompatible local service');
    await expect(readLocalConnection(directory, nativeIdentity)).rejects.toThrow('incompatible local service');
    expect(start).not.toHaveBeenCalled();
    expect(existing.close).not.toHaveBeenCalled();
  });

it('reuses compatible native ownership before any release is selected', async () => {
  const directory = await profile(); const existing = await service(directory, nativeIdentity);
  const start = vi.fn(async () => existing);
  const connected = await connectLocalWorkspace({ directory, requiredService: nativeIdentity, start });
  expect(connected.owned).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

it('also rejects an incompatible process that wins the startup race', async () => {
  const directory = await profile();
  let winner: Awaited<ReturnType<typeof service>> | undefined;
  await expect(connectLocalWorkspace({ directory, requiredService: nativeIdentity, start: async () => {
    winner = await service(directory, { kind: 'development' });
    throw new Error('The local workspace is already running.');
  } })).rejects.toThrow('incompatible local service');
  expect(winner!.close).not.toHaveBeenCalled();
});
