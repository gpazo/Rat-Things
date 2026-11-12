import { AgentsApiError, invalid } from './agents-api-validation.js';

export const API_SCOPES = [
  'api.agents.read', 'api.agents.write', 'api.responses.write',
  'api.vaults.read', 'api.vaults.write', 'api.traces.read',
] as const;
export type ApiScope = typeof API_SCOPES[number];
export interface ApiActor {
  readonly id: string;
  readonly kind: 'human' | 'workload' | 'operator' | 'local';
  readonly issuer?: string;
  readonly subject?: string;
  readonly label?: string;
}
export interface ApiPrincipal {
  readonly ownerId: string;
  readonly scopes: readonly ApiScope[];
  readonly actor?: ApiActor;
  readonly authentication?: 'oidc' | 'iam' | 'token' | 'local';
  readonly expiresAt?: number;
}


export function iamApiPrincipal(ownerId: string): ApiPrincipal { return { ownerId, scopes: [...API_SCOPES], authentication: 'iam', actor: { id: ownerId, kind: 'operator' } }; }

export function parseTokenScopes(input: unknown): ApiScope[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid('Expected a token request object');
  if (Object.keys(input).some(key => key !== 'scopes')) invalid('Only scopes may be supplied when issuing a token');
  const scopes: unknown = (input as { scopes?: unknown }).scopes;
  if (scopes === undefined) return [...API_SCOPES];
  if (!Array.isArray(scopes) || scopes.some(scope => !API_SCOPES.includes(scope))) invalid('Unknown API scope', 'scopes');
  return [...new Set(scopes)] as ApiScope[];
}

/** The caller supplies the same decoded path segments used by dispatch. */
export function requireRoutePermission(principal: ApiPrincipal, method: string, parts: string[]): void {
  if (!principal.ownerId) throw new AgentsApiError(401, 'Authentication required.', 'invalid_api_key');
  if (parts[0] !== 'v1') return;
  if (method === 'GET' && parts[1] === 'agents' && parts[2] === 'sessions' && parts[4] === 'authorizations' && parts[5] === 'otlp' && parts.length === 6) {
    requireAnyScope(principal, ['api.traces.read', 'api.agents.read']);
    return;
  }
  if (method === 'GET' && parts[1] === 'agents' && parts[2] === 'sessions' && parts[4] === 'traces' && parts.length === 5) {
    requireAnyScope(principal, ['api.traces.read', 'api.agents.read']);
    return;
  }
  if (method === 'POST' && parts[1] === 'agents' && parts[2] === 'sessions' && parts[4] === 'fork' && parts.length === 5) requireAnyScope(principal, ['api.agents.read']);
  if (parts[1] === 'models') {
    requireAnyScope(principal, ['api.agents.read']);
    return;
  }
  if (!['agents', 'vaults', 'files', 'skills', 'webhooks'].includes(parts[1] ?? '')) return;
  const resource = parts[1] === 'vaults' ? 'vaults' : 'agents';
  requireAnyScope(principal, [`api.${resource}.${method === 'GET' ? 'read' : 'write'}`]);
}

export function requireInferencePermission(principal: ApiPrincipal, input: unknown, operation: 'create' | 'events'): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return;
  const body = input as { input?: unknown; events?: unknown };
  const inference = operation === 'create'
    ? typeof body.input === 'string' || Array.isArray(body.input) && body.input.length > 0
    : Array.isArray(body.events) && body.events.some(event => event?.type === 'agent.session.input.message' || event?.type === 'agent.session.input.tool_result');
  if (inference) requireAnyScope(principal, ['api.responses.write']);
}

function requireAnyScope(principal: ApiPrincipal, scopes: readonly ApiScope[]): void {
  if (!scopes.some(scope => principal.scopes.includes(scope))) {
    throw new AgentsApiError(403, `Requires ${scopes.join(' or ')}.`, 'insufficient_permissions');
  }
}

export const SPACE_ROLES = ['viewer', 'collaborator', 'controller', 'manager'] as const;
export type SpaceRole = typeof SPACE_ROLES[number];
export const SPACE_ACTIONS = {
  read: 'viewer',
  trace: 'viewer',
  contribute: 'collaborator',
  create_session: 'collaborator',
  cancel: 'controller',
  delete_session: 'controller',
  configure: 'manager',
  credentials: 'manager',
  manage_space: 'manager',
  share: 'collaborator',
  upload: 'collaborator',
} as const satisfies Record<string, SpaceRole>;
export type SpaceAction = keyof typeof SPACE_ACTIONS;
export function roleAllows(role: SpaceRole, action: SpaceAction): boolean {
  return SPACE_ROLES.indexOf(role) >= SPACE_ROLES.indexOf(SPACE_ACTIONS[action]);
}
export function rolePermissions(role: SpaceRole): SpaceAction[] {
  return (Object.keys(SPACE_ACTIONS) as SpaceAction[]).filter(action => roleAllows(role, action));
}

/** An allowlist over the exact decoded path used for dispatch. Unclassified routes have no team authority. */
export function routeActions(method: string, parts: readonly string[], body?: unknown): SpaceAction[] {
  const path = parts.join('/');
  const read = method === 'GET';
  const write = method === 'POST' || method === 'DELETE' || method === 'PUT';
  if (!read && !write) return [];
  if (/^v1\/(?:models|agents\/models)$/.test(path)) return read ? ['read'] : [];
  if (/^v1\/agents\/sessions(?:\/[^/]+)?$/.test(path)) {
    if (read) return ['read'];
    if (parts.length === 3 && method === 'POST') return ['create_session', ...inferenceActions(body)];
    return [method === 'DELETE' ? 'delete_session' : 'configure'];
  }
  if (/^v1\/agents\/sessions\/import$/.test(path)) return read ? ['read'] : ['configure'];
  if (/^v1\/agents\/sessions\/[^/]+\/events$/.test(path)) {
    if (read) return ['read'];
    if (method !== 'POST' || !isRecord(body) || !Array.isArray(body.events)) return [];
    const actions: SpaceAction[] = [];
    for (const event of body.events) {
      if (!isRecord(event)) return [];
      if (event.type === 'agent.session.input.cancel') actions.push('cancel');
      else if (event.type === 'agent.session.input.message' || event.type === 'agent.session.input.tool_result') actions.push('contribute');
      else return [];
    }
    return [...new Set(actions.length ? actions : ['contribute'] as SpaceAction[])];
  }
  if (/^v1\/agents\/sessions\/[^/]+\/fork$/.test(path)) return method === 'POST' ? ['create_session', ...inferenceActions(body)] : [];
  if (/^v1\/agents\/sessions\/[^/]+\/(?:runtime|lineage|items|turns(?:\/[^/]+)?|configurations(?:\/[^/]+)?|authorizations(?:\/[^/]+)?|traces|subagents(?:\/[^/]+(?:\/(?:items|turns(?:\/[^/]+(?:\/items)?)?))?)?)$/.test(path)) return read ? [parts[4] === 'traces' || parts[5] === 'otlp' ? 'trace' : 'read'] : [];
  if (/^v1\/agents\/sessions\/[^/]+\/artifacts(?:\/[^/]+(?:\/content)?)?$/.test(path)) return read ? ['read'] : method === 'DELETE' && parts.length === 6 ? ['delete_session'] : [];
  if (/^v1\/agents\/environments\/templates(?:\/[^/]+)?$/.test(path)) return [read ? 'read' : 'configure'];
  if (/^v1\/agents\/environments\/[^/]+(?:\/files)?$/.test(path)) return read ? ['read'] : parts[4] === 'files' && method === 'POST' ? ['configure'] : [];
  if (/^v1\/agents\/environments\/[^/]+\/connection$/.test(path)) return method === 'POST' ? ['credentials'] : [];
  if (/^v1\/agents(?:\/[^/]+(?:\/revisions(?:\/[^/]+)?)?)?$/.test(path)) return [read ? 'read' : 'configure'];
  if (/^v1\/vaults(?:\/[^/]+(?:\/(?:revisions(?:\/[^/]+)?|credentials(?:\/[^/]+(?:\/revisions(?:\/[^/]+)?)?)?))?)?$/.test(path)) return ['credentials'];
  if (/^v1\/files(?:\/[^/]+(?:\/content)?)?$/.test(path)) return [read ? 'read' : method === 'POST' && parts.length === 2 ? 'upload' : 'configure'];
  if (/^v1\/skills(?:\/[^/]+(?:\/(?:content|versions(?:\/[^/]+(?:\/content)?)?))?)?$/.test(path)) return [read ? 'read' : 'configure'];
  if (/^v1\/webhooks(?:\/[^/]+(?:\/rotate-secret)?)?$/.test(path)) return ['credentials'];
  if (/^v1\/rat\/spaces\/[^/]+\/(?:bindings|execution-roles|invites)(?:\/[^/]+)?$/.test(path)) return ['manage_space'];
  if (/^v1\/rat\/agents\/[^/]+\/workload$/.test(path)) return ['manage_space'];
  if (/^v1\/rat\/sessions\/[^/]+\/(?:typing|messages)$/.test(path)) return method === 'POST' ? ['contribute'] : [];
  if (/^v1\/rat\/sessions\/[^/]+\/workspace\/(?:feedback|browser(?:\/capture)?|threads\/[^/]+\/image)$/.test(path)) return read && (parts[5] === 'browser' && parts.length === 6 || parts[5] === 'threads' && parts.length === 8 && parts[7] === 'image') ? ['read'] : method === 'POST' ? ['contribute'] : [];
  if (/^v1\/rat\/sessions\/[^/]+\/activity(?:\/events)?$/.test(path)) return read ? ['read'] : [];
  if (/^v1\/rat\/shares(?:\/[^/]+(?:\/activate)?)?$/.test(path)) return [read ? 'read' : 'share'];
  return [];
}
export function requireSpaceActions(principal: ApiPrincipal, role: SpaceRole, actions: readonly SpaceAction[]): void {
  if (!actions.length || !SPACE_ROLES.includes(role) || actions.some(action => !roleAllows(role, action))) {
    throw new AgentsApiError(403, 'Your current space role does not permit this action.', 'insufficient_permissions');
  }
  for (const action of actions) requireAnyScope(principal, action === 'trace' ? ['api.traces.read', 'api.agents.read']
    : action === 'read' ? ['api.agents.read'] : action === 'credentials' ? ['api.agents.read', 'api.agents.write', 'api.vaults.read', 'api.vaults.write'] : ['api.agents.write']);
  if (actions.includes('contribute')) requireAnyScope(principal, ['api.responses.write']);
}
function inferenceActions(body: unknown): SpaceAction[] {
  return isRecord(body) && (typeof body.input === 'string' || Array.isArray(body.input) && body.input.length > 0) ? ['contribute'] : [];
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
