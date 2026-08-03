import type { EventBridgeEvent, EventBridgeHandler } from 'aws-lambda';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  CachedSecretReader,
  createAwsClients,
  DynamoRunStore,
  S3ArtifactStore,
} from '../adapters/aws-runtime.js';
import { requiredEnv } from '../adapters/executors.js';
import { AGENT_RESULT_MARKER } from '../channels/result-marker.js';
import { DeliveryFence } from '../core/delivery-fence.js';
import type {
  RunDestination,
  RunRecord,
  RunRequest,
  RunStateEvent,
} from '../domain/contracts.js';

const clients = createAwsClients();
const tableName = requiredEnv('RUNS_TABLE_NAME');
const store = new DynamoRunStore(clients.dynamodb, tableName);
const artifacts = new S3ArtifactStore(clients.s3, requiredEnv('ARTIFACT_BUCKET'));
const secrets = new CachedSecretReader(clients.secrets);

export const handler: EventBridgeHandler<'Agent Run State', RunStateEvent, void> = async (
  event: EventBridgeEvent<'Agent Run State', RunStateEvent>,
) => {
  const detail = event.detail;
  if (!['succeeded', 'failed', 'cancelled'].includes(detail.status)) return;
  const run = await store.get(detail.runId);
  if (!run) throw new Error(`run ${detail.runId} not found`);
  const request = await artifacts.getJson<RunRequest>(run.input);
  const body = await messageBody(run);
  const destinations = resolveDestinations(request);
  const failures: Error[] = [];
  for (const destination of destinations) {
    const key = `${destination.kind}:${destination.route ?? 'default'}`;
    if (!(await fence.claim(run, key))) continue;
    try {
      const receipt = await deliver(destination, request, body, run);
      await fence.delivered(run.runId, key, receipt);
    } catch (error) {
      if (error instanceof KnownNotDeliveredError && error.retryable) {
        await fence.release(run.runId, key);
        failures.push(error);
      } else {
        await fence.failed(run.runId, key, error);
      }
    }
  }
  if (failures.length > 0) throw failures[0];
};

async function messageBody(run: RunRecord): Promise<string> {
  if (run.status === 'succeeded' && run.result) {
    const result = await clients.s3.send(new GetObjectCommand({
      Bucket: run.result.output.bucket,
      Key: run.result.output.key,
    }));
    return result.Body ? result.Body.transformToString('utf8') : run.result.preview;
  }
  if (run.status === 'cancelled') return `Agent run ${run.runId} was cancelled.`;
  return `Agent run ${run.runId} failed: ${run.error?.message ?? 'unknown error'}`;
}

function resolveDestinations(request: RunRequest): RunDestination[] {
  const configured = request.destinations ?? parseDefaultDestinations();
  const resolved = configured.flatMap((destination): RunDestination[] => {
    if (destination.kind !== 'source') return [destination];
    switch (request.source?.kind) {
      case 'github':
      case 'gitlab':
        return [{ kind: 'source' }];
      case 'teams':
        return [{ kind: 'teams' }];
      case 'slack':
        return [{ kind: 'slack', route: request.source.channelId }];
      default:
        return [];
    }
  });
  const unique = new Map(resolved.filter((item) => item.kind !== 'none').map((item) => [`${item.kind}:${item.route ?? ''}`, item]));
  return [...unique.values()];
}

function parseDefaultDestinations(): RunDestination[] {
  return (process.env.DEFAULT_DELIVERY_DESTINATIONS ?? 'source')
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind): kind is RunDestination['kind'] => ['source', 'teams', 'slack', 'none'].includes(kind))
    .map((kind) => ({ kind }));
}

async function deliver(
  destination: RunDestination,
  request: RunRequest,
  body: string,
  run: RunRecord,
): Promise<string> {
  if (destination.kind === 'teams') return deliverTeams(destination.route, body, run);
  if (destination.kind === 'slack') return deliverSlack(destination.route, request, body, run);
  if (destination.kind === 'source' && request.source?.kind === 'github') {
    return deliverGitHub(request, body, run);
  }
  if (destination.kind === 'source' && request.source?.kind === 'gitlab') {
    return deliverGitLab(request, body, run);
  }
  return 'ignored';
}

async function deliverGitHub(request: RunRequest, body: string, run: RunRecord): Promise<string> {
  const source = request.source;
  if (source?.kind !== 'github' || !source.issueNumber) throw new Error('GitHub destination lacks issue number');
  const tokenArn = process.env.GITHUB_NOTIFY_TOKEN_SECRET_ARN ?? requiredEnv('GITHUB_TOKEN_SECRET_ARN');
  const token = secretField(await secrets.get(tokenArn), ['token', 'access_token']);
  const base = validatedBaseUrl(process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com');
  const response = await fetchWithTimeout(`${base}/repos/${source.repository}/issues/${source.issueNumber}/comments`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'indubitably-agent-runtime',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ body: formatMessage(body, run, 60_000, true) }),
  });
  const value = await checkedJson(response, 'GitHub');
  return typeof value.id === 'number' ? String(value.id) : 'accepted';
}

async function deliverGitLab(request: RunRequest, body: string, run: RunRecord): Promise<string> {
  const source = request.source;
  if (source?.kind !== 'gitlab' || !source.mergeRequestIid) throw new Error('GitLab destination lacks merge request IID');
  const tokenArn = process.env.GITLAB_NOTIFY_TOKEN_SECRET_ARN ?? requiredEnv('GITLAB_TOKEN_SECRET_ARN');
  const token = secretField(await secrets.get(tokenArn), ['token', 'access_token']);
  const base = validatedBaseUrl(process.env.GITLAB_API_BASE_URL ?? 'https://gitlab.com/api/v4');
  const response = await fetchWithTimeout(
    `${base}/projects/${encodeURIComponent(source.projectId)}/merge_requests/${source.mergeRequestIid}/notes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'private-token': token },
      body: JSON.stringify({ body: formatMessage(body, run, 60_000, true) }),
    },
  );
  const value = await checkedJson(response, 'GitLab');
  return typeof value.id === 'number' ? String(value.id) : 'accepted';
}

async function deliverTeams(route: string | undefined, body: string, run: RunRecord): Promise<string> {
  const routed = teamsRouteSecret(route);
  if (route && !routed) throw new Error(`unknown Teams destination route ${route}`);
  const secretArn = routed ?? requiredEnv('TEAMS_WORKFLOW_URL_SECRET_ARN');
  const url = secretField(await secrets.get(secretArn), ['url', 'webhook_url']);
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            type: 'AdaptiveCard',
            version: '1.5',
            body: [
              { type: 'TextBlock', weight: 'Bolder', text: `Agent run ${run.status}`, wrap: true },
              { type: 'TextBlock', text: body.slice(0, 20_000), wrap: true },
              { type: 'FactSet', facts: [{ title: 'Run', value: run.runId }] },
            ],
          },
        },
      ],
    }),
  });
  await checkedResponse(response, 'Teams');
  return response.headers.get('request-id') ?? 'accepted';
}

async function deliverSlack(
  route: string | undefined,
  request: RunRequest,
  body: string,
  run: RunRecord,
): Promise<string> {
  const channel = route ?? (request.source?.kind === 'slack' ? request.source.channelId : undefined);
  if (!channel) throw new Error('Slack destination lacks a channel');
  const token = secretField(await secrets.get(requiredEnv('SLACK_BOT_TOKEN_SECRET_ARN')), ['token', 'bot_token']);
  const response = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      channel,
      text: formatMessage(body, run, 38_000),
      ...(request.source?.kind === 'slack' && request.source.threadTs ? { thread_ts: request.source.threadTs } : {}),
    }),
  });
  const value = await checkedJson(response, 'Slack');
  if (value.ok !== true) throw new KnownNotDeliveredError(`Slack rejected message: ${String(value.error ?? 'unknown')}`, false);
  return typeof value.ts === 'string' ? value.ts : 'accepted';
}

const fence = new DeliveryFence(clients.dynamodb, tableName);

class KnownNotDeliveredError extends Error {
  public constructor(message: string, public readonly retryable: boolean) {
    super(message);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
}

async function checkedJson(response: Response, provider: string): Promise<Record<string, unknown>> {
  await checkedResponse(response, provider);
  const value = await response.json() as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function checkedResponse(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  const retryable = response.status === 429 || response.status >= 500;
  throw new KnownNotDeliveredError(`${provider} returned HTTP ${response.status}`, retryable);
}

function formatMessage(body: string, run: RunRecord, maximum: number, markSourceResult = false): string {
  const prefix = markSourceResult ? `${AGENT_RESULT_MARKER}\n` : '';
  const suffix = `\n\n---\nAgent run: ${run.runId}`;
  return `${prefix}${body.slice(0, Math.max(0, maximum - prefix.length - suffix.length))}${suffix}`;
}

function secretField(raw: string, keys: string[]): string {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  } catch {
    // Raw values are supported.
  }
  return raw;
}

function teamsRouteSecret(route: string | undefined): string | undefined {
  if (!route || !process.env.TEAMS_ROUTES_JSON) return undefined;
  const routes = JSON.parse(process.env.TEAMS_ROUTES_JSON) as Record<string, unknown>;
  return typeof routes[route] === 'string' ? routes[route] as string : undefined;
}

function validatedBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('provider API base URL must be credential-free HTTPS');
  }
  return url.toString().replace(/\/$/, '');
}
