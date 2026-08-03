import { describe, expect, it, vi } from 'vitest';
import { CredentialBroker, credentialField } from '../../src/credentials/broker.js';

describe('credential broker', () => {
  it('keeps secret parsing inside the host-owned broker', async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify({ access_token: 'scoped-token' }));
    const broker = new CredentialBroker({ get });

    await expect(broker.read('secret-ref', ['token', 'access_token'])).resolves.toBe('scoped-token');
    expect(get).toHaveBeenCalledWith('secret-ref');
  });

  it('supports raw secret values and rejects missing references', async () => {
    expect(credentialField('raw-token', ['token'])).toBe('raw-token');
    await expect(new CredentialBroker({ get: vi.fn() }).read(undefined, ['token']))
      .rejects.toThrow('credential reference is not configured');
  });
});
