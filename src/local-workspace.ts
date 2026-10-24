import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
import { localServiceCompatible, type LocalServiceIdentity } from './domain/local-service.js';

export function localWorkspaceDirectory(): string {
  return resolve(process.env.RAT_THINGS_LOCAL_DIR ?? join(homedir(), '.rat-things', 'local'));
}

export interface LocalConnection { baseURL: string; token: string }

export interface LocalWorkspaceConnection {
  readonly connection: LocalConnection;
  readonly owned: boolean;
  close(): Promise<void>;
}

export async function connectLocalWorkspace(options: {
  readonly directory?: string;
  readonly requiredService?: LocalServiceIdentity | undefined;
  readonly start: () => Promise<LocalConnection & { close(): Promise<void> }>;
}): Promise<LocalWorkspaceConnection> {
  const reachable = async (): Promise<LocalConnection | undefined> => {
    let connection: LocalConnection;
    let response: Response;
    try {
      connection = await readLocalConnection(options.directory);
      response = await createLocalAgentsFetch(connection)(`${connection.baseURL}/workspace`, { signal: AbortSignal.timeout(1500) });
    } catch { return undefined; }
    if (!response.ok || !options.requiredService) {
      await response.body?.cancel();
      return response.ok ? connection : undefined;
    }
    await assertLocalService(response, options.requiredService);
    return connection;
  };
  const existing = await reachable();
  if (existing) return { connection: existing, owned: false, close: async () => {} };
  try {
    const server = await options.start();
    return { connection: { baseURL: server.baseURL, token: server.token }, owned: true, close: () => server.close() };
  } catch (error) {
    for (let attempt = 0; attempt < 10; attempt++) {
      await delay(100);
      const connection = await reachable();
      if (connection) return { connection, owned: false, close: async () => {} };
    }
    throw error;
  }
}

export async function readLocalConnection(directory = localWorkspaceDirectory(), required?: LocalServiceIdentity): Promise<LocalConnection> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8')); }
  catch { throw new Error('Start your local workspace with rat-things serve, or open rat-things console.'); }
  if (!value || typeof value !== 'object' || !('baseURL' in value) || typeof value.baseURL !== 'string' ||
    !('token' in value) || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('Invalid local workspace connection.');
  validateLocalBase(value.baseURL);
  const connection = { baseURL: value.baseURL, token: value.token };
  if (required) {
    const response = await createLocalAgentsFetch(connection)(`${connection.baseURL}/workspace`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('The local service could not authenticate this connection.');
    }
    await assertLocalService(response, required);
  }
  return connection;
}

async function assertLocalService(response: Response, required: LocalServiceIdentity): Promise<void> {
  let workspace: unknown;
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Workspace identity is missing.');
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 16 * 1024) throw new Error('Workspace identity exceeds its limit.');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    workspace = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new Error('The running local service could not be identified. Stop it before opening the installed Rat Things app.'); }
  if (!workspace || typeof workspace !== 'object' || !('service' in workspace)
    || !localServiceCompatible(required, workspace.service)) {
    throw new Error('This profile is already open in an incompatible local service. Stop that service, then reopen Rat Things.');
  }
}

function validateLocalBase(baseURL: string) {
  const endpoint = new URL(baseURL);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
    endpoint.username || endpoint.password || endpoint.pathname !== '/v1' || endpoint.search || endpoint.hash) throw new Error('Local workspaces require an authenticated loopback endpoint.');
  return endpoint;
}

export function createLocalAgentsFetch(connection: LocalConnection): typeof fetch {
  const endpoint = validateLocalBase(connection.baseURL);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== endpoint.origin || !url.pathname.startsWith('/v1/')) throw new Error('Local credentials cannot be sent to another destination.');
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${connection.token}`);
    return fetch(new Request(request, { headers, redirect: 'error' }));
  };
}

export function createLocalAgentsClient(connection: LocalConnection): OpenAI {
  return new OpenAI({ baseURL: connection.baseURL, apiKey: connection.token, fetch: createLocalAgentsFetch(connection) });
}
