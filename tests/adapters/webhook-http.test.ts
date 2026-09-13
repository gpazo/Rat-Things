import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpsWebhookTransport } from '../../src/adapters/webhook-http.js';
import type { LookupAddress } from 'node:dns';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
// Node overloads lookup for one/all addresses; this adapter always requests all.
const lookupAll = vi.mocked(lookup as (host: string, options: { all: true }) => Promise<LookupAddress[]>);

describe('webhook network transport', () => {
  it('includes DNS resolution in the deadline and never sends a late DNS answer', async () => {
    vi.useFakeTimers();
    let answer!: (addresses: Array<{ address: string; family: number }>) => void;
    lookupAll.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const sending = new HttpsWebhookTransport().post('https://receiver.example/hook', '{}', {});
    const rejected = expect(sending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    answer([{ address: '8.8.8.8', family: 4 }]); await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects mixed public/private DNS answers before opening a connection', async () => {
    lookupAll.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]);
    await expect(new HttpsWebhookTransport().post('https://receiver.example/hook', '{}', {})).rejects.toThrow('must be public');
    expect(request).not.toHaveBeenCalled();
  });

  it('pins the checked address and returns a redirect without following it', async () => {
    const address = { address: '8.8.8.8', family: 4 };
    lookupAll.mockResolvedValue([address]);
    const outgoing = Object.assign(new EventEmitter(), { end: vi.fn() });
    const response = { statusCode: 302, destroy: vi.fn() };
    vi.mocked(request).mockImplementation((...args: unknown[]) => {
      const options = args[1] as { lookup: (host: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void; signal: AbortSignal };
      const resolved = vi.fn(); options.lookup('receiver.example', { all: true }, resolved);
      expect(resolved).toHaveBeenCalledWith(null, [address]);
      expect(options.signal.aborted).toBe(false);
      outgoing.end.mockImplementation(() => { queueMicrotask(() => (args[2] as (response: unknown) => void)(response)); });
      return outgoing as unknown as ReturnType<typeof request>;
    });
    expect(await new HttpsWebhookTransport().post('https://receiver.example/hook', '{}', { 'webhook-id': 'id' })).toBe(302);
    expect(request).toHaveBeenCalledTimes(1); expect(response.destroy).toHaveBeenCalled();
  });
});
