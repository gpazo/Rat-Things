import type { CredentialBroker } from '../../credentials/broker.js';
import { KnownNotDeliveredError, requiredDeliveryCredential } from '../errors.js';
import { checkedResponse, fetchWithTimeout, formatMessage } from '../http.js';
import type { DeliveryAdapter, DeliveryRequest } from '../types.js';

export type TeamsDeliveryMode = 'workflow' | 'threaded-gateway';

export interface TeamsDeliveryOptions {
  mode: TeamsDeliveryMode;
  workflowUrlSecretArn?: string | undefined;
  replyGatewayUrlSecretArn?: string | undefined;
  routes: Record<string, string>;
}

export class TeamsDeliveryAdapter implements DeliveryAdapter {
  public readonly provider = 'teams' as const;

  public constructor(
    private readonly credentials: CredentialBroker,
    private readonly options: TeamsDeliveryOptions,
  ) {}

  public async deliver(input: DeliveryRequest): Promise<string> {
    if (this.options.mode === 'threaded-gateway') return this.deliverThreadedReply(input);

    const route = input.context.destination.route;
    const routed = route ? this.options.routes[route] : undefined;
    if (route && !routed) throw new KnownNotDeliveredError(`unknown Teams destination route ${route}`, false);
    const url = await this.credentials.read(
      requiredDeliveryCredential(routed ?? this.options.workflowUrlSecretArn, 'TEAMS_WORKFLOW_URL_SECRET_ARN'),
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

  private async deliverThreadedReply(input: DeliveryRequest): Promise<string> {
    const source = input.context.source;
    if (source?.kind !== 'teams') {
      throw new KnownNotDeliveredError('Teams threaded delivery requires a Teams source conversation', false);
    }
    if (input.context.destination.route) {
      throw new KnownNotDeliveredError('Teams threaded delivery does not accept named Workflow routes', false);
    }
    const url = await this.credentials.read(
      requiredDeliveryCredential(this.options.replyGatewayUrlSecretArn, 'TEAMS_REPLY_GATEWAY_URL_SECRET_ARN'),
      ['url', 'webhook_url'],
    );
    const text = formatMessage(input.body, input.run, 20_000);
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': input.run.runId,
      },
      body: JSON.stringify({
        version: '1',
        operation: 'reply-to-activity',
        conversationId: source.conversationId,
        replyToActivityId: source.activityId,
        activity: {
          type: 'message',
          text,
          conversation: { id: source.conversationId },
          replyToId: source.activityId,
        },
        source: {
          tenantId: source.tenantId,
          teamId: source.teamId,
          channelId: source.channelId,
          senderId: source.senderId,
        },
        run: {
          id: input.run.runId,
          status: input.run.status,
        },
      }),
    });
    await checkedResponse(response, 'Teams reply gateway');
    return response.headers.get('request-id') ?? 'accepted';
  }
}
