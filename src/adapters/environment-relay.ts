import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { EnvironmentService } from '../core/environment-service.js';
import type { EnvironmentIdentity } from '../credentials/environment.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { relayStreamId } from '../domain/relay-frame.js';
import type { EnvironmentFileOperation } from '../core/environment-file-ports.js';
import { environmentDirectory } from '../domain/environment-files.js';
import { decodeBase64, workspacePath } from '../domain/environment-planning.js';

const securityProfile = 'noise_hybrid_ik_v1';
interface PublicKey { suite: string; x25519_public_key: string; mlkem768_public_key: string }
interface Registration {
  id: string; identity: EnvironmentIdentity; publicKey: PublicKey; executor?: WebSocket;
  harnesses: Set<WebSocket>; streams: Map<string, WebSocket>;
  authorizations: Map<string, { key: string; expires: number }>;
}
interface Ticket { registration: Registration; role: 'executor' | 'harness'; expires: number }

/** A rendezvous transport. The executor and harness perform end-to-end Noise authentication. */
export function createEnvironmentRelay(options: {
  environments: Pick<EnvironmentService, 'authenticate' | 'connection'>;
  publicURL: () => string;
  now?: () => number;
  files?: (identity: EnvironmentIdentity, key: string, operation: EnvironmentFileOperation, signal: AbortSignal) => Promise<unknown>;
}) {
  const now = options.now ?? Date.now;
  const registrations = new Map<string, Registration>();
  const tickets = new Map<string, Ticket>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();
  let fileOperations = 0;
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      const status = error instanceof AgentsApiError ? error.status : 500;
      reply(response, status, { error: { message: status === 500 ? 'Environment relay unavailable.' : (error as Error).message } });
    });
  });

  function ticketURL(registration: Registration, role: Ticket['role']): string {
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { registration, role, expires: now() + (role === 'executor' ? 3_600_000 : 60_000) });
    const url = new URL('/relay', options.publicURL());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket);
    return url.href;
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://relay.invalid');
    if (request.method === 'GET' && url.pathname === '/health') { reply(response, 200, { status: 'ok' }); return; }
    const route = /^\/cloud\/environment\/(env_[a-zA-Z0-9]+)\/(register|connect|validate|files)$/.exec(url.pathname);
    if (!route || request.method !== 'POST') throw new AgentsApiError(404, 'Route not found.');
    const environmentId = route[1]!;
    const operation = route[2]!;
    const role = operation === 'connect' || operation === 'files' ? 'harness' : 'executor';
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const identity = await options.environments.authenticate(token, environmentId, role);
    const body = await readBody(request, operation === 'files' ? 6 * 1024 * 1024 : 16_384);
    if (operation === 'files') {
      if (!options.files || fileOperations >= 2) throw new AgentsApiError(503, 'Environment file service is busy.');
      const input = fileOperation(body);
      const abort = new AbortController();
      response.once('close', () => abort.abort());
      fileOperations++;
      try { reply(response, 200, await options.files(identity, token, input, abort.signal)); }
      finally { fileOperations--; }
      return;
    }
    if (operation === 'register') {
      if (body.security_profile !== securityProfile) throw new AgentsApiError(400, 'Unsupported relay security profile.');
      const publicKey = readPublicKey(body.executor_public_key);
      const previous = registrations.get(environmentId);
      if (previous) disconnect(previous);
      const registration: Registration = { id: randomUUID(), identity, publicKey, harnesses: new Set(), streams: new Map(), authorizations: new Map() };
      registrations.set(environmentId, registration);
      reply(response, 200, { environment_id: environmentId, url: ticketURL(registration, 'executor'), security_profile: securityProfile, executor_registration_id: registration.id });
      return;
    }
    const registration = registrations.get(environmentId);
    if (!registration || registration.identity.ownerId !== identity.ownerId) throw new AgentsApiError(409, 'Environment executor is not connected.');
    if (operation === 'connect') {
      if (registration.executor?.readyState !== WebSocket.OPEN) throw new AgentsApiError(409, 'Environment executor is not connected.');
      if (registration.harnesses.size >= 64) throw new AgentsApiError(429, 'Environment connection limit reached.');
      const publicKey = readPublicKey(body.harness_public_key);
      const authorization = randomBytes(32).toString('base64url');
      registration.authorizations.set(authorization, { key: keyDigest(publicKey), expires: now() + 60_000 });
      reply(response, 200, { environment_id: environmentId, url: ticketURL(registration, 'harness'), security_profile: securityProfile, executor_registration_id: registration.id, executor_public_key: registration.publicKey, harness_key_authorization: authorization });
      return;
    }
    const authorization = typeof body.harness_key_authorization === 'string' ? registration.authorizations.get(body.harness_key_authorization) : undefined;
    reply(response, 200, { valid: Boolean(authorization && authorization.expires > now() && body.executor_registration_id === registration.id && authorization.key === keyDigest(readPublicKey(body.harness_public_key))) });
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay.invalid');
    const ticket = tickets.get(url.searchParams.get('ticket') ?? '');
    if (url.pathname !== '/relay' || !ticket || ticket.expires <= now() || registrations.get(ticket.registration.identity.environmentId) !== ticket.registration) {
      socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n'); return;
    }
    if (ticket.role === 'harness') tickets.delete(url.searchParams.get('ticket')!);
    sockets.handleUpgrade(request, socket, head, (peer) => {
      alive.set(peer, true);
      peer.on('pong', () => alive.set(peer, true));
      const { registration, role } = ticket;
      if (role === 'executor') {
        registration.executor?.terminate();
        registration.executor = peer;
        void options.environments.connection(registration.identity, registration.id, true).catch(() => peer.close(1011, 'Environment unavailable'));
      } else registration.harnesses.add(peer);
      let streamId: string | undefined;
      peer.on('message', (data, binary) => {
        try {
          if (!binary) throw new Error('Binary relay frames are required');
          const bytes = buffer(data);
          const id = relayStreamId(bytes);
          let destination: WebSocket | undefined;
          if (role === 'harness') {
            if (streamId && streamId !== id || registration.streams.has(id) && registration.streams.get(id) !== peer) throw new Error('Relay stream identity changed');
            streamId = id;
            registration.streams.set(id, peer);
            destination = registration.executor;
          } else destination = registration.streams.get(id);
          if (!destination || destination.readyState !== WebSocket.OPEN) {
            if (role === 'harness') peer.close(1013, 'Relay peer disconnected');
            return;
          }
          if (destination.bufferedAmount > 4 * 1024 * 1024) { peer.close(1013, 'Relay backpressure'); destination.close(1013, 'Relay backpressure'); return; }
          destination.send(bytes, { binary: true });
        } catch { peer.close(1008, 'Invalid relay frame'); }
      });
      peer.on('error', () => peer.terminate());
      peer.on('close', () => {
        registration.harnesses.delete(peer);
        if (streamId && registration.streams.get(streamId) === peer) registration.streams.delete(streamId);
        if (role === 'executor' && registration.executor === peer) {
          delete registration.executor;
          for (const harness of registration.harnesses) harness.close(1013, 'Executor disconnected');
          void options.environments.connection(registration.identity, registration.id, false).catch(() => {});
        }
      });
    });
  });

  const lease = setInterval(() => {
    for (const peer of sockets.clients) {
      if (!alive.get(peer)) { peer.terminate(); continue; }
      alive.set(peer, false);
      peer.ping();
    }
    for (const [key, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(key);
    for (const registration of registrations.values()) {
      for (const [key, authorization] of registration.authorizations) if (authorization.expires <= now()) registration.authorizations.delete(key);
      if (registration.executor?.readyState !== WebSocket.OPEN) continue;
      void options.environments.connection(registration.identity, registration.id, true).catch(() => disconnect(registration));
    }
  }, 15_000);
  lease.unref();
  server.on('close', () => { clearInterval(lease); for (const registration of registrations.values()) disconnect(registration); sockets.close(); });
  return { server, close: async () => {
    clearInterval(lease);
    for (const registration of registrations.values()) disconnect(registration);
    sockets.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

function disconnect(registration: Registration) {
  registration.executor?.terminate();
  for (const harness of registration.harnesses) harness.terminate();
}
function buffer(data: RawData): Buffer { return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data); }
function reply(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) { response.end(); return; }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function readBody(request: IncomingMessage, maximum = 16_384): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > maximum) throw new AgentsApiError(413, 'Registry request is too large.');
    parts.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Return a protocol error without including request contents. */ }
  throw new AgentsApiError(400, 'Invalid registry request.');
}
function readPublicKey(value: unknown): PublicKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AgentsApiError(400, 'Invalid Noise public key.');
  const key = value as Record<string, unknown>;
  if (Object.keys(key).length !== 3 || key.suite !== 'Noise_hybridIK_X25519+MLKEM768_AESGCM_SHA256' || !base64Length(key.x25519_public_key, 32) || !base64Length(key.mlkem768_public_key, 1184)) throw new AgentsApiError(400, 'Invalid Noise public key.');
  return { suite: key.suite, x25519_public_key: key.x25519_public_key as string, mlkem768_public_key: key.mlkem768_public_key as string };
}
function base64Length(value: unknown, length: number): boolean { return typeof value === 'string' && Buffer.from(value, 'base64').length === length && Buffer.from(value, 'base64').toString('base64') === value; }
function keyDigest(key: PublicKey): string { return createHash('sha256').update(JSON.stringify(key)).digest('hex'); }

function fileOperation(body: Record<string, unknown>): EnvironmentFileOperation {
  if ((body.operation === 'write_chunk' || body.operation === 'write_abort') && typeof body.path === 'string' && typeof body.uploadId === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(body.uploadId)) {
    workspacePath(body.path, 'path');
    if (body.operation === 'write_abort') return { operation: 'write_abort', path: body.path, uploadId: body.uploadId };
    if (typeof body.data === 'string' && decodeBase64(body.data, 'data').byteLength <= 1024 * 1024 && Number.isSafeInteger(body.offset) && Number(body.offset) >= 0 && Number.isSafeInteger(body.size) && Number(body.size) <= 50 * 1024 * 1024 && typeof body.sha256 === 'string' && /^[a-f0-9]{64}$/.test(body.sha256)) return { operation: 'write_chunk', path: body.path, uploadId: body.uploadId, data: body.data, offset: Number(body.offset), size: Number(body.size), sha256: body.sha256 };
  }
  if (body.operation === 'list' && typeof body.path === 'string') return { operation: 'list', path: environmentDirectory(body.path), ...(body.missingOk === true ? { missingOk: true } : {}) };
  if (body.operation === 'read' && typeof body.path === 'string' && Number.isSafeInteger(body.offset) && Number(body.offset) >= 0 && Number.isSafeInteger(body.length) && Number(body.length) > 0 && Number(body.length) <= 1024 * 1024) {
    workspacePath(body.path, 'path');
    return { operation: 'read', path: body.path, offset: Number(body.offset), length: Number(body.length) };
  }
  if (body.operation === 'write' && typeof body.path === 'string' && typeof body.data === 'string') {
    workspacePath(body.path, 'path');
    if (decodeBase64(body.data, 'data').byteLength > 4 * 1024 * 1024) throw new AgentsApiError(413, 'File exceeds the inline upload limit.');
    return { operation: 'write', path: body.path, data: body.data };
  }
  throw new AgentsApiError(400, 'Invalid environment file operation.');
}
