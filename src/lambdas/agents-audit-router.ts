import type { ConfigurationHistory } from '../core/configuration-history.js';
import type { ToolAuthorizationService } from '../core/tool-authorization-service.js';
import { projectToolAuthorizationTrace } from '../core/tool-authorization-traces.js';
import type { ConfigurationSubject } from '../domain/configuration-history.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export interface AgentsAuditServices {
  history?: Pick<ConfigurationHistory, 'list' | 'retrieve'>;
  authorizations?: Pick<ToolAuthorizationService, 'list' | 'retrieve'>;
}

/** Permission checks use the same decoded path before this dispatcher runs. */
export async function routeAgentsAudit(request: Request, ownerId: string, parts: string[], services: AgentsAuditServices): Promise<unknown | undefined> {
  const route = historyRoute(parts);
  const authorization = parts[1] === 'agents' && parts[2] === 'sessions' && parts[3]
    && parts[4] === 'authorizations' && (parts.length === 5 || parts.length === 6);
  if (!route && !authorization) return undefined;
  if (request.method !== 'GET') throw new AgentsApiError(405, 'Audit records are read-only.', 'method_not_allowed');
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (params.getAll(key).length > 1) throw new AgentsApiError(400, 'Query parameters must not be repeated.', 'invalid_request', key);
  const limit = params.get('limit');
  if (limit !== null && !/^\d+$/.test(limit)) throw new AgentsApiError(400, 'limit must be a positive integer.', 'invalid_request', 'limit');
  const query = Object.fromEntries([...params].map(([key, value]) => [key, key === 'limit' ? Number(value) : value]));
  if (route) {
    if (!services.history) throw new AgentsApiError(503, 'Configuration history is unavailable.', 'service_unavailable');
    return route.revision ? services.history.retrieve(ownerId, route.subject, route.revision)
      : services.history.list(ownerId, route.subject, query);
  }
  if (!services.authorizations) throw new AgentsApiError(503, 'Tool authorization history is unavailable.', 'service_unavailable');
  const sessionId = parts[3]!;
  if (parts[5] && parts[5] !== 'otlp') return services.authorizations.retrieve(ownerId, sessionId, parts[5]);
  const page = await services.authorizations.list(ownerId, sessionId, query);
  return parts[5] === 'otlp' ? { ...page, data: page.data.map(receipt => projectToolAuthorizationTrace(ownerId, receipt)) } : page;
}

function historyRoute(parts: string[]): { subject: ConfigurationSubject; revision?: string } | undefined {
  if (parts[1] === 'agents' && parts[2] === 'sessions' && parts[3] && parts[4] === 'configurations' && (parts.length === 5 || parts.length === 6)) {
    return { subject: { kind: 'session', id: parts[3] }, ...(parts[5] ? { revision: parts[5] } : {}) };
  }
  if ((parts[1] === 'agents' || parts[1] === 'vaults') && parts[2] && parts[3] === 'revisions' && (parts.length === 4 || parts.length === 5)) {
    return { subject: { kind: parts[1] === 'agents' ? 'agent' : 'vault', id: parts[2] }, ...(parts[4] ? { revision: parts[4] } : {}) };
  }
  if (parts[1] === 'vaults' && parts[2] && parts[3] === 'credentials' && parts[4] && parts[5] === 'revisions' && (parts.length === 6 || parts.length === 7)) {
    return { subject: { kind: 'credential', vaultId: parts[2], id: parts[4] }, ...(parts[6] ? { revision: parts[6] } : {}) };
  }
  return undefined;
}
