import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { publicNetworkAddress } from '../domain/network-address.js';
import type { WebhookTransport } from '../core/webhook-service.js';

/** Resolve and pin a public destination before sending signing material; never follow redirects. */
export class HttpsWebhookTransport implements WebhookTransport {
  public async post(url: string, body: string, headers: Record<string, string>): Promise<number> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error('Invalid webhook destination');
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
      const error = new Error('Webhook request timed out'); abort.abort(error); reject(error);
    }, 5000); });
    try { return await Promise.race([this.send(target, body, headers, abort.signal), deadline]); }
    finally { clearTimeout(timer); }
  }

  private async send(target: URL, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<number> {
    const addresses = await lookup(target.hostname.replace(/^\[|\]$/g, ''), { all: true });
    signal.throwIfAborted(); // A DNS answer received after the deadline must not send anything.
    if (!addresses.length || addresses.some(({ address }) => !publicNetworkAddress(address))) throw new Error('Webhook destination must be public');
    const address = addresses[0]!;
    return new Promise((resolve, reject) => {
      const outgoing = request(target, { method: 'POST', signal, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
      }, (response) => { const status = response.statusCode ?? 500; response.destroy(); resolve(status); });
      outgoing.once('error', reject);
      outgoing.end(body);
    });
  }
}
