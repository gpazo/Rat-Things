import { API_SCOPES, type ApiScope } from '../domain/api-permissions.js';

export interface OidcProvider {
  id: string;
  issuer: string;
  jwksUri: string;
  clientId: string;
  audience?: string;
  profile: 'jwt_access' | 'cognito_access';
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  scopes: string[];
  requiredScopes?: string[];
  apiScopes?: ApiScope[];
}
const fields = ['id', 'issuer', 'jwksUri', 'clientId', 'audience', 'profile', 'authorizationEndpoint', 'tokenEndpoint', 'redirectUri', 'scopes', 'requiredScopes', 'apiScopes'];
export function parseOidcProviders(raw: string | undefined): OidcProvider[] {
  let input: unknown;
  try { input = JSON.parse(raw ?? '[]'); } catch { throw new Error('TEAM_OIDC_PROVIDERS_JSON must be valid JSON.'); }
  if (!Array.isArray(input) || !input.length || input.length > 16) throw new Error('Configure between one and sixteen OIDC providers.');
  const providers = input.map((value: unknown): OidcProvider => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid OIDC provider.');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => !fields.includes(key))) throw new Error('Unknown OIDC provider field.');
    for (const key of ['id', 'issuer', 'jwksUri', 'clientId', 'authorizationEndpoint', 'tokenEndpoint', 'redirectUri']) {
      if (typeof record[key] !== 'string' || !record[key] || (record[key] as string).length > 2048) throw new Error(`OIDC provider requires ${key}.`);
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(record.id))) throw new Error('Invalid OIDC provider id.');
    if (record.profile !== 'jwt_access' && record.profile !== 'cognito_access') throw new Error('Select an explicit OIDC access token profile.');
    if (record.audience !== undefined && (typeof record.audience !== 'string' || !record.audience)) throw new Error('Invalid OIDC audience.');
    if (record.profile === 'jwt_access' && !record.audience) throw new Error('JWT access tokens require an API audience.');
    for (const field of ['issuer', 'jwksUri', 'authorizationEndpoint', 'tokenEndpoint']) secureUrl(String(record[field]));
    const redirect = new URL(String(record.redirectUri));
    if (redirect.username || redirect.password || redirect.hash || redirect.search || !(redirect.protocol === 'https:' || redirect.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(redirect.hostname) && redirect.port)) throw new Error('OIDC redirect must use HTTPS or a fixed loopback address and port.');
    for (const key of ['scopes', 'requiredScopes', 'apiScopes']) {
      if (record[key] === undefined && key !== 'scopes') continue;
      if (!Array.isArray(record[key]) || (record[key] as unknown[]).length > 64 || (record[key] as unknown[]).some(scope => typeof scope !== 'string' || !scope || /\s/.test(scope))) throw new Error(`Invalid OIDC ${key}.`);
    }
    if ((record.apiScopes as unknown[] | undefined)?.some(scope => !API_SCOPES.includes(scope as ApiScope))) throw new Error('Unknown OIDC API scope grant.');
    return record as unknown as OidcProvider;
  });
  if (new Set(providers.map(p => p.id)).size !== providers.length || new Set(providers.map(p => p.issuer)).size !== providers.length) throw new Error('OIDC provider ids and issuers must be unique.');
  return providers;
}
function secureUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('OIDC provider endpoints must use HTTPS without credentials or fragments.');
}
export function oidcLoginDiscovery(providers: readonly OidcProvider[]) {
  return providers.map(p => ({ id: p.id, issuer: p.issuer, jwks_uri: p.jwksUri, client_id: p.clientId,
    ...(p.audience ? { audience: p.audience } : {}), profile: p.profile, authorization_endpoint: p.authorizationEndpoint,
    token_endpoint: p.tokenEndpoint, redirect_uri: p.redirectUri, scopes: p.scopes }));
}
