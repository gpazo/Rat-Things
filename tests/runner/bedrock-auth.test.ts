import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tokenProvider = vi.hoisted(() => vi.fn());
const getTokenProvider = vi.hoisted(() => vi.fn(() => tokenProvider));

vi.mock('@aws/bedrock-token-generator', () => ({ getTokenProvider }));

import { loadCodexBedrockToken, tokenTtlSeconds } from '../../src/runner/bedrock-auth.js';

beforeEach(() => {
  getTokenProvider.mockClear();
  tokenProvider.mockReset();
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

describe('Codex Bedrock authentication', () => {
  it('mints a bounded short-term token without exposing the AWS credential chain to Codex', async () => {
    vi.stubEnv('AWS_REGION', 'us-west-2');
    vi.stubEnv('RUN_TIMEOUT_SECONDS', '300');
    tokenProvider.mockResolvedValue('bedrock-api-key-short-term');
    const credentials = { read: vi.fn() };

    await expect(loadCodexBedrockToken(credentials)).resolves.toBe(true);

    expect(credentials.read).not.toHaveBeenCalled();
    expect(getTokenProvider).toHaveBeenCalledWith({
      region: 'us-west-2',
      expiresInSeconds: 900,
    });
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe('bedrock-api-key-short-term');
  });

  it('uses an explicitly configured secret instead of minting a token', async () => {
    vi.stubEnv('BEDROCK_API_KEY_SECRET_ARN', 'arn:aws:secretsmanager:us-west-2:123456789012:secret:key');
    const credentials = { read: vi.fn().mockResolvedValue('configured-key') };

    await loadCodexBedrockToken(credentials);

    expect(credentials.read).toHaveBeenCalledWith(
      'arn:aws:secretsmanager:us-west-2:123456789012:secret:key',
      ['api_key', 'token', 'key'],
    );
    expect(getTokenProvider).not.toHaveBeenCalled();
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe('configured-key');
  });

  it('requires a region for generated tokens and clamps token lifetime', async () => {
    await expect(loadCodexBedrockToken({ read: vi.fn() }))
      .rejects.toThrow('AWS_REGION is required to generate a Bedrock token');
    expect(tokenTtlSeconds('100')).toBe(900);
    expect(tokenTtlSeconds('50000')).toBe(43_200);
    expect(tokenTtlSeconds('not-a-number')).toBe(1_200);
  });
});
