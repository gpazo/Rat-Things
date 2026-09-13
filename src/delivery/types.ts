import type {
  ArtifactReference,
  RunDestination,
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
  request: Pick<RunRequest, 'source' | 'destinations' | 'integrations'>;
  execution: DeliveryExecution;
  body: string;
}

export interface DeliveryExecution {
  id: string;
  status: string;
  label: 'Turn' | 'Run';
  sessionId?: string;
  credentialOwnerId?: string;
  expiresAt?: number;
}

export interface DeliveryAdapter {
  readonly provider: ProviderKind;
  deliver(request: DeliveryRequest): Promise<string>;
}

export interface ResultReader {
  read(reference: ArtifactReference): Promise<string | undefined>;
}

export interface DeliveryFencePort {
  claim(execution: Pick<DeliveryExecution, 'id' | 'expiresAt'>, destination: string): Promise<boolean>;
  delivered(runId: string, destination: string, receipt?: string): Promise<void>;
  release(runId: string, destination: string): Promise<void>;
  failed(runId: string, destination: string, error: unknown): Promise<void>;
}
