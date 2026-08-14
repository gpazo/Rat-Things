export type CodexAuthMode = 'bedrock' | 'chatgpt';

/**
 * Authentication is a runtime policy, not a caller-controlled run option.
 * AWS workers default to short-lived Bedrock credentials. Trusted local runs
 * can opt into the ChatGPT session already cached by the Codex CLI.
 */
export function codexAuthMode(environment: NodeJS.ProcessEnv = process.env): CodexAuthMode {
  const value = environment.CODEX_AUTH_MODE ?? 'bedrock';
  if (value !== 'bedrock' && value !== 'chatgpt') {
    throw new Error('CODEX_AUTH_MODE must be bedrock or chatgpt');
  }
  return value;
}

/**
 * Interactive local runs favor the user's cached ChatGPT subscription. An
 * explicit CLI choice or deployment environment still wins over that default.
 */
export function localCodexAuthMode(
  requested: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): CodexAuthMode {
  if (requested) return codexAuthMode({ CODEX_AUTH_MODE: requested });
  if (environment.CODEX_AUTH_MODE) return codexAuthMode(environment);
  return 'chatgpt';
}

export function codexModelProvider(mode: CodexAuthMode = codexAuthMode()): 'amazon-bedrock' | 'openai' {
  return mode === 'bedrock' ? 'amazon-bedrock' : 'openai';
}
