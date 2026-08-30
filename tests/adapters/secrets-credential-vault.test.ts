import {
  DeleteSecretCommand,
  DescribeSecretCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';
import { SecretsManagerCredentialVault } from '../../src/adapters/secrets-credential-vault.js';

describe('Secrets Manager credential cleanup', () => {
  it('treats a missing secret as already revoked', async () => {
    const send = vi.fn().mockRejectedValue(
      Object.assign(new Error('secret is absent'), { name: 'ResourceNotFoundException' }),
    );
    const vault = new SecretsManagerCredentialVault(
      { send } as unknown as SecretsManagerClient,
    );

    await expect(vault.revoke('secret-ref')).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteSecretCommand);
  });

  it('confirms an ambiguous delete that already scheduled recovery', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(
        new Error('secret is scheduled for deletion'),
        { name: 'InvalidRequestException' },
      ))
      .mockResolvedValueOnce({ DeletedDate: new Date('2026-09-06T00:00:00.000Z') });
    const vault = new SecretsManagerCredentialVault(
      { send } as unknown as SecretsManagerClient,
    );

    await expect(vault.revoke('secret-ref')).resolves.toBeUndefined();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteSecretCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DescribeSecretCommand);
  });

  it('preserves an invalid-state error when the secret remains active', async () => {
    const deleteError = Object.assign(
      new Error('secret cannot be deleted in its current state'),
      { name: 'InvalidRequestException' },
    );
    const send = vi.fn()
      .mockRejectedValueOnce(deleteError)
      .mockResolvedValueOnce({});
    const vault = new SecretsManagerCredentialVault(
      { send } as unknown as SecretsManagerClient,
    );

    await expect(vault.revoke('secret-ref')).rejects.toBe(deleteError);
  });
});
