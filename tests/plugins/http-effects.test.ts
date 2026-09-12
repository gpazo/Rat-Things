import { describe, expect, it, vi } from 'vitest';
import { TrustedHttpIntegrationPlugin, type TrustedHttpRequest } from '../../src/plugins/http.js';
import { IntegrationProviderUnavailableError } from '../../src/plugins/integration-types.js';
import { httpContext, httpOptions } from './http-fixtures.js';

const operationId = 'fixture.records.read';

describe('trusted HTTP effect boundaries', () => {
  it('rejects URL escapes before body validation or authorization', async () => {
    const options = httpOptions({ method: 'POST', path: '../outside', json: null, form: new URLSearchParams() });

    await expect(new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext()))
      .rejects.toThrow('escaped its trusted API base URL');
    expect(options.authorization).not.toHaveBeenCalled();
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('validates incompatible or oversized JSON bodies before authorization', async () => {
    for (const request of [
      { method: 'POST', path: 'records', json: false, form: new URLSearchParams() },
      { method: 'POST', path: 'records', json: 'x'.repeat(256 * 1024) },
    ] satisfies TrustedHttpRequest[]) {
      const options = httpOptions(request);
      await expect(new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext())).rejects.toThrow('integration request');
      expect(options.authorization).not.toHaveBeenCalled();
      expect(options.fetch).not.toHaveBeenCalled();
    }
  });

  it('retains the calculated URL and body while applying headers and method after authorization', async () => {
    const request: TrustedHttpRequest = { method: 'POST', path: 'records', json: { before: true } };
    const options = httpOptions(request);
    options.authorization = vi.fn(() => {
      request.path = 'changed';
      request.method = 'PATCH';
      request.json = { after: true };
      request.headers = { 'x-after-auth': 'present', authorization: 'override' };
      return { authorization: 'original', 'content-type': 'auth-type' };
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    options.fetch = fetcher;

    await new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext());
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://provider.example/api/records');
    expect(init).toMatchObject({
      method: 'PATCH', body: '{"before":true}',
      headers: { authorization: 'override', 'content-type': 'application/json', 'x-after-auth': 'present' },
    });
  });

  it('propagates authorization failures unchanged without making a network request', async () => {
    const options = httpOptions();
    const cause = new Error('authorization failed');
    options.authorization = vi.fn(() => { throw cause; });

    await expect(new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext())).rejects.toBe(cause);
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('passes cancellation and redirect restrictions to fetch and normalizes network errors', async () => {
    const options = httpOptions();
    const controller = new AbortController();
    controller.abort(new Error('private abort detail'));
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).not.toBe(controller.signal);
      expect(init?.signal?.aborted).toBe(true);
      expect(init?.redirect).toBe('error');
      throw new Error('private network detail');
    });
    options.fetch = fetcher;

    await expect(new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, { ...httpContext(), signal: controller.signal }))
      .rejects.toThrow('Fixture credential verification is temporarily unavailable');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(options.validateResponse).not.toHaveBeenCalled();
  });

  it('preserves an existing provider-unavailable error from fetch', async () => {
    const options = httpOptions();
    const cause = new IntegrationProviderUnavailableError('Upstream');
    options.fetch = vi.fn().mockRejectedValue(cause);

    await expect(new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext())).rejects.toBe(cause);
  });

  it('finishes reading before classifying status and releases the reader lock', async () => {
    const events: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { events.push('read'); controller.enqueue(Buffer.from('denied')); controller.close(); },
    }, { highWaterMark: 0 });
    const response = new Response(body, { status: 403 });
    const reader = body.getReader.bind(body);
    vi.spyOn(body, 'getReader').mockImplementation(() => {
      const value = reader();
      const release = value.releaseLock.bind(value);
      value.releaseLock = () => { events.push('release'); release(); };
      return value;
    });
    const options = httpOptions();
    options.fetch = vi.fn(async () => { events.push('fetch'); return response; });

    await expect(new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext()))
      .rejects.toThrow('Fixture returned HTTP 403');
    expect(events).toEqual(['fetch', 'read', 'release']);
    expect(body.locked).toBe(false);
    expect(options.validateResponse).not.toHaveBeenCalled();
  });

  it('stops reading at the byte limit and releases without cancelling the stream', async () => {
    let reads = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(Buffer.alloc(reads === 1 ? 256 * 1024 : 1, 32));
      },
      cancel,
    }, { highWaterMark: 0 });
    const options = httpOptions();
    options.fetch = vi.fn(async () => new Response(body, { status: 400 }));

    await expect(new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext()))
      .rejects.toBeInstanceOf(IntegrationProviderUnavailableError);
    expect(reads).toBe(2);
    expect(body.locked).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(options.validateResponse).not.toHaveBeenCalled();
  });

  it('releases the reader when a later chunk fails and preserves known unavailable errors', async () => {
    const cause = new IntegrationProviderUnavailableError('Body stream');
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++reads === 1) controller.enqueue(Buffer.from('{'));
        else controller.error(cause);
      },
    }, { highWaterMark: 0 });
    const options = httpOptions();
    options.fetch = vi.fn(async () => new Response(body));

    await expect(new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext())).rejects.toBe(cause);
    expect(body.locked).toBe(false);
  });

  it('reassembles split UTF-8 bytes before parsing and calls response validation once', async () => {
    const encoded = Buffer.from('{"text":"é"}');
    const split = encoded.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoded.subarray(0, split));
      controller.enqueue(encoded.subarray(split));
      controller.close();
    } });
    const options = httpOptions();
    options.fetch = vi.fn(async () => new Response(body));

    await expect(new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext())).resolves.toEqual({ text: 'é' });
    expect(options.validateResponse).toHaveBeenCalledExactlyOnceWith({ text: 'é' });
    expect(body.locked).toBe(false);
  });

  it('skips provider validation for empty and non-JSON responses', async () => {
    for (const [body, expected] of [[null, { ok: true }], ['plain text', { text: 'plain text' }]] as const) {
      const options = httpOptions();
      options.fetch = vi.fn(async () => new Response(body));
      await expect(new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext())).resolves.toEqual(expected);
      expect(options.validateResponse).not.toHaveBeenCalled();
    }
  });

  it('retains the raw-text fallback for validator SyntaxErrors and propagates other failures', async () => {
    for (const cause of [new SyntaxError('validator syntax'), new Error('provider rejection')]) {
      const options = httpOptions();
      options.validateResponse = vi.fn(() => { throw cause; });
      const result = new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext());
      if (cause instanceof SyntaxError) await expect(result).resolves.toEqual({ text: '{"ok":true}' });
      else await expect(result).rejects.toBe(cause);
      expect(options.validateResponse).toHaveBeenCalledOnce();
    }
  });

  it('returns the same parsed value that a response validator may modify', async () => {
    const options = httpOptions();
    let validated: unknown;
    options.validateResponse = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
      value.enriched = true;
      validated = value;
    };

    const result = await new TrustedHttpIntegrationPlugin(options).execute(operationId, {}, httpContext());
    expect(result).toBe(validated);
    expect(result).toEqual({ ok: true, enriched: true });
  });

  it('checks authentication and operation bindings before invoking request callbacks', async () => {
    const options = httpOptions();
    const plugin = new TrustedHttpIntegrationPlugin(options);

    await expect(plugin.verifyCredential('oauth2', {})).rejects.toThrow('does not support oauth2');
    await expect(plugin.execute('missing', {}, httpContext())).rejects.toThrow('is not registered');
    expect(options.verification.request).not.toHaveBeenCalled();
    expect(options.operations[0]!.request).not.toHaveBeenCalled();
    expect(options.authorization).not.toHaveBeenCalled();
    expect(options.fetch).not.toHaveBeenCalled();
  });
});
