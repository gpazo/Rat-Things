import { emitMetric } from '../core/metrics.js';
import type { ArtifactStore, Clock, RunStore } from '../core/ports.js';
import type { RunService } from '../core/run-service.js';
import type {
  ArtifactCatalog,
  ArtifactReference,
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
import type { ConversationService } from './service.js';
import {
  bindingForSlice,
  continuationForMessages,
  continuationKey,
  requestForMessage,
  requestForSlice,
  type ContinuationBatch,
} from './continuation.js';
import { completionDecision, sessionForRun } from './completion.js';
import {
  appendContext,
  appendInterruptedToolContext,
  interactionTranscript,
  terminalTranscript,
  type TerminalTranscript,
} from './transcript.js';

// Preserve the coordinator module's existing calculation exports.
export { appendContext, appendInterruptedToolContext, replayPrompt } from './transcript.js';

export interface ConversationResultReader {
  read(reference: ArtifactReference): Promise<string | undefined>;
}

export interface ConversationSessionController {
  suspend(id: string): Promise<void>;
}

export interface ConversationCoordinatorOptions {
  conversations: Pick<ConversationService,
    'acquireLease' | 'getTurn' | 'resumeTurn' | 'beginTurn' | 'pending' | 'attachArtifacts' |
    'scheduleRun' | 'releaseLease' | 'getMessage' | 'readAttachmentManifest' | 'appendMessage'
  >;
  runs: Pick<RunService, 'get' | 'prepareConversation' | 'wake'>;
  artifacts: Pick<ArtifactStore, 'getJson' | 'putJson'>;
  sliceTimeoutSeconds?: number;
  clock?: Clock;
}

/** Converts durable mailbox work into one bounded, independently retryable agent run. */
export class ConversationCoordinator {
  private readonly sliceTimeoutSeconds: number;
  private readonly clock: Clock;

  public constructor(private readonly options: ConversationCoordinatorOptions) {
    this.sliceTimeoutSeconds = options.sliceTimeoutSeconds ?? 600;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  public async handle(message: ConversationWakeMessage): Promise<{ status: string; runId?: string }> {
    validateWakeMessage(message);
    await this.repairMailbox(message);
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
        // One accepted input is one public Run. Thread continuity may delay
        // dispatch, but it never batches several receipts into another Run.
        { limit: 1 },
      );
      const first = pending[0];
      if (!first) {
        await this.options.conversations.releaseLease(conversation.conversationId, lease.token);
        return { status: 'no_work' };
      }
      const loaded = await Promise.all(pending.map(async (message) => ({
        message,
        content: await this.options.artifacts.getJson<ConversationMessageContent>(message.content),
      })));
      const attachedFiles = loaded.flatMap(({ content }) => content.attachments ?? []);
      const preparedConversation = attachedFiles.length > 0
        ? await this.options.conversations.attachArtifacts({
            conversationId: conversation.conversationId,
            leaseToken: lease.token,
            files: attachedFiles,
          })
        : conversation;
      const continuation = continuationForMessages(loaded);
      const continuationArtifact = await this.options.artifacts.putJson(
        continuationKey(conversation, turn.turnId, turn.slice),
        continuation,
      );
      const context = conversation.context
        ? await this.options.artifacts.getJson<ConversationCheckpoint>(conversation.context)
        : { version: '1' as const, messages: [] };
      const rawRequest = loaded[0]?.content.request ?? requestForMessage(conversation, continuation);
      const runId = first.runId;
      if (!runId) throw new Error('thread mailbox item has no Run binding');
      const reserved = await this.options.runs.get(conversation.ownerId, runId);
      if (
        reserved.conversation?.conversationId !== conversation.conversationId ||
        reserved.conversation.messageId !== first.messageId
      ) throw new Error('mailbox item is bound to a different thread Run');
      const request = requestForSlice(
        conversation,
        context,
        continuation,
        this.sliceTimeoutSeconds,
        rawRequest,
      );
      const resumable = this.sessionIsResumable(conversation);
      const run = await this.options.runs.prepareConversation(
        conversation.ownerId,
        reserved.runId,
        request,
        bindingForSlice({
          conversation,
          preparedConversation,
          turn,
          message: first,
          reserved: reserved.conversation,
          continuation: continuationArtifact,
          resumable,
        }),
      );
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
      try {
        await this.options.conversations.releaseLease(conversation.conversationId, lease.token);
      } catch {
        emitMetric('conversation-coordinator', 'CleanupFailure', 1, 'Count');
      }
      throw error;
    }
  }

  private sessionIsResumable(conversation: ConversationRecord): boolean {
    const session = conversation.session;
    if (!session || session.id === 'unknown') return false;
    return !session.expiresAt || Date.parse(session.expiresAt) > this.clock.now().getTime();
  }

  /** Repairs the Run-reserved/mailbox-write crash window from trusted Run state. */
  private async repairMailbox(message: ConversationWakeMessage): Promise<void> {
    if (!message.runId || !message.ownerId) return;
    const run = await this.options.runs.get(message.ownerId, message.runId);
    // Only accepted, still-queued reservations are eligible for crash-window
    // repair. A cancelled reservation may have an older wake-up in SQS; treating
    // it as acknowledged prevents deterministic validation failures from being
    // retried or dead-lettered.
    if (run.status !== 'queued') return;
    const binding = run.conversation;
    if (
      !binding?.messageId ||
      binding.conversationId !== message.conversationId ||
      run.executionInput
    ) return;
    if (await this.options.conversations.getMessage(message.conversationId, binding.messageId)) {
      return;
    }
    if (!run.provenance) throw new Error('thread Run has no trusted provenance');
    const request = await this.options.artifacts.getJson<RunRequest>(run.input);
    if (!request.source) throw new Error('thread Run input has no trusted source');
    const attachments = binding.attachmentManifest
      ? (await this.options.conversations.readAttachmentManifest(binding.attachmentManifest)).files
      : undefined;
    await this.options.conversations.appendMessage({
      conversationId: binding.conversationId,
      ownerId: run.ownerId,
      ...(run.capabilityOwnerId ? { capabilityOwnerId: run.capabilityOwnerId } : {}),
      messageId: binding.messageId,
      ...(binding.title ? { title: binding.title } : {}),
      runId: run.runId,
      delivery: binding.delivery ?? 'defer',
      content: {
        text: request.prompt,
        request,
        ...(attachments?.length ? { attachments } : {}),
        ...(binding.replyToMessageId ? { replyToMessageId: binding.replyToMessageId } : {}),
        metadata: { traceId: run.runId },
      },
      source: request.source,
      destination: request.destinations?.[0] ?? { kind: 'none' },
      actor: run.provenance.actor,
      credentialSubject: run.provenance.credentialSubject,
      ...(request.agent ? { executionPolicy: request.agent } : {}),
      ...(request.integrations ? { integrationPolicy: request.integrations } : {}),
    });
  }
}

export interface ConversationCompletionOptions {
  conversations: Pick<ConversationService,
    'acquireLease' | 'getTurn' | 'completeTurn' | 'failTurn' | 'releaseLease' | 'get'
  >;
  runs: Pick<RunStore, 'get'>;
  artifacts: Pick<ArtifactStore, 'getJson' | 'getBytes'>;
  results: ConversationResultReader;
  queue: ConversationQueue;
  sessions: ConversationSessionController;
  clock?: Clock;
}

/** Folds a terminal run back into durable history, then suspends its warm MicroVM. */
export class ConversationCompletionCoordinator {
  private readonly clock: Clock;

  public constructor(private readonly options: ConversationCompletionOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
  }

  public async handle(event: RunStateEvent): Promise<{ status: string }> {
    if (!['succeeded', 'failed', 'cancelled'].includes(event.status)) return { status: 'ignored' };
    const run = await this.options.runs.get(event.runId);
    if (!run?.conversation) return { status: 'not_conversation' };
    const binding = run.conversation;
    if (!binding.turnId) return { status: 'unprepared' };
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
      const decision = completionDecision(run);
      const transcript = await this.readTerminalTranscript(run);
      if (decision.kind === 'complete') {
        const [previous, continuation] = await Promise.all([
          conversation.context
            ? this.options.artifacts.getJson<ConversationCheckpoint>(conversation.context)
            : Promise.resolve({ version: '1' as const, messages: [] }),
          binding.continuation
            ? this.options.artifacts.getJson<ContinuationBatch>(binding.continuation)
            : Promise.resolve({ version: '1' as const, messages: [] }),
        ]);
        const context = appendContext(previous, continuation, transcript.output, transcript.interactions);
        await this.options.conversations.completeTurn({
          runStatus: decision.runStatus,
          conversationId: binding.conversationId,
          turnId: binding.turnId,
          leaseToken: lease.token,
          result: decision.result.output,
          transcriptMessages: transcript.messages,
          context,
          ...(decision.result.artifacts !== undefined ? {
            artifactCatalog: {
              version: '1',
              files: decision.result.artifacts,
            } satisfies ArtifactCatalog,
          } : {}),
          ...(run.execution ? {
            session: sessionForRun(run, conversation, this.clock.now(), decision.result.agentThreadId),
          } : {}),
        });
      } else {
        let interruptedContext: ConversationCheckpoint | undefined;
        if (decision.interrupted.length > 0 || run.result) {
          // Preserve sequential reads on failure: a context error must not start a continuation read.
          const previous = conversation.context
            ? await this.options.artifacts.getJson<ConversationCheckpoint>(conversation.context)
            : { version: '1' as const, messages: [] };
          const continuation = binding.continuation
            ? await this.options.artifacts.getJson<ContinuationBatch>(binding.continuation)
            : { version: '1' as const, messages: [] };
          interruptedContext = decision.interrupted.length > 0
            ? appendInterruptedToolContext(previous, continuation, decision.interrupted)
            : appendContext(previous, continuation, transcript.output, transcript.interactions);
        }
        await this.options.conversations.failTurn({
          runStatus: decision.runStatus,
          conversationId: binding.conversationId,
          turnId: binding.turnId,
          leaseToken: lease.token,
          transcriptMessages: transcript.messages,
          ...(run.result?.artifacts ? { artifactCatalog: {version: '1', files: run.result.artifacts} } : {}),
          ...(run.execution && run.result?.agentThreadId && !decision.interrupted.length ? {
            session: sessionForRun(run, conversation, this.clock.now(), run.result.agentThreadId),
          } : {}),
          error: decision.error,
          ...(interruptedContext ? { context: interruptedContext, ...(decision.interrupted.length ? { clearSession: true } : {}) } : {}),
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
      try {
        await this.options.conversations.releaseLease(binding.conversationId, lease.token);
      } catch {
        emitMetric('conversation-completion', 'CleanupFailure', 1, 'Count');
      }
      throw error;
    }
  }

  private async readTerminalTranscript(run: RunRecord): Promise<TerminalTranscript> {
    const interactions = run.result?.events
      ? interactionTranscript(
          Buffer.from(await this.options.artifacts.getBytes(run.result.events)).toString('utf8'),
          run.updatedAt,
        )
      : [];
    const savedOutput = run.result ? await this.options.results.read(run.result.output) : undefined;
    return terminalTranscript(run, interactions, savedOutput);
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
    !message.traceId ||
    ((message.runId === undefined) !== (message.ownerId === undefined)) ||
    (message.runId !== undefined && !/^[A-Za-z0-9-]{1,128}$/.test(message.runId)) ||
    (message.ownerId !== undefined && (!message.ownerId || Buffer.byteLength(message.ownerId, 'utf8') > 1_024))
  ) throw new Error('invalid conversation queue message');
}
