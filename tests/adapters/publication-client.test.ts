import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSharedResource, isPrivateArtifactUrl } from '../../src/adapters/publication-client.js';

describe('private artifact redirects', () => {
  const options = { controlUrl: new URL('https://api.example'), region: 'us-west-2' };
  const signed = 'https://private-files.s3.us-west-2.amazonaws.com/file?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=signature';

  it('accepts signed regional S3 URLs without requiring duplicate bucket configuration', () => {
    expect(isPrivateArtifactUrl(new URL(signed), options)).toBe(true);
    expect(isPrivateArtifactUrl(new URL(signed), { ...options, bucket: 'private-files' })).toBe(true);
    expect(isPrivateArtifactUrl(new URL(signed), { ...options, bucket: 'another-bucket' })).toBe(false);
  });

  it('rejects external hosts, share redirects, unsigned URLs, credentials, and other regions', () => {
    for (const url of [
      'https://api.example/v1/shares/token', 'http://127.0.0.1/file',
      signed.replace('amazonaws.com', 'amazonaws.com.attacker.example'),
      signed.replace('us-west-2', 'us-east-1'), signed.split('?')[0]!,
      signed.replace('https:', 'http:'), signed.replace('https://', 'https://user:password@'),
      signed.replace('.com/file', '.com:444/file'), signed.replace('X-Amz-Signature=signature', ''),
    ]) expect(isPrivateArtifactUrl(new URL(url), options)).toBe(false);
  });

  it('keeps unsigned local fixtures restricted to their control origin', () => {
    expect(isPrivateArtifactUrl(new URL('https://api.example/file'), { ...options, unsigned: true })).toBe(true);
    expect(isPrivateArtifactUrl(new URL(signed), { ...options, unsigned: true })).toBe(false);
  });
});

describe('publication share client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('redeems signed entry access and downloads the requested publication asset', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: [
          ['location', 'https://publication.share.example/?Policy=policy&Signature=signature&Key-Pair-Id=key'],
          ['set-cookie', 'CloudFront-Policy=policy; Path=/; Secure; HttpOnly'],
          ['set-cookie', 'CloudFront-Signature=signature; Path=/; Secure; HttpOnly'],
          ['set-cookie', 'CloudFront-Key-Pair-Id=key; Path=/; Secure; HttpOnly'],
        ],
      }))
      .mockResolvedValueOnce(new Response('original bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchSharedResource(
      'https://publication.share.example/__share/token',
      1_000,
      'assets/demo image.webp',
    );

    expect(await response.text()).toBe('original bytes');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://publication.share.example/assets/demo%20image.webp',
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers.cookie).toContain('CloudFront-Policy=policy');
  });

});
