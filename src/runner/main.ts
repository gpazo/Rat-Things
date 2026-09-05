import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import {
  CachedSecretReader,
  createAwsClients,
  DynamoRunStore,
  S3ArtifactStore,
  S3PublicationGrantStore,
  S3PublicationObjectStore,
} from '../adapters/aws-runtime.js';
import { DynamoIntegrationStore } from '../adapters/dynamo-integration-store.js';
import { DynamoOAuthAuthorizationStore } from '../adapters/dynamo-oauth-store.js';
import { SecretsManagerCredentialVault } from '../adapters/secrets-credential-vault.js';
import { PublicationPublisher, publicationTtlSeconds } from '../core/publication-publisher.js';
import { requiredEnv } from '../adapters/executors.js';
import { CredentialBroker } from '../credentials/broker.js';
import type { ArtifactCatalog, RunError, RunRecord } from '../domain/contracts.js';
import type { SandboxMode } from '../domain/contracts.js';
import { InvalidStateTransitionError } from '../domain/state.js';
import { parseRunRequest } from '../domain/validation.js';
import { CodexExecutionError } from './codex-app-server.js';
import type { AgentExecution } from './agent-driver.js';
import { driverFor } from './agent-driver.js';
import { loadCodexBedrockToken } from './bedrock-auth.js';
import { installCodexAuthFile, type CodexAuthFileSession } from './chatgpt-auth.js';
import { codexAuthMode } from './codex-auth.js';
import {
  AGENT_ARTIFACT_DIRECTORY,
  assertArtifactCatalogScope,
  clearArtifactDirectory,
  emptyArtifactCatalog,
  publishArtifactCatalog,
  restoreArtifactCatalog,
} from './artifacts.js';
import {
  appendSharedPublications,
  clearAgentShareRequest,
  readAgentShareRequests,
} from './publications.js';
import type { SharedPublication } from './publications.js';
import { collectWorkspacePatch, prepareWorkspace } from './workspace.js';
import { createRunnerControlBridge } from './control.js';
import { IntegrationPluginRegistry } from '../plugins/integration-registry.js';
import { IntegrationRuntime } from '../plugins/integration-runtime.js';
import { createBuiltinIntegrationPlugins } from '../plugins/integrations/builtins.js';
import {
  OAuthRefreshingCredentialBroker,
  parseOAuthApplicationSecretArns,
  SecretOAuthApplicationRegistry,
} from '../plugins/oauth.js';
import {
  CapabilityProfileRegistry,
  createBuiltinCapabilityProfiles,
  resolveAgentProfile,
} from '../plugins/capability-profiles.js';
import type { AgentDriverControl } from './agent-driver.js';
import { BrowserHostBackend, BrowserToolSession } from './browser.js';
import { createDynamicToolRequestHandler } from './dynamic-tools.js';
import { ExecutionHeartbeat } from './heartbeat.js';

export async function runAgentWorker(): Promise<void> {
  const clients = createAwsClients();
  const runId = requiredEnv('RUN_ID');
  const store = new DynamoRunStore(clients.dynamodb, requiredEnv('RUNS_TABLE_NAME'));
  const artifactBucket = requiredEnv('ARTIFACT_BUCKET');
  const artifacts = new S3ArtifactStore(clients.s3, artifactBucket);
  const secrets = new CachedSecretReader(clients.secrets);
  const credentials = new CredentialBroker(secrets);
  let current = await store.get(runId);
  if (!current) throw new Error(`run ${runId} does not exist`);
  if (current.status !== 'dispatching') return;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? '/tmp/agent-runtime';
  const persistentSession = Boolean(current.conversation) && process.env.PERSISTENT_SESSION === 'true';
  const durableStateRoot = process.env.CONVERSATION_STATE_ROOT;
  if (durableStateRoot && !persistentSession) {
    throw new Error('CONVERSATION_STATE_ROOT requires a persistent conversation session');
  }
  const workspace = durableStateRoot
    ? join(durableStateRoot, 'workspace')
    : join(
      workspaceRoot,
      persistentSession && current.conversation
        ? `conversation-${createHash('sha256').update(current.conversation.conversationId).digest('hex').slice(0, 32)}`
        : runId,
    );
  const startedAt = new Date().toISOString();
  let loadedBedrockToken = false;
  let codexAuthFileSession: CodexAuthFileSession | undefined;
  let browserSession: BrowserToolSession | undefined;
  let heartbeat: ExecutionHeartbeat | undefined;
  const runnerControl = createRunnerControlBridge(runId);

  try {
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
    if (current.status !== 'dispatching') return;
    if (!current.execution || current.execution.id === 'pending') {
      throw new Error('execution reference was not attached');
    }
    const executionGeneration = requiredEnv('EXECUTION_GENERATION');
    if (
      current.execution.backend !== 'microvm' ||
      current.execution.id !== requiredEnv('MICROVM_ID') ||
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
    if (
      current.conversation?.artifacts &&
      (
        current.conversation.artifacts.bucket !== artifactBucket ||
        !current.conversation.artifacts.key.startsWith(`owners/${ownerHash}/conversations/`)
      )
    ) throw new Error('conversation artifact catalog is outside its owner scope');
    const previousArtifacts = current.conversation?.artifacts
      ? await artifacts.getJson<ArtifactCatalog>(current.conversation.artifacts)
      : emptyArtifactCatalog();
    assertArtifactCatalogScope(previousArtifacts, artifactBucket, current.ownerId);
    await restoreArtifactCatalog(workspace, previousArtifacts, artifacts);
    await clearAgentShareRequest(workspace);
    const timeoutSeconds = Number(
      process.env.RUN_TIMEOUT_SECONDS ?? effectiveRequest.execution?.timeoutSeconds ?? 900,
    );
    const driver = driverFor(effectiveRequest.agent?.driver ?? defaultDriver());
    let driverControl: AgentDriverControl | undefined = runnerControl?.hooks;
    const dynamicTools: Array<Record<string, unknown>> = [];
    let integrationSession: Awaited<ReturnType<IntegrationRuntime['prepare']>> | undefined;
    if (effectiveRequest.agent?.capabilities?.computerUse === 'browser') {
      const browserNetworkAccess = effectiveRequest.agent.capabilities.networkAccess ??
        process.env.CODEX_TOOL_NETWORK_ACCESS === 'true';
      if (!browserNetworkAccess) {
        throw new Error('browser computer use requires agent network access');
      }
      if (driver.name !== 'codex') throw new Error('browser computer use requires the Codex driver');
      browserSession = new BrowserToolSession(
        new BrowserHostBackend({
          artifactRoot: join(workspace, AGENT_ARTIFACT_DIRECTORY),
        }),
      );
      runnerControl?.setBrowserSession(browserSession);
      dynamicTools.push(...browserSession.tools);
    }
    if (effectiveRequest.integrations) {
      const capabilityOwnerId = current.capabilityOwnerId ?? current.ownerId;
      const integrationStore = new DynamoIntegrationStore(
        clients.dynamodb,
        requiredEnv('INTEGRATIONS_TABLE_NAME'),
      );
      const integrationRegistry = new IntegrationPluginRegistry(createBuiltinIntegrationPlugins());
      const integrationCredentialBroker = new CredentialBroker(new CachedSecretReader(clients.secrets, 0));
      const oauthApplications = new SecretOAuthApplicationRegistry(
        new CachedSecretReader(clients.secrets),
        parseOAuthApplicationSecretArns(process.env.INTEGRATION_OAUTH_APP_SECRET_ARNS),
      );
      integrationSession = await new IntegrationRuntime({
        registry: integrationRegistry,
        store: integrationStore,
        credentials: new OAuthRefreshingCredentialBroker({
          credentials: integrationCredentialBroker,
          vault: new SecretsManagerCredentialVault(
            clients.secrets,
            process.env.INTEGRATION_CREDENTIAL_KMS_KEY_ARN,
          ),
          registry: integrationRegistry,
          applications: oauthApplications,
          store: new DynamoOAuthAuthorizationStore(
            clients.dynamodb,
            requiredEnv('INTEGRATIONS_TABLE_NAME'),
          ),
        }),
      }).prepare({
        ownerId: capabilityOwnerId,
        request: effectiveRequest.integrations,
        ...(profile.maximumIntegrationAccess
          ? { maximumIntegrationAccess: profile.maximumIntegrationAccess }
          : {}),
      });
      dynamicTools.push(...integrationSession.tools.map((tool) => ({ ...tool })));
    }
    if (dynamicTools.length > 0) {
      const fallbackServerRequest = runnerControl?.hooks.onServerRequest;
      driverControl = {
        ...runnerControl?.hooks,
        dynamicTools,
        onServerRequest: createDynamicToolRequestHandler({
          ...(browserSession ? { browser: browserSession } : {}),
          ...(integrationSession ? { integrations: integrationSession } : {}),
          signal: abort.signal,
          ledger: {
            store,
            runId,
            execution: current.execution!,
            admittedToolsDigest: createHash('sha256')
              .update(JSON.stringify(dynamicTools))
              .digest('hex'),
          },
          ...(fallbackServerRequest ? { fallback: fallbackServerRequest } : {}),
        }),
      };
    }
    if (driver.name === 'codex' && codexAuthMode() === 'bedrock') {
      loadedBedrockToken = await loadCodexBedrockToken(credentials);
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
    // Finalize any active recording before the artifact catalog takes its
    // immutable snapshot. Explicit record_stop remains preferable because it
    // returns metadata to the agent, but a completed turn must not lose bytes.
    if (browserSession) await browserSession.close();
    const prefix = `owners/${ownerHash}/runs/${runId}`;
    const [eventArtifact, patch, publishedArtifacts] = await Promise.all([
      artifacts.putBytes(`${prefix}/events.jsonl`, execution.events, 'application/x-ndjson'),
      collectWorkspacePatch(workspace),
      publishArtifactCatalog({
        workspace,
        previous: previousArtifacts,
        artifacts,
        ownerId: current.ownerId,
        runId,
      }),
    ]);
    const catalog: ArtifactCatalog = { version: '1', files: publishedArtifacts };
    const requestedPublications = process.env.AGENT_PUBLICATION_ENABLED === 'true' && terminalStatus === 'succeeded'
      ? await readAgentShareRequests(workspace)
      : [];
    await clearAgentShareRequest(workspace);
    const sharedPublications: SharedPublication[] = [];
    if (requestedPublications.length > 0) {
      const publisher = new PublicationPublisher(
        new S3PublicationObjectStore(clients.s3, artifactBucket),
        new S3PublicationGrantStore(clients.s3, artifactBucket),
        {
          artifactBucket,
          baseDomain: requiredEnv('PUBLICATION_BASE_DOMAIN'),
          ttlSeconds: publicationTtlSeconds(process.env.ARTIFACT_URL_TTL_SECONDS),
        },
      );
      for (const requested of requestedPublications) {
        const descriptor = await publisher.publish({
          ownerId: current.ownerId,
          spec: requested.spec,
          catalog,
          runId,
          ...(current.conversation
            ? { conversationId: current.conversation.conversationId }
            : {}),
        });
        sharedPublications.push({ ...requested, descriptor });
      }
    }
    const fullText = appendSharedPublications(execution.fullText, sharedPublications);
    const output = await artifacts.putBytes(
      `${prefix}/result.md`,
      Buffer.from(fullText),
      'text/markdown; charset=utf-8',
    );
    const patchArtifact = patch
      ? await artifacts.putBytes(`${prefix}/workspace.patch`, patch, 'text/x-diff')
      : undefined;
    if (persistentSession) await clearPersistentSessionScratch(workspace);
    const finalized = await store.finishExecution(runId, current.execution!, terminalStatus, {
      output,
      preview: execution.fullText.slice(0, 2_000),
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      events: eventArtifact,
      artifacts: publishedArtifacts,
      ...(patchArtifact ? { workspacePatch: patchArtifact } : {}),
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
    await heartbeat?.stop();
    if (loadedBedrockToken) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
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
    if (browserSession) {
      try {
        await browserSession.close();
      } catch {
        // The browser host is an isolated helper and may already have exited.
      }
    }
    runnerControl?.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (!persistentSession) await rm(workspace, { recursive: true, force: true });
  }
}

async function clearPersistentSessionScratch(workspace: string): Promise<void> {
  await clearArtifactDirectory(workspace);
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
        // into a failed conversation. Every Codex temp directory is uniquely
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

function defaultDriver(): 'codex' | 'mock' {
  const value = process.env.DEFAULT_AGENT_DRIVER ?? 'codex';
  if (value !== 'codex' && value !== 'mock') {
    throw new Error('DEFAULT_AGENT_DRIVER is invalid');
  }
  return value;
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
