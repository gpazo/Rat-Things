import type { EnvironmentFileOperation, EnvironmentFileOperations } from '../core/environment-file-ports.js';
import type { EnvironmentCredentialStore } from '../credentials/environment.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export class RelayEnvironmentFiles implements EnvironmentFileOperations {
  public constructor(private readonly credentials: Pick<EnvironmentCredentialStore, 'read'>, private readonly relayURL: string, private readonly transport: typeof fetch = fetch) {
    if (new URL(relayURL).protocol !== 'https:') throw new Error('The environment relay must use HTTPS');
  }
  public async execute(environmentId: string, credentialReference: string, operation: EnvironmentFileOperation): Promise<unknown> {
    const { harness } = await this.credentials.read(credentialReference);
    const response = await this.transport(new URL(`/cloud/environment/${encodeURIComponent(environmentId)}/files`, this.relayURL), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${harness}` },
      body: JSON.stringify(operation), redirect: 'error', signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new AgentsApiError(response.status >= 500 ? 503 : response.status, 'Environment file operation is unavailable.', 'environment_unavailable');
    return response.json() as Promise<unknown>;
  }
}
