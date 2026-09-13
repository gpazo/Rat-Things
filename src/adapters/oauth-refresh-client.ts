import type { OAuthRefreshClient, OAuthRefreshRequest } from '../domain/vault-oauth.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export class HttpOAuthRefreshClient implements OAuthRefreshClient {
  public constructor(private readonly send: typeof fetch = fetch) {}
  public async refresh(request: OAuthRefreshRequest): Promise<unknown> {
    try {
      const response = await this.send(request.url, {
        method: 'POST', headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || !response.body) throw new Error('Refresh denied');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 100_000) throw new Error('Oversized token response');
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      // Provider errors can contain access tokens, refresh tokens, and client secrets.
      throw new AgentsApiError(502, 'The MCP OAuth credential could not be refreshed.', 'credential_refresh_failed');
    }
  }
}
