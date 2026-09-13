import type { CredentialAuth, CredentialAuthCreateParam, CredentialAuthRotateParam } from 'openai/resources/beta/agents/vaults/credentials';
import { invalid } from './agents-api-validation.js';

export function vaultName(value: string): string {
  const name = value.trim();
  if (!name || Buffer.byteLength(name) > 256) invalid('name must contain 1 to 256 UTF-8 bytes after trimming', 'name');
  return name;
}

export function credentialUrl(value: string, param = 'auth.mcp_server_url'): string {
  let url: URL;
  try { url = new URL(value); } catch { invalid('A valid HTTPS URL is required', param); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) invalid('A credential-free HTTPS URL is required', param);
  return url.href;
}

export function validateCredentialAuth(auth: CredentialAuthCreateParam): void {
  credentialUrl(auth.mcp_server_url);
  const tokens = auth.type === 'static_bearer' ? [auth.token] : [
    auth.access_token,
    ...(auth.refresh ? [auth.refresh.refresh_token, ...(auth.refresh.token_endpoint_auth.type === 'none' ? [] : [auth.refresh.token_endpoint_auth.client_secret])] : []),
  ];
  if (tokens.some((token) => !token || /[\r\n]/.test(token))) invalid('Credential secrets must be nonempty single-line values', 'auth');
  if (Buffer.byteLength(JSON.stringify(auth)) > 60_000) invalid('Credential exceeds the supported secret size', 'auth');
  if (auth.type === 'mcp_oauth') {
    if (auth.expires_at != null && (!/^\d{4}-\d\d-\d\dT/.test(auth.expires_at) || !Number.isFinite(Date.parse(auth.expires_at)))) invalid('expires_at must be an RFC 3339 timestamp', 'auth.expires_at');
    if (auth.refresh) credentialUrl(auth.refresh.token_endpoint, 'auth.refresh.token_endpoint');
  }
}

/** Enumerate public fields so new secret fields cannot accidentally become public. */
export function publicCredentialAuth(auth: CredentialAuthCreateParam): CredentialAuth {
  return auth.type === 'static_bearer'
    ? { type: 'static_bearer', mcp_server_url: auth.mcp_server_url }
    : {
      type: 'mcp_oauth', mcp_server_url: auth.mcp_server_url, expires_at: auth.expires_at ?? null,
      refresh: auth.refresh ? {
        client_id: auth.refresh.client_id, resource: auth.refresh.resource ?? null,
        scope: auth.refresh.scope ?? null, token_endpoint: auth.refresh.token_endpoint,
        token_endpoint_auth: { type: auth.refresh.token_endpoint_auth.type },
      } : null,
    };
}

/** Rotation preserves the destination and auth method, with upstream omission/null semantics. */
export function rotateCredentialAuth(previous: CredentialAuthCreateParam, update: CredentialAuthRotateParam): CredentialAuthCreateParam {
  if (previous.type === 'static_bearer' && update.type === 'static_bearer') return { ...previous, token: update.token };
  if (previous.type !== 'mcp_oauth' || update.type !== 'mcp_oauth') invalid('Rotation cannot change the authentication method', 'auth.type');
  const refresh = previous.refresh;
  if (update.refresh && !refresh) invalid('Rotation requires an existing refresh configuration', 'auth.refresh');
  const authUpdate = update.refresh?.token_endpoint_auth;
  if (authUpdate && authUpdate.type !== refresh?.token_endpoint_auth.type) invalid('Rotation cannot change the OAuth client authentication method', 'auth.refresh.token_endpoint_auth.type');
  return {
    ...previous,
    access_token: update.access_token ?? previous.access_token,
    expires_at: update.expires_at === undefined
      ? update.access_token == null ? previous.expires_at ?? null : null
      : update.expires_at,
    refresh: update.refresh === null ? null : refresh ? {
      ...refresh,
      refresh_token: update.refresh?.refresh_token ?? refresh.refresh_token,
      scope: update.refresh?.scope === undefined ? refresh.scope ?? null : update.refresh.scope,
      token_endpoint_auth: refresh.token_endpoint_auth.type === 'none' ? { type: 'none' } : {
        ...refresh.token_endpoint_auth,
        client_secret: authUpdate?.client_secret ?? refresh.token_endpoint_auth.client_secret,
      },
    } : null,
  };
}
