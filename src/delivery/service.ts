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
    const request = await this.options.artifacts.getJson<RunRequest>(run.input);
    const body = await this.messageBody(run);
    const failures: Error[] = [];
    for (const context of resolveDestinations(request, this.options.defaultDestinations)) {
      const key = `${context.provider}:${context.destination.route ?? 'default'}`;
      if (!(await this.options.fence.claim(run, key))) continue;
      try {
        const receipt = await this.options.plugins.deliveryFor(context.provider).deliver({
          context,
          request,
          run,
          body,
        });
        await this.options.fence.delivered(run.runId, key, receipt);
      } catch (error) {
        if (error instanceof KnownNotDeliveredError && error.retryable) {
          await this.options.fence.release(run.runId, key);
          failures.push(error);
        } else {
          await this.options.fence.failed(run.runId, key, error);
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
  request: RunRequest,
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
  request: RunRequest,
): ProviderKind | undefined {
  if (destination.kind === 'none') return undefined;
  if (destination.kind === 'teams' || destination.kind === 'slack') return destination.kind;
  const source = request.source?.kind;
  return source && source !== 'api' ? source : undefined;
}
