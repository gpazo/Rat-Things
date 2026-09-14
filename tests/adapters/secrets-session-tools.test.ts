import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';
import { SecretsSessionTools } from '../../src/adapters/secrets-session-tools.js';

const secret = { ownerId: 'alice', sessionId: 'sess_test', serverLabel: 'crm', headers: { Authorization: 'Bearer confidential' }, env: {} };
const awsError = (name: string) => Object.assign(new Error(name), { name });
function fixture() {
  const send = vi.fn();
  const adapter = new SecretsSessionTools({ send } as unknown as SecretsManagerClient, 'test/connections', 'kms-key');
  return { send, adapter, reference: adapter.reference(secret, 'attempt-1') };
}

describe('reserved Session credential references', () => {
  it('reserves unique identities without effects and creates at the persisted name', async () => {
    const f = fixture();
    expect(f.adapter.reference(secret, 'attempt-1')).toBe(f.reference);
    expect(f.adapter.reference(secret, 'attempt-2')).not.toBe(f.reference);
    expect(f.adapter.reference({ ...secret, ownerId: 'bob' }, 'attempt-1')).not.toBe(f.reference);
    expect(f.adapter.reference({ ...secret, serverLabel: 'other' }, 'attempt-1')).not.toBe(f.reference);
    expect(f.send).not.toHaveBeenCalled();
    f.send.mockResolvedValue({});
    await f.adapter.create(secret, f.reference);
    await f.adapter.create(secret, f.reference);
    expect(f.send.mock.calls[0]![0]).toBeInstanceOf(CreateSecretCommand);
    expect(f.send.mock.calls[0]![0].input).toEqual(f.send.mock.calls[1]![0].input);
    expect(f.send.mock.calls[0]![0].input).toMatchObject({ Name: f.reference, SecretString: JSON.stringify(secret), KmsKeyId: 'kms-key', ClientRequestToken: expect.any(String) });
  });

  it('retires a never-created name before deleting it and prevents a delayed creation', async () => {
    const f = fixture();
    let occupied = false;
    let deleted = false;
    f.send.mockImplementation(async (command) => {
      if (command instanceof CreateSecretCommand) {
        if (deleted) throw awsError('InvalidRequestException');
        if (occupied) throw awsError('ResourceExistsException');
        occupied = true;
        expect(command.input.SecretString).toBe('{}');
      } else if (command instanceof DeleteSecretCommand) deleted = true;
      else if (command instanceof DescribeSecretCommand) return { DeletedDate: deleted ? new Date() : undefined };
      return {};
    });
    await f.adapter.revoke(f.reference);
    await expect(f.adapter.create(secret, f.reference)).rejects.toMatchObject({ name: 'InvalidRequestException' });
    await f.adapter.revoke(f.reference);
    expect(f.send.mock.calls[1]![0].input).toMatchObject({ SecretId: f.reference, RecoveryWindowInDays: 7 });
  });

  it('can retire the known name after creation succeeded but its acknowledgement was lost', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('Creation timeout'))
      .mockRejectedValueOnce(awsError('ResourceExistsException'))
      .mockResolvedValueOnce({});
    await expect(f.adapter.create(secret, f.reference)).rejects.toThrow('Creation timeout');
    await f.adapter.revoke(f.reference);
    expect(f.send.mock.calls[2]![0]).toBeInstanceOf(DeleteSecretCommand);
    expect(f.send.mock.calls[2]![0].input.SecretId).toBe(f.reference);
    expect(f.send.mock.calls[1]![0].input.ClientRequestToken).not.toBe(f.send.mock.calls[0]![0].input.ClientRequestToken);
  });

  it('propagates uncertain retirement and deletion so durable work can retry', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('Reservation timeout'));
    await expect(f.adapter.revoke(f.reference)).rejects.toThrow('Reservation timeout');
    f.send.mockRejectedValueOnce(awsError('ResourceExistsException')).mockRejectedValueOnce(new Error('Deletion timeout'));
    await expect(f.adapter.revoke(f.reference)).rejects.toThrow('Deletion timeout');
    f.send.mockRejectedValueOnce(awsError('InvalidRequestException')).mockResolvedValueOnce({ DeletedDate: new Date() });
    await expect(f.adapter.revoke(f.reference)).resolves.toBeUndefined();
  });

  it('retries a reserved name when deletion cannot yet observe its reservation', async () => {
    const f = fixture();
    f.send.mockResolvedValueOnce({}).mockRejectedValueOnce(awsError('ResourceNotFoundException'));
    await expect(f.adapter.revoke(f.reference)).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
    f.send.mockRejectedValueOnce(awsError('InvalidRequestException')).mockRejectedValueOnce(awsError('ResourceNotFoundException'));
    await expect(f.adapter.revoke(f.reference)).rejects.toMatchObject({ name: 'InvalidRequestException' });
  });

  it('does not mistake an active secret’s invalid state for successful retirement', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(awsError('InvalidRequestException')).mockResolvedValueOnce({});
    await expect(f.adapter.revoke(f.reference)).rejects.toMatchObject({ name: 'InvalidRequestException' });
  });

  it.each(['ResourceNotFoundException', 'InvalidRequestException'])('keeps legacy ARN deletion idempotent after %s', async (name) => {
    const f = fixture();
    f.send.mockRejectedValueOnce(awsError(name)).mockResolvedValueOnce({ DeletedDate: new Date() });
    await f.adapter.revoke('arn:aws:secretsmanager:us-west-2:123:secret:legacy-abcdef');
    expect(f.send.mock.calls[0]![0]).toBeInstanceOf(DeleteSecretCommand);
    expect(f.send.mock.calls.every(([command]) => !(command instanceof CreateSecretCommand))).toBe(true);
  });
});
