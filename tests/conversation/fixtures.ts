import type { ArtifactReference, RunRecord, RunResult } from '../../src/domain/contracts.js';
import type { ConversationMessageRecord, ConversationRecord, ConversationTurnRecord } from '../../src/domain/conversations.js';
import type { AgentToolCallRecord } from '../../src/domain/interaction.js';

export const timestamp = '2026-08-03T12:00:00.000Z';
export const lease = {
  token: 'lease-1', acquiredAt: timestamp, checkedInAt: timestamp, expiresAt: '2026-08-03T12:01:30.000Z',
};

export function artifact(key: string): ArtifactReference {
  return { bucket: 'private-artifacts', key, sha256: 'a'.repeat(64) };
}

export function conversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    version: '1', itemType: 'conversation', conversationId: 'conversation-1', ownerId: 'owner-1',
    status: 'running', pendingCount: 0, createdAt: timestamp, updatedAt: timestamp, expiresAt: 2_000_000_000,
    source: { kind: 'api', requestId: 'request-1' }, destination: { kind: 'none' },
    actor: { kind: 'human', id: 'owner-1', provider: 'api' }, credentialSubject: { kind: 'runtime', id: 'runtime-1' },
    context: artifact('context.json'), lease,
    session: {
      backend: 'microvm', id: 'microvm-1', state: 'suspended', updatedAt: timestamp,
      expiresAt: '2026-08-03T20:00:00.000Z', agentThreadId: 'thread-1',
    },
    ...overrides,
  };
}

export function message(overrides: Partial<ConversationMessageRecord> = {}): ConversationMessageRecord {
  const record = conversation();
  return {
    version: '1', itemType: 'message', conversationId: record.conversationId, messageId: 'message-1',
    delivery: 'defer', state: 'pending', actor: record.actor, credentialSubject: record.credentialSubject,
    source: record.source, destination: record.destination, content: artifact('message.json'),
    contentHash: 'b'.repeat(64), attemptCount: 0, createdAt: timestamp, receivedAt: timestamp,
    expiresAt: record.expiresAt, runId: 'run-1', ...overrides,
  };
}

export function turn(overrides: Partial<ConversationTurnRecord> = {}): ConversationTurnRecord {
  return {
    version: '1', itemType: 'turn', conversationId: 'conversation-1', turnId: 'turn-1',
    state: 'running', slice: 0, startedAt: timestamp, updatedAt: timestamp,
    expiresAt: 2_000_000_000, runId: 'run-1', ...overrides,
  };
}

export function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    output: artifact('output.md'), events: artifact('events.jsonl'), preview: 'Saved preview',
    exitCode: 0, durationMs: 0, agentThreadId: 'thread-1', artifacts: [], ...overrides,
  };
}

export function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1', ownerId: 'owner-1', ownerCreated: `owner-1#${timestamp}#run-1`,
    status: 'succeeded', createdAt: timestamp, updatedAt: timestamp, expiresAt: 2_000_000_000,
    requestHash: 'b'.repeat(64), input: artifact('input.json'), sourceKind: 'api',
    conversation: { conversationId: 'conversation-1', messageId: 'message-1', turnId: 'turn-1', slice: 0, continuation: artifact('continuation.json') },
    execution: { backend: 'microvm', id: 'microvm-1', startedAt: timestamp }, result: result(), ...overrides,
  };
}

export function toolCall(overrides: Partial<AgentToolCallRecord> = {}): AgentToolCallRecord {
  return {
    version: '1', runId: 'run-1', requestId: 'call-1', method: 'item/tool/call',
    executionId: 'microvm-1', executionGeneration: 'c'.repeat(64), namespace: 'crm', tool: 'records_create',
    argumentDigest: 'd'.repeat(64), admittedToolsDigest: 'e'.repeat(64), status: 'interrupted',
    startedAt: timestamp, ...overrides,
  };
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
