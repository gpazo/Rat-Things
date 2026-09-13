import { createHash, randomUUID } from 'node:crypto';
import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { AgentCredentialSecrets } from '../credentials/agents-vault.js';
import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import { parseAgentsContract } from '../domain/agents-api-validation.js';

export class SecretsAgentCredentials implements AgentCredentialSecrets {
  public constructor(private readonly client: SecretsManagerClient, private readonly prefix: string, private readonly kmsKeyId: string) {}

  public async create(ownerId: string, credentialId: string, auth: CredentialAuthCreateParam): Promise<string> {
    const owner = createHash('sha256').update(ownerId).digest('hex');
    const result = await this.client.send(new CreateSecretCommand({
      Name: `${this.prefix}/agents/${owner}/${credentialId}/${randomUUID()}`,
      SecretString: JSON.stringify(auth), KmsKeyId: this.kmsKeyId,
      Tags: [{ Key: 'rat-things:purpose', Value: 'integration-credential' }],
    }));
    if (!result.ARN) throw new Error('Secrets Manager returned no credential reference');
    return result.ARN;
  }

  public async read(reference: string): Promise<CredentialAuthCreateParam> {
    const result = await this.client.send(new GetSecretValueCommand({ SecretId: reference }));
    if (!result.SecretString) throw new Error('Credential secret is unavailable');
    return parseAgentsContract('CredentialCreate', { name: 'stored', auth: JSON.parse(result.SecretString) }).auth;
  }

  public async revoke(reference: string): Promise<void> {
    try {
      await this.client.send(new DeleteSecretCommand({ SecretId: reference, RecoveryWindowInDays: 7 }));
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') return;
      if (!(error instanceof Error) || error.name !== 'InvalidRequestException') throw error;
      const secret = await this.client.send(new DescribeSecretCommand({ SecretId: reference }));
      if (!secret.DeletedDate) throw error;
    }
  }
}
