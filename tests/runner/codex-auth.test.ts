import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexAuthMode, codexModelProvider } from '../../src/runner/codex-auth.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Codex authentication policy', () => {
  it('defaults to Bedrock for unattended workers', () => {
    expect(codexAuthMode({})).toBe('bedrock');
    expect(codexModelProvider('bedrock')).toBe('amazon-bedrock');
  });

  it('selects the built-in OpenAI provider for a signed-in local device', () => {
    vi.stubEnv('CODEX_AUTH_MODE', 'chatgpt');
    expect(codexAuthMode()).toBe('chatgpt');
    expect(codexModelProvider()).toBe('openai');
  });

  it('rejects unsupported authentication modes', () => {
    expect(() => codexAuthMode({ CODEX_AUTH_MODE: 'auto' })).toThrow(
      'CODEX_AUTH_MODE must be bedrock or chatgpt',
    );
  });
});
