import { createHash } from 'node:crypto';
import type { ArtifactStore, RunStore } from '../core/ports.js';
import type { RunService } from '../core/run-service.js';
import type {
  ArtifactCatalog,
  ArtifactReference,
  JsonValue,
  RunRecord,
  RunRequest,
  RunStateEvent,
} from '../domain/contracts.js';
import type {
  ConversationCheckpoint,
  ConversationMessageContent,
  ConversationRecord,
  ConversationWakeMessage,
} from '../domain/conversations.js';
import type { ConversationQueue } from './types.js';
import { ConversationService } from './service.js';

const MAX_SLICE_MESSAGES = 20;
const MAX_REPLAY_BYTES = 80_000;
const MAX_CONTEXT_MESSAGES = 200;
const MAX_CONTEXT_BYTES = 4_500_000;

export interface ConversationResultReader {
  read(reference: ArtifactReference): Promise<string | undefined>;
}

export interface ConversationSessionController {
  suspend(id: string): Promise<void>;
}

export interface ConversationCoordinatorOptions {
  conversations: ConversationService;
  runs: Pick<RunService, 'submit' | 'wake'>;
  artifacts: ArtifactStore;
  sliceTimeoutSeconds?: number;
}

interface ContinuationBatch {
  version: '1';
  messages: Array<{
    messageId: string;
    text: string;
    receivedAt: string;
  }>;
}

/** Converts durable mailbox work into one bounded, independently retryable agent run. */
export class ConversationCoordinator {
  private readonly sliceTimeoutSeconds: number;

  public constructor(private readonly options: ConversationCoordinatorOptions) {
    this.sliceTimeoutSeconds = options.sliceTimeoutSeconds ?? 600;
  }

  public async handle(message: ConversationWakeMessage): Promise<{ status: string; runId?: string }> {
    validateWakeMessage(message);
    const acquired = await this.options.conversations.acquireLease(message.conversationId);
    if (acquired.status !== 'acquired') return { status: acquired.status };
    const { conversation, lease } = acquired;
    try {
      let turn = conversation.activeTurnId
        ? await this.options.conversations.getTurn(conversation.conversationId, conversation.activeTurnId)
        : undefined;
      if (conversation.activeTurnId && !turn) throw new Error('active conversation turn was not found');
      if (turn?.state === 'running' && turn.runId) {
        // Repair the attach/enqueue crash window. Duplicate wake-ups are harmless because run
        // claiming is conditional.
        await this.options.runs.wake(turn.runId, message.traceId);
        await this.options.conversations.releaseLease(conversation.conversationId, lease.token);
        return { status: 'running', runId: turn.runId };
      }
      if (turn?.state === 'awaiting_resume') {
        turn = await this.options.conversations.resumeTurn({
          conversationId: conversation.conversationId,
          turnId: turn.turnId,
          leaseToken: lease.token,
        });
      }
      if (!turn) {
        turn = await this.options.conversations.beginTurn({
          conversationId: conversation.conversationId,
          leaseToken: lease.token,
        });
      }

      const pending = await this.options.conversations.pending(
        conversation.conversationId,
        lease.token,
        { limit: MAX_SLICE_MESSAGES },
      );
      if (pending.length === 0) {
        await this.options.conversations.releaseLease(conversation.conversationId, lease.token);
        return { status: 'no_work' };
      }
      const continuation: ContinuationBatch = {
        version: '1',
        messages: await Promise.all(pending.map(async (item) => {
          const content = await this.options.artifacts.getJson<ConversationMessageContent>(item.content);
          return { messageId: item.messageId, text: content.text, receivedAt: item.receivedAt };
        })),
      };
      const continuationArtifact = await this.options.artifacts.putJson(
        continuationKey(conversation, turn.turnId, turn.slice),
        continuation,
      );
      const context = conversation.context
        ? await this.options.artifacts.getJson<ConversationCheckpoint>(conversation.context)
        : { version: '1' as const, messages: [] };
      const request = requestForSlice(conversation, context, continuation, this.sliceTimeoutSeconds);
      const resumable = sessionIsResumable(conversation);
      const run = await this.options.runs.submit(conversation.ownerId, request, {
        idempotencyKey: sliceIdempotencyKey(conversation.conversationId, turn.turnId, turn.slice),
        traceId: message.traceId,
        provenance: {
          actor: conversation.actor,
          credentialSubject: conversation.credentialSubject,
        },
        enqueue: false,
        conversation: {
          conversationId: conversation.conversationId,
          turnId: turn.turnId,
          slice: turn.slice,
          continuation: continuationArtifact,
          ...(conversation.artifacts ? { artifacts: conversation.artifacts } : {}),
          ...(resumable ? { preferredMicrovmId: conversation.session!.id } : {}),
          // The MicroVM lease expires independently of the durable Codex
          // thread stored in S3 Files. Carry the thread ID into a replacement
          // VM even when the previous VM can no longer be resumed.
          ...(conversation.session?.agentThreadId
            ? { agentThreadId: conversation.session.agentThreadId }
            : {}),
        },
      });
      await this.options.conversations.scheduleRun({
        conversationId: conversation.conversationId,
        turnId: turn.turnId,
        runId: run.runId,
        messageIds: pending.map((item) => item.messageId),
        leaseToken: lease.token,
      });
      await this.options.runs.wake(run.runId, message.traceId);
      await this.options.conversations.releaseLease(conversation.conversationId, lease.token);
      return { status: 'scheduled', runId: run.runId };
    } catch (error) {
      await this.options.conversations.releaseLease(conversation.conversationId, lease.token)
        .catch(() => undefined);
      throw error;
    }
  }
}

export interface ConversationCompletionOptions {
  conversations: ConversationService;
  runs: Pick<RunStore, 'get'>;
  artifacts: ArtifactStore;
  results: ConversationResultReader;
  queue: ConversationQueue;
  sessions: ConversationSessionController;
  clock?: { now(): Date };
}

/** Folds a terminal run back into durable history, then suspends its warm MicroVM. */
export class ConversationCompletionCoordinator {
  private readonly clock: { now(): Date };

  public constructor(private readonly options: ConversationCompletionOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
  }

  public async handle(event: RunStateEvent): Promise<{ status: string }> {
    if (!['succeeded', 'failed', 'cancelled'].includes(event.status)) return { status: 'ignored' };
    const run = await this.options.runs.get(event.runId);
    if (!run?.conversation) return { status: 'not_conversation' };
    const binding = run.conversation;
    const acquired = await this.options.conversations.acquireLease(binding.conversationId);
    if (acquired.status !== 'acquired') return { status: acquired.status };
    const { conversation, lease } = acquired;
    try {
      const turn = await this.options.conversations.getTurn(binding.conversationId, binding.turnId);
      if (!turn || turn.runId !== run.runId || turn.state !== 'running') {
        await this.options.conversations.releaseLease(binding.conversationId, lease.token);
        return { status: 'stale' };
      }
      // Suspend first so a failed suspension is retried while this turn is still active. Once the
      // turn is terminal, duplicate completion events are intentionally treated as stale.
      if (run.execution) await this.options.sessions.suspend(run.execution.id);
      if (run.status === 'succeeded' && run.result) {
        const [previous, continuation, output] = await Promise.all([
          conversation.context
            ? this.options.artifacts.getJson<ConversationCheckpoint>(conversation.context)
            : Promise.resolve({ version: '1' as const, messages: [] }),
          binding.continuation
            ? this.options.artifacts.getJson<ContinuationBatch>(binding.continuation)
            : Promise.resolve({ version: '1' as const, messages: [] }),
          this.options.results.read(run.result.output),
        ]);
        const context = appendContext(previous, continuation, output ?? run.result.preview);
        await this.options.conversations.completeTurn({
          conversationId: binding.conversationId,
          turnId: binding.turnId,
          leaseToken: lease.token,
          result: run.result.output,
          context,
          ...(run.result.artifacts !== undefined ? {
            artifactCatalog: {
              version: '1',
              files: run.result.artifacts,
            } satisfies ArtifactCatalog,
          } : {}),
          ...(run.execution ? {
            session: sessionForRun(run, conversation, this.clock.now(), run.result.agentThreadId),
          } : {}),
        });
      } else {
        await this.options.conversations.failTurn({
          conversationId: binding.conversationId,
          turnId: binding.turnId,
          leaseToken: lease.token,
          error: run.error ?? {
            code: run.status === 'cancelled' ? 'agent_cancelled' : 'agent_failed',
            message: `conversation slice ${run.status}`,
            retryable: false,
          },
        });
      }
      const latest = await this.options.conversations.get(binding.conversationId);
      if ((latest?.pendingCount ?? 0) > 0) {
        await this.options.queue.enqueue({
          version: '1',
          conversationId: binding.conversationId,
          traceId: `completion:${run.runId}`,
        });
      }
      return { status: 'completed' };
    } catch (error) {
      await this.options.conversations.releaseLease(binding.conversationId, lease.token)
        .catch(() => undefined);
      throw error;
    }
  }
}

export function parseConversationWakeMessage(body: string): ConversationWakeMessage {
  const parsed = JSON.parse(body) as Partial<ConversationWakeMessage>;
  validateWakeMessage(parsed);
  return parsed as ConversationWakeMessage;
}

function validateWakeMessage(message: Partial<ConversationWakeMessage>): void {
  if (
    message.version !== '1' ||
    typeof message.conversationId !== 'string' ||
    !message.conversationId ||
    typeof message.traceId !== 'string' ||
    !message.traceId
  ) throw new Error('invalid conversation queue message');
}

function requestForSlice(
  conversation: ConversationRecord,
  context: ConversationCheckpoint,
  continuation: ContinuationBatch,
  timeoutSeconds: number,
): RunRequest {
  return {
    version: '1',
    prompt: replayPrompt(context, continuation),
    agent: {
      ...conversation.executionPolicy,
      sandbox: conversation.executionPolicy?.sandbox ?? 'read-only',
    },
    execution: { backend: 'microvm', timeoutSeconds },
    source: conversation.source,
    destinations: [conversation.destination],
    metadata: {
      conversationId: conversation.conversationId,
      messageIds: continuation.messages.map((message) => message.messageId),
    },
  };
}

function replayPrompt(context: ConversationCheckpoint, continuation: ContinuationBatch): string {
  const latest: JsonValue[] = continuation.messages.map((message) => ({
    role: 'user',
    content: message.text,
    messageId: message.messageId,
  }));
  const transcript = [...context.messages, ...latest];
  const selected: JsonValue[] = [];
  let bytes = 0;
  for (const item of transcript.slice().reverse()) {
    const encoded = JSON.stringify(item);
    if (bytes + Buffer.byteLength(encoded) > MAX_REPLAY_BYTES) break;
    selected.unshift(item);
    bytes += Buffer.byteLength(encoded);
  }
  return [
    'Continue this durable conversation. The JSON transcript is canonical and may overlap with warm session memory.',
    'Respond to the newest user message. Use tools when the request requires them.',
    JSON.stringify(selected),
  ].join('\n\n');
}

function appendContext(
  previous: ConversationCheckpoint,
  continuation: ContinuationBatch,
  output: string,
): ConversationCheckpoint {
  const appended: JsonValue[] = [
    ...previous.messages,
    ...continuation.messages.map((message) => ({
      role: 'user',
      content: message.text,
      messageId: message.messageId,
      receivedAt: message.receivedAt,
    })),
    { role: 'assistant', content: output },
  ];
  const messages = appended.slice(-MAX_CONTEXT_MESSAGES);
  while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) > MAX_CONTEXT_BYTES) {
    messages.shift();
  }
  return {
    version: '1',
    messages,
    metadata: { compactedMessages: Math.max(0, appended.length - messages.length) },
  };
}

function sessionForRun(
  run: RunRecord,
  conversation: ConversationRecord,
  now: Date,
  agentThreadId?: string,
) {
  const existingStart = run.execution?.startedAt ? Date.parse(run.execution.startedAt) : now.getTime();
  const sameSession = conversation.session?.id === run.execution?.id;
  return {
    backend: 'microvm' as const,
    id: run.execution?.id ?? 'unknown',
    state: 'suspended' as const,
    updatedAt: now.toISOString(),
    expiresAt: sameSession && conversation.session?.expiresAt
      ? conversation.session.expiresAt
      : new Date(existingStart + 28_800_000).toISOString(),
    ...(agentThreadId ? { agentThreadId } : {}),
  };
}

function sessionIsResumable(conversation: ConversationRecord): boolean {
  if (!conversation.session || conversation.session.id === 'unknown') return false;
  return !conversation.session.expiresAt || Date.parse(conversation.session.expiresAt) > Date.now();
}

function continuationKey(conversation: ConversationRecord, turnId: string, slice: number): string {
  return `owners/${hash(conversation.ownerId).slice(0, 32)}/conversations/${hash(conversation.conversationId).slice(0, 32)}/turns/${hash(turnId).slice(0, 32)}/slice-${slice}-input.json`;
}

function sliceIdempotencyKey(conversationId: string, turnId: string, slice: number): string {
  return `conversation:${hash(conversationId).slice(0, 32)}:${hash(turnId).slice(0, 32)}:${slice}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
