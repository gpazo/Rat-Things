import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return safeEqual(expected, signature);
}

export function verifyGitLabToken(provided: string | undefined, secret: string): boolean {
  return provided !== undefined && safeEqual(provided, secret);
}

export function verifyGitLabStandardSignature(
  body: string,
  messageId: string | undefined,
  timestamp: string | undefined,
  signatureHeader: string | undefined,
  signingToken: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  if (!messageId || messageId.length > 256 || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 5 * 60) return false;
  if (!signatureHeader || !signingToken.startsWith('whsec_')) return false;
  const encodedKey = signingToken.slice('whsec_'.length);
  const key = strictBase64(encodedKey);
  if (!key || key.length !== 32) return false;
  const expected = createHmac('sha256', key)
    .update(`${messageId}.${timestamp}.${body}`, 'utf8')
    .digest('base64');
  return signatureHeader
    .trim()
    .split(/\s+/)
    .some((entry) => {
      const match = entry.match(/^v1,([A-Za-z0-9+/]+={0,2})$/);
      return Boolean(match?.[1] && safeEqual(expected, match[1]));
    });
}

export function verifyTeamsSignature(body: string, authorization: string | undefined, base64Secret: string): boolean {
  const provided = authorization?.match(/^HMAC\s+(.+)$/i)?.[1];
  if (!provided) return false;
  const key = strictBase64(base64Secret.trim());
  if (!key || key.length === 0) return false;
  const expected = createHmac('sha256', key).update(body, 'utf8').digest('base64');
  return safeEqual(expected, provided);
}

export function verifySlackSignature(
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 5 * 60) return false;
  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
  return safeEqual(expected, signature);
}

export function header(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function strictBase64(value: string): Buffer | undefined {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}
