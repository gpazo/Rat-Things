import type { CredentialBroker } from '../../credentials/broker.js';
import { checkedJson, fetchWithTimeout, formatMessage, validatedBaseUrl } from '../http.js';
import type { DeliveryAdapter, DeliveryRequest } from '../types.js';

export interface GitLabDeliveryOptions {
  tokenSecretArn?: string | undefined;
  apiBaseUrl: string;
}

export class GitLabDeliveryAdapter implements DeliveryAdapter {
  public readonly provider = 'gitlab' as const;

  public constructor(
    private readonly credentials: CredentialBroker,
    private readonly options: GitLabDeliveryOptions,
  ) {}

  public async deliver(input: DeliveryRequest): Promise<string> {
    const source = input.request.source;
    if (source?.kind !== 'gitlab' || !source.mergeRequestIid) {
      throw new Error('GitLab destination lacks merge request IID');
    }
    const token = await this.credentials.read(this.options.tokenSecretArn, ['token', 'access_token']);
    const base = validatedBaseUrl(this.options.apiBaseUrl);
    const response = await fetchWithTimeout(
      `${base}/projects/${encodeURIComponent(source.projectId)}/merge_requests/${source.mergeRequestIid}/notes`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'private-token': token },
        body: JSON.stringify({ body: formatMessage(input.body, input.run, 60_000, true) }),
      },
    );
    const value = await checkedJson(response, 'GitLab');
    return typeof value.id === 'number' ? String(value.id) : 'accepted';
  }
}
