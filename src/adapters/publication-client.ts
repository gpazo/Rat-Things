/** Accept only private byte URLs supplied by an authenticated control response. */
export function isPrivateArtifactUrl(target: URL, options: {
  controlUrl: URL;
  region?: string | undefined;
  bucket?: string | undefined;
  unsigned?: boolean;
}): boolean {
  if (options.unsigned) return target.origin === options.controlUrl.origin;
  if (!options.region || target.protocol !== 'https:' || target.port || target.username || target.password) return false;
  const suffix = `.s3.${options.region}.amazonaws.com`;
  if (!target.hostname.endsWith(suffix)) return false;
  const bucket = target.hostname.slice(0, -suffix.length);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return false;
  if (options.bucket && bucket !== options.bucket) return false;
  return target.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' &&
    Boolean(target.searchParams.get('X-Amz-Signature'));
}

/**
 * Redeems a browser publication and follows its redirects. When a publication
 * asset path is supplied, the first signed-cookie response
 * authorizes the host and the client then requests the original asset bytes.
 */
export async function fetchSharedResource(
  url: string,
  timeoutMs: number,
  publicationPath?: string,
): Promise<Response> {
  let current = new URL(url);
  const cookies = new Map<string, string>();
  for (let redirects = 0; redirects < 6; redirects += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      ...(cookies.size > 0 ? { headers: { cookie: [...cookies.values()].join('; ') } } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let receivedPublicationCookie = false;
    for (const setCookie of responseCookies(response.headers)) {
      const pair = setCookie.split(';', 1)[0];
      const name = pair?.split('=', 1)[0];
      if (pair && name) {
        cookies.set(name, pair);
        if (name.startsWith('CloudFront-')) receivedPublicationCookie = true;
      }
    }
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    if (publicationPath && receivedPublicationCookie && isRedirect) {
      const location = response.headers.get('location');
      const publicationOrigin = location ? new URL(location, current).origin : current.origin;
      current = new URL(encodePublicationPath(publicationPath), `${publicationOrigin}/`);
      publicationPath = undefined;
      continue;
    }
    if (!isRedirect) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error(`share redirect returned HTTP ${response.status} without Location`);
    current = new URL(location, current);
  }
  throw new Error('share link returned too many redirects');
}

function responseCookies(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (extended.getSetCookie) return extended.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? combined.split(/,(?=\s*CloudFront-)/) : [];
}

function encodePublicationPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
