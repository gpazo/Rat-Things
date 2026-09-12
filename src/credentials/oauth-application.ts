export interface OAuthApplication {
  clientId: string;
  clientSecret: string;
}

export function oauthApplication(value: unknown, pluginId: string): OAuthApplication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OAuth application secret for ${pluginId} is invalid`);
  }
  const clientId = (value as Record<string, unknown>).client_id;
  const clientSecret = (value as Record<string, unknown>).client_secret;
  if (
    typeof clientId !== 'string' ||
    !clientId ||
    Buffer.byteLength(clientId, 'utf8') > 2_048 ||
    typeof clientSecret !== 'string' ||
    !clientSecret ||
    Buffer.byteLength(clientSecret, 'utf8') > 8_192
  ) throw new Error(`OAuth application secret for ${pluginId} requires client_id and client_secret`);
  return { clientId, clientSecret };
}
