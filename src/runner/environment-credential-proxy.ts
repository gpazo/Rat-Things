import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, isIP, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, rootCertificates, TLSSocket, type SecureContext } from 'node:tls';
import { publicNetworkAddress } from '../domain/network-address.js';
import { substituteEnvironmentHeaders, type EnvironmentCredentialSubstitution, type HostedCredentialPolicy } from '../domain/environment-credential-planning.js';
import { runProcess } from './process.js';

export interface EnvironmentCredentialProxy {
  url: string;
  certificate: string;
  close(): Promise<void>;
}

/** The only component holding raw sandbox credentials runs in the trusted host UID. */
export async function createEnvironmentCredentialProxy(options: {
  network: HostedCredentialPolicy['network']; credentials: EnvironmentCredentialSubstitution[];
  signal?: AbortSignal;
}): Promise<EnvironmentCredentialProxy> {
  const directory = await mkdtemp(join(tmpdir(), 'rat-credential-proxy-'));
  const privateDirectory = join(directory, 'private');
  const sockets = new Set<Socket>();
  const authorities = new WeakMap<Socket, URL>();
  const contexts = new Map<string, Promise<SecureContext>>();
  const pendingCertificates = new Set<Promise<SecureContext>>();
  let certificateQueue: Promise<unknown> = Promise.resolve();
  const abort = new AbortController();
  const stop = () => abort.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const server = createServer({ maxHeaderSize: 96 * 1024 }, (request, response) => {
    void forward(request, response).catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 128;
  const track = (socket: Socket) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(120_000, () => socket.destroy());
  };
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (request, socket, head) => { void upgrade(request, socket as Socket, head).catch(() => socket.destroy()); });
  // A CONNECT authority is pinned for the entire decrypted connection. Inner
  // Host headers, absolute URLs and SNI cannot redirect an authenticated request.
  server.on('connect', (request, socket, head) => {
    void tunnel(request, socket as Socket, head).catch(() => socket.destroy());
  });
  const close = async () => {
    abort.abort(); options.signal?.removeEventListener('abort', stop);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled(pendingCertificates);
    await rm(directory, { recursive: true, force: true });
  };
  abort.signal.addEventListener('abort', () => { for (const socket of sockets) socket.destroy(); }, { once: true });
  try {
    await mkdir(privateDirectory, { mode: 0o700 });
    await certificateCommand(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '3650',
      '-subj', '/CN=Rat Things Session Credential Authority', '-keyout', 'ca.key', '-out', 'ca.pem']);
    const certificate = join(directory, 'ca-bundle.pem');
    await writeFile(certificate, [...rootCertificates, await readFile(join(privateDirectory, 'ca.pem'), 'utf8')].join('\n'), { mode: 0o444 });
    await chmod(directory, 0o755); // Only the public CA is visible; all keys remain under private/.
    abort.signal.throwIfAborted();
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Credential proxy failed to bind');
    return { url: `http://127.0.0.1:${address.port}`, certificate, close };
  } catch (error) { await close(); throw error; }

  async function certificateCommand(arguments_: string[]): Promise<void> {
    const result = await runProcess('openssl', arguments_, { cwd: privateDirectory, env: { PATH: process.env.PATH }, timeoutMs: 10_000, signal: abort.signal });
    if (result.exitCode !== 0) throw new Error('Credential proxy certificate generation failed');
  }
  async function certificateContext(host: string): Promise<SecureContext> {
    const existing = contexts.get(host);
    if (existing) { contexts.delete(host); contexts.set(host, existing); return existing; }
    // Bound cached keys and serialize signing. No client can request certificates
    // for arbitrary hosts outside the credential grant.
    if (contexts.size >= 128) contexts.delete(contexts.keys().next().value!);
    const pending = certificateQueue.then(async () => {
      abort.signal.throwIfAborted();
      const id = randomBytes(16).toString('hex');
      const files = ['.key', '.csr', '.ext', '.pem'].map(suffix => join(privateDirectory, id + suffix));
      try {
        await certificateCommand(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', `/CN=${host}`, '-keyout', id + '.key', '-out', id + '.csr']);
        await writeFile(files[2]!, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}\n`, { mode: 0o600 });
        await certificateCommand(['x509', '-req', '-in', id + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', `0x${id}`, '-days', '3650', '-extfile', id + '.ext', '-out', id + '.pem']);
        return createSecureContext({ key: await readFile(files[0]!), cert: await readFile(files[3]!), minVersion: 'TLSv1.2' });
      } finally { await Promise.all(files.map(file => rm(file, { force: true }))); }
    });
    certificateQueue = pending.catch(() => {});
    pendingCertificates.add(pending);
    contexts.set(host, pending);
    try { return await pending; } catch (error) { if (contexts.get(host) === pending) contexts.delete(host); throw error; }
    finally { pendingCertificates.delete(pending); }
  }
  function admit(target: URL): void {
    if (target.username || target.password || target.hash || !['http:', 'https:'].includes(target.protocol)
      || options.network.access === 'disabled'
      || options.network.access === 'restricted' && !options.network.allowed_domains.some(host => host.toLowerCase() === target.hostname)) throw new Error('Destination denied');
  }
  async function resolveTarget(target: URL) {
    admit(target); abort.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([lookup(target.hostname.replace(/^\[|\]$/g, ''), { all: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 5000); timer.unref(); })]).finally(() => clearTimeout(timer));
    abort.signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !publicNetworkAddress(address))) throw new Error('Destination must be public');
    return addresses[0]!;
  }
  async function tunnel(request: IncomingMessage, socket: Socket, head: Buffer) {
    if (authorities.has(socket)) throw new Error('Nested CONNECT is not allowed');
    const target = new URL(`https://${request.url}`);
    if (target.pathname !== '/' || target.search || request.url !== target.host && request.url !== `${target.hostname}:443`) throw new Error('Invalid CONNECT target');
    const address = await resolveTarget(target);
    const intercept = ['', '443', '8443'].includes(target.port) && options.credentials.some(credential => credential.allowedHosts.includes(target.hostname));
    if (!intercept) {
      const upstream = connect({ host: address.address, port: Number(target.port || 443) }); track(upstream);
      upstream.setTimeout(10_000, () => upstream.destroy());
      await once(upstream, 'connect');
      upstream.setTimeout(120_000);
      if (socket.destroyed || abort.signal.aborted) { upstream.destroy(); return; }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
      socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
      return;
    }
    const context = await certificateContext(target.hostname);
    if (socket.destroyed || abort.signal.aborted) return;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    const tls = new TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'],
      SNICallback: (name, callback) => callback(name.toLowerCase() === target.hostname ? null : new Error('Destination mismatch'), context),
    });
    track(tls); authorities.set(tls, target);
    server.emit('connection', tls);
  }
  async function forward(incoming: IncomingMessage, response: ServerResponse) {
    let target: URL;
    try { target = destination(incoming); } catch { response.writeHead(403).end(); return; }
    const requestOptions = await outgoingOptions(incoming, target);
    if (incoming.socket.destroyed || response.destroyed) return;
    const outgoing = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, requestOptions, upstream => {
      response.writeHead(upstream.statusCode ?? 502, proxyRequestHeaders(upstream.headers));
      upstream.pipe(response); upstream.on('error', () => response.destroy());
    });
    outgoing.setTimeout(120_000, () => outgoing.destroy());
    outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    incoming.once('aborted', () => outgoing.destroy());
    response.once('close', () => outgoing.destroy());
    incoming.pipe(outgoing);
  }
  function destination(incoming: IncomingMessage): URL {
    const authority = authorities.get(incoming.socket);
    const target = authority ? new URL(incoming.url ?? '/', authority) : new URL(incoming.url ?? '');
    const host = authority && incoming.headers.host ? new URL(`https://${incoming.headers.host}`) : undefined;
    if (authority && (target.origin !== authority.origin || host?.origin !== authority.origin || host.pathname !== '/' || host.search || host.hash || host.username || host.password)
      || !authority && target.protocol !== 'http:') throw new Error('Destination mismatch');
    return target;
  }
  async function outgoingOptions(incoming: IncomingMessage, target: URL): Promise<RequestOptions> {
    const address = await resolveTarget(target);
    const headers = proxyRequestHeaders(substituteEnvironmentHeaders(incoming.headers, target, authorities.has(incoming.socket) ? options.credentials : []));
    return { method: incoming.method, headers: { ...headers, host: target.host }, agent: false, signal: abort.signal,
      lookup: (_hostname, parameters, callback) => parameters.all ? callback(null, [address]) : callback(null, address.address, address.family),
    };
  }
  async function upgrade(incoming: IncomingMessage, socket: Socket, head: Buffer) {
    if (incoming.method !== 'GET' || incoming.headers.upgrade?.toLowerCase() !== 'websocket') throw new Error('Invalid upgrade');
    const target = destination(incoming);
    const requestOptions = await outgoingOptions(incoming, target);
    if (socket.destroyed) return;
    const outgoing = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { ...requestOptions,
      headers: { ...requestOptions.headers, connection: 'Upgrade', upgrade: 'websocket' },
    });
    outgoing.setTimeout(10_000, () => outgoing.destroy());
    outgoing.on('error', () => socket.destroy());
    socket.once('close', () => outgoing.destroy());
    outgoing.once('response', response => { response.destroy(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    outgoing.once('upgrade', (response, upstream, upstreamHead) => {
      if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket' || socket.destroyed || abort.signal.aborted) { upstream.destroy(); socket.destroy(); return; }
      track(upstream);
      const headers = proxyRequestHeaders(response.headers);
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket',
        ...Object.entries(headers).flatMap(([name, values]) => values === undefined ? [] : (Array.isArray(values) ? values : [values]).map(value => `${name}: ${value}`)), '', '',
      ].join('\r\n'));
      if (head.length) upstream.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(upstream); upstream.pipe(socket);
      socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
    });
    outgoing.end();
  }
}

/** Never relay hop-by-hop or proxy authentication headers to a destination. */
export function proxyRequestHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const connection = typeof headers.connection === 'string' ? headers.connection.split(',').map(name => name.trim().toLowerCase()) : [];
  const hop = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', ...connection]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hop.has(name.toLowerCase())));
}
