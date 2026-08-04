import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createHash } from 'node:crypto';
import type {
  ExecutionBackend,
  ExecutionReference,
  RunRecord,
  RunRequest,
} from '../domain/contracts.js';
import { ExecutionRegistry } from '../execution/registry.js';
import type { RunExecutor } from '../execution/types.js';

export type { RunExecutor } from '../execution/types.js';
export { ExecutionRegistry, ExecutionRegistry as ExecutorRegistry } from '../execution/registry.js';

export interface MicrovmExecutorOptions {
  imageParameterName: string;
  imageVersionParameterName: string;
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
  sessionIdleSeconds?: number;
  sessionSuspendedSeconds?: number;
  s3Files?: {
    networkConnectorArn: string;
    fileSystemId: string;
    accessPointId: string;
    mountTargetIp: string;
  };
}

class MicrovmSessionUnavailableError extends Error {}

export class MicrovmRunExecutor implements RunExecutor {
  public readonly backend = 'microvm' as const;
  private imageArn?: string;

  public constructor(
    private readonly client: LambdaMicrovmsClient,
    private readonly ssm: SSMClient,
    private readonly options: MicrovmExecutorOptions,
  ) {}

  public async start(record: RunRecord, request: RunRequest, traceId: string): Promise<ExecutionReference> {
    if (record.conversation?.preferredMicrovmId) {
      try {
        return await this.resumeAndStart(record, request, record.conversation.preferredMicrovmId);
      } catch (error) {
        if (!(error instanceof MicrovmSessionUnavailableError)) throw error;
      }
    }
    return this.launch(record, request);
  }

  private async launch(record: RunRecord, request: RunRequest): Promise<ExecutionReference> {
    const timeout = request.execution?.timeoutSeconds ?? 900;
    const imageArn = await this.parameter('image');
    const imageVersion = await this.parameter('version');
    const runHookPayload = this.runHookPayload(record, request, false);
    const persistent = Boolean(record.conversation);
    const result = await this.client.send(
      new RunMicrovmCommand({
        imageIdentifier: imageArn,
        imageVersion,
        executionRoleArn: this.options.executionRoleArn,
        ...(persistent && this.options.s3Files ? {
          egressNetworkConnectors: [this.options.s3Files.networkConnectorArn],
        } : {}),
        ...(persistent ? {
          ingressNetworkConnectors: [
            `arn:aws:lambda:${this.options.region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
          ],
        } : {}),
        logging: { cloudWatch: { logGroup: this.options.logGroupName } },
        runHookPayload,
        ...(persistent ? {
          idlePolicy: {
            autoResumeEnabled: true,
            maxIdleDurationSeconds: this.options.sessionIdleSeconds ?? 1_200,
            suspendedDurationSeconds: this.options.sessionSuspendedSeconds ?? 21_600,
          },
        } : {}),
        maximumDurationInSeconds: persistent ? 28_800 : Math.min(28_800, timeout + 300),
        clientToken: record.runId,
      }),
    );
    if (!result.microvmId) throw new Error('RunMicrovm returned no MicroVM ID');
    return { backend: 'microvm', id: result.microvmId };
  }

  private async resumeAndStart(
    record: RunRecord,
    request: RunRequest,
    microvmId: string,
  ): Promise<ExecutionReference> {
    let microvm;
    try {
      microvm = await this.client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
    } catch (error) {
      if (isUnavailableSessionError(error)) throw new MicrovmSessionUnavailableError();
      throw error;
    }
    if (microvm.state === 'TERMINATED' || microvm.state === 'TERMINATING') {
      throw new MicrovmSessionUnavailableError();
    }
    if (microvm.state === 'SUSPENDED') {
      try {
        await this.client.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
      } catch (error) {
        if (isUnavailableSessionError(error)) throw new MicrovmSessionUnavailableError();
        throw error;
      }
    }
    const endpoint = microvm.endpoint;
    if (!endpoint) throw new MicrovmSessionUnavailableError();
    const tokenResult = await this.client.send(new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: 5,
      allowedPorts: [{ port: 8080 }],
    }));
    const token = tokenResult.authToken?.['X-aws-proxy-auth'];
    if (!token) throw new Error('CreateMicrovmAuthToken returned no proxy token');
    const response = await fetch(`${endpointUrl(endpoint)}/agent-runtime/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aws-proxy-auth': token,
        'x-aws-proxy-port': '8080',
      },
      body: JSON.stringify({ runHookPayload: this.runHookPayload(record, request, true) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 || response.status === 410) {
      throw new MicrovmSessionUnavailableError();
    }
    if (!response.ok) {
      throw new Error(`persistent MicroVM rejected run ${record.runId} with HTTP ${response.status}`);
    }
    return { backend: 'microvm', id: microvmId };
  }

  private runHookPayload(record: RunRecord, request: RunRequest, resuming: boolean): string {
    const payload = JSON.stringify({
      version: 1,
      runId: record.runId,
      inputBucket: record.input.bucket,
      inputKey: record.input.key,
      runsTableName: this.options.runsTableName,
      artifactBucket: this.options.artifactBucket,
      eventBusName: this.options.eventBusName,
      region: this.options.region,
      timeoutSeconds: request.execution?.timeoutSeconds ?? 900,
      // RunMicrovm client tokens are limited to printable ASCII and 64 characters.
      traceId: record.runId,
      allowedRepositoryHosts: this.options.allowedRepositoryHosts,
      allowedSandboxModes: this.options.allowedSandboxModes,
      defaultAgentDriver: this.options.defaultAgentDriver,
      persistentSession: Boolean(record.conversation),
      ...(record.conversation && this.options.s3Files ? {
        conversationStorageKey: createHash('sha256')
          .update(record.conversation.conversationId)
          .digest('hex'),
        s3FilesFileSystemId: this.options.s3Files.fileSystemId,
        s3FilesAccessPointId: this.options.s3Files.accessPointId,
        s3FilesMountTargetIp: this.options.s3Files.mountTargetIp,
      } : {}),
      ...((resuming || this.options.s3Files) && record.conversation?.agentThreadId
        ? { agentThreadId: record.conversation.agentThreadId }
        : {}),
      ...(this.options.defaultModel ? { defaultModel: this.options.defaultModel } : {}),
      ...(this.options.bedrockApiKeySecretArn
        ? { bedrockApiKeySecretArn: this.options.bedrockApiKeySecretArn }
        : {}),
      allowAgentAwsCredentialChain: this.options.allowAgentAwsCredentialChain,
    });
    if (Buffer.byteLength(payload) > 4_096) {
      throw new Error('Lambda MicroVM run hook payload exceeds 4096 bytes');
    }
    return payload;
  }

  public async stop(id: string): Promise<void> {
    await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
  }

  private async parameter(kind: 'image' | 'version'): Promise<string> {
    // The image ARN is stable, but the active version changes on every image
    // deployment. A warm dispatcher must not keep launching the version that
    // happened to be active during its first invocation.
    if (kind === 'image' && this.imageArn) return this.imageArn;
    const name = kind === 'image'
      ? this.options.imageParameterName
      : this.options.imageVersionParameterName;
    const result = await this.ssm.send(new GetParameterCommand({ Name: name }));
    const value = result.Parameter?.Value;
    if (!value || value === 'UNPROVISIONED') {
      throw new Error(`Lambda MicroVM ${kind} is not provisioned; apply Terraform with enable_microvm=true`);
    }
    if (kind === 'image') this.imageArn = value;
    return value;
  }
}

export class MicrovmSessionController {
  public constructor(private readonly client: LambdaMicrovmsClient) {}

  public async suspend(id: string): Promise<void> {
    try {
      await this.client.send(new SuspendMicrovmCommand({ microvmIdentifier: id }));
    } catch (error) {
      if (!isUnavailableSessionError(error) && errorName(error) !== 'ConflictException') throw error;
    }
  }
}

export function createExecutorRegistryFromEnv(): ExecutionRegistry {
  const region = requiredEnv('AWS_REGION');
  const s3Files = s3FilesOptionsFromEnv();
  const microvm = new MicrovmRunExecutor(
    new LambdaMicrovmsClient({ region }),
    new SSMClient({ region }),
    {
      imageParameterName: requiredEnv('MICROVM_IMAGE_PARAMETER_NAME'),
      imageVersionParameterName: requiredEnv('MICROVM_IMAGE_VERSION_PARAMETER_NAME'),
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
      sessionIdleSeconds: Number(process.env.MICROVM_SESSION_IDLE_SECONDS ?? 1_200),
      sessionSuspendedSeconds: Number(process.env.MICROVM_SESSION_SUSPENDED_SECONDS ?? 21_600),
      ...(s3Files ? { s3Files } : {}),
    },
  );
  return new ExecutionRegistry([microvm]);
}

function s3FilesOptionsFromEnv(): NonNullable<MicrovmExecutorOptions['s3Files']> | undefined {
  if (process.env.S3_FILES_ENABLED !== 'true') return undefined;
  return {
    networkConnectorArn: requiredEnv('MICROVM_VPC_NETWORK_CONNECTOR_ARN'),
    fileSystemId: requiredEnv('S3_FILES_FILE_SYSTEM_ID'),
    accessPointId: requiredEnv('S3_FILES_ACCESS_POINT_ID'),
    mountTargetIp: requiredEnv('S3_FILES_MOUNT_TARGET_IP'),
  };
}

function endpointUrl(value: string): string {
  return value.startsWith('https://') ? value.replace(/\/$/, '') : `https://${value.replace(/\/$/, '')}`;
}

function isUnavailableSessionError(error: unknown): boolean {
  return ['ResourceNotFoundException', 'GoneException'].includes(errorName(error));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}
