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
  ExecutionReference,
  RunRecord,
  RunRequest,
} from '../domain/contracts.js';
import type {
  AgentInteractionTarget,
  AgentRuntimeSnapshot,
  ComputerSnapshot,
  ComputerTakeoverReceipt,
  HumanBrowserAction,
  TeachRecordingInput,
  TeachRecordingResult,
} from '../domain/interaction.js';
import type { JsonValue } from '../domain/contracts.js';
import type { AgentInteractionController } from '../core/ports.js';
import { ExecutionRegistry } from '../execution/registry.js';
import { executionGeneration } from '../execution/generation.js';
import type { RunExecutor } from '../execution/types.js';
import type { ExecutionInspection, ExecutionInspector } from '../execution/reconciler.js';

export type { RunExecutor } from '../execution/types.js';
export { ExecutionRegistry } from '../execution/registry.js';

export interface MicrovmExecutorOptions {
  imageParameterName: string;
  imageVersionParameterName: string;
  executionRoleArn: string;
  logGroupName: string;
  runsTableName: string;
  integrationsTableName: string;
  artifactBucket: string;
  eventBusName: string;
  region: string;
  allowedRepositoryHosts: string;
  allowedSandboxModes: string;
  defaultAgentDriver: string;
  defaultSandboxMode?: string;
  defaultAgentNetworkAccess?: boolean;
  defaultModel?: string;
  bedrockApiKeySecretArn?: string;
  allowAgentAwsCredentialChain: boolean;
  sessionIdleSeconds?: number;
  sessionSuspendedSeconds?: number;
  heartbeatIntervalMs?: number;
  onStartupObservation?: (observation: MicrovmStartupObservation) => void;
  s3Files?: {
    networkConnectorArn: string;
    fileSystemId: string;
    accessPointId: string;
    mountTargetIp: string;
  };
}

export interface MicrovmStartupObservation {
  mode: 'launch' | 'resume';
  outcome: 'succeeded' | 'fallback' | 'failed';
  durationMs: number;
}

class MicrovmSessionUnavailableError extends Error {}
export class AgentInteractionUnavailableError extends Error {}

const MICROVM_RESUME_START_RETRY_WINDOW_MS = 20_000;
const MICROVM_RESUME_START_ATTEMPT_TIMEOUT_MS = 5_000;
const MICROVM_RESUME_START_INITIAL_DELAY_MS = 250;
const MICROVM_RESUME_START_MAX_DELAY_MS = 2_000;
const MICROVM_RESUME_STATE_WINDOW_MS = 20_000;
const MICROVM_RESUME_START_RETRYABLE_STATUS = new Set([502, 503, 504]);

export class MicrovmRunExecutor implements RunExecutor {
  public readonly backend = 'microvm' as const;
  private imageArn?: string;

  public constructor(
    private readonly client: LambdaMicrovmsClient,
    private readonly ssm: SSMClient,
    private readonly options: MicrovmExecutorOptions,
  ) {}

  public async start(record: RunRecord, request: RunRequest, _traceId: string): Promise<ExecutionReference> {
    if (record.conversation?.preferredMicrovmId) {
      const startedAt = Date.now();
      try {
        const execution = await this.resumeAndStart(
          record,
          request,
          record.conversation.preferredMicrovmId,
        );
        this.observeStartup('resume', 'succeeded', startedAt);
        return execution;
      } catch (error) {
        if (error instanceof MicrovmSessionUnavailableError) {
          this.observeStartup('resume', 'fallback', startedAt);
        } else {
          this.observeStartup('resume', 'failed', startedAt);
          throw error;
        }
      }
    }
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
    const [imageArn, imageVersion] = await Promise.all([
      this.parameter('image'),
      this.parameter('version'),
    ]);
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
      // ResumeMicrovm is asynchronous. The lifecycle proxy can briefly accept
      // traffic before AWS has completed the resume hook; starting a Run in
      // that window can strand it if the hook then fails and terminates the
      // MicroVM. Only hand work to a session AWS reports as RUNNING.
      microvm = await this.waitForResumedMicrovm(microvmId);
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
    const response = await this.postRunToResumedMicrovm(
      endpoint,
      token,
      JSON.stringify({ runHookPayload: this.runHookPayload(record, request, true) }),
    );
    if (response.status === 404 || response.status === 410) {
      throw new MicrovmSessionUnavailableError();
    }
    if (!response.ok) {
      throw new Error(`persistent MicroVM rejected run ${record.runId} with HTTP ${response.status}`);
    }
    return {
      backend: 'microvm',
      id: microvmId,
      generation: record.execution?.generation ?? executionGeneration(record),
    };
  }

  private async waitForResumedMicrovm(microvmId: string): Promise<{
    state: string | undefined;
    endpoint: string | undefined;
  }> {
    const deadline = Date.now() + MICROVM_RESUME_STATE_WINDOW_MS;
    let delay = MICROVM_RESUME_START_INITIAL_DELAY_MS;
    while (Date.now() < deadline) {
      let microvm;
      try {
        microvm = await this.client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      } catch (error) {
        if (isUnavailableSessionError(error)) throw new MicrovmSessionUnavailableError();
        throw error;
      }
      if (microvm.state === 'RUNNING') return microvm;
      if (microvm.state === 'TERMINATED' || microvm.state === 'TERMINATING') {
        throw new MicrovmSessionUnavailableError();
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, MICROVM_RESUME_START_MAX_DELAY_MS);
    }
    throw new MicrovmSessionUnavailableError();
  }

  private async postRunToResumedMicrovm(
    endpoint: string,
    token: string,
    body: string,
  ): Promise<Response> {
    const url = `${endpointUrl(endpoint)}/agent-runtime/v1/runs`;
    const deadline = Date.now() + MICROVM_RESUME_START_RETRY_WINDOW_MS;
    let retryDelay = MICROVM_RESUME_START_INITIAL_DELAY_MS;
    let lastError: Error | undefined;

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-aws-proxy-auth': token,
            'x-aws-proxy-port': '8080',
          },
          body,
          signal: AbortSignal.timeout(Math.min(MICROVM_RESUME_START_ATTEMPT_TIMEOUT_MS, remaining)),
        });
        if (!MICROVM_RESUME_START_RETRYABLE_STATUS.has(response.status)) return response;
        lastError = new Error(`persistent MicroVM proxy returned HTTP ${response.status} after resume`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      const delay = Math.min(retryDelay, deadline - Date.now());
      if (delay <= 0) break;
      await sleep(delay);
      retryDelay = Math.min(retryDelay * 2, MICROVM_RESUME_START_MAX_DELAY_MS);
    }

    throw lastError ?? new Error('persistent MicroVM proxy was not ready after resume');
  }

  private runHookPayload(record: RunRecord, request: RunRequest, resuming: boolean): string {
    const executionInput = record.executionInput ?? record.input;
    const payload = JSON.stringify({
      version: 1,
      runId: record.runId,
      executionGeneration: record.execution?.generation ?? executionGeneration(record),
      // Threaded Runs retain their immutable accepted request in `input`, but
      // execute the coordinator-prepared transcript in `executionInput`.
      inputBucket: executionInput.bucket,
      inputKey: executionInput.key,
      runsTableName: this.options.runsTableName,
      integrationsTableName: this.options.integrationsTableName,
      artifactBucket: this.options.artifactBucket,
      eventBusName: this.options.eventBusName,
      region: this.options.region,
      timeoutSeconds: request.execution?.timeoutSeconds ?? 900,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? 15_000,
      // RunMicrovm client tokens are limited to printable ASCII and 64 characters.
      traceId: record.runId,
      allowedRepositoryHosts: this.options.allowedRepositoryHosts,
      allowedSandboxModes: this.options.allowedSandboxModes,
      defaultAgentDriver: this.options.defaultAgentDriver,
      defaultSandboxMode: this.options.defaultSandboxMode ?? 'danger-full-access',
      defaultAgentNetworkAccess: this.options.defaultAgentNetworkAccess ?? true,
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
      if (isUnavailableSessionError(error)) {
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
  public constructor(private readonly client: LambdaMicrovmsClient) {}

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

  public async steer(target: AgentInteractionTarget, prompt: string): Promise<void> {
    await this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/steer`,
      'POST',
      { prompt },
    );
  }

  public async interrupt(target: AgentInteractionTarget): Promise<void> {
    await this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/interrupt`,
      'POST',
      {},
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

  public computer(target: AgentInteractionTarget): Promise<ComputerSnapshot> {
    return this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/computer`,
      'GET',
    ) as Promise<ComputerSnapshot>;
  }

  public takeComputer(target: AgentInteractionTarget): Promise<ComputerTakeoverReceipt> {
    return this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/computer/takeover`,
      'POST',
      { control: 'human' },
    ) as Promise<ComputerTakeoverReceipt>;
  }

  public returnComputer(target: AgentInteractionTarget): Promise<ComputerTakeoverReceipt> {
    return this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/computer/takeover`,
      'POST',
      { control: 'agent' },
    ) as Promise<ComputerTakeoverReceipt>;
  }

  public actOnComputer(
    target: AgentInteractionTarget,
    action: HumanBrowserAction,
  ): Promise<ComputerSnapshot> {
    return this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/computer/action`,
      'POST',
      { action },
    ) as Promise<ComputerSnapshot>;
  }

  public startTeaching(
    target: AgentInteractionTarget,
    input: TeachRecordingInput,
  ): Promise<ComputerSnapshot> {
    return this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/computer/teach`,
      'POST',
      { action: 'start', ...input },
    ) as Promise<ComputerSnapshot>;
  }

  public stopTeaching(
    target: AgentInteractionTarget,
    discard: boolean,
  ): Promise<TeachRecordingResult> {
    return this.request(
      target,
      `/agent-runtime/v1/runs/${encodeURIComponent(target.runId)}/computer/teach`,
      'POST',
      { action: 'stop', discard },
    ) as Promise<TeachRecordingResult>;
  }

  private async request(
    target: AgentInteractionTarget,
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (target.execution.backend !== 'microvm') {
      throw new AgentInteractionUnavailableError('execution backend does not support live interaction');
    }
    let microvm;
    try {
      microvm = await this.client.send(new GetMicrovmCommand({
        microvmIdentifier: target.execution.id,
      }));
    } catch (error) {
      if (isUnavailableSessionError(error)) {
        throw new AgentInteractionUnavailableError('the run MicroVM is no longer available');
      }
      throw error;
    }
    if (
      !microvm.endpoint ||
      microvm.state === 'TERMINATED' ||
      microvm.state === 'TERMINATING' ||
      microvm.state === 'SUSPENDED'
    ) throw new AgentInteractionUnavailableError('the run MicroVM is not active');
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

export function createExecutorRegistryFromEnv(
  onStartupObservation?: (observation: MicrovmStartupObservation) => void,
): ExecutionRegistry {
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
      integrationsTableName: requiredEnv('INTEGRATIONS_TABLE_NAME'),
      artifactBucket: requiredEnv('ARTIFACT_BUCKET'),
      eventBusName: requiredEnv('EVENT_BUS_NAME'),
      region,
      allowedRepositoryHosts: process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com',
      allowedSandboxModes: process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write',
      defaultAgentDriver: process.env.DEFAULT_AGENT_DRIVER ?? 'codex',
      defaultSandboxMode: process.env.DEFAULT_SANDBOX_MODE ?? 'danger-full-access',
      defaultAgentNetworkAccess: process.env.DEFAULT_AGENT_NETWORK_ACCESS !== 'false',
      ...(process.env.DEFAULT_MODEL ? { defaultModel: process.env.DEFAULT_MODEL } : {}),
      ...(process.env.BEDROCK_API_KEY_SECRET_ARN
        ? { bedrockApiKeySecretArn: process.env.BEDROCK_API_KEY_SECRET_ARN }
        : {}),
      allowAgentAwsCredentialChain: process.env.ALLOW_AGENT_AWS_CREDENTIAL_CHAIN === 'true',
      sessionIdleSeconds: Number(process.env.MICROVM_SESSION_IDLE_SECONDS ?? 1_200),
      sessionSuspendedSeconds: Number(process.env.MICROVM_SESSION_SUSPENDED_SECONDS ?? 21_600),
      heartbeatIntervalMs: Number(process.env.RUN_HEARTBEAT_INTERVAL_MS ?? 15_000),
      ...(onStartupObservation ? { onStartupObservation } : {}),
      ...(s3Files ? { s3Files } : {}),
    },
  );
  return new ExecutionRegistry([microvm]);
}

export function createAgentInteractionControllerFromEnv(): MicrovmAgentInteractionController {
  return new MicrovmAgentInteractionController(
    new LambdaMicrovmsClient({ region: requiredEnv('AWS_REGION') }),
  );
}

export function createExecutionInspectorFromEnv(): MicrovmExecutionInspector {
  return new MicrovmExecutionInspector(
    new LambdaMicrovmsClient({ region: requiredEnv('AWS_REGION') }),
  );
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isUnavailableSessionError(error: unknown): boolean {
  if (['ResourceNotFoundException', 'GoneException'].includes(errorName(error))) return true;
  // SuspendMicrovm returns ValidationException after the reconciler has already
  // observed and fenced a terminated guest. Completion is still required to
  // release the durable conversation and wake pending mailbox work, so treat
  // this terminal control-plane response like an unavailable session.
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
