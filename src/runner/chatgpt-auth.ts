import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialVault } from '../credentials/types.js';

interface SecretCredentialReader {
  read(secretArn: string | undefined, preferredKeys: string[]): Promise<string>;
}

export interface CodexAuthFileSession {
  /** Persist a refreshed credential bundle, then remove the runtime copy. */
  finalize(): Promise<void>;
}

/**
 * Materializes the user's file-based ChatGPT login for one isolated cloud run.
 * The secret ARN may cross orchestration boundaries; auth.json may exist only
 * inside Secrets Manager and the active MicroVM's Codex home. When that home
 * is S3 Files-backed, the active runtime copy can transit its encrypted store.
 */
export async function installCodexAuthFile(
  credentials: SecretCredentialReader,
  vault: Pick<CredentialVault, 'replace'>,
): Promise<CodexAuthFileSession | undefined> {
  const secretArn = process.env.CODEX_AUTH_FILE_SECRET_ARN;
  if (!secretArn) return undefined;
  if (!process.env.MICROVM_ID) {
    throw new Error('file-based Codex cloud authentication requires a MicroVM runtime');
  }
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) throw new Error('CODEX_HOME is required for file-based Codex authentication');

  const initial = validateCodexAuthJson(
    await credentials.read(secretArn, ['auth_json', 'codex_auth_json', 'auth']),
  );
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await chmod(codexHome, 0o700);
  const authPath = join(codexHome, 'auth.json');
  await writePrivateFile(authPath, initial);

  let finalized = false;
  return {
    async finalize(): Promise<void> {
      if (finalized) return;
      finalized = true;
      try {
        const current = validateCodexAuthJson(await readFile(authPath, 'utf8'));
        if (current !== initial) await vault.replace(secretArn, { auth_json: current });
      } finally {
        await rm(authPath, { force: true });
      }
    },
  };
}

export function validateCodexAuthJson(raw: string): string {
  if (!raw || Buffer.byteLength(raw) > 32 * 1024) {
    throw new Error('Codex auth.json must contain 1-32768 bytes');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Codex auth.json is not valid JSON');
  }
  if (!isRecord(value) || value.auth_mode !== 'chatgpt') {
    throw new Error('Codex auth.json must use ChatGPT authentication');
  }
  if (value.OPENAI_API_KEY !== null && value.OPENAI_API_KEY !== undefined) {
    throw new Error('Codex auth.json must not contain an OpenAI API key');
  }
  const tokens = value.tokens;
  if (
    !isRecord(tokens) ||
    !boundedString(tokens.access_token, 16_384) ||
    !boundedString(tokens.refresh_token, 16_384) ||
    !boundedString(tokens.id_token, 16_384) ||
    !boundedString(tokens.account_id, 1_024)
  ) {
    throw new Error(
      'Codex auth.json must contain bounded access_token, refresh_token, id_token, and account_id values',
    );
  }
  const normalized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(normalized) > 32 * 1024) {
    throw new Error('normalized Codex auth.json exceeds 32768 bytes');
  }
  return normalized;
}

async function writePrivateFile(path: string, value: string): Promise<void> {
  const temporary = `${path}.rat-things-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximumBytes;
}
