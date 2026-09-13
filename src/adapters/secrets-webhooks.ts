import { createHash, randomUUID } from 'node:crypto';
import { CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, DescribeSecretCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { WebhookSecrets } from '../credentials/webhooks.js';

export class SecretsWebhooks implements WebhookSecrets {
  public constructor(private readonly client: SecretsManagerClient, private readonly prefix: string, private readonly kmsKeyId: string) {}
  public async create(ownerId: string, endpointId: string, secret: string): Promise<string> {
    const owner = createHash('sha256').update(ownerId).digest('hex');
    const result = await this.client.send(new CreateSecretCommand({
      Name: `${this.prefix}/agents/${owner}/webhooks/${endpointId}/${randomUUID()}`,
      SecretString: secret, KmsKeyId: this.kmsKeyId,
      Tags: [{ Key: 'rat-things:purpose', Value: 'integration-credential' }],
    }));
    if (!result.ARN) throw new Error('Webhook secret could not be created');
    return result.ARN;
  }
  public async read(reference: string): Promise<string> {
    const result = await this.client.send(new GetSecretValueCommand({ SecretId: reference }));
    if (!result.SecretString) throw new Error('Webhook signing secret is unavailable');
    return result.SecretString;
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
