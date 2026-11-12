import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TestTeamIdentity } from '../../aws/team-identities.js';
import { classifyDemoRoute } from '../demo-policy.js';

export interface AwsRelayParticipant {
  name: string;
  label: string;
  loopback: string;
  person: TestTeamIdentity;
}

export interface HostedUsage {
  turns: number;
  estimated_usd: number;
}

export function createAgentsAwsRelayHandler(options: {
  participants: readonly AwsRelayParticipant[];
  endpoint: string;
  spaceId: string;
  sessionId: string;
  maxHostedTurns: number;
  spendLimit: number;
  team: <T>(person: TestTeamIdentity, path: string) => Promise<T>;
  hostedUsage: () => Promise<HostedUsage>;
  fetch?: typeof globalThis.fetch;
}): (incoming: IncomingMessage, outgoing: ServerResponse) => void {
  const fetchUpstream = options.fetch ?? globalThis.fetch;
  return (incoming, outgoing) => void handleRelayRequest(incoming, outgoing, options, fetchUpstream)
    .catch(() => {
      if (!outgoing.headersSent) { outgoing.writeHead(502); outgoing.end(); }
      else outgoing.destroy();
    });
}

async function handleRelayRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: Parameters<typeof createAgentsAwsRelayHandler>[0],
  fetchUpstream: typeof globalThis.fetch,
): Promise<void> {
  const abort = new AbortController();
  outgoing.once('close', () => abort.abort());
  const who = options.participants.find(entry => incoming.headers.authorization === `Bearer ${entry.loopback}`);
  if (!who) { outgoing.writeHead(401); outgoing.end(); return; }

  const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/^\/api/, '');
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const reply = (status: number, body: unknown) => {
    outgoing.writeHead(status, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify(body));
  };

  if (incoming.method === 'GET' && path === '/v1/workspace') {
    const spaces = await options.team<{ data: Array<{ id: string; name: string; role: string; permissions: string[] }> }>(who.person, '/rat/spaces');
    const space = spaces.data.find(value => value.id === options.spaceId);
    reply(200, space ? { ...space, kind: 'team', connection_id: 'aws', space_id: options.spaceId }
      : { kind: 'team', role: 'no_access', permissions: [], space_id: options.spaceId });
    return;
  }
  if (incoming.method === 'GET' && path === '/v1/team/connections') {
    reply(200, { data: [{ id: 'aws', endpoint: options.endpoint, identity: { issuer: who.person.issuer, subject: who.person.subject, label: who.label } }] });
    return;
  }
  if (!path.startsWith('/v1/') || path.startsWith('/v1/team/')) {
    reply(404, { error: { message: 'Not available through the relay.' } });
    return;
  }

  const decision = classifyDemoRoute(incoming.method ?? 'GET', path, options.sessionId);
  if (decision.kind === 'deny') {
    reply(404, { error: { message: 'Route is not available through this demo relay.' } });
    return;
  }
  if (decision.kind === 'inference') {
    const usage = await options.hostedUsage();
    if (usage.turns >= options.maxHostedTurns || usage.estimated_usd >= options.spendLimit) {
      reply(429, { error: { message: `Live budget reached (${usage.turns} hosted Turns, $${usage.estimated_usd}).`, code: 'demo_budget' } });
      return;
    }
  }

  const headers: Record<string, string> = { authorization: `Bearer ${await who.person.accessTokenForRequest()}`, 'x-rat-space': options.spaceId };
  for (const key of ['content-type', 'idempotency-key', 'last-event-id', 'accept']) {
    const value = incoming.headers[key];
    if (typeof value === 'string') headers[key] = value;
  }
  const upstream = await fetchUpstream(`${options.endpoint}${path.slice(3)}${url.search}`, {
    method: incoming.method ?? 'GET',
    headers,
    redirect: 'error',
    signal: abort.signal,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)) responseHeaders[key] = value;
  });
  outgoing.writeHead(upstream.status, responseHeaders);
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), outgoing);
  else outgoing.end();
}
