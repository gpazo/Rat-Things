import { createHash, randomUUID } from 'node:crypto';
import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SessionToolSecret, SessionToolSecrets } from '../credentials/session-tools.js';

export class SecretsSessionTools implements SessionToolSecrets {
  public constructor(private readonly client: SecretsManagerClient, private readonly prefix: string, private readonly kmsKeyId: string) {}
  public async create(value: SessionToolSecret): Promise<string> {
    const owner = createHash('sha256').update(value.ownerId).digest('hex');
    const result = await this.client.send(new CreateSecretCommand({
      Name: `${this.prefix}/agents/${owner}/sessions/${value.sessionId}/${randomUUID()}`,
      KmsKeyId: this.kmsKeyId, SecretString: JSON.stringify(value),
      Tags: [{ Key: 'rat-things:purpose', Value: 'integration-credential' }],
    }));
    if (!result.ARN) throw new Error('Session tool credentials were not created');
    return result.ARN;
  }
  public async revoke(reference: string): Promise<void> {
    try { await this.client.send(new DeleteSecretCommand({ SecretId: reference, RecoveryWindowInDays: 7 })); }
    catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') return;
      if (!(error instanceof Error) || error.name !== 'InvalidRequestException') throw error;
      if (!(await this.client.send(new DescribeSecretCommand({ SecretId: reference }))).DeletedDate) throw error;
    }
  }
}
