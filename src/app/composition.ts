import { GetObjectCommand } from '@aws-sdk/client-s3';
import { SessionPublicationService } from '../core/session-publication-service.js';
import { S3PublicationObjectStore, S3PublicationGrantStore } from '../adapters/aws-runtime.js';
import { ScheduleService } from '../core/schedule-service.js';
import { EventBridgeSessionScheduler } from '../adapters/eventbridge-session-scheduler.js';
import { SessionIntegrationService } from '../core/session-integration-service.js';
import { SessionDeliveryService } from '../delivery/session-delivery.js';
import {
  CachedSecretReader,
  createAwsClients,
  DynamoRunStore,
  S3ArtifactStore,
  S3ResultReader,
  SqsRunQueue,
  type AwsClients,
} from '../adapters/aws-runtime.js';
import { DynamoIntegrationStore } from '../adapters/dynamo-integration-store.js';
import { DynamoOAuthAuthorizationStore } from '../adapters/dynamo-oauth-store.js';
import { SecretsManagerCredentialVault } from '../adapters/secrets-credential-vault.js';
import { DynamoDeliveryFence } from '../adapters/dynamo-delivery-fence.js';
import {
  createAgentInteractionControllerFromEnv,
  createExecutorRegistryFromEnv,
  requiredEnv,
} from '../adapters/executors.js';
import { SessionRuntimeStore } from '../core/session-runtime-store.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { FileService } from '../core/file-service.js';
import { SkillService } from '../core/skill-service.js';
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
import { StoredSourceSessionResolver } from '../plugins/source-policies.js';
import { createBuiltinPlugins } from '../plugins/builtins.js';
import type { AgentInteractionController, ExecutionController } from '../core/ports.js';
import { RunService } from '../core/run-service.js';
import { AgentService } from '../core/agent-service.js';
import { ApiTokenService } from '../core/api-token-service.js';
import { VaultService } from '../core/vault-service.js';
import { EnvironmentTemplateService } from '../core/environment-template-service.js';
import { SessionService } from '../core/session-service.js';
import { RunSessionExecution } from './run-session-execution.js';
import { EnvironmentService } from '../core/environment-service.js';
import { SessionToolService } from '../core/session-tool-service.js';
import { SecretsSessionTools } from '../adapters/secrets-session-tools.js';
import { RelayEnvironmentFiles } from '../adapters/relay-environment-files.js';
import { SecretsEnvironmentCredentials } from '../adapters/secrets-environment-credentials.js';
import { DynamoAgentsStore } from '../adapters/dynamo-agents-store.js';
import { SessionEventStore } from '../core/session-event-store.js';
import { WebhookService } from '../core/webhook-service.js';
import { SecretsWebhooks } from '../adapters/secrets-webhooks.js';
import { HttpsWebhookTransport } from '../adapters/webhook-http.js';
import { SecretsAgentCredentials } from '../adapters/secrets-agent-credentials.js';
import { HttpOAuthRefreshClient } from '../adapters/oauth-refresh-client.js';

interface BaseServices {
  clients: AwsClients;
  store: DynamoRunStore;
  artifacts: S3ArtifactStore;
  definitions: S3ArtifactStore;
  queue: SqsRunQueue;
  credentials: CredentialBroker;
}

let baseServices: BaseServices | undefined;
let submissionService: RunService | undefined;
let controlService: RunService | undefined;
let pluginRegistry: RuntimePluginRegistry | undefined;
let ingressService: WebhookIngressService | undefined;
let deliveryService: DeliveryService | undefined;
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
let sourcePolicyResolver: StoredSourceSessionResolver | undefined;
let agentsApiServices: { store: SessionEventStore; tokens: ApiTokenService; agents: AgentService; vaults: VaultService; templates: EnvironmentTemplateService; environments: EnvironmentService; files: FileService; skills: SkillService; webhooks: WebhookService; readonly sessions: SessionService } | undefined;
let sessionIntegrationService: SessionIntegrationService | undefined;
let agentsSessionService: SessionService | undefined;
let apiTokenService: ApiTokenService | undefined;

/** Issuance needs only token storage, independently of execution and provider services. */
export function getApiTokenService() {
  if (apiTokenService) return apiTokenService;
  const clients = createAwsClients();
  const definitions = new S3ArtifactStore(clients.s3, requiredEnv('DEFINITION_BUCKET'),
    process.env.DEFINITION_KMS_KEY_ARN ? { algorithm: 'aws:kms', kmsKeyId: process.env.DEFINITION_KMS_KEY_ARN } : { algorithm: 'AES256' });
  apiTokenService = new ApiTokenService(new DynamoAgentsStore(clients.dynamodb, requiredEnv('AGENTS_TABLE_NAME'), definitions));
  return apiTokenService;
}

export function getAgentsApiServices() {
  if (agentsApiServices) return agentsApiServices;
  const base = getBaseServices();
  const store = new SessionEventStore(new DynamoAgentsStore(base.clients.dynamodb, requiredEnv('AGENTS_TABLE_NAME'), base.definitions));
  const environmentCredentials = new SecretsEnvironmentCredentials(base.clients.secrets, requiredEnv('INTEGRATION_CREDENTIAL_NAME_PREFIX'), requiredEnv('INTEGRATION_CREDENTIAL_KMS_KEY_ARN'));
  const templates = new EnvironmentTemplateService({ store });
  const files = new FileService({ store, artifacts: base.artifacts });
  const skills = new SkillService({ store, artifacts: base.artifacts });
  agentsApiServices = {
    store,
    webhooks: new WebhookService({ store, transport: new HttpsWebhookTransport(), secrets: new SecretsWebhooks(base.clients.secrets, requiredEnv('INTEGRATION_CREDENTIAL_NAME_PREFIX'), requiredEnv('INTEGRATION_CREDENTIAL_KMS_KEY_ARN')) }),
    tokens: getApiTokenService(),
    agents: new AgentService({ store }),
    templates,
    files, skills,
    environments: new EnvironmentService({ store, credentials: environmentCredentials, templates, uploadedFiles: files, skills, fileContent: (owner, id) => files.bytes(owner, id),
      managedFiles: async (ownerId, sessionId, operation) => {
        const runtime = await new SessionRuntimeStore(store).get(ownerId, sessionId);
        if (!runtime || runtime.value.closed) throw new AgentsApiError(503, 'The environment is unavailable.', 'environment_unavailable');
        const run = await getRunService().get(ownerId, runtime.value.runId);
        const controller = getAgentInteractionController();
        if (run.status !== 'running' || !run.execution || !controller.environmentFiles) throw new AgentsApiError(503, 'The environment is unavailable.', 'environment_unavailable');
        return controller.environmentFiles({ runId: run.runId, execution: run.execution }, operation);
      },
      ...(process.env.AGENTS_ENVIRONMENT_RELAY_URL ? { relayURL: process.env.AGENTS_ENVIRONMENT_RELAY_URL, fileOperations: new RelayEnvironmentFiles(environmentCredentials, process.env.AGENTS_ENVIRONMENT_RELAY_URL) } : {}),
    }),
    vaults: new VaultService({ store, oauth: new HttpOAuthRefreshClient(), secrets: new SecretsAgentCredentials(
      base.clients.secrets, requiredEnv('INTEGRATION_CREDENTIAL_NAME_PREFIX'), requiredEnv('INTEGRATION_CREDENTIAL_KMS_KEY_ARN'),
    ) }),
    get sessions(): SessionService {
      agentsSessionService ??= new SessionService({
        store, agents: this.agents,
        execution: new RunSessionExecution({
          store,
          backend: process.env.DEFAULT_EXECUTION_BACKEND === 'ec2' ? 'ec2' : 'microvm',
          runs: getRunService(true), interaction: getAgentInteractionController(),
          artifacts: base.artifacts, vaults: this.vaults, environments: this.environments,
          tools: new SessionToolService({ store, vaults: this.vaults, secrets: new SecretsSessionTools(
            base.clients.secrets, requiredEnv('INTEGRATION_CREDENTIAL_NAME_PREFIX'), requiredEnv('INTEGRATION_CREDENTIAL_KMS_KEY_ARN'),
          ) }),
        }),
      });
      return agentsSessionService;
    },
  };
  return agentsApiServices;
}

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

export function getSourceSessionResolver(): StoredSourceSessionResolver {
  sourcePolicyResolver ??= new StoredSourceSessionResolver(getIntegrationStore());
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
    store: getAgentsApiServices().store,
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
    getSessionIntegrationService(),
    getSourceSessionResolver(),
  );
  return ingressService;
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

function getBaseServices(): BaseServices {
  if (baseServices) return baseServices;
  const clients = createAwsClients();
  const secretReader = new CachedSecretReader(clients.secrets);
  baseServices = {
    clients,
    store: new DynamoRunStore(clients.dynamodb, requiredEnv('RUNS_TABLE_NAME'), Number(process.env.RUN_RETENTION_SECONDS ?? 2_592_000)),
    artifacts: new S3ArtifactStore(clients.s3, requiredEnv('ARTIFACT_BUCKET')),
    definitions: new S3ArtifactStore(
      clients.s3,
      requiredEnv('DEFINITION_BUCKET'),
      process.env.DEFINITION_KMS_KEY_ARN
        ? { algorithm: 'aws:kms', kmsKeyId: process.env.DEFINITION_KMS_KEY_ARN }
        : { algorithm: 'AES256' },
    ),
    queue: new SqsRunQueue(clients.sqs, requiredEnv('RUN_QUEUE_URL')),
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

export function getSessionIntegrationService(): SessionIntegrationService {
  sessionIntegrationService ??= new SessionIntegrationService({ store: getAgentsApiServices().store, sessions: getAgentsApiServices().sessions, delivery: new SessionDeliveryService(getDeliveryService()), allowedRepositoryHosts: csv(process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com') });
  return sessionIntegrationService;
}

let scheduleService: ScheduleService | undefined;
export function getScheduleService(): ScheduleService {
  const services = getAgentsApiServices();
  scheduleService ??= new ScheduleService({ store: services.store, sessions: services.sessions, integrations: getSessionIntegrationService(),
    scheduler: process.env.THING_SCHEDULER_MODE === 'simulation' ? { upsert: async () => {}, remove: async () => {} } : new EventBridgeSessionScheduler(getBaseServices().clients.scheduler, {
      groupName: requiredEnv('THING_SCHEDULE_GROUP_NAME'), targetArn: requiredEnv('THING_SCHEDULE_TARGET_ARN'), executionRoleArn: requiredEnv('THING_SCHEDULE_ROLE_ARN'),
      ...(process.env.THING_SCHEDULE_DLQ_ARN ? { deadLetterArn: process.env.THING_SCHEDULE_DLQ_ARN } : {}),
    }),
    validateTarget: async (ownerId, target) => {
      await services.agents.retrieve(ownerId, target.agentId);
      await services.vaults.requireVaults(ownerId, target.vaultIds ?? []);
      if (target.environment.type === 'openai_hosted' && target.environment.environment_template_id) await services.templates.retrieve(ownerId, target.environment.environment_template_id);
      if (target.connectionSetId && !await getIntegrationStore().getConnectionSet(ownerId, target.connectionSetId)) throw new AgentsApiError(404, 'Connection set not found.', 'not_found');
    },
  });
  return scheduleService;
}

export function getSessionPublicationService(): SessionPublicationService {
  const clients = createAwsClients();
  const bucket = requiredEnv('ARTIFACT_BUCKET');
  return new SessionPublicationService({
    sessions: getAgentsApiServices().sessions,
    objects: new S3PublicationObjectStore(clients.s3, bucket),
    grants: new S3PublicationGrantStore(clients.s3, bucket),
    artifactBucket: bucket,
    baseDomain: requiredEnv('PUBLICATION_BASE_DOMAIN'),
    ttlSeconds: Number(process.env.ARTIFACT_URL_TTL_SECONDS ?? 86_400),
    readPrefix: async (reference) => {
      const response = await clients.s3.send(new GetObjectCommand({ Bucket: reference.bucket, Key: reference.key, Range: 'bytes=0-4095' }));
      if (!response.Body) throw new Error('Publication artifact content is missing');
      return response.Body.transformToByteArray();
    },
  });
}
