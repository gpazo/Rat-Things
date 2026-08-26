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
import type { AgentToolCallRecord } from '../domain/interaction.js';
import type {
  ConversationCheckpoint,
  ConversationMessageContent,
  ConversationRecord,
  ConversationWakeMessage,
} from '../domain/conversations.js';
import type { ConversationQueue } from './types.js';
import { ConversationService } from './service.js';

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
  runs: Pick<RunService, 'get' | 'prepareConversation' | 'wake'>;
  artifacts: ArtifactStore;
  sliceTimeoutSeconds?: number;
}

interface ContinuationBatch {
  version: '1';
  messages: Array<{
    messageId: string;
    text: string;
    receivedAt: string;
    replyToMessageId?: string;
    attachments?: Array<{
      id: string;
      path: string;
      mediaType: string;
      bytes: number;
    }>;
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
      if (pending.length === 0) {
        await this.options.conversations.releaseLease(conversation.conversationId, lease.token);
        return { status: 'no_work' };
      }
      const contents = await Promise.all(pending.map(
        (item) => this.options.artifacts.getJson<ConversationMessageContent>(item.content),
      ));
      const attachedFiles = contents.flatMap((content) => content.attachments ?? []);
      const preparedConversation = attachedFiles.length > 0
        ? await this.options.conversations.attachArtifacts({
            conversationId: conversation.conversationId,
            leaseToken: lease.token,
            files: attachedFiles,
          })
        : conversation;
      const continuation: ContinuationBatch = {
        version: '1',
        messages: pending.map((item, index) => ({
          messageId: item.messageId,
          text: contents[index]!.text,
          receivedAt: item.receivedAt,
          ...(contents[index]!.replyToMessageId
            ? { replyToMessageId: contents[index]!.replyToMessageId }
            : {}),
          ...(contents[index]!.attachments?.length ? {
            attachments: contents[index]!.attachments!.map((attachment) => ({
              id: attachment.id,
              path: `.rat-things/artifacts/${attachment.path}`,
              mediaType: attachment.mediaType,
              bytes: attachment.bytes,
            })),
          } : {}),
        })),
      };
      const continuationArtifact = await this.options.artifacts.putJson(
        continuationKey(conversation, turn.turnId, turn.slice),
        continuation,
      );
      const context = conversation.context
        ? await this.options.artifacts.getJson<ConversationCheckpoint>(conversation.context)
        : { version: '1' as const, messages: [] };
      const rawRequest = contents[0]?.request ?? requestForMessage(conversation, continuation);
      const runId = pending[0]!.runId;
      if (!runId) throw new Error('thread mailbox item has no Run binding');
      const reserved = await this.options.runs.get(conversation.ownerId, runId);
      if (
        reserved.conversation?.conversationId !== conversation.conversationId ||
        reserved.conversation.messageId !== pending[0]!.messageId
      ) throw new Error('mailbox item is bound to a different thread Run');
      const request = requestForSlice(
        conversation,
        context,
        continuation,
        this.sliceTimeoutSeconds,
        rawRequest,
      );
      const resumable = sessionIsResumable(conversation);
      const run = await this.options.runs.prepareConversation(
        conversation.ownerId,
        reserved.runId,
        request,
        {
          conversationId: conversation.conversationId,
          messageId: pending[0]!.messageId,
          turnId: turn.turnId,
          slice: turn.slice,
          delivery: reserved.conversation.delivery ?? pending[0]!.delivery,
          continuation: continuationArtifact,
          ...(preparedConversation.artifacts ? { artifacts: preparedConversation.artifacts } : {}),
          ...(reserved.conversation.attachmentManifest
            ? { attachmentManifest: reserved.conversation.attachmentManifest }
            : {}),
          ...(reserved.conversation.attachmentDigest
            ? { attachmentDigest: reserved.conversation.attachmentDigest }
            : {}),
          ...(reserved.conversation.replyToMessageId
            ? { replyToMessageId: reserved.conversation.replyToMessageId }
            : {}),
          ...(resumable ? { preferredMicrovmId: conversation.session!.id } : {}),
          // The MicroVM lease expires independently of the durable Codex
          // thread stored in S3 Files. Carry the thread ID into a replacement
          // VM even when the previous VM can no longer be resumed.
          ...(conversation.session?.agentThreadId
            ? { agentThreadId: conversation.session.agentThreadId }
            : {}),
        },
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
      await this.options.conversations.releaseLease(conversation.conversationId, lease.token)
        .catch(() => undefined);
      throw error;
    }
  }

  /** Repairs the Run-reserved/mailbox-write crash window from trusted Run state. */
  private async repairMailbox(message: ConversationWakeMessage): Promise<void> {
    if (!message.runId || !message.ownerId) return;
    const run = await this.options.runs.get(message.ownerId, message.runId);
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
      runId: run.runId,
      delivery: binding.delivery ?? 'defer',
      content: {
        text: request.prompt,
        request,
        ...(attachments?.length ? { attachments } : {}),
        ...(binding.replyToMessageId ? { replyToMessageId: binding.replyToMessageId } : {}),
        metadata: { traceId: message.traceId },
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
        const interruptedToolCalls = (run.agentToolCalls ?? []).filter(
          (call) => call.status === 'interrupted',
        );
        const interruptedContext = interruptedToolCalls.length > 0
          ? appendInterruptedToolContext(
              conversation.context
                ? await this.options.artifacts.getJson<ConversationCheckpoint>(conversation.context)
                : { version: '1', messages: [] },
              binding.continuation
                ? await this.options.artifacts.getJson<ContinuationBatch>(binding.continuation)
                : { version: '1', messages: [] },
              interruptedToolCalls,
            )
          : undefined;
        await this.options.conversations.failTurn({
          conversationId: binding.conversationId,
          turnId: binding.turnId,
          leaseToken: lease.token,
          error: run.error ?? {
            code: run.status === 'cancelled' ? 'agent_cancelled' : 'agent_failed',
            message: `conversation slice ${run.status}`,
            retryable: false,
          },
          ...(interruptedContext ? { context: interruptedContext, clearSession: true } : {}),
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
    !message.traceId ||
    ((message.runId === undefined) !== (message.ownerId === undefined)) ||
    (message.runId !== undefined && !/^[A-Za-z0-9-]{1,128}$/.test(message.runId)) ||
    (message.ownerId !== undefined && (!message.ownerId || Buffer.byteLength(message.ownerId, 'utf8') > 1_024))
  ) throw new Error('invalid conversation queue message');
}

function requestForSlice(
  conversation: ConversationRecord,
  context: ConversationCheckpoint,
  continuation: ContinuationBatch,
  timeoutSeconds: number,
  rawRequest: RunRequest,
): RunRequest {
  return {
    ...rawRequest,
    prompt: replayPrompt(context, continuation),
    agent: {
      ...rawRequest.agent,
      sandbox: rawRequest.agent?.sandbox ?? conversation.executionPolicy?.sandbox ?? 'danger-full-access',
    },
    ...(rawRequest.integrations ?? conversation.integrationPolicy
      ? { integrations: rawRequest.integrations ?? conversation.integrationPolicy }
      : {}),
    execution: {
      ...rawRequest.execution,
      backend: 'microvm',
      timeoutSeconds: Math.min(rawRequest.execution?.timeoutSeconds ?? timeoutSeconds, timeoutSeconds),
    },
    metadata: {
      ...rawRequest.metadata,
      conversationId: conversation.conversationId,
      messageIds: continuation.messages.map((message) => message.messageId),
    },
  };
}

function requestForMessage(
  conversation: ConversationRecord,
  continuation: ContinuationBatch,
): RunRequest {
  return {
    version: '1',
    prompt: continuation.messages[0]?.text ?? 'Continue the conversation.',
    agent: {
      ...conversation.executionPolicy,
      sandbox: conversation.executionPolicy?.sandbox ?? 'danger-full-access',
    },
    ...(conversation.integrationPolicy ? { integrations: conversation.integrationPolicy } : {}),
    source: conversation.source,
    destinations: [conversation.destination],
  };
}

export function replayPrompt(
  context: ConversationCheckpoint,
  continuation: ContinuationBatch,
): string {
  const latest: JsonValue[] = continuation.messages.map((message) => ({
    role: 'user',
    content: message.text,
    messageId: message.messageId,
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
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
  const compacted = compactedMessageCount(context);
  const omittedFromReplay = transcript.length - selected.length;
  const handoff = compacted > 0 || omittedFromReplay > 0
    ? [
        'Durable replay handoff:',
        `- ${compacted} older transcript item(s) were compacted before this turn.`,
        `- ${omittedFromReplay} retained item(s) were omitted from this bounded replay.`,
        '- Warm session memory may contain more context, but do not invent omitted details. Ask the user or inspect durable files when an omitted fact is required.',
      ].join('\n')
    : 'Durable replay handoff: no known transcript items were omitted.';
  return [
    'Continue this durable conversation. The JSON transcript is canonical and may overlap with warm session memory.',
    'Respond to the newest user message. Use tools when the request requires them.',
    handoff,
    JSON.stringify(selected),
  ].join('\n\n');
}

export function appendContext(
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
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      receivedAt: message.receivedAt,
    })),
    { role: 'assistant', content: output },
  ];
  const messages = appended.slice(-MAX_CONTEXT_MESSAGES);
  while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) > MAX_CONTEXT_BYTES) {
    messages.shift();
  }
  const newlyCompacted = appended.length - messages.length;
  return {
    version: '1',
    messages,
    metadata: {
      ...previous.metadata,
      compactedMessages: Math.min(
        Number.MAX_SAFE_INTEGER,
        compactedMessageCount(previous) + newlyCompacted,
      ),
    },
  };
}

export function appendInterruptedToolContext(
  previous: ConversationCheckpoint,
  continuation: ContinuationBatch,
  interrupted: AgentToolCallRecord[],
): ConversationCheckpoint {
  const listed = interrupted.slice(0, 20).map((call) => (
    `- request ${call.requestId}: ${call.namespace ? `${call.namespace}.` : ''}${call.tool} ` +
    `(started ${call.startedAt}; argument digest ${call.argumentDigest})`
  ));
  const content = [
    'Execution interruption handoff:',
    `${interrupted.length} host tool call(s) ended without a durably settled result.`,
    ...listed,
    ...(interrupted.length > listed.length
      ? [`- ${interrupted.length - listed.length} additional interrupted call(s) omitted from this bounded handoff.`]
      : []),
    'The external outcome is unknown. Do not replay any of these calls automatically.',
    'Verify durable/provider state and wait for an explicit new user instruction before attempting a consequential call again.',
  ].join('\n');
  const appended: JsonValue[] = [
    ...previous.messages,
    ...continuation.messages.map((message) => ({
      role: 'user',
      content: message.text,
      messageId: message.messageId,
      receivedAt: message.receivedAt,
    })),
    { role: 'system', content },
  ];
  return boundedCheckpoint(previous, appended);
}

function compactedMessageCount(context: ConversationCheckpoint): number {
  const value = context.metadata?.compactedMessages;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function boundedCheckpoint(
  previous: ConversationCheckpoint,
  appended: JsonValue[],
): ConversationCheckpoint {
  const messages = appended.slice(-MAX_CONTEXT_MESSAGES);
  while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) > MAX_CONTEXT_BYTES) {
    messages.shift();
  }
  return {
    version: '1',
    messages,
    metadata: {
      ...previous.metadata,
      compactedMessages: Math.min(
        Number.MAX_SAFE_INTEGER,
        compactedMessageCount(previous) + appended.length - messages.length,
      ),
    },
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


function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
