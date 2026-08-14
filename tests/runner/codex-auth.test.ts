import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexAuthMode, codexModelProvider, localCodexAuthMode } from '../../src/runner/codex-auth.js';

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

  it('defaults interactive local Codex runs to ChatGPT auth', () => {
    expect(localCodexAuthMode(undefined, {})).toBe('chatgpt');
    expect(localCodexAuthMode(undefined, { CODEX_AUTH_MODE: 'bedrock' })).toBe('bedrock');
    expect(localCodexAuthMode('chatgpt', { CODEX_AUTH_MODE: 'bedrock' })).toBe('chatgpt');
  });

  it('rejects unsupported authentication modes', () => {
    expect(() => codexAuthMode({ CODEX_AUTH_MODE: 'auto' })).toThrow(
      'CODEX_AUTH_MODE must be bedrock or chatgpt',
    );
  });
});
