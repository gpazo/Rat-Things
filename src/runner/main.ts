import { isRetiredRun } from '../domain/run-bindings.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import {
  CachedSecretReader,
  createAwsClients,
  DynamoRunStore,
  S3ArtifactStore,
} from '../adapters/aws-runtime.js';
import { SecretsManagerCredentialVault } from '../adapters/secrets-credential-vault.js';
import { requiredEnv } from '../adapters/executors.js';
import { CredentialBroker } from '../credentials/broker.js';
import type { RunError, RunRecord } from '../domain/contracts.js';
import type { SandboxMode } from '../domain/contracts.js';
import { InvalidStateTransitionError } from '../domain/state.js';
import { parseRunRequest } from '../domain/validation.js';
import type { SessionLaunch } from '../domain/session-execution.js';
import { environmentTokenIdentity, parseEnvironmentCredentials } from '../credentials/environment.js';
import { CodexExecutionError } from './codex-app-server.js';
import type { AgentExecution } from './agent-driver.js';
import { driverFor } from './agent-driver.js';
import { loadCodexBedrockToken, readCodexBedrockToken } from './bedrock-auth.js';
import { installBedrockTokenFile } from './bedrock-token-file.js';
import { agentProcessIdentity } from './agent-identity.js';
import { installCodexAuthFile, type CodexAuthFileSession } from './chatgpt-auth.js';
import { codexAuthMode } from './codex-auth.js';
import { prepareWorkspace } from './workspace.js';
import { createRunnerControlBridge } from './control.js';
import {
  CapabilityProfileRegistry,
  createBuiltinCapabilityProfiles,
  resolveAgentProfile,
} from '../plugins/capability-profiles.js';
import type { AgentDriverControl } from './agent-driver.js';
import { ExecutionHeartbeat } from './heartbeat.js';
import { prepareSessionMcp, type SessionMcpRuntime } from './session-mcp.js';
import { VaultService } from '../core/vault-service.js';
import { DynamoAgentsStore } from '../adapters/dynamo-agents-store.js';
import { SessionEventStore } from '../core/session-event-store.js';
import { SecretsAgentCredentials } from '../adapters/secrets-agent-credentials.js';
import { HttpOAuthRefreshClient } from '../adapters/oauth-refresh-client.js';
import { SessionRuntimeStore } from '../core/session-runtime-store.js';
import { SessionRuntimeJournal } from './session-runtime-journal.js';
import { SessionArtifactCapture } from '../core/session-artifact-capture.js';
import { EnvironmentService } from '../core/environment-service.js';
import { SecretsEnvironmentCredentials } from '../adapters/secrets-environment-credentials.js';
import { bindHostedWorkspace, prepareHostedEnvironment } from './hosted-environment.js';
import { planCodexLaunch } from './agent-planning.js';
import { codexEnvironmentFiles } from '../adapters/codex-environment-files.js';
import type { EnvironmentFileOperations } from '../core/environment-file-ports.js';
import { prepareSessionEnvironmentCredentials, type SessionEnvironmentCredentialsRuntime } from './session-environment-credentials.js';

export async function runAgentWorker(): Promise<void> {
  const clients = createAwsClients();
  const runId = requiredEnv('RUN_ID');
  const store = new DynamoRunStore(clients.dynamodb, requiredEnv('RUNS_TABLE_NAME'), Number(process.env.RUN_RETENTION_SECONDS ?? 2_592_000));
  const artifactBucket = requiredEnv('ARTIFACT_BUCKET');
  const artifacts = new S3ArtifactStore(clients.s3, artifactBucket);
  const secrets = new CachedSecretReader(clients.secrets);
  const credentials = new CredentialBroker(secrets);
  let current = await store.get(runId);
  if (!current) throw new Error(`run ${runId} does not exist`);
  if (current.status !== 'dispatching' || isRetiredRun(current)) return;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? '/tmp/agent-runtime';
  const persistentSession = Boolean(current.agentsSession) && process.env.PERSISTENT_SESSION === 'true';
  const durableStateRoot = process.env.SESSION_STATE_ROOT;
  if (durableStateRoot && !persistentSession) {
    throw new Error('Durable state requires a persistent session');
  }
  const workspace = durableStateRoot
    ? join(durableStateRoot, 'workspace')
    : join(
      workspaceRoot,
      persistentSession && current.agentsSession
        ? `session-${createHash('sha256').update(JSON.stringify([current.ownerId, current.agentsSession.sessionId])).digest('hex').slice(0, 32)}`
        : runId,
    );
  const startedAt = new Date().toISOString();
  let loadedBedrockToken = false;
  let bedrockTokenFile: Awaited<ReturnType<typeof installBedrockTokenFile>> | undefined;
  let codexAuthFileSession: CodexAuthFileSession | undefined;
  let heartbeat: ExecutionHeartbeat | undefined;
  let sessionMcp: SessionMcpRuntime | undefined;
  let sessionEnvironmentCredentials: SessionEnvironmentCredentialsRuntime | undefined;
  let sessionJournal: SessionRuntimeJournal | undefined;
  let managedStatus: ((status: 'connected' | 'failed' | 'expired') => Promise<void>) | undefined;
  let managedTimer: ReturnType<typeof setInterval> | undefined;
  let managedUpdate: Promise<void> | undefined;
  let managedReady = false;
  const runnerControl = createRunnerControlBridge(runId);

  try {
    if (!current.agentsSession) throw new Error('Cloud execution requires an Agents Session binding');
    const rawRequest = await artifacts.getJson<unknown>({
      bucket: requiredEnv('RUN_INPUT_BUCKET'),
      key: requiredEnv('RUN_INPUT_KEY'),
    });
    const request = parseRunRequest(rawRequest, {
      allowedRepositoryHosts: csv(process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com'),
      allowedSandboxModes: sandboxModes(
        process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write,danger-full-access',
      ),
    });
    const profile = resolveAgentProfile(
      request.agent,
      new CapabilityProfileRegistry(createBuiltinCapabilityProfiles()),
    );
    const effectiveRequest = {
      ...request,
      ...(profile.agent ? { agent: profile.agent } : {}),
    };
    current = await waitForExecutionAttachment(
      store,
      runId,
      Number(process.env.EXECUTION_ATTACHMENT_TIMEOUT_MS ?? 60_000),
      abort.signal,
    );
    if (current.status === 'cancelling') {
      await store.transition(runId, ['cancelling'], 'cancelled');
      return;
    }
    if (current.status !== 'dispatching' || isRetiredRun(current)) return;
    if (!current.execution || current.execution.id === 'pending') {
      throw new Error('execution reference was not attached');
    }
    const executionGeneration = requiredEnv('EXECUTION_GENERATION');
    if (
      current.execution.backend !== (process.env.DEFAULT_EXECUTION_BACKEND ?? 'microvm') ||
      current.execution.id !== requiredEnv(current.execution.backend === 'ec2' ? 'EC2_INSTANCE_ID' : 'MICROVM_ID') ||
      current.execution.generation !== executionGeneration
    ) throw new Error('execution attachment does not match this worker generation');
    current = await store.startExecution(runId, current.execution, startedAt);
    heartbeat = new ExecutionHeartbeat({
      store,
      runId,
      execution: current.execution!,
      intervalMs: Number(process.env.RUN_HEARTBEAT_INTERVAL_MS ?? 15_000),
      onAuthorityLost: () => abort.abort(),
      onError: (error) => console.error(JSON.stringify({
        level: 'error',
        message: 'execution heartbeat failed',
        runId,
        error: safeMessage(error),
      })),
    });
    heartbeat.start();
    await prepareWorkspace(effectiveRequest.repository, workspace, credentials, {
      reuseExisting: persistentSession,
    });
    const ownerHash = createHash('sha256').update(current.ownerId).digest('hex').slice(0, 32);
    const timeoutSeconds = Number(
      process.env.RUN_TIMEOUT_SECONDS ?? effectiveRequest.execution?.timeoutSeconds ?? 900,
    );
    const driver = driverFor('codex');
    let driverControl: AgentDriverControl | undefined = runnerControl?.hooks;
    if (current.agentsSession) {
      const reference = current.agentsSession.launch;
      if (reference.bucket !== artifactBucket || !reference.key.startsWith(`owners/${ownerHash}/sessions/`)) throw new Error('Session launch configuration is outside its owner scope');
      let launch = await artifacts.getJson<SessionLaunch>(reference);
      if (launch.sessionId !== current.agentsSession.sessionId || launch.turnId !== current.agentsSession.turnId) throw new Error('Session launch identity does not match its Run');
      const agentsStore = new SessionEventStore(new DynamoAgentsStore(clients.dynamodb, requiredEnv('AGENTS_TABLE_NAME'), new S3ArtifactStore(clients.s3, requiredEnv('DEFINITION_BUCKET'))));
      const runtimes = new SessionRuntimeStore(agentsStore);
      const runtime = await runtimes.get(current.ownerId, launch.sessionId);
      if (!runtime || runtime.value.closed || runtime.value.runId !== runId) throw new Error('Session execution authority changed before launch');
      const sessionOwner = current.ownerId;
      let environmentFiles: EnvironmentFileOperations | undefined;
      if (launch.environment.type === 'openai_hosted') {
        const environmentId = launch.environment.id;
        const environments = new EnvironmentService({ store: agentsStore, credentials: new SecretsEnvironmentCredentials(clients.secrets, requiredEnv('INTEGRATION_CREDENTIAL_NAME_PREFIX'), requiredEnv('INTEGRATION_CREDENTIAL_KMS_KEY_ARN')) });
        managedStatus = (status) => environments.managedStatus(sessionOwner, environmentId, runId, status);
        await bindHostedWorkspace(workspace);
        const plan = planCodexLaunch(effectiveRequest, workspace, timeoutSeconds * 1000, process.env);
        sessionEnvironmentCredentials = await prepareSessionEnvironmentCredentials(sessionOwner, launch, secrets, abort.signal);
        launch = await prepareHostedEnvironment({ launch, workspace, plan, artifacts, signal: abort.signal, stateDirectory: '/tmp/rat-hosted-state', previouslyPrepared: Boolean(runtime.value.snapshot), ...(sessionEnvironmentCredentials ? { credentials: sessionEnvironmentCredentials } : {}) });
        environmentFiles = { execute: (_environmentId, _reference, operation) => codexEnvironmentFiles({ workspace: '/workspace', operation, binary: plan.binary, ...(plan.identity ? { identity: plan.identity } : {}), signal: abort.signal }) };
        runnerControl?.setEnvironmentFiles((operation) => environmentFiles!.execute(environmentId, '', operation as import('../core/environment-file-ports.js').EnvironmentFileOperation));
        await managedStatus('connected');
        managedReady = true;
        managedTimer = setInterval(() => {
          if (managedUpdate) return;
          managedUpdate = managedStatus!('connected').catch(() => { abort.abort(); }).finally(() => { managedUpdate = undefined; });
        }, 15_000);
        managedTimer.unref();
      }
      const capture = new SessionArtifactCapture({ ownerId: sessionOwner, launch, artifacts,
        ...(environmentFiles ? { files: environmentFiles } : {}),
      });
      sessionJournal = new SessionRuntimeJournal({
        publish: async (snapshot) => runtimes.publish(sessionOwner, launch.sessionId, runId, await capture.capture(snapshot)),
        onFailure: () => abort.abort(),
      });
      driverControl = { ...driverControl, session: launch, sessionRuntime: {
        lifetime: current.execution?.backend === 'ec2' ? 'host-managed' : 'bounded',
        ...(runtime.value.snapshot ? { previous: runtime.value.snapshot } : {}),
        changed: sessionJournal.changed, flush: sessionJournal.flush,
      } };
      const sessionVaults = launch.mcp?.some((binding) => binding.vaultId) ? new VaultService({
        store: agentsStore,
        secrets: new SecretsAgentCredentials(clients.secrets, requiredEnv('INTEGRATION_CREDENTIAL_NAME_PREFIX'), requiredEnv('INTEGRATION_CREDENTIAL_KMS_KEY_ARN')),
        oauth: new HttpOAuthRefreshClient(),
      }) : undefined;
      sessionMcp = await prepareSessionMcp(current.ownerId, launch, secrets, abort.signal, sessionVaults, sessionEnvironmentCredentials);
      driverControl = { ...driverControl, sessionMcp, ...(sessionEnvironmentCredentials ? { sessionEnvironmentCredentials } : {}) };
      if (launch.environment.type === 'self_hosted') {
        if (!launch.environmentCredential) throw new Error('Session environment credential is missing');
        const credential = parseEnvironmentCredentials(await secrets.get(launch.environmentCredential));
        const identity = environmentTokenIdentity(credential.harness);
        if (identity?.ownerId !== current.ownerId || identity.environmentId !== launch.environment.id || identity.role !== 'harness') throw new Error('Session environment credential does not match its owner');
        driverControl = { ...driverControl, sessionEnvironmentToken: credential.harness };
      }
    }
    if (driver.name === 'codex' && codexAuthMode() === 'bedrock') {
      if (current.agentsSession && current.execution?.backend === 'ec2') {
        const identity = agentProcessIdentity(process.env.RUN_AGENT_UID, process.env.RUN_AGENT_GID);
        bedrockTokenFile = await installBedrockTokenFile({ token: () => readCodexBedrockToken(credentials),
          onFailure: () => abort.abort(), ...(identity ? { gid: identity.gid } : {}) });
        process.env.RAT_BEDROCK_AUTH_FILE = bedrockTokenFile.path;
      } else loadedBedrockToken = await loadCodexBedrockToken(credentials);
    }
    if (driver.name === 'codex' && codexAuthMode() === 'chatgpt') {
      codexAuthFileSession = await installCodexAuthFile(
        credentials,
        new SecretsManagerCredentialVault(clients.secrets),
      );
    }
    let execution: AgentExecution;
    let executionError: RunError | undefined;
    const executionStarted = Date.now();
    try {
      execution = await driver.execute(effectiveRequest, workspace, timeoutSeconds * 1_000, abort.signal, driverControl);
    } catch (error) {
      execution = {
        ...(error instanceof CodexExecutionError ? error.execution : {
          fullText: '', durationMs: Date.now() - executionStarted, events: Buffer.alloc(0),
        }),
        outcome: 'failed', exitCode: 1,
      };
      executionError = {
        code: abort.signal.aborted ? 'worker_interrupted' : classifyError(error),
        message: safeMessage(error), retryable: false,
      };
    }
    if (execution.outcome === 'interrupted' || execution.outcome === 'failed') abort.abort();
    const finalizing = await store.get(runId);
    if (finalizing?.status === 'cancelling') execution.outcome = 'interrupted';
    const terminalStatus = execution.outcome === 'interrupted' ? 'cancelled'
      : execution.outcome === 'failed' ? 'failed' : 'succeeded';
    const terminalText = terminalStatus === 'cancelled' ? 'Stopped by you. Available files were saved.'
      : terminalStatus === 'failed' ? `Work failed: ${executionError?.message ?? 'Agent execution failed'}` : '';
    if (terminalText) execution.fullText = [execution.fullText, terminalText].filter(Boolean).join('\n\n');
    await codexAuthFileSession?.finalize();
    codexAuthFileSession = undefined;
    await sessionJournal?.flush();
    const prefix = `owners/${ownerHash}/runs/${runId}`;
    const eventArtifact = await artifacts.putBytes(`${prefix}/events.jsonl`, execution.events, 'application/x-ndjson');
    const output = await artifacts.putBytes(
      `${prefix}/result.md`,
      Buffer.from(execution.fullText),
      'text/markdown; charset=utf-8',
    );
    if (persistentSession) await clearPersistentSessionScratch();
    const finalized = await store.finishExecution(runId, current.execution!, terminalStatus, {
      output,
      preview: execution.fullText.slice(0, 2_000),
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      events: eventArtifact,
      ...(execution.threadId ? { agentThreadId: execution.threadId } : {}),
      ...(execution.usage ? { usage: execution.usage } : {}),
    }, executionError);
    if (!finalized) throw new Error('execution authority changed before finalization');
  } catch (error) {
    const latest = await store.get(runId);
    if (latest?.status === 'cancelling') {
      try {
        if (latest.execution?.generation) {
          await store.cancelExecution(runId, current.execution!);
        } else {
          await store.transition(runId, ['running', 'cancelling'], 'cancelled');
        }
      } catch (transitionError) {
        if (!(transitionError instanceof InvalidStateTransitionError)) throw transitionError;
      }
      return;
    }
    const runError: RunError = {
      code: abort.signal.aborted ? 'worker_interrupted' : classifyError(error),
      message: safeMessage(error),
      retryable: false,
    };
    const execution = current.execution;
    const failed = execution?.generation
      ? await store.failExecution(
        runId,
        execution,
        latest?.heartbeatAt ?? current.heartbeatAt ?? startedAt,
        runError,
      )
      : false;
    if (
      !execution?.generation &&
      !failed &&
      latest &&
      ['dispatching', 'running'].includes(latest.status)
    ) {
      await store.fail(runId, runError, ['dispatching', 'running']);
    }
    throw error;
  } finally {
    clearInterval(managedTimer);
    await managedUpdate;
    await managedStatus?.(managedReady ? 'expired' : 'failed').catch(() => {});
    await Promise.all([sessionMcp?.close(), sessionEnvironmentCredentials?.close()]);
    await heartbeat?.stop();
    if (loadedBedrockToken) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (bedrockTokenFile) { delete process.env.RAT_BEDROCK_AUTH_FILE; await bedrockTokenFile.close(); }
    if (codexAuthFileSession) {
      try {
        await codexAuthFileSession.finalize();
      } catch (error) {
        console.warn(JSON.stringify({
          level: 'warn',
          message: 'Codex auth.json refresh could not be persisted during cleanup',
          error: safeMessage(error),
        }));
      }
    }
    runnerControl?.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (!persistentSession) await rm(workspace, { recursive: true, force: true });
  }
}

async function clearPersistentSessionScratch(): Promise<void> {
  const codexHome = requiredEnv('CODEX_HOME');
  for (const path of ['.tmp', 'tmp']) {
    const root = join(codexHome, path);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      try {
        // Codex can finish a turn while a short-lived plugin clone is still
        // unwinding. Node's recursive rm does not retry ENOTEMPTY unless
        // maxRetries is set, so give that writer time to release the tree.
        await rm(join(root, entry), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } catch (error) {
        // Scratch cleanup must not turn an otherwise successful agent turn
        // into a failed Session. Every Codex temp directory is uniquely
        // named and a later turn will make another cleanup attempt.
        console.warn(JSON.stringify({
          level: 'warn',
          message: 'persistent session scratch cleanup was incomplete',
          scratchRoot: path,
          error: safeMessage(error),
        }));
      }
    }
  }
}

interface ExecutionAttachmentStore {
  get(runId: string): Promise<RunRecord | undefined>;
}

export async function waitForExecutionAttachment(
  store: ExecutionAttachmentStore,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  pollIntervalMs = 250,
): Promise<RunRecord> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('execution attachment timeout is invalid');
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw new Error('execution attachment wait was cancelled');
    const current = await store.get(runId);
    if (!current) throw new Error(`run ${runId} does not exist`);
    if (
      current.status !== 'dispatching' ||
      (current.execution !== undefined && current.execution.id !== 'pending')
    ) return current;
    if (Date.now() >= deadline) throw new Error('execution reference was not attached before timeout');
    await abortableDelay(Math.max(0, pollIntervalMs), signal);
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('execution attachment wait was cancelled');
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done(new Error('execution attachment wait was cancelled'));
    function done(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function csv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function sandboxModes(value: string): SandboxMode[] {
  const modes = csv(value);
  if (modes.length === 0 || modes.some((mode) => !['read-only', 'workspace-write', 'danger-full-access'].includes(mode))) {
    throw new Error('ALLOWED_SANDBOX_MODES contains an invalid value');
  }
  return modes as SandboxMode[];
}

function classifyError(error: unknown): string {
  const message = safeMessage(error).toLowerCase();
  if (message.includes('execution reference')) return 'execution_attachment_failed';
  if (message.includes('timed out')) return 'agent_timeout';
  if (message.includes('cancel')) return 'agent_cancelled';
  if (message.includes('git')) return 'repository_checkout_failed';
  return 'agent_failed';
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
