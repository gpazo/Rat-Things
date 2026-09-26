/** Fixed program run inside the execution environment. Configuration contains no secret values. */
export async function environmentMcpWorker() {
  const { createInterface } = await import('node:readline');
  const { spawn } = await import('node:child_process');
  const http = await import('node:http');
  const https = await import('node:https');
  const tls = await import('node:tls');
  const { setTimeout: delay } = await import('node:timers/promises');
  const config = JSON.parse(process.argv[1]!) as {
    transport: { type: 'http'; server_url: string } | { type: 'stdio'; command: string; args: string[]; cwd: string };
    metadata: Record<string, unknown>; allowedTools: string[] | null; headerEnv: Record<string, string>;
  };
  const abort = new AbortController();
  const input = createInterface({ input: process.stdin });
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const plan = (value: unknown): Record<string, unknown> => {
    if (!object(value)) throw new Error('Invalid MCP request');
    if (typeof value.method !== 'string') return value;
    const params = object(value.params) ? value.params : {};
    if (value.method === 'tools/call' && (typeof params.name !== 'string' || config.allowedTools !== null && !config.allowedTools.includes(params.name))) throw new Error('Tool is unavailable');
    return { ...value, params: { ...params, _meta: { ...(object(params._meta) ? params._meta : {}), ...config.metadata } } };
  };
  const child = config.transport.type === 'stdio' ? spawn(config.transport.command, config.transport.args, { cwd: config.transport.cwd, env: process.env }) : undefined;
  if (child) {
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', (line) => { try { output(JSON.parse(line)); } catch { abort.abort(); child.kill(); } });
    child.once('exit', () => { input.close(); process.stdin.destroy(); });
    child.once('error', () => { input.close(); process.stdin.destroy(); });
  }
  let session: string | undefined;
  let protocol: string | undefined;
  let initializeId: unknown;
  let initializeRequest: Record<string, unknown> | undefined;
  let generation = 0;
  let needsInitialization = false;
  let reconnecting: Promise<void> | undefined;
  let listening = false;
  const deliver = (value: unknown) => {
    if (object(value) && value.id === initializeId && object(value.result) && typeof value.result.protocolVersion === 'string') protocol = value.result.protocolVersion;
    output(value);
  };
  interface StreamState {
    cursor: string | undefined; retryMs: number; generation: number; signal: AbortSignal;
    replied: boolean; replyId?: unknown; initialize?: boolean; receive(value: unknown): void;
  }
  const streamState = (receive: (value: unknown) => void, signal: AbortSignal): StreamState => ({ cursor: undefined, retryMs: 1000, generation, signal, replied: false, receive });
  let notificationAbort = new AbortController();
  let notificationStream = streamState(deliver, AbortSignal.any([abort.signal, notificationAbort.signal]));
  class ExpiredSession extends Error { constructor(public readonly generation: number) { super('MCP session expired'); } }
  async function send(method: string, body: string | undefined, stream: StreamState) {
    if (config.transport.type !== 'http') throw new Error('Expected HTTP');
    if (stream.generation !== generation) throw new Error('MCP session changed');
    const sentSession = session;
    const url = new URL(config.transport.server_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid destination');
    const headers: Record<string, string> = Object.fromEntries(Object.entries(config.headerEnv).map(([name, key]) => [name, process.env[key] ?? '']));
    headers.accept = 'application/json, text/event-stream';
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (sentSession) headers['mcp-session-id'] = sentSession;
    if (protocol) headers['mcp-protocol-version'] = protocol;
    if (method === 'GET' && stream.cursor) headers['last-event-id'] = stream.cursor;
    const proxyValue = url.protocol === 'https:' ? process.env.HTTPS_PROXY ?? process.env.https_proxy : process.env.HTTP_PROXY ?? process.env.http_proxy;
    let agent: import('node:https').Agent | undefined;
    let destination = url;
    let requestOptions: import('node:http').RequestOptions = { method, headers, signal: stream.signal };
    if (proxyValue) {
      const proxy = new URL(proxyValue);
      if (proxy.protocol !== 'http:' || proxy.username || proxy.password) throw new Error('Invalid environment proxy');
      if (url.protocol === 'https:') {
        const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
          const connect = http.request(proxy, { method: 'CONNECT', path: `${url.hostname}:${url.port || '443'}`, headers: { host: `${url.hostname}:${url.port || '443'}` }, signal: stream.signal });
          connect.setTimeout(30_000, () => connect.destroy(new Error('Proxy timed out')));
          connect.once('connect', (response, socket) => { if (response.statusCode === 200) resolve(socket); else { socket.destroy(); reject(new Error('Proxy denied')); } });
          connect.once('error', reject); connect.end();
        });
        agent = new class extends https.Agent { public createConnection() { return tls.connect({ socket, servername: url.hostname }); } }();
        requestOptions = { ...requestOptions, agent };
      } else {
        destination = proxy;
        requestOptions = { ...requestOptions, path: url.href, headers: { ...headers, host: url.host } };
      }
    }
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = (destination.protocol === 'https:' ? https : http).request(destination, requestOptions, resolve);
      if (method !== 'GET') request.setTimeout(120_000, () => request.destroy(new Error('MCP timed out')));
      request.once('error', reject); request.end(body);
    }).catch((error: unknown) => { agent?.destroy(); throw error; });
    response.once('end', () => agent?.destroy()); response.once('error', () => agent?.destroy());
    if (stream.initialize && stream.generation === generation && typeof response.headers['mcp-session-id'] === 'string') session = response.headers['mcp-session-id'];
    if (method === 'GET' && response.statusCode === 405) { response.resume(); return false; }
    if (response.statusCode === 404 && sentSession) { response.resume(); throw new ExpiredSession(stream.generation); }
    if (!response.statusCode || response.statusCode >= 300) { response.resume(); throw new Error('MCP transport failed'); }
    if (response.statusCode === 202 || response.statusCode === 204) { response.resume(); return; }
    const receive = (value: unknown) => {
      if (stream.generation !== generation) throw new Error('MCP session changed');
      if (stream.replyId !== undefined && object(value) && value.id === stream.replyId && ('result' in value || 'error' in value)) stream.replied = true;
      stream.receive(value);
    };
    try { if (response.headers['content-type']?.startsWith('text/event-stream')) {
      let data = '';
      let eventId: string | undefined;
      for await (const line of createInterface({ input: response, crlfDelay: Infinity })) {
        if (line === '') {
          // Empty data events prime resumability without carrying a JSON-RPC message.
          if (data.trim()) receive(JSON.parse(data));
          if (eventId !== undefined) stream.cursor = eventId;
          data = ''; eventId = undefined;
          if (stream.replied) break;
        }
        else if (line.startsWith('data:')) { data += `${line.slice(5).trimStart()}\n`; if (data.length > 8 * 1024 * 1024) throw new Error('MCP frame too large'); }
        else if (line.startsWith('id:') && !line.includes('\0')) eventId = line.slice(3).trimStart();
        else if (line.startsWith('retry:') && /^\d+$/.test(line.slice(6).trim())) {
          const retry = Number(line.slice(6).trim());
          if (!Number.isSafeInteger(retry) || retry > 2_147_483_647) throw new Error('MCP retry delay exceeds timer range');
          stream.retryMs = retry;
        }
      }
    } else {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of response) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('MCP response too large'); chunks.push(Buffer.from(chunk)); }
      if (size) receive(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } } finally { response.destroy(); agent?.destroy(); }
    return true;
  }

  async function initializeAgain(expiredGeneration = generation) {
    if (reconnecting) return reconnecting;
    if (expiredGeneration !== generation && !needsInitialization) return;
    if (!initializeRequest) throw new Error('MCP initialization is unavailable');
    const request = initializeRequest;
    const attempt = (async () => {
      needsInitialization = true; generation++; session = undefined; protocol = undefined;
      notificationAbort.abort(); notificationAbort = new AbortController();
      notificationStream = streamState(deliver, AbortSignal.any([abort.signal, notificationAbort.signal]));
      let negotiated: string | undefined;
      const stream = streamState(value => {
        if (object(value) && value.id === request.id && object(value.result) && typeof value.result.protocolVersion === 'string') negotiated = value.result.protocolVersion;
      }, AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]));
      stream.replyId = request.id; stream.initialize = true;
      await exchange(request, stream);
      if (!negotiated) throw new Error('MCP reinitialization failed');
      protocol = negotiated;
      await send('POST', JSON.stringify(plan({ jsonrpc: '2.0', method: 'notifications/initialized' })), streamState(deliver, stream.signal));
      needsInitialization = false;
    })();
    reconnecting = attempt;
    try { await attempt; } finally { reconnecting = undefined; }
  }

  /** POST exactly once; only resume its response stream with GET and a server cursor. */
  async function exchange(request: Record<string, unknown>, stream: StreamState) {
    try { await send('POST', JSON.stringify(request), stream); }
    catch (error) { if (error instanceof ExpiredSession || stream.cursor === undefined || stream.signal.aborted) throw error; }
    while (request.id !== undefined && !stream.replied) {
      if (!stream.cursor) throw new Error('MCP response was lost without a resumable cursor');
      await delay(stream.retryMs, undefined, { signal: stream.signal });
      try { if (await send('GET', undefined, stream) === false) throw new Error('MCP response resumption is unavailable'); }
      catch (error) { if (error instanceof ExpiredSession || stream.generation !== generation || stream.signal.aborted) throw error; }
    }
  }
  async function notifications() {
    while (!abort.signal.aborted) {
      try {
        if (reconnecting) await reconnecting;
        if (needsInitialization) await initializeAgain();
        if (await send('GET', undefined, notificationStream) === false) return;
      } catch (error) {
        if (error instanceof ExpiredSession) await initializeAgain(error.generation).catch(() => {});
      }
      await delay(notificationStream.retryMs, undefined, { signal: abort.signal }).catch(() => {});
    }
  }
  input.on('line', (line) => {
    let request: Record<string, unknown> | undefined;
    void (async () => {
      const parsed: unknown = JSON.parse(line);
      request = object(parsed) ? parsed : undefined;
      request = plan(parsed);
      if (child) { child.stdin.write(`${JSON.stringify(request)}\n`); return; }
      if (reconnecting) await reconnecting;
      if (needsInitialization) await initializeAgain();
      if (request.method === 'initialize') { initializeId = request.id; initializeRequest = request; }
      const stream = streamState(deliver, AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]));
      stream.replyId = request.id; stream.initialize = request.method === 'initialize';
      try { await exchange(request, stream); }
      catch (error) {
        if (error instanceof ExpiredSession) await initializeAgain(error.generation);
        // The caller observes the failed tool; a new call uses the replacement session.
        throw error;
      }
      if (request.method === 'notifications/initialized' && !listening) { listening = true; void notifications(); }
    })().catch(() => { if (request?.id !== undefined) output({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Environment MCP request failed' } }); });
  });
  input.once('close', () => { abort.abort(); child?.stdin.destroy(); child?.kill('SIGTERM'); });
}
