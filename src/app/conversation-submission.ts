import { createHash } from 'node:crypto';
import type { ConversationQueue } from '../conversation/types.js';
import { ConversationConflictError } from '../conversation/types.js';
import { ConversationService } from '../conversation/service.js';
import type { RunDestination, RunRecord, RunRequest } from '../domain/contracts.js';
import { ValidationError } from '../domain/validation.js';
import type { IngressContext } from '../identity/context.js';
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
    const runId = this.runs.idFor(ownerId, submit.idempotencyKey ?? thread.messageId);
    const preparedAttachments = thread.attachments?.length
      ? await this.conversations.prepareAttachments({
          conversationId: thread.conversationId,
          ownerId,
          messageId: thread.messageId,
          sourceRunId: runId,
          uploads: thread.attachments,
        })
      : undefined;
    const result = await this.appendRun({
      conversationId: thread.conversationId,
      ownerId,
      ...(submit.capabilityOwnerId ? { capabilityOwnerId: submit.capabilityOwnerId } : {}),
      messageId: thread.messageId,
      delivery,
      request,
      context: {
        owner: { id: ownerId },
        actor: submit.provenance.actor,
        credentialSubject: submit.provenance.credentialSubject,
        source: request.source,
      },
      destination: request.destinations?.[0] ?? { kind: 'none' },
      submit,
      ...(preparedAttachments ? {
        attachments: preparedAttachments.files,
        attachmentManifest: preparedAttachments.manifest,
        attachmentDigest: attachmentDigest(thread.attachments!),
      } : {}),
      ...(thread.replyToMessageId ? { replyToMessageId: thread.replyToMessageId } : {}),
    });
    return result.run;
  }

  private async appendRun(input: {
    conversationId: string;
    ownerId: string;
    capabilityOwnerId?: string;
    messageId: string;
    delivery: 'interrupt' | 'defer';
    request: RunRequest;
    context: IngressContext;
    destination: RunDestination;
    submit: SubmitOptions;
    attachments?: Awaited<ReturnType<ConversationService['prepareAttachments']>>['files'];
    attachmentManifest?: Awaited<ReturnType<ConversationService['prepareAttachments']>>['manifest'];
    attachmentDigest?: string;
    replyToMessageId?: string;
  }): Promise<{
    messageId: string;
    runId: string;
    status: 'appended' | 'duplicate';
    run: RunRecord;
  }> {
    const idempotencyKey = input.submit.idempotencyKey ?? input.messageId;
    // The Run is the durable acceptance record and recovery source. If the
    // process dies before the mailbox write, the queued-run reconciler can
    // reconstruct this thread occurrence from the immutable input artifact.
    const run = await this.runs.submit(input.ownerId, input.request, {
      ...input.submit,
      idempotencyKey,
      enqueue: false,
      conversation: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        delivery: input.delivery,
        ...(input.attachmentManifest ? { attachmentManifest: input.attachmentManifest } : {}),
        ...(input.attachmentDigest ? { attachmentDigest: input.attachmentDigest } : {}),
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      },
    });
    const attachments = run.conversation?.attachmentManifest && input.attachmentManifest &&
      run.conversation.attachmentManifest.sha256 !== input.attachmentManifest.sha256
      ? (await this.conversations.readAttachmentManifest(run.conversation.attachmentManifest)).files
      : input.attachments;
    let receipt;
    try {
      receipt = await this.conversations.appendMessage({
        conversationId: input.conversationId,
        ownerId: input.ownerId,
        ...(input.capabilityOwnerId ? { capabilityOwnerId: input.capabilityOwnerId } : {}),
        messageId: input.messageId,
        runId: run.runId,
        delivery: input.delivery,
        content: {
          text: input.request.prompt,
          request: input.request,
          ...(attachments?.length ? { attachments } : {}),
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
          metadata: {
            traceId: input.submit.traceId ?? run.runId,
          },
        },
        source: input.context.source,
        destination: input.destination,
        actor: input.context.actor,
        credentialSubject: input.context.credentialSubject,
        ...(input.request.agent ? { executionPolicy: input.request.agent } : {}),
        ...(input.request.integrations ? { integrationPolicy: input.request.integrations } : {}),
      });
    } catch (error) {
      if (error instanceof ConversationConflictError) {
        // A fixed thread envelope rejected this occurrence after its durable Run
        // reservation. Tombstone the queued reservation so the scheduled crash-
        // window reconciler cannot turn a deterministic 409 into poison retries.
        await this.runs.cancel(input.ownerId, run.runId);
      }
      throw error;
    }
    await this.queue.enqueue({
      version: '1',
      conversationId: input.conversationId,
      traceId: input.submit.traceId ?? run.runId,
      runId: run.runId,
      ownerId: input.ownerId,
    });
    return { messageId: receipt.message.messageId, runId: run.runId, status: receipt.status, run };
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
    const current = await this.conversations.get(conversationId);
    if (!current?.activeTurnId) return 'defer';
    const existing = await this.conversations.getMessage(conversationId, messageId);
    return existing?.delivery ?? 'interrupt';
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
