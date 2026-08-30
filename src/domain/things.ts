import type {
  AgentInput,
  ArtifactReference,
  ExecutionInput,
  JsonValue,
  RepositoryInput,
  RunDestination,
  RunRecord,
  RunRequest,
  ThingRunBinding,
} from './contracts.js';
import type {
  ConnectionStatus,
  IntegrationAccessLevel,
  IntegrationPermissionPreset,
  ProviderAuthorization,
} from './capabilities.js';

export const THING_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type ThingStatus = (typeof THING_STATUSES)[number];

export interface ManualThingTrigger {
  kind: 'manual';
}

export interface ScheduleThingTrigger {
  kind: 'schedule';
  /** Amazon EventBridge Scheduler rate(...) or cron(...) expression. */
  expression: string;
  /** IANA time-zone name. Omitted schedules use UTC. */
  timezone?: string;
}

export type ThingTrigger = ManualThingTrigger | ScheduleThingTrigger;

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

/** Stable, portable public contract for a reusable cloud agent. */
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

/** Immutable revision metadata. The complete spec remains in encrypted artifact storage. */
export interface ThingRevision {
  revision: number;
  name: string;
  trigger: ThingTrigger;
  spec: ArtifactReference;
  specHash: string;
  createdAt: string;
}

export type ThingTriggerStateStatus = 'inactive' | 'syncing' | 'ready' | 'paused' | 'error';

export interface ThingTriggerState {
  status: ThingTriggerStateStatus;
  revision?: number;
  updatedAt: string;
  error?: string;
}

/** Internal owner-scoped metadata with separate draft and published pointers. */
export interface ThingRecord {
  version: '1';
  thingId: string;
  ownerId: string;
  ownerCreated: string;
  status: ThingStatus;
  draft: ThingRevision;
  active?: ThingRevision;
  triggerState: ThingTriggerState;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunId?: string;
}

export interface ThingVersionRecord extends ThingRevision {
  version: '1';
  thingId: string;
}

export interface ListThingsResult {
  items: ThingRecord[];
  nextToken?: string;
}

export interface PublicThingVersion extends Omit<ThingVersionRecord, 'spec'> {
  spec: ThingSpec;
}

export interface PublicThingRevisionSummary extends Omit<ThingRevision, 'spec'> {}

export interface PublicThingSummary {
  version: '1';
  thingId: string;
  status: ThingStatus;
  draft: PublicThingRevisionSummary;
  active?: PublicThingRevisionSummary;
  hasUnpublishedChanges: boolean;
  triggerState: ThingTriggerState;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunId?: string;
}

export interface PublicThing extends Omit<PublicThingSummary, 'draft' | 'active'> {
  draft: PublicThingVersion;
  active?: PublicThingVersion;
}

export interface ThingDiagnostic {
  id: string;
  status: 'pass' | 'warning' | 'error';
  message: string;
}

export interface ThingExplanation {
  version: '1';
  target: 'draft' | 'active';
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

export interface ScheduledThingInvocation {
  version: '1';
  thingId: string;
  revision: number;
  scheduledAt: string;
}

export interface ScheduledThingResult {
  accepted: boolean;
  reason?: 'missing' | 'not-active' | 'stale-revision' | 'not-scheduled';
  run?: Pick<RunRecord, 'runId' | 'status'>;
}

export type { ThingInvocationKind } from './contracts.js';

/** Immutable Thing revision evidence returned with a newly accepted occurrence. */
export type ThingRunEvidence = ThingRunBinding;

/** The ordinary run receipt plus the exact Thing revision that produced it. */
export interface ThingOccurrenceRun extends RunRecord {
  thing: ThingRunEvidence;
}
