import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  CachedSecretReader,
  createAwsClients,
  DynamoRunStore,
  S3ArtifactStore,
  S3PublicationGrantStore,
  S3PublicationObjectStore,
} from '../adapters/aws-runtime.js';
import { PublicationPublisher, publicationTtlSeconds } from '../core/publication-publisher.js';
import { requiredEnv } from '../adapters/executors.js';
import { CredentialBroker } from '../credentials/broker.js';
import type { ArtifactCatalog, RunError, RunRecord } from '../domain/contracts.js';
import type { SandboxMode } from '../domain/contracts.js';
import { InvalidStateTransitionError } from '../domain/state.js';
import { parseRunRequest } from '../domain/validation.js';
import { driverFor } from './agent-driver.js';
import { loadCodexBedrockToken } from './bedrock-auth.js';
import { codexAuthMode } from './codex-auth.js';
import {
  assertArtifactCatalogScope,
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

  try {
    const rawRequest = await artifacts.getJson<unknown>({
      bucket: requiredEnv('RUN_INPUT_BUCKET'),
      key: requiredEnv('RUN_INPUT_KEY'),
    });
    const request = parseRunRequest(rawRequest, {
      allowedRepositoryHosts: csv(process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com'),
      allowedSandboxModes: sandboxModes(process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write'),
    });
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
    await store.transition(runId, ['dispatching'], 'running', {
      execution: { ...current.execution, startedAt },
    });
    await prepareWorkspace(request.repository, workspace, credentials, {
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
    const timeoutSeconds = Number(process.env.RUN_TIMEOUT_SECONDS ?? request.execution?.timeoutSeconds ?? 900);
    const driver = driverFor(request.agent?.driver ?? defaultDriver());
    if (driver.name === 'codex' && codexAuthMode() === 'bedrock') {
      loadedBedrockToken = await loadCodexBedrockToken(credentials);
    }
    const execution = await driver.execute(request, workspace, timeoutSeconds * 1_000, abort.signal);
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
    const requestedPublications = process.env.AGENT_PUBLICATION_ENABLED === 'true'
      ? await readAgentShareRequests(workspace)
      : [];
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
    await store.complete(runId, {
      output,
      preview: execution.fullText.slice(0, 2_000),
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      events: eventArtifact,
      artifacts: publishedArtifacts,
      ...(patchArtifact ? { workspacePatch: patchArtifact } : {}),
      ...(execution.threadId ? { agentThreadId: execution.threadId } : {}),
      ...(execution.usage ? { usage: execution.usage } : {}),
    });
  } catch (error) {
    const latest = await store.get(runId);
    if (latest?.status === 'cancelling') {
      try {
        await store.transition(runId, ['running', 'cancelling'], 'cancelled');
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
    await store.fail(runId, runError, ['dispatching', 'running']);
    throw error;
  } finally {
    if (loadedBedrockToken) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (!persistentSession) await rm(workspace, { recursive: true, force: true });
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
