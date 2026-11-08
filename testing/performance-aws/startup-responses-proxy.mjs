import { createServer } from 'node:http';

export const STARTUP_RESPONSES_PROXY = Object.freeze({
  host: '127.0.0.1',
  port: 43188,
  endpointPath: '/openai/v1/responses',
  providerBaseUrl: 'http://127.0.0.1:43188/openai/v1',
  forwardUrl: 'https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses',
  model: 'openai.gpt-5.6-luna',
  modelAliases: Object.freeze(['openai.gpt-5.6-luna', 'gpt-5.6-luna']),
  requestLimit: 1,
  requestBytesLimit: 65_536,
  outputTokensLimit: 128,
  forwardTimeoutMs: 30_000,
  responseBytesLimit: 1_048_576,
  proxyRetries: 0,
});

const maxHeaderBytes = 16 * 1024;
const allowedModes = new Set(['fixture', 'bedrock']);
const statusCodes = Object.freeze({ method: 405, path: 404, requestLimit: 429, body: 400, bodyLimit: 413,
  model: 400, tools: 400, streaming: 400, authorization: 401, upstream: 502, timeout: 504 });

export function canonicalLunaModel(value) {
  return STARTUP_RESPONSES_PROXY.modelAliases.includes(value) ? STARTUP_RESPONSES_PROXY.model : null;
}

/** @returns {{ok: true, model: string, requestBytes: number, authorization: string | undefined, forwardedBody: Buffer} | {ok: false, reason: string, requestBytes: number, model: string | null}} */
export function planStartupResponsesRequest({ method, url, headers, body, count }) {
  const requestBytes = body.byteLength;
  if (count > STARTUP_RESPONSES_PROXY.requestLimit) return rejected('requestLimit', requestBytes);
  if (method !== 'POST') return rejected('method', requestBytes);
  if (url !== STARTUP_RESPONSES_PROXY.endpointPath) return rejected('path', requestBytes);
  if (requestBytes > STARTUP_RESPONSES_PROXY.requestBytesLimit) return rejected('bodyLimit', requestBytes);

  let request;
  try { request = JSON.parse(body.toString('utf8')); } catch { return rejected('body', requestBytes); }
  if (!isRecord(request)) return rejected('body', requestBytes);
  const model = canonicalLunaModel(request.model);
  if (!model) return rejected('model', requestBytes);
  if (request.stream !== true) return rejected('streaming', requestBytes, model);
  if (request.tools !== undefined && !Array.isArray(request.tools)) return rejected('tools', requestBytes, model);
  if (request.tool_choice !== undefined && !['auto', 'none'].includes(request.tool_choice)) return rejected('tools', requestBytes, model);

  const authorization = header(headers, 'authorization');
  return {
    ok: true,
    model,
    requestBytes,
    authorization,
    forwardedBody: Buffer.from(JSON.stringify({ ...request, model, tools: [], tool_choice: 'none', max_output_tokens: STARTUP_RESPONSES_PROXY.outputTokensLimit })),
  };
}

/** @param {{mode?: 'fixture' | 'bedrock', port?: number, fetchImpl?: typeof fetch, log?: (line: string) => void, onDecision?: (decision: unknown) => void}} [options] */
export async function startStartupResponsesProxy({ mode, port = STARTUP_RESPONSES_PROXY.port, fetchImpl = fetch, log = (line) => console.log(line), onDecision = () => {} } = {}) {
  if (!allowedModes.has(mode)) throw new Error('Startup Responses proxy mode must be fixture or bedrock.');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Startup Responses proxy port is invalid.');

  const state = { count: 0 };
  const server = createServer({ maxHeaderSize: maxHeaderBytes }, (request, response) => {
    state.count += 1;
    const count = state.count;
    const started = performance.now();
    const requestBytesHeader = parseContentLength(request.headers['content-length']);
    if (count > STARTUP_RESPONSES_PROXY.requestLimit) {
      request.resume();
      finish(response, log, { mode, model: null, count, requestBytes: requestBytesHeader, cap: STARTUP_RESPONSES_PROXY.outputTokensLimit,
        status: 'rejected', elapsedMs: elapsed(started), usage: null }, statusCodes.requestLimit);
      return;
    }

    void readBoundedRequestBody(request, response, requestBytesHeader).then(async (read) => {
      const planned = read.tooLarge
        ? rejected('bodyLimit', read.requestBytes)
        : planStartupResponsesRequest({ method: request.method, url: request.url, headers: request.headers, body: read.body, count });
      let safeShape = {};
      if (!read.tooLarge) {
        try {
          const parsed = JSON.parse(read.body.toString('utf8'));
          if (isRecord(parsed)) safeShape = {
            stream: parsed.stream === true,
            toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
            toolNames: Array.isArray(parsed.tools) ? parsed.tools.slice(0, 32).flatMap((tool) =>
              isRecord(tool) && typeof tool.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tool.name) ? [tool.name] : []) : [],
            toolChoice: ['auto', 'none'].includes(parsed.tool_choice) ? parsed.tool_choice : parsed.tool_choice === undefined ? 'missing' : 'other',
          };
        } catch {}
      }
      try { onDecision({ count, accepted: planned.ok, reason: planned.ok ? 'accepted' : planned.reason,
        endpointMatch: request.url === STARTUP_RESPONSES_PROXY.endpointPath, model: planned.model ?? null, ...safeShape }); } catch {}
      if (!planned.ok) {
        finish(response, log, { mode, model: planned.model ?? null, count, requestBytes: planned.requestBytes,
          cap: STARTUP_RESPONSES_PROXY.outputTokensLimit, status: 'rejected', elapsedMs: elapsed(started), usage: null }, statusCodes[planned.reason]);
        return;
      }
      if (mode === 'fixture') {
        writeFixtureResponse(response);
        finish(response, log, { mode, model: planned.model, count, requestBytes: planned.requestBytes,
          cap: STARTUP_RESPONSES_PROXY.outputTokensLimit, status: 'success', upstreamStatus: null,
          elapsedMs: elapsed(started), usage: fixtureUsage }, 200);
        return;
      }
      if (!isBearerToken(planned.authorization)) {
        finish(response, log, { mode, model: planned.model, count, requestBytes: planned.requestBytes,
          cap: STARTUP_RESPONSES_PROXY.outputTokensLimit, status: 'rejected', elapsedMs: elapsed(started), usage: null }, statusCodes.authorization);
        return;
      }

      await forwardBedrock({ planned, response, fetchImpl, log, mode, count, started });
    }).catch(() => {
      if (!response.headersSent && !response.writableEnded) {
        finish(response, log, { mode, model: null, count, requestBytes: requestBytesHeader,
          cap: STARTUP_RESPONSES_PROXY.outputTokensLimit, status: 'error', elapsedMs: elapsed(started), usage: null }, statusCodes.upstream);
      } else if (!response.writableEnded) response.end();
    });
  });
  server.requestTimeout = STARTUP_RESPONSES_PROXY.forwardTimeoutMs;
  server.headersTimeout = 5_000;

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, STARTUP_RESPONSES_PROXY.host);
  });

  const address = server.address();
  return { server, port: typeof address === 'object' && address ? address.port : port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

const fixtureUsage = Object.freeze({ input_tokens: 1, output_tokens: 1, total_tokens: 2 });

const fixtureEvents = Object.freeze([
  { type: 'response.created', response: { id: 'response_startup_fixture', model: STARTUP_RESPONSES_PROXY.model, status: 'in_progress' } },
  { type: 'response.output_item.done', item: { id: 'message_startup_fixture', type: 'message', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: 'OK' }] } },
  { type: 'response.completed', response: { id: 'response_startup_fixture', model: STARTUP_RESPONSES_PROXY.model, status: 'completed',
    output: [{ id: 'message_startup_fixture', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'OK' }] }], usage: fixtureUsage } },
]);

function writeFixtureResponse(response) {
  response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/event-stream; charset=utf-8', 'x-content-type-options': 'nosniff' });
  for (const event of fixtureEvents) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

async function forwardBedrock({ planned, response, fetchImpl, log, mode, count, started }) {
  let upstream;
  try {
    upstream = await fetchImpl(STARTUP_RESPONSES_PROXY.forwardUrl, {
      method: 'POST',
      headers: { authorization: planned.authorization, accept: 'text/event-stream', 'content-type': 'application/json' },
      body: planned.forwardedBody,
      redirect: 'error',
      signal: AbortSignal.timeout(STARTUP_RESPONSES_PROXY.forwardTimeoutMs),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    finish(response, log, { mode, model: planned.model, count, requestBytes: planned.requestBytes, cap: STARTUP_RESPONSES_PROXY.outputTokensLimit,
      status: 'error', upstreamStatus: null, elapsedMs: elapsed(started), usage: null }, timeout ? statusCodes.timeout : statusCodes.upstream);
    return;
  }
  if (!upstream.ok || !upstream.body || upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    finish(response, log, { mode, model: planned.model, count, requestBytes: planned.requestBytes, cap: STARTUP_RESPONSES_PROXY.outputTokensLimit,
      status: 'error', upstreamStatus: safeStatus(upstream.status), elapsedMs: elapsed(started), usage: null }, statusCodes.upstream);
    return;
  }
  if (upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream') {
    await upstream.body.cancel().catch(() => undefined);
    finish(response, log, { mode, model: planned.model, count, requestBytes: planned.requestBytes, cap: STARTUP_RESPONSES_PROXY.outputTokensLimit,
      status: 'error', upstreamStatus: safeStatus(upstream.status), elapsedMs: elapsed(started), usage: null }, statusCodes.upstream);
    return;
  }

  response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/event-stream; charset=utf-8', 'x-content-type-options': 'nosniff' });
  let totalBytes = 0;
  let pending = Buffer.alloc(0);
  let usage = null;
  try {
    for await (const chunk of upstream.body) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > STARTUP_RESPONSES_PROXY.responseBytesLimit) throw new ProxyStreamError('response_limit');
      pending = Buffer.concat([pending, bytes]);
      let split;
      while ((split = findSseFrameEnd(pending)) >= 0) {
        const frame = pending.subarray(0, split);
        const restStart = split + sseFrameDelimiterLength(pending, split);
        pending = pending.subarray(restStart);
        const inspected = inspectSseFrame(frame);
        if (inspected.error) throw new ProxyStreamError(inspected.error);
        if (inspected.usage) usage = inspected.usage;
        response.write(frame);
        response.write('\n\n');
      }
      if (pending.length > 64 * 1024) throw new ProxyStreamError('event_limit');
    }
    if (pending.length) {
      const inspected = inspectSseFrame(pending);
      if (inspected.error) throw new ProxyStreamError(inspected.error);
      if (inspected.usage) usage = inspected.usage;
      response.write(pending);
    }
    response.end();
    logSummary(log, { mode, model: planned.model, count, requestBytes: planned.requestBytes, cap: STARTUP_RESPONSES_PROXY.outputTokensLimit,
      status: 'success', upstreamStatus: safeStatus(upstream.status), elapsedMs: elapsed(started), usage });
  } catch (error) {
    if (!response.writableEnded) response.end('data: {"type":"response.failed","response":{"id":"proxy_rejected","status":"failed","error":{"code":"upstream_response_rejected","message":"The bounded test proxy rejected the provider response."}}}\n\n');
    logSummary(log, { mode, model: planned.model, count, requestBytes: planned.requestBytes, cap: STARTUP_RESPONSES_PROXY.outputTokensLimit,
      status: 'error', upstreamStatus: safeStatus(upstream.status), elapsedMs: elapsed(started), usage: null });
  }
}

class ProxyStreamError extends Error {}

function inspectSseFrame(frame) {
  const lines = frame.toString('utf8').split(/\r?\n/);
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return { error: null, usage: null };
  let event;
  try { event = JSON.parse(data); } catch { return { error: null, usage: null }; }
  if (['response.function_call_arguments.delta', 'response.function_call_arguments.done',
    'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done'].includes(event.type)) {
    return { error: 'tool_request', usage: null };
  }
  const items = [event.item, event.output_item, ...(Array.isArray(event.response?.output) ? event.response.output : [])].filter(isRecord);
  if (items.some((item) => !['message', 'reasoning'].includes(item.type))) return { error: 'tool_request', usage: null };
  if (event.response?.usage) return { error: null, usage: safeUsage(event.response.usage) };
  return { error: null, usage: null };
}

function findSseFrameEnd(buffer) {
  for (let index = 0; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 10 && buffer[index + 1] === 10) return index;
    if (buffer[index] === 13 && buffer[index + 1] === 10 && buffer[index + 2] === 13 && buffer[index + 3] === 10) return index;
  }
  return -1;
}

function sseFrameDelimiterLength(buffer, index) { return buffer[index] === 13 ? 4 : 2; }

function readBoundedRequestBody(request, response, declaredBytes) {
  if (declaredBytes !== null && declaredBytes > STARTUP_RESPONSES_PROXY.requestBytesLimit) {
    request.resume();
    return Promise.resolve({ tooLarge: true, requestBytes: declaredBytes, body: Buffer.alloc(0) });
  }
  return new Promise((resolve) => {
    const chunks = [];
    let requestBytes = 0;
    let settled = false;
    request.on('data', (chunk) => {
      if (settled) return;
      requestBytes += chunk.length;
      if (requestBytes > STARTUP_RESPONSES_PROXY.requestBytesLimit) {
        settled = true;
        chunks.length = 0;
        resolve({ tooLarge: true, requestBytes, body: Buffer.alloc(0) });
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      if (!settled) { settled = true; resolve({ tooLarge: false, requestBytes, body: Buffer.concat(chunks) }); }
    });
    request.on('error', () => {
      if (!settled) { settled = true; resolve({ tooLarge: false, requestBytes, body: Buffer.alloc(0) }); }
    });
  });
}

function finish(response, log, summary, statusCode) {
  if (!response.headersSent && !response.writableEnded) {
    response.writeHead(statusCode, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
    response.end('{"error":"bounded_test_proxy_rejected_request"}');
  }
  logSummary(log, summary);
}

function rejected(reason, requestBytes, model = null) { return { ok: false, reason, requestBytes, model }; }
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function header(headers, name) {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}
function isBearerToken(value) { return typeof value === 'string' && value.length <= 8_192 && /^Bearer [\x21-\x7E]+$/.test(value); }
function parseContentLength(value) { return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null; }
function safeStatus(value) { return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null; }
function safeUsage(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.input_tokens) || value.input_tokens < 0
    || !Number.isSafeInteger(value.output_tokens) || value.output_tokens < 0
    || !Number.isSafeInteger(value.total_tokens) || value.total_tokens < 0) return null;
  return { input_tokens: value.input_tokens, output_tokens: value.output_tokens, total_tokens: value.total_tokens };
}
function elapsed(started) { return Math.min(STARTUP_RESPONSES_PROXY.forwardTimeoutMs, Math.max(0, Math.round(performance.now() - started))); }
function logSummary(log, value) {
  const summary = {
    mode: value.mode,
    model: canonicalLunaModel(value.model) ? STARTUP_RESPONSES_PROXY.model : null,
    count: Number.isSafeInteger(value.count) ? value.count : 0,
    requestBytes: Number.isSafeInteger(value.requestBytes) && value.requestBytes >= 0 ? value.requestBytes : null,
    cap: STARTUP_RESPONSES_PROXY.outputTokensLimit,
    status: ['success', 'error', 'rejected'].includes(value.status) ? value.status : 'error',
    upstreamStatus: safeStatus(value.upstreamStatus),
    elapsedMs: Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : 0,
    usage: value.usage ? safeUsage(value.usage) : null,
  };
  log(`startup-responses-proxy ${JSON.stringify(summary)}`);
}
