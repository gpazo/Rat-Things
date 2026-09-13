import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import { AgentsApiError } from './agents-api-validation.js';
import { credentialUrl, validateCredentialAuth } from './vault-planning.js';

export type OAuthCredential = Extract<CredentialAuthCreateParam, { type: 'mcp_oauth' }>;
export interface OAuthRefreshRequest { url: string; headers: Record<string, string>; body: string }
export interface OAuthRefreshClient { refresh(request: OAuthRefreshRequest): Promise<unknown> }

export function needsOAuthRefresh(auth: CredentialAuthCreateParam, now: number): boolean {
  return auth.type === 'mcp_oauth' && auth.expires_at != null && Date.parse(auth.expires_at) <= (now + (auth.refresh ? 60 : 0)) * 1000;
}

/** RFC 6749 token requests contain secrets and are used only at the host HTTP boundary. */
export function planOAuthRefresh(auth: OAuthCredential): OAuthRefreshRequest {
  if (!auth.refresh) throw new AgentsApiError(503, 'The MCP OAuth credential needs replacement.', 'credential_expired');
  const refresh = auth.refresh;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh.refresh_token });
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
  if (refresh.scope != null) body.set('scope', refresh.scope);
  if (refresh.resource != null) body.set('resource', refresh.resource);
  const clientAuth = refresh.token_endpoint_auth;
  if (clientAuth.type === 'client_secret_basic') {
    const encode = (value: string) => new URLSearchParams({ value }).toString().slice('value='.length);
    headers.authorization = `Basic ${Buffer.from(`${encode(refresh.client_id)}:${encode(clientAuth.client_secret)}`).toString('base64')}`;
  } else {
    body.set('client_id', refresh.client_id);
    if (clientAuth.type === 'client_secret_post') body.set('client_secret', clientAuth.client_secret);
  }
  return { url: credentialUrl(refresh.token_endpoint, 'auth.refresh.token_endpoint'), headers, body: body.toString() };
}

/** Missing refresh tokens preserve the previous grant; an explicit expiry of zero stays zero. */
export function refreshedOAuthCredential(previous: OAuthCredential, result: unknown, now: number): OAuthCredential {
  if (!record(result) || typeof result.access_token !== 'string' || !result.access_token ||
    typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer' ||
    result.refresh_token !== undefined && (typeof result.refresh_token !== 'string' || !result.refresh_token) ||
    result.expires_in !== undefined && (typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in < 0) ||
    result.scope !== undefined && typeof result.scope !== 'string') {
    throw new AgentsApiError(502, 'The OAuth token endpoint returned an invalid response.', 'credential_refresh_failed');
  }
  const auth: OAuthCredential = {
    ...previous, access_token: result.access_token,
    expires_at: typeof result.expires_in === 'number' ? new Date((now + result.expires_in) * 1000).toISOString() : null,
    refresh: previous.refresh ? { ...previous.refresh,
      ...(typeof result.refresh_token === 'string' ? { refresh_token: result.refresh_token } : {}),
      ...(typeof result.scope === 'string' ? { scope: result.scope } : {}),
    } : null,
  };
  validateCredentialAuth(auth);
  return auth;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
