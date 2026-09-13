import type {
  PublicationDescriptor,
  PublicationManifest,
  ShareGrant,
} from '../domain/publications.js';
import { validatePublicationId } from '../domain/publications.js';

export function validatePublicationTokenSuffix(tokenSuffix: string): void {
  if (!/^[a-f0-9]{64}$/.test(tokenSuffix)) {
    throw new Error('publication token generator returned an invalid token');
  }
}

export function publicationGrant(input: {
  publicationId: string;
  ownerHash: string;
  tokenSuffix: string;
  now: Date;
  ttlSeconds: number;
}): ShareGrant {
  return {
    version: '1',
    id: `${input.ownerHash}-${input.tokenSuffix}`,
    publicationId: input.publicationId,
    ownerHash: input.ownerHash,
    access: 'bearer',
    expiresAt: new Date(input.now.getTime() + input.ttlSeconds * 1_000).toISOString(),
  };
}

export function publicationDescriptor(
  manifest: PublicationManifest,
  grant: ShareGrant,
  domain: string,
): PublicationDescriptor {
  return {
    publicationId: grant.publicationId,
    kind: manifest.kind,
    url: `https://${publicationHost(grant.publicationId, grant.ownerHash, domain)}/__share/${grant.id}`,
    expiresAt: grant.expiresAt,
    entrypoint: manifest.entrypoint,
    ...(manifest.primaryPath ? { primaryPath: manifest.primaryPath } : {}),
    paths: manifest.files.map((file) => file.path),
  };
}

export function publicationTtlSeconds(configured: string | number | undefined): number {
  const seconds = Number(configured ?? 86_400);
  if (!Number.isFinite(seconds)) return 86_400;
  return Math.max(60, Math.min(86_400, Math.floor(seconds)));
}

function publicationHost(publicationId: string, ownerHash: string, domain: string): string {
  validatePublicationId(publicationId);
  if (!/^[a-f0-9]{32}$/.test(ownerHash)) throw new Error('publication owner hash is invalid');
  return `${publicationId}-${ownerHash}.${domain}`;
}

export function publicationDomain(value: string): string {
  const domain = value.toLowerCase().replace(/^\.+|\.+$/g, '');
  if (
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) throw new Error('publication base domain is invalid');
  return domain;
}
