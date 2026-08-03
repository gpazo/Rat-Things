import type {
  ArtifactReference,
  RunDestination,
  RunRecord,
  RunRequest,
} from '../domain/contracts.js';
import type { ProviderKind } from '../identity/context.js';

export interface DestinationContext {
  provider: ProviderKind;
  destination: RunDestination;
  source: RunRequest['source'];
}

export interface DeliveryRequest {
  context: DestinationContext;
  request: RunRequest;
  run: RunRecord;
  body: string;
}

export interface DeliveryAdapter {
  readonly provider: ProviderKind;
  deliver(request: DeliveryRequest): Promise<string>;
}

export interface ResultReader {
  read(reference: ArtifactReference): Promise<string | undefined>;
}

export interface DeliveryFencePort {
  claim(run: RunRecord, destination: string): Promise<boolean>;
  delivered(runId: string, destination: string, receipt?: string): Promise<void>;
  release(runId: string, destination: string): Promise<void>;
  failed(runId: string, destination: string, error: unknown): Promise<void>;
}
