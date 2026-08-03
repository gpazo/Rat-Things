import type { CredentialBroker } from '../../credentials/broker.js';
import { checkedResponse, fetchWithTimeout } from '../http.js';
import type { DeliveryAdapter, DeliveryRequest } from '../types.js';

export interface TeamsDeliveryOptions {
  workflowUrlSecretArn?: string | undefined;
  routes: Record<string, string>;
}

export class TeamsDeliveryAdapter implements DeliveryAdapter {
  public readonly provider = 'teams' as const;

  public constructor(
    private readonly credentials: CredentialBroker,
    private readonly options: TeamsDeliveryOptions,
  ) {}

  public async deliver(input: DeliveryRequest): Promise<string> {
    const route = input.context.destination.route;
    const routed = route ? this.options.routes[route] : undefined;
    if (route && !routed) throw new Error(`unknown Teams destination route ${route}`);
    const url = await this.credentials.read(
      routed ?? this.options.workflowUrlSecretArn,
      ['url', 'webhook_url'],
    );
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            contentUrl: null,
            content: {
              type: 'AdaptiveCard',
              version: '1.5',
              body: [
                { type: 'TextBlock', weight: 'Bolder', text: `Agent run ${input.run.status}`, wrap: true },
                { type: 'TextBlock', text: input.body.slice(0, 20_000), wrap: true },
                { type: 'FactSet', facts: [{ title: 'Run', value: input.run.runId }] },
              ],
            },
          },
        ],
      }),
    });
    await checkedResponse(response, 'Teams');
    return response.headers.get('request-id') ?? 'accepted';
  }
}
