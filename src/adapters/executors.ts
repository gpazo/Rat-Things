import { createHash } from 'node:crypto';
import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type {
  ExecutionBackend,
  ExecutionReference,
  RunRecord,
  RunRequest,
} from '../domain/contracts.js';
import type { ExecutionController } from '../core/ports.js';

export interface RunExecutor {
  readonly backend: ExecutionBackend;
  start(record: RunRecord, request: RunRequest, traceId: string): Promise<ExecutionReference>;
  stop(id: string, reason: string): Promise<void>;
}

export interface EcsExecutorOptions {
  clusterArn: string;
  taskDefinitionArn: string;
  containerName: string;
  subnetIds: string[];
  securityGroupIds: string[];
  assignPublicIp: boolean;
  runsTableName: string;
  artifactBucket: string;
  eventBusName: string;
  region: string;
}

export class EcsRunExecutor implements RunExecutor {
  public readonly backend = 'ecs' as const;

  public constructor(
    private readonly client: ECSClient,
    private readonly options: EcsExecutorOptions,
  ) {}

  public async start(record: RunRecord, request: RunRequest, traceId: string): Promise<ExecutionReference> {
    const timeout = request.execution?.timeoutSeconds ?? 900;
    const result = await this.client.send(
      new RunTaskCommand({
        cluster: this.options.clusterArn,
        taskDefinition: this.options.taskDefinitionArn,
        clientToken: record.runId,
        launchType: 'FARGATE',
        count: 1,
        enableExecuteCommand: false,
        startedBy: `agent-${record.runId}`.slice(0, 36),
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.options.subnetIds,
            securityGroups: this.options.securityGroupIds,
            assignPublicIp: this.options.assignPublicIp ? 'ENABLED' : 'DISABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: this.options.containerName,
              environment: environmentOverrides({
                RUN_ID: record.runId,
                RUN_INPUT_BUCKET: record.input.bucket,
                RUN_INPUT_KEY: record.input.key,
                RUNS_TABLE_NAME: this.options.runsTableName,
                ARTIFACT_BUCKET: this.options.artifactBucket,
                EVENT_BUS_NAME: this.options.eventBusName,
                RUN_TIMEOUT_SECONDS: String(timeout),
                // RunTask idempotency requires every parameter paired with clientToken to remain
                // identical. A queue/reconciler trace can change, so use the stable run ID here.
                TRACE_ID: record.runId,
                AWS_REGION: this.options.region,
                AWS_DEFAULT_REGION: this.options.region,
              }),
            },
          ],
        },
        tags: [
          { key: 'run_id', value: record.runId },
          {
            key: 'owner_hash',
            value: createHash('sha256').update(record.ownerId).digest('hex').slice(0, 32),
          },
          { key: 'source', value: record.sourceKind },
        ],
        propagateTags: 'TASK_DEFINITION',
      }),
    );
    const failure = result.failures?.[0];
    if (failure) throw new Error(`ECS RunTask failed: ${failure.reason ?? failure.detail ?? 'unknown'}`);
    const taskArn = result.tasks?.[0]?.taskArn;
    if (!taskArn) throw new Error('ECS RunTask returned no task ARN');
    return { backend: 'ecs', id: taskArn };
  }

  public async stop(id: string, reason: string): Promise<void> {
    await this.client.send(
      new StopTaskCommand({
        cluster: this.options.clusterArn,
        task: id,
        reason: reason.slice(0, 255),
      }),
    );
  }
}

export interface MicrovmExecutorOptions {
  imageParameterName: string;
  imageVersionParameterName: string;
  connectorParameterName: string;
  executionRoleArn: string;
  logGroupName: string;
  runsTableName: string;
  artifactBucket: string;
  eventBusName: string;
  region: string;
  allowedRepositoryHosts: string;
  allowedSandboxModes: string;
  defaultAgentDriver: string;
  defaultModel?: string;
  bedrockApiKeySecretArn?: string;
  allowAgentAwsCredentialChain: boolean;
}

export class MicrovmRunExecutor implements RunExecutor {
  public readonly backend = 'microvm' as const;
  private imageArn?: string;
  private imageVersion?: string;
  private connectorArn?: string;

  public constructor(
    private readonly client: LambdaMicrovmsClient,
    private readonly ssm: SSMClient,
    private readonly options: MicrovmExecutorOptions,
  ) {}

  public async start(record: RunRecord, request: RunRequest, traceId: string): Promise<ExecutionReference> {
    const timeout = request.execution?.timeoutSeconds ?? 900;
    const imageArn = await this.parameter('image');
    const imageVersion = await this.parameter('version');
    const connectorArn = await this.parameter('connector');
    const runHookPayload = JSON.stringify({
      version: 1,
      runId: record.runId,
      inputBucket: record.input.bucket,
      inputKey: record.input.key,
      runsTableName: this.options.runsTableName,
      artifactBucket: this.options.artifactBucket,
      eventBusName: this.options.eventBusName,
      region: this.options.region,
      timeoutSeconds: timeout,
      // RunMicrovm has the same client-token constraint as ECS RunTask.
      traceId: record.runId,
      allowedRepositoryHosts: this.options.allowedRepositoryHosts,
      allowedSandboxModes: this.options.allowedSandboxModes,
      defaultAgentDriver: this.options.defaultAgentDriver,
      ...(this.options.defaultModel ? { defaultModel: this.options.defaultModel } : {}),
      ...(this.options.bedrockApiKeySecretArn
        ? { bedrockApiKeySecretArn: this.options.bedrockApiKeySecretArn }
        : {}),
      allowAgentAwsCredentialChain: this.options.allowAgentAwsCredentialChain,
    });
    if (Buffer.byteLength(runHookPayload) > 4_096) {
      throw new Error('Lambda MicroVM run hook payload exceeds 4096 bytes');
    }
    const result = await this.client.send(
      new RunMicrovmCommand({
        imageIdentifier: imageArn,
        imageVersion,
        egressNetworkConnectors: [connectorArn],
        executionRoleArn: this.options.executionRoleArn,
        logging: { cloudWatch: { logGroup: this.options.logGroupName } },
        runHookPayload,
        maximumDurationInSeconds: Math.min(28_800, timeout + 300),
        clientToken: record.runId,
      }),
    );
    if (!result.microvmId) throw new Error('RunMicrovm returned no MicroVM ID');
    return { backend: 'microvm', id: result.microvmId };
  }

  public async stop(id: string): Promise<void> {
    await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
  }

  private async parameter(kind: 'image' | 'version' | 'connector'): Promise<string> {
    const cached = kind === 'image'
      ? this.imageArn
      : kind === 'version'
        ? this.imageVersion
        : this.connectorArn;
    if (cached) return cached;
    const name = kind === 'image'
      ? this.options.imageParameterName
      : kind === 'version'
        ? this.options.imageVersionParameterName
        : this.options.connectorParameterName;
    const result = await this.ssm.send(new GetParameterCommand({ Name: name }));
    const value = result.Parameter?.Value;
    if (!value || value === 'UNPROVISIONED') {
      throw new Error(`Lambda MicroVM ${kind} is not provisioned; apply Terraform with enable_microvm=true`);
    }
    if (kind === 'image') this.imageArn = value;
    else if (kind === 'version') this.imageVersion = value;
    else this.connectorArn = value;
    return value;
  }
}

export class ExecutorRegistry implements ExecutionController {
  private readonly executors: Map<ExecutionBackend, RunExecutor>;

  public constructor(executors: RunExecutor[]) {
    this.executors = new Map(executors.map((executor) => [executor.backend, executor]));
  }

  public get(backend: ExecutionBackend): RunExecutor {
    const executor = this.executors.get(backend);
    if (!executor) throw new Error(`execution backend ${backend} is not enabled`);
    return executor;
  }

  public stop(execution: ExecutionReference, reason: string): Promise<void> {
    return this.get(execution.backend).stop(execution.id, reason);
  }
}

export function createExecutorRegistryFromEnv(): ExecutorRegistry {
  const region = requiredEnv('AWS_REGION');
  const ecs = new EcsRunExecutor(new ECSClient({ region }), {
    clusterArn: requiredEnv('ECS_CLUSTER_ARN'),
    taskDefinitionArn: requiredEnv('ECS_TASK_DEFINITION_ARN'),
    containerName: requiredEnv('ECS_CONTAINER_NAME'),
    subnetIds: csv(requiredEnv('ECS_SUBNET_IDS')),
    securityGroupIds: csv(requiredEnv('ECS_SECURITY_GROUP_IDS')),
    assignPublicIp: process.env.ECS_ASSIGN_PUBLIC_IP === 'true',
    runsTableName: requiredEnv('RUNS_TABLE_NAME'),
    artifactBucket: requiredEnv('ARTIFACT_BUCKET'),
    eventBusName: requiredEnv('EVENT_BUS_NAME'),
    region,
  });
  const executors: RunExecutor[] = [ecs];
  if (process.env.MICROVM_ENABLED === 'true') {
    executors.push(
      new MicrovmRunExecutor(new LambdaMicrovmsClient({ region }), new SSMClient({ region }), {
        imageParameterName: requiredEnv('MICROVM_IMAGE_PARAMETER_NAME'),
        imageVersionParameterName: requiredEnv('MICROVM_IMAGE_VERSION_PARAMETER_NAME'),
        connectorParameterName: requiredEnv('MICROVM_CONNECTOR_PARAMETER_NAME'),
        executionRoleArn: requiredEnv('MICROVM_EXECUTION_ROLE_ARN'),
        logGroupName: requiredEnv('MICROVM_LOG_GROUP_NAME'),
        runsTableName: requiredEnv('RUNS_TABLE_NAME'),
        artifactBucket: requiredEnv('ARTIFACT_BUCKET'),
        eventBusName: requiredEnv('EVENT_BUS_NAME'),
        region,
        allowedRepositoryHosts: process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com',
        allowedSandboxModes: process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write',
        defaultAgentDriver: process.env.DEFAULT_AGENT_DRIVER ?? 'codex',
        ...(process.env.DEFAULT_MODEL ? { defaultModel: process.env.DEFAULT_MODEL } : {}),
        ...(process.env.BEDROCK_API_KEY_SECRET_ARN
          ? { bedrockApiKeySecretArn: process.env.BEDROCK_API_KEY_SECRET_ARN }
          : {}),
        allowAgentAwsCredentialChain: process.env.ALLOW_AGENT_AWS_CREDENTIAL_CHAIN === 'true',
      }),
    );
  }
  return new ExecutorRegistry(executors);
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

function csv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function environmentOverrides(values: Record<string, string>) {
  return Object.entries(values).map(([name, value]) => ({ name, value }));
}
