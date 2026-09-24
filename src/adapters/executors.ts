import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { EC2Client } from '@aws-sdk/client-ec2';
import { Ec2RunExecutor, Ec2ExecutionInspector } from './ec2-executor.js';
import { createEc2CommandTransport } from './execution-command-transport.js';
import type { ExecutionCommandRequest } from '../core/execution-command-planning.js';
import { runHookPayload as buildRunHookPayload, type MicrovmExecutorOptions } from './worker-launch.js';
export type { MicrovmExecutorOptions } from './worker-launch.js';
import type {
  ExecutionReference,
  RunRecord,
  RunRequest,
} from '../domain/contracts.js';
import type {
  AgentInteractionTarget,
  AgentRuntimeSnapshot,
} from '../domain/interaction.js';
import type { JsonValue } from '../domain/contracts.js';
import type { AgentInteractionController } from '../core/ports.js';
import { ExecutionRegistry } from '../execution/registry.js';
import { executionGeneration } from '../execution/generation.js';
import type { RunExecutor } from '../execution/types.js';
import type { ExecutionInspection, ExecutionInspector } from '../execution/reconciler.js';

export type { RunExecutor } from '../execution/types.js';
export { ExecutionRegistry } from '../execution/registry.js';

export interface MicrovmStartupObservation {
  mode: 'launch';
  outcome: 'succeeded' | 'failed';
  durationMs: number;
}
export class AgentInteractionUnavailableError extends Error {}

export class MicrovmRunExecutor implements RunExecutor {
  public readonly backend = 'microvm' as const;
  private imageArn?: string;

  public constructor(
    private readonly client: LambdaMicrovmsClient,
    private readonly ssm: SSMClient,
    private readonly options: MicrovmExecutorOptions,
  ) {}

  public async start(record: RunRecord, request: RunRequest, _traceId: string): Promise<ExecutionReference> {
    const startedAt = Date.now();
    try {
      const execution = await this.launch(record, request);
      this.observeStartup('launch', 'succeeded', startedAt);
      return execution;
    } catch (error) {
      this.observeStartup('launch', 'failed', startedAt);
      throw error;
    }
  }

  private async launch(record: RunRecord, request: RunRequest): Promise<ExecutionReference> {
    const timeout = request.execution?.timeoutSeconds ?? 900;
    const persistent = Boolean(record.agentsSession);
    const connector = persistent && this.options.s3Files ? this.options.s3Files.networkConnectorArn : undefined;
    if (persistent && this.options.s3Files && !connector) throw new Error('MicroVM Session storage requires a network connector.');
    const [imageArn, imageVersion] = await Promise.all([
      this.parameter('image'),
      this.parameter('version'),
    ]);
    const runHookPayload = buildRunHookPayload(record, request, this.options);
    const result = await this.client.send(
      new RunMicrovmCommand({
        imageIdentifier: imageArn,
        imageVersion,
        executionRoleArn: this.options.executionRoleArn,
        ...(connector ? {
          egressNetworkConnectors: [connector],
        } : {}),
        // The endpoint remains private behind an AWS-issued, port-scoped proxy
        // token. It carries lifecycle continuation and live agent control only.
        ingressNetworkConnectors: [
          `arn:aws:lambda:${this.options.region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
        ],
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
    return {
      backend: 'microvm',
      id: result.microvmId,
      generation: record.execution?.generation ?? executionGeneration(record),
    };
  }

  public async stop(id: string): Promise<void> {
    await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
  }

  private observeStartup(
    mode: MicrovmStartupObservation['mode'],
    outcome: MicrovmStartupObservation['outcome'],
    startedAt: number,
  ): void {
    try {
      this.options.onStartupObservation?.({
        mode,
        outcome,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch {
      // Telemetry must never change execution behavior.
    }
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

/** Proves both the AWS MicroVM state and the exact root-supervised worker generation. */
export class MicrovmExecutionInspector implements ExecutionInspector {
  public constructor(private readonly client: LambdaMicrovmsClient) {}

  public async inspect(runId: string, execution: ExecutionReference): Promise<ExecutionInspection> {
    if (execution.backend !== 'microvm' || !execution.generation) {
      return { kind: 'conflict', reason: 'execution identity is incomplete' };
    }
    let microvm;
    try {
      microvm = await this.client.send(new GetMicrovmCommand({ microvmIdentifier: execution.id }));
    } catch (error) {
      if (isUnavailableMicrovmError(error)) {
        return { kind: 'absent', reason: 'the attached MicroVM no longer exists' };
      }
      return { kind: 'unknown', reason: `could not describe attached MicroVM: ${safeError(error)}` };
    }
    if (microvm.state === 'TERMINATED' || microvm.state === 'TERMINATING') {
      return { kind: 'terminal', reason: `the attached MicroVM is ${microvm.state.toLowerCase()}` };
    }
    if (microvm.state !== 'RUNNING' || !microvm.endpoint) {
      return {
        kind: 'unknown',
        reason: `the attached MicroVM is ${microvm.state?.toLowerCase() ?? 'in an unknown state'}`,
      };
    }

    try {
      const tokenResult = await this.client.send(new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: execution.id,
        expirationInMinutes: 2,
        allowedPorts: [{ port: 8080 }],
      }));
      const token = tokenResult.authToken?.['X-aws-proxy-auth'];
      if (!token) return { kind: 'unknown', reason: 'AWS returned no MicroVM health-probe token' };
      const response = await fetch(
        `${endpointUrl(microvm.endpoint)}/agent-runtime/v1/runs/${encodeURIComponent(runId)}/health`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-aws-proxy-auth': token,
            'x-aws-proxy-port': '8080',
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      const body = parseJson(await response.text());
      if (response.status === 410) {
        return { kind: 'inactive', reason: 'the MicroVM has no active worker for the attached Run' };
      }
      if (response.status === 409) {
        return { kind: 'conflict', reason: 'the MicroVM reports a different active execution identity' };
      }
      if (!response.ok || !isRecord(body)) {
        return { kind: 'unknown', reason: `MicroVM health probe returned HTTP ${response.status}` };
      }
      if (
        body.active !== true ||
        body.workerConnected !== true ||
        body.runId !== runId ||
        body.generation !== execution.generation
      ) {
        return { kind: 'conflict', reason: 'the MicroVM health identity does not match the Run attachment' };
      }
      return { kind: 'active' };
    } catch (error) {
      return { kind: 'unknown', reason: `MicroVM health probe failed: ${safeError(error)}` };
    }
  }
}

export class MicrovmAgentInteractionController implements AgentInteractionController {
  public constructor(private readonly client: LambdaMicrovmsClient,
    private readonly ec2Request?: (target: AgentInteractionTarget, request: ExecutionCommandRequest) => Promise<unknown>) {}

  public environmentFiles(target: AgentInteractionTarget, operation: import('../core/environment-file-ports.js').EnvironmentFileOperation): Promise<unknown> {
    return this.request(target, `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/environment-files`, 'POST', operation);
  }

  public async startSessionTurn(target: AgentInteractionTarget, turn: import('../domain/agents-api.js').Turn, input: import('../domain/agents-api.js').AgentSessionInputMessageParam[], settings?: import('../domain/session-execution.js').SessionModelSettings): Promise<void> {
    await this.request(target, `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/session-start`, 'POST', { turn, input, settings });
  }

  public events(
    target: AgentInteractionTarget,
    after = 0,
    limit = 100,
  ): Promise<AgentRuntimeSnapshot> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/events?${query}`,
      'GET',
    ) as Promise<AgentRuntimeSnapshot>;
  }

  public async steer(target: AgentInteractionTarget & { turnId: string }, prompt: string, operationId?: string, input?: import('../domain/agents-api.js').AgentSessionInputMessageParam[]): Promise<void> {
    await this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/steer`,
      'POST',
      { turnId: target.turnId, prompt, ...(operationId ? { operationId } : {}), ...(input ? { input } : {}) },
    );
  }

  public async interrupt(target: AgentInteractionTarget & { turnId: string }): Promise<void> {
    await this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/interrupt`,
      'POST',
      { turnId: target.turnId },
    );
  }

  public async respond(
    target: AgentInteractionTarget,
    requestId: string,
    result: JsonValue,
  ): Promise<void> {
    await this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/requests/${encodeURIComponent(requestId)}/respond`,
      'POST',
      { result },
    );
  }

  private async request(
    target: AgentInteractionTarget,
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (target.execution.backend === 'ec2' && this.ec2Request) return this.ec2Request(target, { path, method, ...(body ? { body } : {}) });
    if (target.execution.backend !== 'microvm') {
      throw new AgentInteractionUnavailableError('execution backend does not support live interaction');
    }
    let microvm;
    try {
      microvm = await this.client.send(new GetMicrovmCommand({
        microvmIdentifier: target.execution.id,
      }));
    } catch (error) {
      if (isUnavailableMicrovmError(error)) {
        throw new AgentInteractionUnavailableError('the run MicroVM is no longer available');
      }
      throw error;
    }
    if (
      !microvm.endpoint ||
      microvm.state === 'TERMINATED' ||
      microvm.state === 'TERMINATING'
    ) throw new AgentInteractionUnavailableError('the run MicroVM is not active');
    // Persistent launches enable automatic resume. A port-authenticated proxy
    // request wakes a suspended instance without another Run or wider authority.
    const tokenResult = await this.client.send(new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: target.execution.id,
      expirationInMinutes: 2,
      allowedPorts: [{ port: 8080 }],
    }));
    const token = tokenResult.authToken?.['X-aws-proxy-auth'];
    if (!token) throw new Error('CreateMicrovmAuthToken returned no proxy token');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const response = await fetch(`${endpointUrl(microvm.endpoint)}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(encoded ? { 'content-type': 'application/json' } : {}),
        'x-aws-proxy-auth': token,
        'x-aws-proxy-port': '8080',
      },
      ...(encoded ? { body: encoded } : {}),
      signal: AbortSignal.timeout(28_000),
    });
    const text = await response.text();
    const value = text ? parseJson(text) : {};
    if (!response.ok) {
      const message = isRecord(value) && typeof value.message === 'string'
        ? value.message
        : `MicroVM control endpoint returned HTTP ${response.status}`;
      // A newly started Lambda MicroVM can advertise its endpoint before the
      // lifecycle proxy is ready to forward port 8080. Treat gateway startup
      // responses as temporarily unavailable so control clients can retry.
      if ([404, 409, 410, 502, 503, 504].includes(response.status)) {
        throw new AgentInteractionUnavailableError(message);
      }
      throw new Error(message);
    }
    return value;
  }
}

export function createExecutorRegistryFromEnv(onStartupObservation?: (observation: MicrovmStartupObservation) => void): ExecutionRegistry {
  const options = workerOptionsFromEnv(onStartupObservation);
  return new ExecutionRegistry([
    new MicrovmRunExecutor(new LambdaMicrovmsClient({ region: options.region }), new SSMClient({ region: options.region }), options),
    ...(process.env.EC2_LAUNCH_TEMPLATE_ID ? [new Ec2RunExecutor(new EC2Client({ region: options.region }), {
      launchTemplateId: requiredEnv('EC2_LAUNCH_TEMPLATE_ID'), launchTemplateVersion: requiredEnv('EC2_LAUNCH_TEMPLATE_VERSION'), deployment: requiredEnv('RAT_DEPLOYMENT'),
    })] : []),
  ]);
}

export function workerOptionsFromEnv(onStartupObservation?: (observation: MicrovmStartupObservation) => void): MicrovmExecutorOptions {
  const region = requiredEnv('AWS_REGION');
  const s3Files = s3FilesOptionsFromEnv();
  return {
      imageParameterName: process.env.MICROVM_IMAGE_PARAMETER_NAME ?? 'UNPROVISIONED',
      imageVersionParameterName: process.env.MICROVM_IMAGE_VERSION_PARAMETER_NAME ?? 'UNPROVISIONED',
      executionRoleArn: process.env.MICROVM_EXECUTION_ROLE_ARN ?? 'UNPROVISIONED',
      logGroupName: process.env.MICROVM_LOG_GROUP_NAME ?? 'UNPROVISIONED',
      runsTableName: requiredEnv('RUNS_TABLE_NAME'),
      integrationsTableName: requiredEnv('INTEGRATIONS_TABLE_NAME'),
      ...(process.env.AGENTS_TABLE_NAME ? { agentsTableName: process.env.AGENTS_TABLE_NAME } : {}),
      ...(process.env.DEFINITION_BUCKET ? { definitionBucket: process.env.DEFINITION_BUCKET } : {}),
      ...(process.env.INTEGRATION_CREDENTIAL_NAME_PREFIX ? { credentialNamePrefix: process.env.INTEGRATION_CREDENTIAL_NAME_PREFIX } : {}),
      ...(process.env.INTEGRATION_CREDENTIAL_KMS_KEY_ARN ? { credentialKmsKeyArn: process.env.INTEGRATION_CREDENTIAL_KMS_KEY_ARN } : {}),
      artifactBucket: requiredEnv('ARTIFACT_BUCKET'),
      eventBusName: requiredEnv('EVENT_BUS_NAME'),
      region,
      allowedRepositoryHosts: process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com',
      allowedSandboxModes: process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write',
      defaultSandboxMode: process.env.DEFAULT_SANDBOX_MODE ?? 'danger-full-access',
      defaultAgentNetworkAccess: process.env.DEFAULT_AGENT_NETWORK_ACCESS !== 'false',
      ...(process.env.DEFAULT_MODEL ? { defaultModel: process.env.DEFAULT_MODEL } : {}),
      ...(process.env.CODEX_AUTH_FILE_SECRET_ARN
        ? { codexAuthFileSecretArn: process.env.CODEX_AUTH_FILE_SECRET_ARN }
        : {}),
      ...(process.env.BEDROCK_API_KEY_SECRET_ARN
        ? { bedrockApiKeySecretArn: process.env.BEDROCK_API_KEY_SECRET_ARN }
        : {}),
      allowAgentAwsCredentialChain: process.env.ALLOW_AGENT_AWS_CREDENTIAL_CHAIN === 'true',
      sessionIdleSeconds: Number(process.env.MICROVM_SESSION_IDLE_SECONDS ?? 1_200),
      sessionSuspendedSeconds: Number(process.env.MICROVM_SESSION_SUSPENDED_SECONDS ?? 21_600),
      heartbeatIntervalMs: Number(process.env.RUN_HEARTBEAT_INTERVAL_MS ?? 15_000),
      ...(onStartupObservation ? { onStartupObservation } : {}),
      ...(s3Files ? { s3Files } : {}),
    };
}

export function createAgentInteractionControllerFromEnv(): MicrovmAgentInteractionController {
  return new MicrovmAgentInteractionController(
    new LambdaMicrovmsClient({ region: requiredEnv('AWS_REGION') }),
    ...(process.env.EC2_LAUNCH_TEMPLATE_ID ? [createEc2CommandTransport()] as const : []),
  );
}

export function createExecutionInspectorFromEnv(): ExecutionInspector {
  const microvm = new MicrovmExecutionInspector(new LambdaMicrovmsClient({ region: requiredEnv('AWS_REGION') }));
  if (!process.env.EC2_LAUNCH_TEMPLATE_ID) return microvm;
  const request = createEc2CommandTransport();
  const ec2 = new Ec2ExecutionInspector(new EC2Client({ region: requiredEnv('AWS_REGION') }), requiredEnv('RAT_DEPLOYMENT'),
    (runId, execution) => request({ runId, execution }, { method: 'GET', path: `/agent-runtime/v1/runs/${encodeURIComponent(runId)}/health` }));
  return { inspect: (runId, execution) => (execution.backend === 'ec2' ? ec2 : microvm).inspect(runId, execution) };
}

function s3FilesOptionsFromEnv(): NonNullable<MicrovmExecutorOptions['s3Files']> | undefined {
  if (process.env.S3_FILES_ENABLED !== 'true') return undefined;
  return {
    ...(process.env.MICROVM_VPC_NETWORK_CONNECTOR_ARN ? { networkConnectorArn: process.env.MICROVM_VPC_NETWORK_CONNECTOR_ARN } : {}),
    fileSystemId: requiredEnv('S3_FILES_FILE_SYSTEM_ID'),
    accessPointId: requiredEnv('S3_FILES_ACCESS_POINT_ID'),
    mountTargetIp: requiredEnv('S3_FILES_MOUNT_TARGET_IP'),
  };
}

function endpointUrl(value: string): string {
  return value.startsWith('https://') ? value.replace(/\/$/, '') : `https://${value.replace(/\/$/, '')}`;
}

function isUnavailableMicrovmError(error: unknown): boolean {
  if (['ResourceNotFoundException', 'GoneException'].includes(errorName(error))) return true;
  return errorName(error) === 'ValidationException'
    && safeError(error).toLowerCase().includes('microvm')
    && safeError(error).toLowerCase().includes('terminated');
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}
