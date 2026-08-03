import type { SecretReader } from './types.js';

export class CredentialBroker {
  public constructor(private readonly secrets: SecretReader) {}

  public async read(reference: string | undefined, fields: string[]): Promise<string> {
    if (!reference) throw new Error('credential reference is not configured');
    const raw = await this.secrets.get(reference);
    return credentialField(raw, fields);
  }
}

export function credentialField(raw: string, fields: string[]): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const field of fields) {
        const value = (parsed as Record<string, unknown>)[field];
        if (typeof value === 'string' && value) return value;
      }
    }
  } catch {
    // Raw secret strings are valid host-owned credential values.
  }
  return raw;
}
