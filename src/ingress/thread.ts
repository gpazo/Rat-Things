import type { RunSource } from '../domain/contracts.js';

export function threadForSource(source: RunSource, scope: 'sender' | 'thread' = 'sender'): string | undefined {
  switch (source.kind) {
    case 'github': return source.issueNumber === undefined ? undefined : JSON.stringify(['github', source.repository, source.issueNumber]);
    case 'gitlab': return source.mergeRequestIid === undefined ? undefined : JSON.stringify(['gitlab', source.projectId, source.mergeRequestIid]);
    case 'teams': return JSON.stringify(['teams', source.tenantId ?? 'unknown', ...(scope === 'sender' ? [source.senderId ?? 'unknown'] : []), source.conversationId]);
    case 'slack': return JSON.stringify(['slack', source.teamId ?? 'unknown', ...(scope === 'sender' ? [source.userId ?? 'unknown'] : []), source.channelId, source.threadTs ?? source.eventId]);
    case 'api': return undefined;
  }
}
