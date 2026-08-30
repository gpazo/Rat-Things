import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  InvalidRequestException,
  PutSecretValueCommand,
  ResourceNotFoundException,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type {
  CredentialVault,
  IntegrationCredentialValue,
} from '../credentials/types.js';

export class SecretsManagerCredentialVault implements CredentialVault {
  public constructor(
    private readonly client: SecretsManagerClient,
    private readonly kmsKeyId?: string,
  ) {}

  public async create(name: string, value: IntegrationCredentialValue): Promise<string> {
    const result = await this.client.send(new CreateSecretCommand({
      Name: name,
      SecretString: encodedCredential(value),
      ...(this.kmsKeyId ? { KmsKeyId: this.kmsKeyId } : {}),
      Tags: [{ Key: 'rat-things:purpose', Value: 'integration-credential' }],
    }));
    if (!result.ARN) throw new Error('Secrets Manager returned no credential ARN');
    return result.ARN;
  }

  public async replace(reference: string, value: IntegrationCredentialValue): Promise<void> {
    await this.client.send(new PutSecretValueCommand({
      SecretId: reference,
      SecretString: encodedCredential(value),
    }));
  }

  public async revoke(reference: string): Promise<void> {
    try {
      await this.client.send(new DeleteSecretCommand({
        SecretId: reference,
        RecoveryWindowInDays: 7,
      }));
    } catch (error) {
      if (isResourceNotFound(error)) return;
      if (!(error instanceof InvalidRequestException) && !awsErrorNamed(error, 'InvalidRequestException')) {
        throw error;
      }
      let description;
      try {
        description = await this.client.send(new DescribeSecretCommand({ SecretId: reference }));
      } catch (describeError) {
        if (isResourceNotFound(describeError)) return;
        throw describeError;
      }
      if (description.DeletedDate) return;
      throw error;
    }
  }
}

function isResourceNotFound(error: unknown): boolean {
  return error instanceof ResourceNotFoundException || awsErrorNamed(error, 'ResourceNotFoundException');
}

function awsErrorNamed(error: unknown, name: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { name?: unknown; Code?: unknown };
  return value.name === name || value.Code === name;
}

function encodedCredential(value: IntegrationCredentialValue): string {
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 64) throw new Error('credential must contain 1-64 fields');
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`credential field ${key} is invalid`);
    if (typeof item !== 'string' || !item || Buffer.byteLength(item) > 32_768) {
      throw new Error(`credential field ${key} must be a bounded non-empty string`);
    }
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error('credential exceeds 65536 bytes');
  return encoded;
}
