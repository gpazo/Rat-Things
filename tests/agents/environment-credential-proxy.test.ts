import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { checkServerIdentity, connect as connectTls } from 'node:tls';
import { runProcess } from '../../src/runner/process.js';
import { createEnvironmentCredentialProxy } from '../../src/runner/environment-credential-proxy.js';
import { prepareSessionEnvironmentCredentials } from '../../src/runner/session-environment-credentials.js';
import { planSessionLaunch } from '../../src/runner/session-launch-planning.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import type { SessionLaunch } from '../../src/domain/session-execution.js';
import { CodexRpcClient } from '../../src/adapters/codex-rpc.js';
import { hostedCodexArguments } from '../../src/runner/hosted-environment-planning.js';

// Only DNS and the outbound socket are redirected. CONNECT, inbound TLS,
// certificate verification, HTTP parsing and the upstream TLS server are real.
const transport = vi.hoisted(() => ({ address: '93.184.216.34', port: 0, certificate: '', destinations: [] as string[] }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: transport.address, family: 4 }]) }));
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: (target: URL, options: import('node:https').RequestOptions, callback: (response: import('node:http').IncomingMessage) => void) => {
    transport.destinations.push(target.href);
    return actual.request(target, { ...options, hostname: '127.0.0.1', servername: isIP(target.hostname) ? '' : target.hostname, checkServerIdentity: (_host, cert) => checkServerIdentity(target.hostname, cert), port: transport.port, ca: transport.certificate,
      lookup: (_hostname, parameters, done) => parameters.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4),
    }, callback);
  } };
});
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; transport.address = '93.184.216.34'; transport.destinations = []; });

async function fixture(host = 'api.example.com') {
  const directory = await mkdtemp(join(tmpdir(), 'rat-credential-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const created = await runProcess('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', `/CN=${host}`, '-addext', `subjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}`, '-keyout', 'key.pem', '-out', 'cert.pem'], { cwd: directory, timeoutMs: 10_000 });
  expect(created.exitCode).toBe(0);
  transport.certificate = await readFile(join(directory, 'cert.pem'), 'utf8');
  const requests: Array<{ headers: import('node:http').IncomingHttpHeaders; url: string | undefined; body: string }> = [];
  const server = httpsServer({ key: await readFile(join(directory, 'key.pem')), cert: transport.certificate }, async (request, response) => {
    const body: Buffer[] = []; for await (const chunk of request) body.push(Buffer.from(chunk));
    requests.push({ headers: request.headers, url: request.url, body: Buffer.concat(body).toString() });
    response.end('accepted');
  });
  server.on('upgrade', (request, socket) => {
    requests.push({ headers: request.headers, url: request.url, body: '' });
    const accepted = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accepted}\r\n\r\n`), Buffer.from([0x81, 4]), Buffer.from('pong')]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  transport.port = (server.address() as import('node:net').AddressInfo).port;
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const proxy = await createEnvironmentCredentialProxy({ network: { access: 'restricted', allowed_domains: [host] }, credentials: [
    { placeholder: 'rat_placeholder', secret: 'private-$&-value', allowedHosts: [host] },
  ] });
  cleanup.push(proxy.close);
  const ca = await readFile(proxy.certificate, 'utf8');
  async function send(options: { authority?: string; host?: string; path?: string; sni?: string; websocket?: boolean; rebind?: boolean } = {}) {
    const connection = httpRequest(proxy.url, { method: 'CONNECT', path: options.authority ?? 'api.example.com:443' });
    connection.end();
    const [, socket] = await once(connection, 'connect') as [unknown, import('node:net').Socket];
    const tls = connectTls({ socket, servername: options.sni ?? 'api.example.com', ca });
    cleanup.push(async () => tls.destroy());
    await once(tls, 'secureConnect');
    if (options.rebind) transport.address = '169.254.169.254';
    tls.write(options.websocket
      ? 'GET /websocket HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer rat_placeholder\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      : `POST ${options.path ?? '/test/rat_placeholder'} HTTP/1.1\r\nHost: ${options.host ?? 'api.example.com'}\r\nAuthorization: Bearer rat_placeholder\r\nProxy-Authorization: never-relay\r\nContent-Length: 15\r\nConnection: close\r\n\r\nrat_placeholder`);
    const chunks: Buffer[] = []; for await (const chunk of tls) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString();
  }
  return { proxy, requests, send };
}

it('substitutes HTTPS headers, preserves bodies and paths, and strips proxy credentials', async () => {
  const f = await fixture();
  expect(await f.send()).toContain('200 OK');
  expect(f.requests).toEqual([{ headers: expect.objectContaining({ authorization: 'Bearer private-$&-value', host: 'api.example.com' }), url: '/test/rat_placeholder', body: 'rat_placeholder' }]);
  expect(f.requests[0]?.headers['proxy-authorization']).toBeUndefined();
  expect(transport.destinations).toEqual(['https://api.example.com/test/rat_placeholder']);
  expect((await stat(join(dirname(f.proxy.certificate), 'private'))).mode & 0o777).toBe(0o700);
  await f.proxy.close();
  await expect(stat(f.proxy.certificate)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([{ host: 'other.example.com' }, { path: 'https://other.example.com/test' }])('rejects a different destination inside CONNECT: %j', async options => {
  const f = await fixture();
  expect(await f.send(options)).toContain('403');
  expect(f.requests).toHaveLength(0);
});

it('rejects a mismatched SNI and private DNS answers before sending a credential', async () => {
  const f = await fixture();
  await expect(f.send({ sni: 'other.example.com' })).rejects.toThrow();
  transport.address = '169.254.169.254';
  await expect(f.send()).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});

it('checks DNS again before supplying the secret and supports HTTPS port 8443', async () => {
  const f = await fixture();
  expect(await f.send({ authority: 'api.example.com:8443', host: 'api.example.com:8443' })).toContain('200 OK');
  expect(f.requests[0]?.headers.authorization).toBe('Bearer private-$&-value');
  expect(await f.send({ rebind: true })).toContain('502');
  expect(f.requests).toHaveLength(1);
});

it('substitutes HTTPS WebSocket handshake headers and preserves upgraded bytes', async () => {
  const f = await fixture();
  const received = await f.send({ websocket: true });
  expect(received).toContain('101 Switching Protocols');
  expect(received).toContain('pong');
  expect(f.requests[0]?.headers.authorization).toBe('Bearer private-$&-value');
});

it('keeps raw values outside native configuration and wires distinct harness and shell proxy policies', async () => {
  const launch: SessionLaunch = { sessionId: 'sess_example', turnId: 'turn_example', input: [], agent: sessionAgent({ model: 'gpt-5.4' }, 'agent_example', 0),
    environment: { id: 'env_example', type: 'openai_hosted', capability_directories: [], network: { access: 'restricted', allowed_domains: ['api.example.com'] }, files: [], plugins: [], skills: [], packages: { npm: [], python: [], system: [] } },
    hostedConfiguration: {}, environmentCredentials: { environmentId: 'env_example', references: ['secret_ref'] },
  };
  const secret = { ownerId: 'owner', sessionId: launch.sessionId, environmentId: 'env_example', credentials: [{ type: 'environment_variable', secret_name: 'SERVICE_TOKEN', secret_value: 'never-in-guest-config', networking: { type: 'limited', allowed_hosts: ['api.example.com'] } }] };
  const runtime = await prepareSessionEnvironmentCredentials('owner', launch, { get: async () => JSON.stringify(secret) });
  if (!runtime) throw new Error('Missing runtime'); cleanup.push(runtime.close);
  const planned = planSessionLaunch(planCodexLaunch({ version: '1', prompt: '' }, '/workspace', 1000, {}), launch, undefined, undefined, runtime);
  expect(JSON.stringify(planned)).not.toContain('never-in-guest-config');
  expect(runtime.shellEnvironment.SERVICE_TOKEN).toMatch(/^rat_secret_[a-f0-9]{64}$/);
  expect(planned.environment).toMatchObject({ NO_PROXY: '*', SERVICE_TOKEN: runtime.shellEnvironment.SERVICE_TOKEN });
  expect(planned.sessionConfig?.shell_environment_policy).toMatchObject({ set: { NO_PROXY: '', SERVICE_TOKEN: runtime.shellEnvironment.SERVICE_TOKEN } });
  expect(planned.binaryArguments?.join(' ')).toContain('allow_upstream_proxy = true');
  await expect(prepareSessionEnvironmentCredentials('other', launch, { get: async () => JSON.stringify(secret) })).rejects.toThrow('identity');
});

it.each(['enabled', 'restricted'] as const)('executes credential requests through the native %s network policy', async access => {
  // A numeric public destination avoids DNS in the native process. The host
  // proxy's outbound socket is redirected to our TLS fixture above.
  const host = '1.1.1.1';
  const f = await fixture(host);
  const home = await mkdtemp(join(tmpdir(), 'rat-credential-native-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const rpc = new CodexRpcClient({ binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'),
    binaryArguments: hostedCodexArguments(undefined, { access, allowed_domains: access === 'restricted' ? [host] : [] }, true), cwd: home,
    environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_API_KEY: 'unused', HTTP_PROXY: f.proxy.url, HTTPS_PROXY: f.proxy.url, NO_PROXY: '*', no_proxy: '*', SSL_CERT_FILE: f.proxy.certificate },
  });
  cleanup.push(() => rpc.close());
  await rpc.initialize();
  const result = await rpc.call('command/exec', { permissionProfile: 'rat_managed', cwd: '/tmp', timeoutMs: 10_000,
    env: { SERVICE_TOKEN: 'rat_placeholder', HTTPS_PROXY: f.proxy.url, HTTP_PROXY: f.proxy.url, NO_PROXY: '', no_proxy: '', SSL_CERT_FILE: f.proxy.certificate },
    command: ['bash', '-c', `curl --silent --show-error --fail --max-time 8 -H "Authorization: Bearer $SERVICE_TOKEN" https://${host}/native`],
  }, 15_000);
  expect(result, JSON.stringify({ result, destinations: transport.destinations })).toMatchObject({ exitCode: 0, stdout: 'accepted' });
  expect(f.requests[0]?.headers.authorization).toBe('Bearer private-$&-value');
}, 20_000);
