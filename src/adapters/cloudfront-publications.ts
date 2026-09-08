import { createSign } from 'node:crypto';
import type { ShareGrant } from '../domain/publications.js';
import { validateShareGrant } from '../domain/publications.js';

export interface CloudFrontCookieInput {
  grant: ShareGrant;
  resource: string;
  keyPairId: string;
  privateKey: string;
  now?: Date;
}

export interface CloudFrontSignedAccess {
  cookies: string[];
  url: string;
}

/**
 * Authorizes the first publication document with a signed URL and the
 * remaining publication tree with equivalent host-only cookies. The signed
 * first request makes the handoff reliable even in clients that delay or
 * discard cookies set by an intermediate redirect.
 */
export function cloudFrontSignedAccess(
  input: CloudFrontCookieInput,
  target: string,
): CloudFrontSignedAccess {
  validateShareGrant(input.grant);
  if (input.grant.revokedAt) throw new Error('cannot issue cookies for a revoked share grant');
  const now = input.now ?? new Date();
  const expiresAt = Date.parse(input.grant.expiresAt);
  const maxAge = Math.ceil((expiresAt - now.getTime()) / 1_000);
  if (maxAge <= 0) throw new Error('cannot issue cookies for an expired share grant');
  if (!/^[A-Z0-9]{8,128}$/.test(input.keyPairId)) {
    throw new Error('CloudFront key pair id is invalid');
  }
  const resource = new URL(input.resource);
  if (resource.protocol !== 'https:' || resource.username || resource.password) {
    throw new Error('CloudFront cookie resource must be an HTTPS URL');
  }
  const policy = JSON.stringify({
    Statement: [{
      Resource: resource.toString(),
      Condition: { DateLessThan: { 'AWS:EpochTime': Math.floor(expiresAt / 1_000) } },
    }],
  });
  const signature = createSign('RSA-SHA1').update(policy).sign(input.privateKey);
  const encodedPolicy = cloudFrontBase64(Buffer.from(policy));
  const encodedSignature = cloudFrontBase64(signature);
  const targetUrl = new URL(target);
  if (
    targetUrl.protocol !== 'https:' ||
    targetUrl.username ||
    targetUrl.password ||
    targetUrl.origin !== resource.origin
  ) throw new Error('CloudFront signed URL target must use the signed HTTPS origin');
  const delimiter = targetUrl.search ? '&' : '?';
  const query = [
    `Policy=${encodedPolicy}`,
    `Signature=${encodedSignature}`,
    `Key-Pair-Id=${encodeURIComponent(input.keyPairId)}`,
  ].join('&');
  const attributes = `Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
  return {
    cookies: [
      `CloudFront-Policy=${encodedPolicy}; ${attributes}`,
      `CloudFront-Signature=${encodedSignature}; ${attributes}`,
      `CloudFront-Key-Pair-Id=${input.keyPairId}; ${attributes}`,
    ],
    url: `${targetUrl.toString()}${delimiter}${query}`,
  };
}

function cloudFrontBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replace(/\+/g, '-')
    .replace(/=/g, '_')
    .replace(/\//g, '~');
}
