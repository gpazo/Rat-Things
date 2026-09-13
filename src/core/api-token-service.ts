import { createHash, randomBytes } from 'node:crypto';
import type { AgentsStore, AgentsClock } from './agents-ports.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

interface TokenGrant { ownerId: string; audience: string; expiresAt: number }

/** IAM authenticates issuance. Only a digest, owner, audience and expiry are persisted. */
export class ApiTokenService {
  public constructor(private readonly store: AgentsStore, private readonly clock: AgentsClock = { now: () => Math.floor(Date.now() / 1000) }) {}

  public async issue(ownerId: string, audience: string) {
    const secret = randomBytes(32).toString('base64url');
    const api_key = `rat_${Buffer.from(ownerId).toString('base64url')}.${secret}`;
    const expires_at = this.clock.now() + 900;
    await this.store.put<TokenGrant>({ ownerId, id: digest(api_key), collection: 'api_tokens', createdAt: this.clock.now(), revision: 1, expiresAt: expires_at,
      value: { ownerId, audience, expiresAt: expires_at } }, 0);
    return { api_key, expires_at, base_url: audience };
  }

  public async authenticate(authorization: string | null, audience: string): Promise<string> {
    const matched = authorization?.match(/^Bearer (rat_([A-Za-z0-9_-]{1,4096})\.[A-Za-z0-9_-]{43})$/);
    if (!matched) unauthorized();
    const owner = Buffer.from(matched[2]!, 'base64url').toString('utf8');
    if (Buffer.from(owner).toString('base64url') !== matched[2]) unauthorized();
    const grant = (await this.store.get<TokenGrant>(owner, 'api_tokens', digest(matched[1]!)))?.value;
    if (!grant || grant.ownerId !== owner || grant.audience !== audience || grant.expiresAt <= this.clock.now()) unauthorized();
    return grant.ownerId;
  }
}

function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function unauthorized(): never { throw new AgentsApiError(401, 'Invalid or expired API key.', 'invalid_api_key'); }
