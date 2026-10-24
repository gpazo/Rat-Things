import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each(['0', '1'])('refuses live acceptance without opt-in and a Rat Things ChatGPT account (opt-in %s)', optIn => {
  const root = mkdtempSync(join(tmpdir(), 'rat-subscription-guard-'));
  const directory = join(root, 'workspace');
  try {
    const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'testing/local-runtime/subscription.ts', '--directory', directory], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, RAT_LIVE_SUBSCRIPTION: optIn,
        CODEX_BINARY: resolve('node_modules/.bin/codex'), OPENAI_API_KEY: 'billing-sentinel', CODEX_API_KEY: 'codex-sentinel' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(optIn === '0' ? 'Set RAT_LIVE_SUBSCRIPTION=1' : 'ChatGPT sign-in required');
    expect(result.stdout).not.toContain('passed');
    expect(existsSync(join(directory, 'native-proof'))).toBe(false);
    if (optIn === '0') expect(existsSync(directory)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
