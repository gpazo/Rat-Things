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
  const signed = signCloudFrontPolicy(input);
  const targetUrl = new URL(target);
  const resource = new URL(input.resource);
  if (
    targetUrl.protocol !== 'https:' ||
    targetUrl.username ||
    targetUrl.password ||
    targetUrl.origin !== resource.origin
  ) throw new Error('CloudFront signed URL target must use the signed HTTPS origin');
  const delimiter = targetUrl.search ? '&' : '?';
  const query = [
    `Policy=${signed.policy}`,
    `Signature=${signed.signature}`,
    `Key-Pair-Id=${encodeURIComponent(input.keyPairId)}`,
  ].join('&');
  return {
    cookies: cloudFrontCookies(signed, input.keyPairId),
    url: `${targetUrl.toString()}${delimiter}${query}`,
  };
}

export function cloudFrontSignedCookies(input: CloudFrontCookieInput): string[] {
  const signed = signCloudFrontPolicy(input);
  return cloudFrontCookies(signed, input.keyPairId);
}

function signCloudFrontPolicy(input: CloudFrontCookieInput): {
  policy: string;
  signature: string;
  maxAge: number;
} {
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
  return {
    policy: cloudFrontBase64(Buffer.from(policy)),
    signature: cloudFrontBase64(signature),
    maxAge,
  };
}

function cloudFrontCookies(
  signed: { policy: string; signature: string; maxAge: number },
  keyPairId: string,
): string[] {
  const attributes = `Path=/; Max-Age=${signed.maxAge}; Secure; HttpOnly; SameSite=Lax`;
  return [
    `CloudFront-Policy=${signed.policy}; ${attributes}`,
    `CloudFront-Signature=${signed.signature}; ${attributes}`,
    `CloudFront-Key-Pair-Id=${keyPairId}; ${attributes}`,
  ];
}

function cloudFrontBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replace(/\+/g, '-')
    .replace(/=/g, '_')
    .replace(/\//g, '~');
}
