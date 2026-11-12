export type DemoRouteDecision = { kind: 'inference' } | { kind: 'proxy' } | { kind: 'deny' };

/** Classifies the router's decoded path segments without changing the path sent upstream. */
export function classifyDemoRoute(method: string, pathname: string, sessionId: string): DemoRouteDecision {
  let parts: string[];
  try { parts = pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { return { kind: 'deny' }; }

  if (method === 'POST' && isSessionRoute(parts, 'rat', sessionId, ['messages'])) return { kind: 'inference' };
  if (method === 'POST' && isSessionRoute(parts, 'agents', sessionId, ['events'])) return { kind: 'inference' };
  if (method === 'POST' && isSessionRoute(parts, 'rat', sessionId, ['workspace', 'feedback'])) return { kind: 'inference' };

  if (method === 'GET' && isExactRoute(parts, ['v1', 'workspace'])) return { kind: 'proxy' };
  if (method === 'GET' && isExactRoute(parts, ['v1', 'team', 'connections'])) return { kind: 'proxy' };
  if (method === 'GET' && isExactRoute(parts, ['v1', 'rat', 'spaces'])) return { kind: 'proxy' };
  if (method === 'GET' && isExactRoute(parts, ['v1', 'agents', 'sessions'])) return { kind: 'proxy' };
  if (method === 'GET' && isSessionRoute(parts, 'agents', sessionId)) return { kind: 'proxy' };
  if (method === 'GET' && isSessionRoute(parts, 'rat', sessionId)) return { kind: 'proxy' };

  if (method === 'POST' && isSessionRoute(parts, 'rat', sessionId, ['typing'])) return { kind: 'proxy' };
  if (method === 'POST' && isSessionRoute(parts, 'rat', sessionId, ['workspace', 'browser'])) return { kind: 'proxy' };
  if (method === 'POST' && isSessionRoute(parts, 'rat', sessionId, ['workspace', 'browser', 'capture'])) return { kind: 'proxy' };
  return { kind: 'deny' };
}

function isSessionRoute(parts: string[], api: 'agents' | 'rat', sessionId: string, suffix?: string[]): boolean {
  const prefix = ['v1', api, 'sessions', sessionId];
  if (parts.length < prefix.length || !prefix.every((part, index) => parts[index] === part)) return false;
  return suffix === undefined || parts.length === prefix.length + suffix.length && suffix.every((part, index) => parts[prefix.length + index] === part);
}

function isExactRoute(parts: string[], expected: string[]): boolean {
  return parts.length === expected.length && expected.every((part, index) => parts[index] === part);
}
