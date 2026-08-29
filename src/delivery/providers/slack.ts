import type { CredentialBroker } from '../../credentials/broker.js';
import type { JsonValue, RunRequest } from '../../domain/contracts.js';
import { KnownNotDeliveredError } from '../errors.js';
import { checkedJson, fetchWithTimeout, formatMessage } from '../http.js';
import type { DeliveryAdapter, DeliveryRequest } from '../types.js';

export interface SlackDeliveryOptions {
  botTokenSecretArn?: string | undefined;
  connectionPoster?: SlackConnectionPoster | undefined;
}

export interface SlackConnectionPoster {
  post(input: {
    ownerId: string;
    request: NonNullable<RunRequest['integrations']>;
    channel: string;
    text: string;
    threadTs?: string;
  }): Promise<JsonValue>;
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
    const text = formatMessage(input.body, input.run, 38_000);
    if (input.run.capabilityOwnerId && input.request.integrations && this.options.connectionPoster) {
      try {
        return slackReceipt(await this.options.connectionPoster.post({
          ownerId: input.run.capabilityOwnerId,
          request: input.request.integrations,
          channel,
          text,
          ...(source?.kind === 'slack' && source.threadTs ? { threadTs: source.threadTs } : {}),
        }));
      } catch (error) {
        throw new KnownNotDeliveredError(
          `Slack connection delivery failed: ${error instanceof Error ? error.message : String(error)}`,
          false,
        );
      }
    }
    const token = await this.credentials.read(this.options.botTokenSecretArn, ['token', 'bot_token']);
    const response = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        channel,
        text,
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
    return slackReceipt(value as JsonValue);
  }
}

function slackReceipt(value: JsonValue): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'accepted';
  return typeof value.ts === 'string' ? value.ts : 'accepted';
}
