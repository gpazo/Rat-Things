import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSharedResource } from '../../src/adapters/publication-client.js';

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
