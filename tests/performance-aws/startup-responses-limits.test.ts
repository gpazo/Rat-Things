import { expect, it, vi } from 'vitest';
import { startStartupResponsesProxy } from '../../testing/performance-aws/startup-responses-proxy.mjs';

const requestBody = { model: 'openai.gpt-5.6-luna', stream: true, input: 'Reply OK', tools: [], tool_choice: 'auto' };
const headers = { authorization: 'Bearer fixture-secret', 'content-type': 'application/json' };
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const completed = frame({ type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } });
const reply = () => new Response(completed, { headers: { 'content-type': 'text/event-stream' } });

it('admits only one concurrent request and forces provider generation bounds', async () => {
  const logs: string[] = [];
  const forward = vi.fn(async () => reply());
  const proxy = await startStartupResponsesProxy({ mode: 'bedrock', port: 0, fetchImpl: forward, log: (line: string) => logs.push(line) });
  try {
    const body = JSON.stringify({ ...requestBody, max_output_tokens: 100_000, tools: [{ type: 'function', name: 'unwanted' }] });
    const responses = await Promise.all([1, 2].map(() => fetch(`http://127.0.0.1:${proxy.port}/openai/v1/responses`, { method: 'POST', headers, body })));
    await Promise.all(responses.map(response => response.text()));
    expect(responses.map(response => response.status).sort()).toEqual([200, 429]);
    expect(forward).toHaveBeenCalledTimes(1);
    const [url, init] = forward.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString())).toMatchObject({ max_output_tokens: 128, tools: [], tool_choice: 'none' });
    expect(logs.join('')).not.toContain('fixture-secret');
    expect(logs.join('')).not.toContain('Reply OK');
  } finally { await proxy.close(); }
});

it.each([
  { method: 'POST', path: '/openai/v1/responses', body: JSON.stringify({ ...requestBody, model: 'openai.gpt-6-astra' }), status: 400 },
  { method: 'POST', path: '/openai/v1/responses', body: 'x'.repeat(65_537), status: 413 },
  { method: 'POST', path: '/openai/v1/responses', body: '{invalid', status: 400 },
  { method: 'POST', path: '/another-host', body: JSON.stringify(requestBody), status: 404 },
  { method: 'PUT', path: '/openai/v1/responses', body: JSON.stringify(requestBody), status: 405 },
])('rejects inadmissible requests before forwarding: $status $method $path', async ({ method, path, body, status }) => {
  const forward = vi.fn(async () => reply());
  const proxy = await startStartupResponsesProxy({ mode: 'bedrock', port: 0, fetchImpl: forward, log: () => undefined });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}${path}`, { method, headers, body });
    expect(response.status).toBe(status);
    await response.text();
    expect(forward).not.toHaveBeenCalled();
  } finally { await proxy.close(); }
});

it('does not retry provider failures or return their bodies', async () => {
  const logs: string[] = [];
  const forward = vi.fn(async () => new Response('upstream-private-body', { status: 503 }));
  const proxy = await startStartupResponsesProxy({ mode: 'bedrock', port: 0, fetchImpl: forward, log: (line: string) => logs.push(line) });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/openai/v1/responses`, { method: 'POST', headers, body: JSON.stringify(requestBody) });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('upstream-private-body');
    expect(forward).toHaveBeenCalledTimes(1);
    expect(logs.join('')).not.toContain('upstream-private-body');
  } finally { await proxy.close(); }
});

it.each([
  frame({ type: 'response.output_item.added', item: { type: 'function_call', name: 'forbidden-tool', arguments: '{}' } }),
  frame({ type: 'response.custom_tool_call_input.delta', delta: 'forbidden-tool' }),
  'x'.repeat(1_048_577),
])('rejects tool output and oversized responses before forwarding their payload', async body => {
  const logs: string[] = [];
  const proxy = await startStartupResponsesProxy({ mode: 'bedrock', port: 0,
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), log: (line: string) => logs.push(line) });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/openai/v1/responses`, { method: 'POST', headers, body: JSON.stringify(requestBody) });
    const text = await response.text();
    expect(text).toContain('upstream_response_rejected');
    expect(text).not.toContain('forbidden-tool');
    expect(text.length).toBeLessThan(1_024);
    expect(JSON.parse(logs[0]!.slice('startup-responses-proxy '.length)).status).toBe('error');
  } finally { await proxy.close(); }
});

it('streams a valid event before the provider completes and permits reasoning metadata', async () => {
  let provider: ReadableStreamDefaultController<Uint8Array> | undefined;
  const initial = frame({ type: 'response.output_item.added', item: { type: 'reasoning', id: 'reasoning' } });
  const stream = new ReadableStream<Uint8Array>({ start(controller) { provider = controller; controller.enqueue(Buffer.from(initial)); } });
  const proxy = await startStartupResponsesProxy({ mode: 'bedrock', port: 0, fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), log: () => undefined });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/openai/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(2_000),
    });
    const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toContain('reasoning');
    provider!.enqueue(Buffer.from(completed));
    provider!.close();
    while (!(await reader.read()).done) {}
  } finally {
    try { provider?.close(); } catch {}
    await proxy.close();
  }
}, 5_000);
