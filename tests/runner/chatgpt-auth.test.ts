import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installCodexAuthFile,
  validateCodexAuthJson,
} from '../../src/runner/chatgpt-auth.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe('file-based Codex ChatGPT authentication', () => {
  it('materializes auth.json privately, persists token rotation, and removes the runtime copy', async () => {
    const codexHome = await temporaryCodexHome();
    configureCloudAuth(codexHome);
    const initial = authJson({ refresh_token: 'refresh-initial' });
    const read = vi.fn().mockResolvedValue(initial);
    const replace = vi.fn().mockResolvedValue(undefined);

    const session = await installCodexAuthFile({ read }, { replace });
    const authPath = join(codexHome, 'auth.json');

    expect(session).toBeDefined();
    expect(read).toHaveBeenCalledWith(process.env.CODEX_AUTH_FILE_SECRET_ARN, [
      'auth_json',
      'codex_auth_json',
      'auth',
    ]);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(authPath, 'utf8'))).toMatchObject({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'refresh-initial' },
    });

    const rotated = authJson({ refresh_token: 'refresh-rotated' });
    await writeFile(authPath, rotated, { mode: 0o600 });
    await session?.finalize();

    expect(replace).toHaveBeenCalledWith(process.env.CODEX_AUTH_FILE_SECRET_ARN, {
      auth_json: validateCodexAuthJson(rotated),
    });
    await expect(access(authPath)).rejects.toThrow();
  });

  it('removes an unchanged runtime copy without creating a new secret version', async () => {
    const codexHome = await temporaryCodexHome();
    configureCloudAuth(codexHome);
    const read = vi.fn().mockResolvedValue(authJson());
    const replace = vi.fn();

    const session = await installCodexAuthFile({ read }, { replace });
    await session?.finalize();
    await session?.finalize();

    expect(replace).not.toHaveBeenCalled();
    await expect(access(join(codexHome, 'auth.json'))).rejects.toThrow();
  });

  it('leaves device-local login untouched when no cloud secret is configured', async () => {
    const read = vi.fn();
    const replace = vi.fn();

    await expect(installCodexAuthFile({ read }, { replace })).resolves.toBeUndefined();

    expect(read).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('refuses to materialize a cloud credential outside a MicroVM', async () => {
    const codexHome = await temporaryCodexHome();
    vi.stubEnv('CODEX_AUTH_FILE_SECRET_ARN', secretArn());
    vi.stubEnv('CODEX_HOME', codexHome);

    await expect(installCodexAuthFile(
      { read: vi.fn().mockResolvedValue(authJson()) },
      { replace: vi.fn() },
    )).rejects.toThrow('requires a MicroVM runtime');
  });

  it('accepts only bounded ChatGPT auth files without embedded API keys', () => {
    expect(JSON.parse(validateCodexAuthJson(authJson()))).toMatchObject({ auth_mode: 'chatgpt' });
    expect(() => validateCodexAuthJson('{')).toThrow('not valid JSON');
    expect(() => validateCodexAuthJson(JSON.stringify({
      ...authValue(),
      auth_mode: 'apikey',
    }))).toThrow('must use ChatGPT authentication');
    expect(() => validateCodexAuthJson(JSON.stringify({
      ...authValue(),
      OPENAI_API_KEY: 'sk-do-not-copy',
    }))).toThrow('must not contain an OpenAI API key');
    expect(() => validateCodexAuthJson(JSON.stringify({
      ...authValue(),
      tokens: { ...authValue().tokens, refresh_token: '' },
    }))).toThrow('must contain bounded');
  });
});

async function temporaryCodexHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'rat-things-codex-auth-'));
  temporaryDirectories.push(path);
  return path;
}

function configureCloudAuth(codexHome: string): void {
  vi.stubEnv('CODEX_AUTH_FILE_SECRET_ARN', secretArn());
  vi.stubEnv('MICROVM_ID', 'microvm-test');
  vi.stubEnv('CODEX_HOME', codexHome);
}

function secretArn(): string {
  return 'arn:aws:secretsmanager:us-west-2:123456789012:secret:rat/codex-auth';
}

function authJson(tokenOverrides: Record<string, string> = {}): string {
  const value = authValue();
  return JSON.stringify({
    ...value,
    tokens: { ...value.tokens, ...tokenOverrides },
  });
}

function authValue(): {
  OPENAI_API_KEY: null;
  auth_mode: 'chatgpt';
  last_refresh: string;
  tokens: Record<string, string>;
} {
  return {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    last_refresh: '2026-09-01T00:00:00.000Z',
    tokens: {
      access_token: 'access-token',
      account_id: 'account-id',
      id_token: 'identity-token',
      refresh_token: 'refresh-token',
    },
  };
}
