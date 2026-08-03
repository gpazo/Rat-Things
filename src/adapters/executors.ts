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
}

export class MicrovmRunExecutor implements RunExecutor {
  public readonly backend = 'microvm' as const;
  private imageArn?: string;
  private imageVersion?: string;

  public constructor(
    private readonly client: LambdaMicrovmsClient,
    private readonly ssm: SSMClient,
    private readonly options: MicrovmExecutorOptions,
  ) {}

  public async start(record: RunRecord, request: RunRequest, traceId: string): Promise<ExecutionReference> {
    const timeout = request.execution?.timeoutSeconds ?? 900;
    const imageArn = await this.parameter('image');
    const imageVersion = await this.parameter('version');
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
      // RunMicrovm client tokens are limited to printable ASCII and 64 characters.
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

  private async parameter(kind: 'image' | 'version'): Promise<string> {
    const cached = kind === 'image' ? this.imageArn : this.imageVersion;
    if (cached) return cached;
    const name = kind === 'image'
      ? this.options.imageParameterName
      : this.options.imageVersionParameterName;
    const result = await this.ssm.send(new GetParameterCommand({ Name: name }));
    const value = result.Parameter?.Value;
    if (!value || value === 'UNPROVISIONED') {
      throw new Error(`Lambda MicroVM ${kind} is not provisioned; apply Terraform with enable_microvm=true`);
    }
    if (kind === 'image') this.imageArn = value;
    else this.imageVersion = value;
    return value;
  }
}

export function createExecutorRegistryFromEnv(): ExecutionRegistry {
  const region = requiredEnv('AWS_REGION');
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
    },
  );
  return new ExecutionRegistry([microvm]);
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}
