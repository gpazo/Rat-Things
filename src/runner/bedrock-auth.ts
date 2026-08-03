import { getTokenProvider } from '@aws/bedrock-token-generator';

interface SecretCredentialReader {
  read(secretArn: string | undefined, preferredKeys: string[]): Promise<string>;
}

const MAX_TOKEN_TTL_SECONDS = 43_200;
const MIN_TOKEN_TTL_SECONDS = 900;

/**
 * Loads a configured Bedrock API key or mints a short-term token from the
 * worker's AWS role. Only the resulting bearer token is exposed to Codex.
 */
export async function loadCodexBedrockToken(credentials: SecretCredentialReader): Promise<boolean> {
  const secretArn = process.env.BEDROCK_API_KEY_SECRET_ARN;
  const token = secretArn
    ? await credentials.read(secretArn, ['api_key', 'token', 'key'])
    : await getTokenProvider({
      region: bedrockRegion(),
      expiresInSeconds: tokenTtlSeconds(process.env.RUN_TIMEOUT_SECONDS),
    })();
  process.env.AWS_BEARER_TOKEN_BEDROCK = token;
  return true;
}

function bedrockRegion(): string {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error('AWS_REGION is required to generate a Bedrock token');
  return region;
}

export function tokenTtlSeconds(rawRunTimeoutSeconds: string | undefined): number {
  const runTimeoutSeconds = Number(rawRunTimeoutSeconds ?? 900);
  const requested = Number.isFinite(runTimeoutSeconds) ? Math.ceil(runTimeoutSeconds) + 300 : 1_200;
  return Math.max(MIN_TOKEN_TTL_SECONDS, Math.min(MAX_TOKEN_TTL_SECONDS, requested));
}
