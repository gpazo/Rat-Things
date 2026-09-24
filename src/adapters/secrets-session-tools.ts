import { createHash } from 'node:crypto';
import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SessionCredentialIdentity, SessionCredentialSecret, SessionToolSecrets } from '../credentials/session-tools.js';

export class SecretsSessionTools implements SessionToolSecrets {
  public constructor(private readonly client: SecretsManagerClient, private readonly prefix: string, private readonly kmsKeyId: string) {}
  public reference(identity: SessionCredentialIdentity, attemptId: string): string {
    const scope = 'serverLabel' in identity ? identity.serverLabel : { environmentId: identity.environmentId };
    return `${this.prefix}/agents/${hash(identity.ownerId)}/sessions/${identity.sessionId}/${hash(JSON.stringify([attemptId, scope]))}`;
  }
  public async create(value: SessionCredentialSecret, reference: string): Promise<void> {
    await this.client.send(new CreateSecretCommand({
      Name: reference, ClientRequestToken: hash(`create:${reference}`),
      KmsKeyId: this.kmsKeyId, SecretString: JSON.stringify(value),
      Tags: [{ Key: 'rat-things:purpose', Value: 'integration-credential' }],
    }));
  }
  public async revoke(reference: string): Promise<void> {
    // Occupy an uncertain reserved name before deleting it. A delayed create
    // cannot resurrect it during Secrets Manager's seven-day recovery window.
    // Legacy bindings contain ARNs and never need this reservation.
    if (!reference.startsWith('arn:')) {
      try {
        await this.client.send(new CreateSecretCommand({ Name: reference,
          ClientRequestToken: hash(`retire:${reference}`), SecretString: '{}', KmsKeyId: this.kmsKeyId,
          Tags: [{ Key: 'rat-things:purpose', Value: 'integration-credential' }],
        }));
      } catch (error) {
        if (named(error, 'InvalidRequestException') && await this.deleted(reference)) return;
        if (!named(error, 'ResourceExistsException')) throw error;
      }
    }
    try { await this.client.send(new DeleteSecretCommand({ SecretId: reference, RecoveryWindowInDays: 7 })); }
    catch (error) {
      if (named(error, 'ResourceNotFoundException') && reference.startsWith('arn:')) return;
      if (!(error instanceof Error) || error.name !== 'InvalidRequestException') throw error;
      if (!await this.deleted(reference)) throw error;
    }
  }
  private async deleted(reference: string): Promise<boolean> {
    try { return Boolean((await this.client.send(new DescribeSecretCommand({ SecretId: reference }))).DeletedDate); }
    catch (error) { if (named(error, 'ResourceNotFoundException')) return reference.startsWith('arn:'); throw error; }
  }
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function named(error: unknown, name: string): boolean { return error instanceof Error && error.name === name; }
