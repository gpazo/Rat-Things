import type { CredentialBroker } from '../../credentials/broker.js';
import { checkedJson, fetchWithTimeout, formatMessage, validatedBaseUrl } from '../http.js';
import type { DeliveryAdapter, DeliveryRequest } from '../types.js';

export interface GitHubDeliveryOptions {
  tokenSecretArn?: string | undefined;
  apiBaseUrl: string;
}

export class GitHubDeliveryAdapter implements DeliveryAdapter {
  public readonly provider = 'github' as const;

  public constructor(
    private readonly credentials: CredentialBroker,
    private readonly options: GitHubDeliveryOptions,
  ) {}

  public async deliver(input: DeliveryRequest): Promise<string> {
    const source = input.request.source;
    if (source?.kind !== 'github' || !source.issueNumber) {
      throw new Error('GitHub destination lacks issue number');
    }
    const token = await this.credentials.read(this.options.tokenSecretArn, ['token', 'access_token']);
    const base = validatedBaseUrl(this.options.apiBaseUrl);
    const response = await fetchWithTimeout(
      `${base}/repos/${source.repository}/issues/${source.issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'indubitably-agent-runtime',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({ body: formatMessage(input.body, input.run, 60_000, true) }),
      },
    );
    const value = await checkedJson(response, 'GitHub');
    return typeof value.id === 'number' ? String(value.id) : 'accepted';
  }
}
