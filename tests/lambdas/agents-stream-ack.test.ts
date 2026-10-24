import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ events: vi.fn(), release: undefined as (() => void) | undefined }));
vi.mock('../../src/app/composition.js', () => ({
  getApiTokenService: () => ({ issue: vi.fn() }),
  getAgentsApiServices: () => ({ sessions: { events: fixture.events } }),
}));

// AWS HttpResponseStream emits its status/headers prelude only on the first write.
// Ending without a write leaves Function URLs with the default empty 200 response.
// https://github.com/aws/aws-lambda-nodejs-runtime-interface-client/blob/962ed28eefbc052389c4de4366b1c0c49ee08a13/src/HttpResponseStream.js
vi.stubGlobal('awslambda', {
  streamifyResponse: (handler: unknown) => handler,
  HttpResponseStream: { from: (stream: Writable, metadata: unknown) => {
    const write = stream.write.bind(stream);
    let first = true;
    stream.write = ((...args: Parameters<typeof stream.write>) => {
      if (first) {
        first = false;
        write(JSON.stringify(metadata));
        write(new Uint8Array(8));
      }
      return write(...args);
    }) as typeof stream.write;
    // AWS exposes selected methods/getters, without Node's private _writableState.
    const facade = Object.fromEntries([
      'cork', 'destroy', 'end', 'uncork', 'write', 'emit', 'on', 'once',
      'removeListener', 'off',
    ].map(name => [name, (stream[name as keyof Writable] as (...args: unknown[]) => unknown).bind(stream)]));
    for (const name of ['destroyed', 'writable', 'writableFinished', 'writableEnded', 'writableNeedDrain'] as const) {
      Object.defineProperty(facade, name, { get: () => stream[name] });
    }
    return facade;
  } },
});
const { handler } = await import('../../src/lambdas/agents-api.js');
const invoke = handler as unknown as (event: unknown, stream: Writable, context: unknown) => Promise<void>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGENTS_TOKEN_ISSUER_ONLY', 'false');
  vi.stubEnv('ALLOW_OWNER_HEADER', 'false');
  fixture.events.mockResolvedValue(undefined);
  fixture.release = undefined;
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function response({ hold = false, writeError = false, finalError = false, authenticated = true } = {}) {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (writeError) done(new Error('fixture response transport failed'));
      else { chunks.push(Buffer.from(chunk)); done(); }
    },
    final(done) {
      if (hold) fixture.release = done;
      else done(finalError ? new Error('fixture response finalization failed') : undefined);
    },
  });
  const result = invoke({ rawPath: '/v1/agents/sessions/sess_fixture/events',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'event-once' },
    body: JSON.stringify({ events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'fixture' }] }] }] }),
    requestContext: { http: { method: 'POST' },
      ...(authenticated ? { authorizer: { iam: { userArn: 'arn:aws:iam::123456789012:user/operator' } } } : {}) },
  }, stream, { awsRequestId: 'request-ack', getRemainingTimeInMillis: () => 10_000 });
  return { result, wire: () => Buffer.concat(chunks), stream };
}
function decode(wire: Buffer) {
  const delimiter = wire.indexOf(Buffer.alloc(8));
  expect(delimiter).toBeGreaterThan(0);
  return { metadata: JSON.parse(wire.subarray(0, delimiter).toString()), body: wire.subarray(delimiter + 8) };
}

describe('Lambda streaming event acknowledgements', () => {
  it('sends the 204 and request ID prelude with no response body after accepting one event', async () => {
    const pending = response();
    await pending.result;
    expect(decode(pending.wire())).toEqual({ metadata: { statusCode: 204, headers: { 'x-request-id': 'request-ack' } }, body: Buffer.alloc(0) });
    expect(fixture.events).toHaveBeenCalledOnce();
    expect(fixture.events.mock.calls[0]).toMatchObject([
      'api:arn:aws:iam::123456789012:user/operator', 'sess_fixture', expect.any(Object), 'event-once', { waitForConnection: true },
    ]);
    expect(pending.stream.writableFinished).toBe(true);
  });

  it('waits for the bodyless response to finish before resolving the handler', async () => {
    const pending = response({ hold: true });
    let settled = false;
    void pending.result.then(() => { settled = true; });
    await vi.waitFor(() => expect(fixture.release).toBeTypeOf('function'));
    try { expect(settled).toBe(false); }
    finally { fixture.release!(); }
    await pending.result;
    expect(pending.stream.writableFinished).toBe(true);
    expect(decode(pending.wire()).metadata.statusCode).toBe(204);
  });

  it('retains the structured authentication error and emits only one prelude', async () => {
    const pending = response({ authenticated: false });
    await pending.result;
    const decoded = decode(pending.wire());
    expect(decoded.metadata.statusCode).toBe(401);
    expect(JSON.parse(decoded.body.toString()).error.code).toBe('invalid_api_key');
    expect(fixture.events).not.toHaveBeenCalled();
  });

  it('rejects a failed response write without accepting the event again', async () => {
    const pending = response({ writeError: true });
    await expect(pending.result).rejects.toThrow('fixture response transport failed');
    expect(fixture.events).toHaveBeenCalledOnce();
  });

  it('rejects failed finalization without accepting the event again', async () => {
    const pending = response({ finalError: true });
    await expect(pending.result).rejects.toThrow('fixture response finalization failed');
    expect(fixture.events).toHaveBeenCalledOnce();
  });
});
