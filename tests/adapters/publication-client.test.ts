import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSharedResource } from '../../src/adapters/publication-client.js';

describe('publication share client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('redeems signed cookies and downloads the requested publication asset', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<p>Opening shared work…</p>', {
        status: 200,
        headers: [
          ['content-type', 'text/html; charset=utf-8'],
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

  it('continues to support signed-cookie redirects from older deployments', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: [
          ['location', 'https://publication.share.example/'],
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
      'assets/demo.webp',
    );

    expect(await response.text()).toBe('original bytes');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://publication.share.example/assets/demo.webp',
    );
  });

  it('continues to support legacy redirects without publication cookies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { location: 'https://bucket.s3.example/signed-object' },
      }))
      .mockResolvedValueOnce(new Response('legacy bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchSharedResource(
      'https://api.example/v1/shares/token',
      1_000,
      'assets/ignored.txt',
    );

    expect(await response.text()).toBe('legacy bytes');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://bucket.s3.example/signed-object');
  });
});
