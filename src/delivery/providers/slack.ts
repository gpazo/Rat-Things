import type { CredentialBroker } from '../../credentials/broker.js';
import { KnownNotDeliveredError } from '../errors.js';
import { checkedJson, fetchWithTimeout, formatMessage } from '../http.js';
import type { DeliveryAdapter, DeliveryRequest } from '../types.js';

export interface SlackDeliveryOptions {
  botTokenSecretArn?: string | undefined;
}

export class SlackDeliveryAdapter implements DeliveryAdapter {
  public readonly provider = 'slack' as const;

  public constructor(
    private readonly credentials: CredentialBroker,
    private readonly options: SlackDeliveryOptions,
  ) {}

  public async deliver(input: DeliveryRequest): Promise<string> {
    const source = input.request.source;
    const channel = input.context.destination.route ?? (source?.kind === 'slack' ? source.channelId : undefined);
    if (!channel) throw new Error('Slack destination lacks a channel');
    const token = await this.credentials.read(this.options.botTokenSecretArn, ['token', 'bot_token']);
    const response = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        channel,
        text: formatMessage(input.body, input.run, 38_000),
        ...(source?.kind === 'slack' && source.threadTs ? { thread_ts: source.threadTs } : {}),
      }),
    });
    const value = await checkedJson(response, 'Slack');
    if (value.ok !== true) {
      throw new KnownNotDeliveredError(
        `Slack rejected message: ${String(value.error ?? 'unknown')}`,
        false,
      );
    }
    return typeof value.ts === 'string' ? value.ts : 'accepted';
  }
}
