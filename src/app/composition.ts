import {
  CachedSecretReader,
  createAwsClients,
  DynamoRunStore,
  S3ArtifactStore,
  S3ResultReader,
  SqsConversationQueue,
  SqsRunQueue,
  type AwsClients,
} from '../adapters/aws-runtime.js';
import { DynamoConversationStore } from '../adapters/dynamo-conversation-store.js';
import { DynamoIntegrationStore } from '../adapters/dynamo-integration-store.js';
import { DynamoOAuthAuthorizationStore } from '../adapters/dynamo-oauth-store.js';
import { DynamoRoutineStore } from '../adapters/dynamo-routine-store.js';
import { DynamoThingStore } from '../adapters/dynamo-thing-store.js';
import { EventBridgeThingScheduler } from '../adapters/eventbridge-thing-scheduler.js';
import { SecretsManagerCredentialVault } from '../adapters/secrets-credential-vault.js';
import { DynamoDeliveryFence } from '../adapters/dynamo-delivery-fence.js';
import {
  createAgentInteractionControllerFromEnv,
  createExecutorRegistryFromEnv,
  requiredEnv,
} from '../adapters/executors.js';
import { ConversationService } from '../conversation/service.js';
import { ConversationSubmissionService } from './conversation-submission.js';
import { ConnectionConsumerService } from './connection-consumers.js';
import { CredentialBroker } from '../credentials/broker.js';
import { DeliveryService } from '../delivery/service.js';
import type { TeamsDeliveryMode } from '../delivery/providers/teams.js';
import type { RunDestination, SandboxMode } from '../domain/contracts.js';
import { WebhookIngressService } from '../ingress/service.js';
import { RuntimePluginRegistry } from '../plugins/registry.js';
import { IntegrationPluginRegistry } from '../plugins/integration-registry.js';
import { IntegrationRuntime } from '../plugins/integration-runtime.js';
import { ConnectionService } from '../plugins/connection-service.js';
import {
  OAuthAuthorizationService,
  OAuthRefreshingCredentialBroker,
  parseOAuthApplicationSecretArns,
  SecretOAuthApplicationRegistry,
} from '../plugins/oauth.js';
import { createBuiltinIntegrationPlugins } from '../plugins/integrations/builtins.js';
import {
  CapabilityProfileRegistry,
  createBuiltinCapabilityProfiles,
} from '../plugins/capability-profiles.js';
import { StoredSourcePolicyResolver } from '../plugins/source-policies.js';
import { createBuiltinPlugins } from '../plugins/builtins.js';
import type { AgentInteractionController, ExecutionController } from '../core/ports.js';
import { RunService } from '../core/run-service.js';
import { RunSubmissionService } from '../core/run-submission-service.js';
import { RoutineService } from '../core/routine-service.js';
import { ThingService } from '../core/thing-service.js';

interface BaseServices {
  clients: AwsClients;
  store: DynamoRunStore;
  conversations: DynamoConversationStore;
  artifacts: S3ArtifactStore;
  definitions: S3ArtifactStore;
  queue: SqsRunQueue;
  conversationQueue: SqsConversationQueue;
  credentials: CredentialBroker;
}

let baseServices: BaseServices | undefined;
let submissionService: RunService | undefined;
let controlService: RunService | undefined;
let runSubmissionService: RunSubmissionService | undefined;
let pluginRegistry: RuntimePluginRegistry | undefined;
let ingressService: WebhookIngressService | undefined;
let deliveryService: DeliveryService | undefined;
let conversationService: ConversationService | undefined;
let conversationSubmissionService: ConversationSubmissionService | undefined;
let agentInteractionController: AgentInteractionController | undefined;
let integrationPluginRegistry: IntegrationPluginRegistry | undefined;
let integrationStore: DynamoIntegrationStore | undefined;
let integrationRuntime: IntegrationRuntime | undefined;
let oauthApplicationRegistry: SecretOAuthApplicationRegistry | undefined;
let oauthCredentialBroker: OAuthRefreshingCredentialBroker | undefined;
let connectionService: ConnectionService | undefined;
let connectionConsumerService: ConnectionConsumerService | undefined;
let oauthAuthorizationService: OAuthAuthorizationService | undefined;
let capabilityProfileRegistry: CapabilityProfileRegistry | undefined;
let sourcePolicyResolver: StoredSourcePolicyResolver | undefined;
let routineService: RoutineService | undefined;
let thingService: ThingService | undefined;

const noExecutions: ExecutionController = {
  stop: async () => {
    throw new Error('execution control is not available in this Lambda');
  },
};

export function getRunService(enableExecutionControl = false): RunService {
  if (enableExecutionControl && controlService) return controlService;
  if (!enableExecutionControl && submissionService) return submissionService;
  const base = getBaseServices();
  const service = new RunService({
    store: base.store,
    artifacts: base.artifacts,
    queue: base.queue,
    executions: enableExecutionControl ? createExecutorRegistryFromEnv() : noExecutions,
    allowedRepositoryHosts: csv(process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com'),
    allowedSandboxModes: sandboxModes(
      process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write,danger-full-access',
    ),
    retentionSeconds: Number(process.env.RUN_RETENTION_SECONDS ?? 2_592_000),
  });
  if (enableExecutionControl) controlService = service;
  else submissionService = service;
  return service;
}

export function getAgentInteractionController(): AgentInteractionController {
  agentInteractionController ??= createAgentInteractionControllerFromEnv();
  return agentInteractionController;
}

export function getRunSubmissionService(): RunSubmissionService {
  runSubmissionService ??= new RunSubmissionService(
    getRunService(false),
    getConversationSubmissionService(),
  );
  return runSubmissionService;
}

export function getIntegrationPluginRegistry(): IntegrationPluginRegistry {
  integrationPluginRegistry ??= new IntegrationPluginRegistry(createBuiltinIntegrationPlugins());
  return integrationPluginRegistry;
}

function getIntegrationStore(): DynamoIntegrationStore {
  integrationStore ??= new DynamoIntegrationStore(
    getBaseServices().clients.dynamodb,
    requiredEnv('INTEGRATIONS_TABLE_NAME'),
  );
  return integrationStore;
}

function getOAuthApplicationRegistry(): SecretOAuthApplicationRegistry {
  oauthApplicationRegistry ??= new SecretOAuthApplicationRegistry(
    new CachedSecretReader(getBaseServices().clients.secrets),
    parseOAuthApplicationSecretArns(process.env.INTEGRATION_OAUTH_APP_SECRET_ARNS),
  );
  return oauthApplicationRegistry;
}

function getOAuthCredentialBroker(): OAuthRefreshingCredentialBroker {
  if (oauthCredentialBroker) return oauthCredentialBroker;
  const base = getBaseServices();
  oauthCredentialBroker = new OAuthRefreshingCredentialBroker({
    credentials: base.credentials,
    vault: new SecretsManagerCredentialVault(
      base.clients.secrets,
      process.env.INTEGRATION_CREDENTIAL_KMS_KEY_ARN,
    ),
    registry: getIntegrationPluginRegistry(),
    applications: getOAuthApplicationRegistry(),
    store: new DynamoOAuthAuthorizationStore(
      base.clients.dynamodb,
      requiredEnv('INTEGRATIONS_TABLE_NAME'),
    ),
  });
  return oauthCredentialBroker;
}

function getIntegrationRuntime(): IntegrationRuntime {
  integrationRuntime ??= new IntegrationRuntime({
    registry: getIntegrationPluginRegistry(),
    store: getIntegrationStore(),
    credentials: getOAuthCredentialBroker(),
  });
  return integrationRuntime;
}

export function getCapabilityProfileRegistry(): CapabilityProfileRegistry {
  capabilityProfileRegistry ??= new CapabilityProfileRegistry(createBuiltinCapabilityProfiles());
  return capabilityProfileRegistry;
}

export function getSourcePolicyResolver(): StoredSourcePolicyResolver {
  sourcePolicyResolver ??= new StoredSourcePolicyResolver(getIntegrationStore());
  return sourcePolicyResolver;
}

export function getConnectionService(): ConnectionService {
  if (connectionService) return connectionService;
  const base = getBaseServices();
  connectionService = new ConnectionService({
    store: getIntegrationStore(),
    vault: new SecretsManagerCredentialVault(
      base.clients.secrets,
      process.env.INTEGRATION_CREDENTIAL_KMS_KEY_ARN,
    ),
    registry: getIntegrationPluginRegistry(),
    credentials: getOAuthCredentialBroker(),
    credentialNamePrefix: requiredEnv('INTEGRATION_CREDENTIAL_NAME_PREFIX'),
  });
  return connectionService;
}

export function getConnectionConsumerService(): ConnectionConsumerService {
  connectionConsumerService ??= new ConnectionConsumerService({
    connections: getConnectionService(),
    things: getThingService(),
    routines: getRoutineService(),
  });
  return connectionConsumerService;
}

export function getOAuthAuthorizationService(): OAuthAuthorizationService {
  if (oauthAuthorizationService) return oauthAuthorizationService;
  const base = getBaseServices();
  oauthAuthorizationService = new OAuthAuthorizationService({
    registry: getIntegrationPluginRegistry(),
    applications: getOAuthApplicationRegistry(),
    store: new DynamoOAuthAuthorizationStore(
      base.clients.dynamodb,
      requiredEnv('INTEGRATIONS_TABLE_NAME'),
    ),
    connections: getConnectionService(),
  });
  return oauthAuthorizationService;
}

export function getRoutineService(): RoutineService {
  if (routineService) return routineService;
  const base = getBaseServices();
  routineService = new RoutineService({
    store: new DynamoRoutineStore(
      base.clients.dynamodb,
      requiredEnv('ROUTINES_TABLE_NAME'),
    ),
    artifacts: base.artifacts,
    runs: getRunSubmissionService(),
    allowedRepositoryHosts: csv(process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com'),
    allowedSandboxModes: sandboxModes(
      process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write,danger-full-access',
    ),
  });
  return routineService;
}

export function getThingService(): ThingService {
  if (thingService) return thingService;
  const base = getBaseServices();
  thingService = new ThingService({
    store: new DynamoThingStore(
      base.clients.dynamodb,
      requiredEnv('THINGS_TABLE_NAME'),
    ),
    artifacts: base.definitions,
    runs: getRunSubmissionService(),
    scheduler: process.env.THING_SCHEDULER_MODE === 'simulation'
      ? {
        upsert: async () => undefined,
        remove: async () => undefined,
      }
      : new EventBridgeThingScheduler(base.clients.scheduler, {
        groupName: requiredEnv('THING_SCHEDULE_GROUP_NAME'),
        targetArn: requiredEnv('THING_SCHEDULE_TARGET_ARN'),
        executionRoleArn: requiredEnv('THING_SCHEDULE_ROLE_ARN'),
        ...(process.env.THING_SCHEDULE_DLQ_ARN
          ? { deadLetterArn: process.env.THING_SCHEDULE_DLQ_ARN }
          : {}),
      }),
    allowedRepositoryHosts: csv(process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com'),
    allowedSandboxModes: sandboxModes(
      process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write,danger-full-access',
    ),
  });
  return thingService;
}

export function getPluginRegistry(): RuntimePluginRegistry {
  if (pluginRegistry) return pluginRegistry;
  const credentials = getBaseServices().credentials;
  pluginRegistry = new RuntimePluginRegistry(createBuiltinPlugins(credentials, {
    github: {
      webhookSecretArn: process.env.GITHUB_WEBHOOK_SECRET_ARN,
      cloneTokenSecretArn: process.env.GITHUB_CLONE_TOKEN_SECRET_ARN ?? process.env.GITHUB_TOKEN_SECRET_ARN,
      notifyTokenSecretArn: process.env.GITHUB_NOTIFY_TOKEN_SECRET_ARN ?? process.env.GITHUB_TOKEN_SECRET_ARN,
      commentTrigger: process.env.GITHUB_COMMENT_TRIGGER ?? '@rat-things',
      apiBaseUrl: process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
    },
    gitlab: {
      webhookSecretArn: process.env.GITLAB_WEBHOOK_SECRET_ARN,
      cloneTokenSecretArn: process.env.GITLAB_CLONE_TOKEN_SECRET_ARN ?? process.env.GITLAB_TOKEN_SECRET_ARN,
      notifyTokenSecretArn: process.env.GITLAB_NOTIFY_TOKEN_SECRET_ARN ?? process.env.GITLAB_TOKEN_SECRET_ARN,
      commentTrigger: process.env.GITLAB_COMMENT_TRIGGER ?? '@rat-things',
      apiBaseUrl: process.env.GITLAB_API_BASE_URL ?? 'https://gitlab.com/api/v4',
    },
    teams: {
      webhookSecretArn: process.env.TEAMS_OUTGOING_WEBHOOK_SECRET_ARN,
      deliveryMode: teamsDeliveryMode(process.env.TEAMS_DELIVERY_MODE),
      workflowUrlSecretArn: process.env.TEAMS_WORKFLOW_URL_SECRET_ARN,
      replyGatewayUrlSecretArn: process.env.TEAMS_REPLY_GATEWAY_URL_SECRET_ARN,
      routes: stringMap(process.env.TEAMS_ROUTES_JSON),
    },
    slack: {
      signingSecretArn: process.env.SLACK_SIGNING_SECRET_ARN,
      botTokenSecretArn: process.env.SLACK_BOT_TOKEN_SECRET_ARN,
      connectionPoster: {
        post: async ({ ownerId, request, channel, text, threadTs }) => {
          const session = await getIntegrationRuntime().prepare({ ownerId, request });
          return session.call({
            namespace: 'slack',
            tool: 'messages_post',
            arguments: {
              input: {
                channel,
                text,
                ...(threadTs ? { threadTs } : {}),
              },
            },
          });
        },
      },
    },
  }));
  return pluginRegistry;
}

export function getWebhookIngressService(): WebhookIngressService {
  ingressService ??= new WebhookIngressService(
    getPluginRegistry(),
    getRunSubmissionService(),
    getSourcePolicyResolver(),
  );
  return ingressService;
}

export function getConversationSubmissionService(): ConversationSubmissionService {
  if (conversationSubmissionService) return conversationSubmissionService;
  conversationSubmissionService = new ConversationSubmissionService(
    getConversationService(),
    getBaseServices().conversationQueue,
    getRunService(false),
  );
  return conversationSubmissionService;
}

export function getDeliveryService(): DeliveryService {
  if (deliveryService) return deliveryService;
  const base = getBaseServices();
  const tableName = requiredEnv('RUNS_TABLE_NAME');
  deliveryService = new DeliveryService({
    store: base.store,
    artifacts: base.artifacts,
    results: new S3ResultReader(base.clients.s3),
    fence: new DynamoDeliveryFence(base.clients.dynamodb, tableName),
    plugins: getPluginRegistry(),
    defaultDestinations: defaultDestinations(process.env.DEFAULT_DELIVERY_DESTINATIONS ?? 'source'),
  });
  return deliveryService;
}

export function getConversationService(): ConversationService {
  if (conversationService) return conversationService;
  const base = getBaseServices();
  conversationService = new ConversationService({
    store: base.conversations,
    artifacts: base.artifacts,
    retentionSeconds: Number(process.env.RUN_RETENTION_SECONDS ?? 2_592_000),
  });
  return conversationService;
}

function getBaseServices(): BaseServices {
  if (baseServices) return baseServices;
  const clients = createAwsClients();
  const secretReader = new CachedSecretReader(clients.secrets);
  baseServices = {
    clients,
    store: new DynamoRunStore(clients.dynamodb, requiredEnv('RUNS_TABLE_NAME')),
    conversations: new DynamoConversationStore(
      clients.dynamodb,
      requiredEnv('CONVERSATIONS_TABLE_NAME'),
    ),
    artifacts: new S3ArtifactStore(clients.s3, requiredEnv('ARTIFACT_BUCKET')),
    definitions: new S3ArtifactStore(
      clients.s3,
      requiredEnv('DEFINITION_BUCKET'),
      process.env.DEFINITION_KMS_KEY_ARN
        ? { algorithm: 'aws:kms', kmsKeyId: process.env.DEFINITION_KMS_KEY_ARN }
        : { algorithm: 'AES256' },
    ),
    queue: new SqsRunQueue(clients.sqs, requiredEnv('RUN_QUEUE_URL')),
    conversationQueue: new SqsConversationQueue(
      clients.sqs,
      requiredEnv('CONVERSATION_QUEUE_URL'),
    ),
    credentials: new CredentialBroker(secretReader),
  };
  return baseServices;
}

function csv(value: string): string[] {
  return value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function sandboxModes(value: string): SandboxMode[] {
  const modes = csv(value);
  if (modes.length === 0 || modes.some((mode) => !['read-only', 'workspace-write', 'danger-full-access'].includes(mode))) {
    throw new Error('ALLOWED_SANDBOX_MODES contains an invalid value');
  }
  return modes as SandboxMode[];
}

function defaultDestinations(value: string): RunDestination[] {
  return value
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind): kind is RunDestination['kind'] => ['source', 'teams', 'slack', 'none'].includes(kind))
    .map((kind) => ({ kind }));
}

function stringMap(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TEAMS_ROUTES_JSON must be an object');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== 'string' || !item)) {
    throw new Error('TEAMS_ROUTES_JSON values must be secret ARN strings');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function teamsDeliveryMode(value: string | undefined): TeamsDeliveryMode {
  const mode = value ?? 'workflow';
  if (mode !== 'workflow' && mode !== 'threaded-gateway') {
    throw new Error('TEAMS_DELIVERY_MODE must be workflow or threaded-gateway');
  }
  return mode;
}
