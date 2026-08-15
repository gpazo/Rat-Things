import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cloudFrontSignedCookies } from '../../src/adapters/cloudfront-publications.js';

describe('CloudFront publication cookies', () => {
  it('issues a host-only custom-policy cookie set scoped by the signed resource', () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const cookies = cloudFrontSignedCookies({
      grant: {
        version: '1',
        id: 'share-1',
        publicationId: 'a'.repeat(24),
        ownerHash: 'b'.repeat(32),
        access: 'bearer',
        expiresAt: '2026-08-16T00:00:00.000Z',
      },
      resource: `https://${'a'.repeat(24)}-${'b'.repeat(32)}.content.example.com/*`,
      keyPairId: 'K12345678',
      privateKey,
      now: new Date('2026-08-15T23:00:00.000Z'),
    });

    expect(cookies).toHaveLength(3);
    expect(cookies.every((cookie) => cookie.includes('Secure; HttpOnly; SameSite=Lax'))).toBe(true);
    expect(cookies.every((cookie) => !cookie.includes('Domain='))).toBe(true);
    const policy = decodeCookie(cookies[0]!, 'CloudFront-Policy');
    const signature = decodeCookie(cookies[1]!, 'CloudFront-Signature');
    expect(JSON.parse(policy.toString('utf8'))).toEqual({
      Statement: [{
        Resource: `https://${'a'.repeat(24)}-${'b'.repeat(32)}.content.example.com/*`,
        Condition: { DateLessThan: { 'AWS:EpochTime': 1_786_838_400 } },
      }],
    });
    expect(verify('RSA-SHA1', policy, keys.publicKey, signature)).toBe(true);
  });

  it('does not authorize revoked grants', () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => cloudFrontSignedCookies({
      grant: {
        version: '1',
        id: 'share-1',
        publicationId: 'a'.repeat(24),
        ownerHash: 'b'.repeat(32),
        access: 'bearer',
        expiresAt: '2026-08-16T00:00:00.000Z',
        revokedAt: '2026-08-15T22:00:00.000Z',
      },
      resource: 'https://publication.content.example/*',
      keyPairId: 'K12345678',
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      now: new Date('2026-08-15T23:00:00.000Z'),
    })).toThrow('revoked');
  });
});

function decodeCookie(cookie: string, name: string): Buffer {
  const encoded = cookie.slice(`${name}=`.length, cookie.indexOf(';'))
    .replace(/-/g, '+')
    .replace(/_/g, '=')
    .replace(/~/g, '/');
  return Buffer.from(encoded, 'base64');
}
