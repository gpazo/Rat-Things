import type {
  AgentInput,
  ArtifactReference,
  ExecutionInput,
  JsonValue,
  RepositoryInput,
  RunDestination,
  RunRecord,
  RunRequest,
} from './contracts.js';
import type {
  ConnectionStatus,
  IntegrationAccessLevel,
  IntegrationPermissionPreset,
  OperationApproval,
  ProviderAuthorization,
} from './capabilities.js';

export const THING_STATUSES = ['draft', 'enabled', 'paused', 'archived'] as const;
export type ThingStatus = (typeof THING_STATUSES)[number];

export interface ManualThingTrigger {
  kind: 'manual';
}

export interface IntervalThingTrigger {
  kind: 'interval';
  everyMinutes: number;
  startAt?: string;
}

export type ThingTrigger = ManualThingTrigger | IntervalThingTrigger;

/**
 * A deployment-owned account selector. The account is an owner-scoped
 * connection ID or alias; provider credentials never enter a Thing spec.
 */
export interface ThingAccountSelector {
  account: string;
  access?: IntegrationPermissionPreset;
  allowOperations?: string[];
  denyOperations?: string[];
}

export interface ThingConnections {
  /** Owner-scoped connection-set ID or name. */
  set?: string;
  /** Additional or narrowed accounts. Multiple accounts per integration are supported. */
  accounts?: ThingAccountSelector[];
}

/** Stable, portable public contract for a reusable agent automation. */
export interface ThingSpec {
  version: '1';
  name: string;
  goal: string;
  trigger: ThingTrigger;
  repository?: RepositoryInput;
  agent?: AgentInput;
  connections?: ThingConnections;
  execution?: ExecutionInput;
  deliver?: RunDestination[];
  metadata?: { [key: string]: JsonValue };
}

/** Internal owner-scoped metadata. The complete spec remains in encrypted artifact storage. */
export interface ThingRecord {
  version: '1';
  thingId: string;
  ownerId: string;
  ownerCreated: string;
  revision: number;
  name: string;
  status: ThingStatus;
  trigger: ThingTrigger;
  nextRunAt?: string;
  spec: ArtifactReference;
  specHash: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunId?: string;
}

export interface ThingVersionRecord {
  version: '1';
  thingId: string;
  revision: number;
  spec: ArtifactReference;
  specHash: string;
  createdAt: string;
}

export interface ListThingsResult {
  items: ThingRecord[];
  nextToken?: string;
}

export interface PublicThingSummary extends Omit<
  ThingRecord,
  'ownerId' | 'ownerCreated' | 'spec'
> {}

export interface PublicThing extends PublicThingSummary {
  spec: ThingSpec;
}

export interface PublicThingVersion extends Omit<ThingVersionRecord, 'spec'> {
  spec: ThingSpec;
}

export interface ThingDiagnostic {
  id: string;
  status: 'pass' | 'warning' | 'error';
  message: string;
}

export interface ThingExplanation {
  version: '1';
  thing: PublicThing;
  /** Direct, deterministic ThingSpec-to-RunRequest compilation. */
  compiledRun: RunRequest;
  /** Profile-resolved request that the runner will enforce, when environment resolution succeeds. */
  effectiveRun?: RunRequest;
  resolvedConnections?: ResolvedThingConnection[];
  runnable: boolean;
  diagnostics: ThingDiagnostic[];
}

export interface ResolvedThingOperation {
  id: string;
  access: IntegrationAccessLevel;
  allowed: boolean;
  requiresApproval: boolean;
  approval: OperationApproval;
  enforcement: 'provider-and-broker' | 'broker';
  reason?: string;
}

export interface ResolvedThingConnection {
  connectionId: string;
  alias: string;
  pluginId: string;
  selectedBy: Array<'connection-set' | 'account'>;
  defaultFor?: string[];
  status: ConnectionStatus;
  providerAuthorization: ProviderAuthorization;
  grant?: {
    preset: IntegrationPermissionPreset;
    expiresAt?: string;
    resourceConstraints?: { [key: string]: string[] };
  };
  requestedAccess?: IntegrationPermissionPreset;
  operations: ResolvedThingOperation[];
}

export interface ThingTickResult {
  examined: number;
  scheduled: number;
  runs: Array<Pick<RunRecord, 'runId' | 'status'>>;
}
