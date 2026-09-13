import type { NormalizedWebhookInput } from '../../channels/normalize.js';
import type { RunSource } from '../../domain/contracts.js';
import { providerIngressContext } from '../../identity/context.js';
import type { IngressWork, WebhookResponse } from '../types.js';

export function normalizedWork(normalized: NormalizedWebhookInput, traceId: string): IngressWork {
  const source = normalized.request.source;
  if (!source || source.kind === 'api') throw new Error('provider ingress must supply trusted source context');
  const actor = providerActor(source);
  const context = providerIngressContext({ ownerId: normalized.ownerId, actorId: actor.id, actorKind: actor.kind, source });
  return {
    context,
    input: { id: normalized.idempotencyKey, text: normalized.request.prompt, source, actor: context.actor, credentialSubject: context.credentialSubject,
      ...(normalized.request.repository ? { repository: normalized.request.repository } : {}),
    },
    threadId: threadForSource(source) ?? traceId,
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
      return JSON.stringify([
          'teams',
          source.tenantId ?? 'unknown',
          source.senderId ?? 'unknown',
          source.conversationId,
        ]);
    case 'slack':
      return JSON.stringify([
          'slack',
          source.teamId ?? 'unknown',
          source.userId ?? 'unknown',
          source.channelId,
          source.threadTs ?? source.eventId,
        ]);
    case 'github':
    case 'gitlab':
      return undefined;
  }
}
