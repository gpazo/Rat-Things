import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { API_SCOPES, type ApiPrincipal } from '../domain/api-permissions.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import type { OidcProvider } from '../identity/oidc-provider.js';
import { oidcActorId } from '../identity/principal.js';

/** Issuer discovery selects only already-configured keys; no token claim controls an outbound URL. */
export class OidcAuthenticator {
  private readonly keys: Map<string, JWTVerifyGetKey>;
  public constructor(private readonly providers: readonly OidcProvider[], options: { keys?: (provider: OidcProvider) => JWTVerifyGetKey; now?: () => number } = {}) {
    this.keys = new Map(providers.map(provider => [provider.id, options.keys?.(provider) ?? createRemoteJWKSet(new URL(provider.jwksUri), { timeoutDuration: 5000, cooldownDuration: 30_000 })]));
    this.now = options.now ?? Date.now;
  }
  private readonly now: () => number;
  public async authenticate(authorization: string | null): Promise<ApiPrincipal> {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1];
    if (!token || token.length > 32_768) return unauthorized();
    try {
      const issuer = decodeJwt(token).iss;
      const provider = this.providers.find(candidate => candidate.issuer === issuer);
      if (!provider) return unauthorized();
      const { payload, protectedHeader } = await jwtVerify(token, this.keys.get(provider.id)!, {
        issuer: provider.issuer, ...(provider.audience ? { audience: provider.audience } : {}),
        algorithms: ['RS256', 'PS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'],
        currentDate: new Date(this.now()), clockTolerance: 0,
      });
      if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 1024 || typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.iat > this.now() / 1000) return unauthorized();
      if (provider.profile === 'cognito_access') {
        if (payload.token_use !== 'access' || payload.client_id !== provider.clientId) return unauthorized();
      } else {
        if (protectedHeader.typ?.toLowerCase() !== 'at+jwt' || payload.token_use === 'id' || payload.nonce !== undefined) return unauthorized();
        if (payload.client_id !== provider.clientId || payload.azp !== undefined && payload.azp !== provider.clientId) return unauthorized();
      }
      if (payload.scope !== undefined && typeof payload.scope !== 'string') return unauthorized();
      const granted = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];
      if (provider.requiredScopes?.some(scope => !granted.includes(scope))) return unauthorized();
      const apiGrants = granted.filter(scope => scope.startsWith('api.'));
      const scopes = (provider.apiScopes ?? API_SCOPES).filter(scope => !apiGrants.length || apiGrants.includes(scope));
      const workload = payload.gty === 'client-credentials' || payload.grant_type === 'client_credentials' || payload.sub === provider.clientId;
      return { ownerId: '', authentication: 'oidc', scopes, expiresAt: payload.exp * 1000,
        actor: { id: oidcActorId(provider.issuer, payload.sub), kind: workload ? 'workload' : 'human', issuer: provider.issuer, subject: payload.sub } };
    } catch { return unauthorized(); }
  }
}
function unauthorized(): never { throw new AgentsApiError(401, 'Invalid or expired access token.', 'invalid_api_key'); }
