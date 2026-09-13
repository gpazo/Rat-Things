import type { ArtifactStore, RunStore } from '../core/ports.js';
import type {
  RunDestination,
  RunRecord,
  RunRequest,
  RunStateEvent,
} from '../domain/contracts.js';
import type { ProviderKind } from '../identity/context.js';
import type { RuntimePluginRegistry } from '../plugins/registry.js';
import { KnownNotDeliveredError } from './errors.js';
import type {
  DeliveryFencePort,
  DestinationContext,
  ResultReader,
  DeliveryRequest,
} from './types.js';

export interface DeliveryServiceOptions {
  store: Pick<RunStore, 'get'>;
  artifacts: Pick<ArtifactStore, 'getJson'>;
  results: ResultReader;
  fence: DeliveryFencePort;
  plugins: RuntimePluginRegistry;
  defaultDestinations: RunDestination[];
}

export class DeliveryService {
  public constructor(private readonly options: DeliveryServiceOptions) {}

  public async handle(detail: RunStateEvent): Promise<void> {
    if (!['succeeded', 'failed', 'cancelled'].includes(detail.status)) return;
    const run = await this.options.store.get(detail.runId);
    if (!run) throw new Error(`run ${detail.runId} not found`);
    if (run.agentsSession) return; // Session delivery follows saved root Turns, not harness exit.
    const request = await this.options.artifacts.getJson<RunRequest>(run.input);
    const body = await this.messageBody(run);
    await this.deliver({ request, body, execution: { id: run.runId, status: run.status, label: 'Run', expiresAt: run.expiresAt, ...(run.capabilityOwnerId ? { credentialOwnerId: run.capabilityOwnerId } : {}) } });
  }

  public async deliver({ request, body, execution }: Omit<DeliveryRequest, 'context'>): Promise<void> {
    const failures: Error[] = [];
    for (const context of resolveDestinations(request, this.options.defaultDestinations)) {
      const key = destinationKey(context);
      if (!(await this.options.fence.claim(execution, key))) continue;
      try {
        const receipt = await this.options.plugins.deliveryFor(context.provider).deliver({
          context,
          request,
          execution,
          body,
        });
        await this.options.fence.delivered(execution.id, key, receipt);
      } catch (error) {
        if (error instanceof KnownNotDeliveredError && error.retryable) {
          await this.options.fence.release(execution.id, key);
          failures.push(error);
        } else {
          await this.options.fence.failed(execution.id, key, error);
        }
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  private async messageBody(run: RunRecord): Promise<string> {
    if (run.status === 'succeeded' && run.result) {
      return (await this.options.results.read(run.result.output)) ?? run.result.preview;
    }
    if (run.status === 'cancelled') return `Agent run ${run.runId} was cancelled.`;
    return `Agent run ${run.runId} failed: ${run.error?.message ?? 'unknown error'}`;
  }
}

export function resolveDestinations(
  request: Pick<RunRequest, 'source' | 'destinations'>,
  defaults: RunDestination[],
): DestinationContext[] {
  const configured = request.destinations ?? defaults;
  const resolved = configured.flatMap((destination): DestinationContext[] => {
    const provider = destinationProvider(destination, request);
    if (!provider) return [];
    const normalized = destination.kind === 'source' && provider === 'teams'
      ? { kind: 'teams' as const }
      : destination.kind === 'source' && provider === 'slack' && request.source?.kind === 'slack'
        ? { kind: 'slack' as const, route: request.source.channelId }
        : destination;
    return [{ provider, destination: normalized, source: request.source }];
  });
  return [...new Map(resolved.map((context) => [
    `${context.provider}:${context.destination.route ?? ''}`,
    context,
  ])).values()];
}

function destinationProvider(
  destination: RunDestination,
  request: Pick<RunRequest, 'source' | 'destinations'>,
): ProviderKind | undefined {
  if (destination.kind === 'none') return undefined;
  if (destination.kind === 'teams' || destination.kind === 'slack') return destination.kind;
  const source = request.source?.kind;
  return source && source !== 'api' ? source : undefined;
}

/** Include thread/activity scope so equal channel names cannot share a delivery fence. */
export function destinationKey(context: DestinationContext): string {
  const source = context.source;
  const thread = source?.kind === 'slack' ? [source.teamId, source.channelId, source.threadTs] : source?.kind === 'teams' ? [source.tenantId, source.conversationId, source.activityId] : source?.kind === 'github' ? [source.repository, source.issueNumber] : source?.kind === 'gitlab' ? [source.projectId, source.mergeRequestIid] : [];
  return JSON.stringify([context.provider, context.destination.route ?? 'default', ...thread]);
}
