import { createHash, randomBytes } from 'node:crypto';
import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { environmentToken, parseEnvironmentCredentials, type EnvironmentCredentials, type EnvironmentCredentialStore } from '../credentials/environment.js';

export class SecretsEnvironmentCredentials implements EnvironmentCredentialStore {
  public constructor(private readonly client: SecretsManagerClient, private readonly prefix: string, private readonly kmsKeyId: string) {}

  public async create(ownerId: string, environmentId: string): Promise<string> {
    const value: EnvironmentCredentials = {
      executor: environmentToken({ ownerId, environmentId, role: 'executor' }, randomBytes(32).toString('base64url')),
      harness: environmentToken({ ownerId, environmentId, role: 'harness' }, randomBytes(32).toString('base64url')),
    };
    const name = `${this.prefix}/agents/environments/${createHash('sha256').update(ownerId).digest('hex')}/${environmentId}`;
    let result;
    try { result = await this.client.send(new CreateSecretCommand({
      Name: name,
      KmsKeyId: this.kmsKeyId, SecretString: JSON.stringify(value),
      Tags: [{ Key: 'rat-things-resource', Value: 'environment-connection' }],
    })); } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ResourceExistsException') throw error;
      result = await this.client.send(new DescribeSecretCommand({ SecretId: name }));
      if (result.DeletedDate) throw new Error('Environment credentials have been retired');
    }
    if (!result.ARN) throw new Error('Environment credentials were not created');
    return result.ARN;
  }

  public async read(reference: string): Promise<EnvironmentCredentials> {
    const result = await this.client.send(new GetSecretValueCommand({ SecretId: reference }));
    return parseEnvironmentCredentials(result.SecretString ?? 'null');
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
