import type { NormalizedWebhookRun } from '../../channels/normalize.js';
import type { RunSource } from '../../domain/contracts.js';
import { providerIngressContext } from '../../identity/context.js';
import type { IngressWork, WebhookResponse } from '../types.js';

export function normalizedWork(normalized: NormalizedWebhookRun, traceId: string): IngressWork {
  const source = normalized.request.source;
  if (!source || source.kind === 'api') throw new Error('provider ingress must supply trusted source context');
  const actor = providerActor(source);
  const thread = threadForSource(source);
  return {
    context: providerIngressContext({
      ownerId: normalized.ownerId,
      actorId: actor.id,
      actorKind: actor.kind,
      source,
    }),
    request: normalized.request,
    submit: {
      idempotencyKey: normalized.idempotencyKey,
      traceId,
      ...(thread ? { thread } : {}),
    },
  };
}

export function jsonResponse(statusCode: number, body: unknown): WebhookResponse {
  return { statusCode, body };
}

function providerActor(source: Exclude<RunSource, { kind: 'api' }>): {
  id: string;
  kind: 'human' | 'system';
} {
  switch (source.kind) {
    case 'github':
      return {
        id: `github:${source.installationId ?? source.repository}`,
        kind: 'system',
      };
    case 'gitlab':
      return { id: `gitlab:${source.projectId}`, kind: 'system' };
    case 'teams':
      return {
        id: `teams:${source.tenantId ?? 'unknown'}:${source.senderId ?? 'unknown'}`,
        kind: 'human',
      };
    case 'slack':
      return {
        id: `slack:${source.teamId ?? 'unknown'}:${source.userId ?? 'unknown'}`,
        kind: 'human',
      };
  }
}

function threadForSource(source: Exclude<RunSource, { kind: 'api' }>) {
  switch (source.kind) {
    case 'teams':
      return {
        conversationId: [
          'teams',
          source.tenantId ?? 'unknown',
          source.senderId ?? 'unknown',
          source.conversationId,
        ].join(':'),
        messageId: source.activityId,
      };
    case 'slack':
      return {
        conversationId: [
          'slack',
          source.teamId ?? 'unknown',
          source.userId ?? 'unknown',
          source.channelId,
          source.threadTs ?? source.eventId,
        ].join(':'),
        messageId: source.eventId,
      };
    case 'github':
    case 'gitlab':
      return undefined;
  }
}
