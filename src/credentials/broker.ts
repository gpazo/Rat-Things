import type { IntegrationCredentialValue, SecretReader } from './types.js';

export class CredentialBroker {
  public constructor(private readonly secrets: SecretReader) {}

  public async read(reference: string | undefined, fields: string[]): Promise<string> {
    if (!reference) throw new Error('credential reference is not configured');
    const raw = await this.secrets.get(reference);
    return credentialField(raw, fields);
  }

  public async readRecord(reference: string | undefined): Promise<IntegrationCredentialValue> {
    if (!reference) throw new Error('credential reference is not configured');
    const raw = await this.secrets.get(reference);
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { value: raw };
      }
      const result: IntegrationCredentialValue = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || typeof value !== 'string') continue;
        if (value) result[key] = value;
      }
      if (Object.keys(result).length === 0) throw new Error('credential contains no string fields');
      return result;
    } catch (error) {
      if (error instanceof SyntaxError) return { value: raw };
      throw error;
    }
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
