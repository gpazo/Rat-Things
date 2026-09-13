import type { AgentSession } from './agents-api.js';
import { invalid } from './agents-api-validation.js';

export const sessionWebhookTypes = [
  'agent.session.created', 'agent.session.action_required', 'agent.session.in_progress',
  'agent.session.idle', 'agent.session.failed',
] as const;
export type SessionWebhookType = typeof sessionWebhookTypes[number];
export interface SessionWebhookEvent {
  id: string; object: 'event'; created_at: number; type: SessionWebhookType;
  data: { id: string; required_action?: { type: 'function_call' | 'environment_connection' };
    environment_id?: string; environment_type?: 'openai_hosted' | 'self_hosted'; connect?: { remote_url: string } };
}
export interface WebhookEndpoint {
  id: string; object: 'webhook.endpoint'; name: string; url: string;
  events: SessionWebhookType[]; enabled: boolean; created_at: number;
}
export interface StoredWebhookEndpoint { endpoint: WebhookEndpoint; secretReference: string }
export interface WebhookDelivery {
  endpointId: string; event: SessionWebhookEvent; webhookId: string;
  status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'disabled';
  attempts: number; nextAttemptAt: number; deadline: number; leaseUntil?: number;
  lastStatus?: number;
}

/** Webhooks deliberately use action_required; the live stream uses requires_action. */
export function planSessionWebhooks(previous: AgentSession | undefined, session: AgentSession): Array<Omit<SessionWebhookEvent, 'id' | 'object' | 'created_at'>> {
  const events: Array<Omit<SessionWebhookEvent, 'id' | 'object' | 'created_at'>> = [];
  if (!previous) {
    const environment = session.environment;
    events.push({ type: 'agent.session.created', data: { id: session.id,
      ...(environment.type === 'none' ? {} : { environment_id: environment.id, environment_type: environment.type }),
      ...(environment.type === 'self_hosted' ? { connect: { remote_url: environment.remote_url } } : {}),
    } });
  }
  if (session.status === 'requires_action') {
    const kinds = [...new Set(session.required_actions.map((action) => action.type))];
    for (const type of kinds) {
      const before = previous?.required_actions.filter((action) => action.type === type) ?? [];
      const after = session.required_actions.filter((action) => action.type === type);
      if (previous?.status !== 'requires_action' || JSON.stringify(before) !== JSON.stringify(after)) events.push({
        type: 'agent.session.action_required', data: { id: session.id, required_action: { type } },
      });
    }
  } else if (session.status !== previous?.status) events.push({ type: `agent.session.${session.status}`, data: { id: session.id } });
  return events;
}

/** Backoff is bounded by the documented 72-hour delivery horizon. */
export function webhookRetry(attempts: number, now: number, deadline: number): { status: 'pending' | 'failed'; nextAttemptAt: number } {
  return now >= deadline ? { status: 'failed', nextAttemptAt: deadline } : {
    status: 'pending', nextAttemptAt: Math.min(deadline, now + Math.min(3600, 5 * 2 ** Math.min(Math.max(attempts - 1, 0), 10))),
  };
}

export function webhookEndpointInput(raw: unknown, previous?: WebhookEndpoint): Pick<WebhookEndpoint, 'name' | 'url' | 'events' | 'enabled'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Expected a webhook endpoint object');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['name', 'url', 'events', 'enabled'].includes(key))) invalid('Unknown webhook endpoint field');
  const name = input.name === undefined ? previous?.name ?? '' : input.name;
  const url = input.url === undefined ? previous?.url : input.url;
  const events = input.events === undefined ? previous?.events : input.events;
  const enabled = input.enabled === undefined ? previous?.enabled ?? true : input.enabled;
  if (typeof name !== 'string' || name.length > 128) invalid('name must be at most 128 characters', 'name');
  if (typeof url !== 'string' || url.length > 2048) invalid('A public HTTPS endpoint URL is required', 'url');
  let parsed: URL;
  try { parsed = new URL(url); } catch { return invalid('Invalid webhook URL', 'url'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) invalid('A credential-free HTTPS endpoint URL is required', 'url');
  if (!Array.isArray(events) || !events.length || events.some((event) => !sessionWebhookTypes.includes(event))) invalid('Select supported Session webhook events', 'events');
  if (typeof enabled !== 'boolean') invalid('enabled must be a boolean', 'enabled');
  return { name, url: parsed.toString(), events: [...new Set(events as SessionWebhookType[])], enabled };
}
