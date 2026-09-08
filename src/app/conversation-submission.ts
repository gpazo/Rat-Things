import { createHash } from 'node:crypto';
import type { ConversationQueue } from '../conversation/types.js';
import { ConversationConflictError } from '../conversation/types.js';
import { ConversationService } from '../conversation/service.js';
import type { RunRecord, RunRequest } from '../domain/contracts.js';
import { ValidationError } from '../domain/validation.js';
import type { RunService, SubmitOptions } from '../core/run-service.js';
import type { ThreadTarget } from '../core/run-submission-service.js';

export class ConversationSubmissionService {
  public constructor(
    private readonly conversations: ConversationService,
    private readonly queue: ConversationQueue,
    private readonly runs: Pick<RunService, 'idFor' | 'submit' | 'cancel'>,
  ) {}

  /** Reserves one public Run, then queues only its optional thread preparation. */
  public async submitThread(
    ownerId: string,
    request: RunRequest,
    submit: SubmitOptions,
    thread: ThreadTarget,
  ): Promise<RunRecord> {
    if (!request.source) throw new ValidationError('threaded Run requires a source');
    if (!submit.provenance) throw new ValidationError('threaded Run requires trusted provenance');
    const delivery = thread.delivery ?? await this.deliveryFor(
      thread.conversationId,
      thread.messageId,
    );
    const idempotencyKey = submit.idempotencyKey ?? thread.messageId;
    const runId = this.runs.idFor(ownerId, idempotencyKey);
    const preparedAttachments = thread.attachments?.length
      ? await this.conversations.prepareAttachments({
          conversationId: thread.conversationId,
          ownerId,
          messageId: thread.messageId,
          sourceRunId: runId,
          uploads: thread.attachments,
        })
      : undefined;
    // The Run is the durable acceptance record and recovery source. If the
    // process dies before the mailbox write, the queued-run reconciler can
    // reconstruct this thread occurrence from the immutable input artifact.
    const run = await this.runs.submit(ownerId, request, {
      ...submit,
      idempotencyKey,
      enqueue: false,
      conversation: {
        conversationId: thread.conversationId,
        messageId: thread.messageId,
        ...(thread.title ? { title: thread.title } : {}),
        delivery,
        ...(preparedAttachments ? {
          attachmentManifest: preparedAttachments.manifest,
          attachmentDigest: attachmentDigest(thread.attachments!),
        } : {}),
        ...(thread.replyToMessageId ? { replyToMessageId: thread.replyToMessageId } : {}),
      },
    });
    // RunService has already checked the immutable request and thread binding.
    // Older mailbox records included transport trace IDs in their content hash;
    // replay their accepted receipt rather than rebuilding transport metadata.
    const accepted = await this.conversations.getMessage(thread.conversationId, thread.messageId);
    if (accepted?.runId === run.runId) {
      if (run.status === 'queued') await this.queue.enqueue({
        version: '1', conversationId: thread.conversationId, runId: run.runId,
        ownerId, traceId: submit.traceId ?? run.runId,
      });
      return run;
    }
    const attachments = run.conversation?.attachmentManifest && preparedAttachments &&
      run.conversation.attachmentManifest.sha256 !== preparedAttachments.manifest.sha256
      ? (await this.conversations.readAttachmentManifest(run.conversation.attachmentManifest)).files
      : preparedAttachments?.files;
    try {
      await this.conversations.appendMessage({
        conversationId: thread.conversationId,
        ownerId,
        ...(submit.capabilityOwnerId ? { capabilityOwnerId: submit.capabilityOwnerId } : {}),
        messageId: thread.messageId,
        runId: run.runId,
        ...(thread.title ? { title: thread.title } : {}),
        delivery,
        content: {
          text: request.prompt,
          request,
          ...(attachments?.length ? { attachments } : {}),
          ...(thread.replyToMessageId ? { replyToMessageId: thread.replyToMessageId } : {}),
          metadata: {
            traceId: run.runId,
          },
        },
        source: request.source,
        destination: request.destinations?.[0] ?? { kind: 'none' },
        actor: submit.provenance.actor,
        credentialSubject: submit.provenance.credentialSubject,
        ...(request.agent && Object.keys(request.agent).length ? { executionPolicy: request.agent } : {}),
        ...(request.integrations ? { integrationPolicy: request.integrations } : {}),
      });
    } catch (error) {
      if (error instanceof ConversationConflictError &&
        !await this.conversations.getMessage(thread.conversationId, thread.messageId)) {
        // A fixed thread envelope rejected this occurrence after its durable Run
        // reservation. Tombstone the queued reservation so the scheduled crash-
        // window reconciler cannot turn a deterministic 409 into poison retries.
        await this.runs.cancel(ownerId, run.runId);
      }
      throw error;
    }
    await this.queue.enqueue({
      version: '1',
      conversationId: thread.conversationId,
      traceId: submit.traceId ?? run.runId,
      runId: run.runId,
      ownerId,
    });
    return run;
  }

  /**
   * Delivery priority is derived from mutable conversation state, but an
   * idempotent redelivery must retain the priority recorded by its first
   * receipt. A coordinator can bind a turn between two identical webhook
   * requests, so consult the stored message before reclassifying it.
   */
  private async deliveryFor(
    conversationId: string,
    messageId: string,
  ): Promise<'interrupt' | 'defer'> {
    const existing = await this.conversations.getMessage(conversationId, messageId);
    if (existing) return existing.delivery;
    const current = await this.conversations.get(conversationId);
    return current?.activeTurnId ? 'interrupt' : 'defer';
  }
}

export function apiConversationId(ownerId: string, conversationKey: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(conversationKey)) {
    throw new ValidationError('conversation ID must be 1-128 safe ASCII characters');
  }
  return `api:${hash(ownerId).slice(0, 32)}:${conversationKey}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function attachmentDigest(
  attachments: NonNullable<ThreadTarget['attachments']>,
): string {
  return hash(JSON.stringify(attachments.map((attachment) => ({
    name: attachment.name,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes.byteLength,
    sha256: attachment.sha256,
  }))));
}
