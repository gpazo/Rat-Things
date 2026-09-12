import { validateArtifactCatalog } from '../domain/artifacts.js';
import type { ArtifactCatalog, RunActorContext, RunCredentialSubjectContext, RunDestination, RunSource } from '../domain/contracts.js';
import type { IntegrationAccessRequest } from '../domain/capabilities.js';
import type { ConversationCheckpoint, ConversationDelivery, ConversationExecutionPolicy, ConversationMessageContent } from '../domain/conversations.js';
import { canonicalJson } from '../domain/json.js';
import { parseRunRequest } from '../domain/validation.js';
import { ConversationStateError } from './types.js';

export const MAX_TEXT_BYTES = 100_000;
const MAX_METADATA_BYTES = 32_000;
const MAX_CONSUME_BATCH = 20;

export interface AppendConversationMessageInput {
  conversationId: string;
  ownerId: string;
  capabilityOwnerId?: string;
  messageId: string;
  /** Optional human display name, independent of the routing key. */
  title?: string;
  /** Public Run reserved for this exact mailbox item before coordination. */
  runId?: string;
  delivery: ConversationDelivery;
  content: ConversationMessageContent;
  source: RunSource;
  destination: RunDestination;
  actor: RunActorContext;
  credentialSubject: RunCredentialSubjectContext;
  executionPolicy?: ConversationExecutionPolicy;
  integrationPolicy?: IntegrationAccessRequest;
  receivedAt?: string;
}

export function validateMessageInput(input: AppendConversationMessageInput): void {
  requiredId(input.conversationId, 'conversationId', 512);
  requiredId(input.ownerId, 'ownerId', 1_024);
  if (input.capabilityOwnerId) requiredId(input.capabilityOwnerId, 'capabilityOwnerId', 1_024);
  requiredId(input.messageId, 'messageId', 512);
  if (input.runId) requiredId(input.runId, 'runId', 128);
  validateMessageContent(input.content);
  if (input.title !== undefined) requiredText(input.title, 'title', 512);
  if (input.delivery !== 'interrupt' && input.delivery !== 'defer') {
    throw new ConversationStateError('delivery must be interrupt or defer');
  }
}

export function validateConversationArtifactCatalog(value: unknown, fallback: string): asserts value is ArtifactCatalog {
  try {
    validateArtifactCatalog(value);
  } catch (error) {
    throw new ConversationStateError(error instanceof Error ? error.message : fallback);
  }
}

export function validateExecutionPolicy(input: ConversationExecutionPolicy): ConversationExecutionPolicy {
  if ('outputSchema' in (input as Record<string, unknown>)) {
    throw new ConversationStateError('conversation execution policy cannot define an output schema');
  }
  const parsed = parseRunRequest({
    version: '1',
    prompt: 'validate trusted conversation execution policy',
    agent: input,
  }).agent;
  if (!parsed) throw new ConversationStateError('conversation execution policy is invalid');
  return {
    ...(parsed.driver ? { driver: parsed.driver } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.sandbox ? { sandbox: parsed.sandbox } : {}),
    ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
    ...(parsed.reasoningSummary ? { reasoningSummary: parsed.reasoningSummary } : {}),
    ...(parsed.personality ? { personality: parsed.personality } : {}),
    ...(parsed.capabilities ? { capabilities: parsed.capabilities } : {}),
  };
}

export function validateIntegrationPolicy(input: IntegrationAccessRequest): IntegrationAccessRequest {
  const parsed = parseRunRequest({
    version: '1',
    prompt: 'validate trusted conversation integration policy',
    integrations: input,
  }).integrations;
  if (!parsed) throw new ConversationStateError('conversation integration policy is invalid');
  return parsed;
}

export function requiredId(value: string, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConversationStateError(`${label} is required`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ConversationStateError(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

export function requiredText(value: string, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConversationStateError(`${label} is required`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ConversationStateError(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

export function uniqueMessageIds(values: string[]): string[] {
  const result = [...new Set(values.map((id) => requiredId(id, 'messageId', 512)))];
  if (result.length === 0 || result.length > MAX_CONSUME_BATCH) {
    throw new ConversationStateError(`messageIds must contain 1-${MAX_CONSUME_BATCH} unique values`);
  }
  return result;
}

export function validateMessageContent(content: ConversationMessageContent): void {
  const hasText = typeof content.text === 'string' && content.text.trim().length > 0;
  const hasAttachments = Array.isArray(content.attachments) && content.attachments.length > 0;
  if (!hasText && !hasAttachments) throw new ConversationStateError('message requires text or attachments');
  if (Buffer.byteLength(content.text, 'utf8') > MAX_TEXT_BYTES) {
    throw new ConversationStateError(`message text exceeds ${MAX_TEXT_BYTES} bytes`);
  }
  if ((content.attachments?.length ?? 0) > 20) {
    throw new ConversationStateError('message supports at most 20 attachment references');
  }
  if (content.attachments?.length) {
    try {
      validateArtifactCatalog({ version: '1', files: content.attachments });
    } catch (error) {
      throw new ConversationStateError(error instanceof Error ? error.message : 'message attachments are invalid');
    }
  }
  if (content.replyToMessageId !== undefined) requiredId(content.replyToMessageId, 'replyToMessageId', 512);
  if (content.metadata && Buffer.byteLength(canonicalJson(content.metadata), 'utf8') > MAX_METADATA_BYTES) {
    throw new ConversationStateError(`message metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  if (content.request) {
    let parsed;
    try {
      parsed = parseRunRequest(content.request);
    } catch (error) {
      throw new ConversationStateError(
        error instanceof Error ? error.message : 'message request is invalid',
      );
    }
    if (parsed.prompt !== content.text) {
      throw new ConversationStateError('message text must match its canonical Run prompt');
    }
  }
}

export function validateCheckpoint(checkpoint: ConversationCheckpoint): void {
  if (checkpoint.version !== '1' || !Array.isArray(checkpoint.messages)) {
    throw new ConversationStateError('checkpoint must be a version 1 message array');
  }
  const bytes = Buffer.byteLength(canonicalJson(checkpoint), 'utf8');
  if (bytes > 5_000_000) throw new ConversationStateError('checkpoint exceeds 5000000 bytes');
}

export function assertIsoDate(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new ConversationStateError(`${label} must be an ISO date`);
}
