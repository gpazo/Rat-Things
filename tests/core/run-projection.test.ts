import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../../src/domain/contracts.js';
import { projectPublicRun } from '../../src/core/run-projection.js';

describe('public run projection', () => {
  it('keeps client lifecycle data while stripping internal authority and storage state', () => {
    const run: RunRecord = {
      runId: 'run-1',
      ownerId: 'api:owner-1',
      capabilityOwnerId: 'api:capability-owner',
      ownerCreated: 'api:owner-1#2026-08-24T10:00:00.000Z#run-1',
      status: 'succeeded',
      createdAt: '2026-08-24T10:00:00.000Z',
      updatedAt: '2026-08-24T10:01:00.000Z',
      expiresAt: 1_800_000_000,
      requestHash: 'a'.repeat(64),
      input: artifact('input.json'),
      executionInput: artifact('execution.json'),
      sourceKind: 'api',
      provenance: {
        actor: { kind: 'human', id: 'api:owner-1', provider: 'api' },
        credentialSubject: { kind: 'actor', id: 'api:owner-1' },
      },
      conversation: {
        conversationId: 'conversation-private',
        messageId: 'message-private',
        turnId: 'turn-private',
        preferredMicrovmId: 'microvm-private',
        agentThreadId: 'thread-private',
        continuation: artifact('continuation.json'),
      },
      thing: {
        version: '1',
        thingId: 'thing-1',
        revision: 2,
        specHash: 'b'.repeat(64),
        invocation: 'manual',
      },
      execution: {
        backend: 'microvm',
        id: 'microvm-private',
        startedAt: '2026-08-24T10:00:05.000Z',
      },
      result: {
        output: artifact('result.md'),
        preview: 'Finished safely.',
        exitCode: 0,
        durationMs: 55_000,
        agentThreadId: 'thread-private',
        usage: { inputTokens: 10, outputTokens: 4 },
        events: artifact('events.jsonl'),
        workspacePatch: artifact('workspace.patch'),
        artifacts: [{
          id: 'artifact-1',
          path: 'reports/result.txt',
          mediaType: 'text/plain; charset=utf-8',
          bytes: 17,
          createdAt: '2026-08-24T10:00:55.000Z',
          sourceRunId: 'run-1',
          file: artifact('result.txt'),
        }],
      },
    };

    const projected = projectPublicRun(run);

    expect(projected).toEqual({
      runId: 'run-1',
      status: 'succeeded',
      createdAt: '2026-08-24T10:00:00.000Z',
      updatedAt: '2026-08-24T10:01:00.000Z',
      expiresAt: 1_800_000_000,
      sourceKind: 'api',
      thing: run.thing,
      execution: {
        backend: 'microvm',
        startedAt: '2026-08-24T10:00:05.000Z',
      },
      result: {
        preview: 'Finished safely.',
        exitCode: 0,
        durationMs: 55_000,
        usage: { inputTokens: 10, outputTokens: 4 },
        artifacts: [{
          id: 'artifact-1',
          path: 'reports/result.txt',
          mediaType: 'text/plain; charset=utf-8',
          bytes: 17,
          createdAt: '2026-08-24T10:00:55.000Z',
          sourceRunId: 'run-1',
          sha256: 'c'.repeat(64),
        }],
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /owner|bucket|key|requestHash|provenance|conversation|microvm-private|thread-private/,
    );
  });

  it('projects queued, failed, and cancellation state without inventing optional fields', () => {
    const queued = baseRun();
    expect(projectPublicRun(queued)).toEqual({
      runId: queued.runId,
      status: 'queued',
      createdAt: queued.createdAt,
      updatedAt: queued.updatedAt,
      expiresAt: queued.expiresAt,
      sourceKind: queued.sourceKind,
    });

    const failed: RunRecord = {
      ...queued,
      status: 'failed',
      error: { code: 'agent_failed', message: 'bounded diagnostic', retryable: false },
      cancelRequestedAt: '2026-08-24T10:00:30.000Z',
    };
    expect(projectPublicRun(failed)).toMatchObject({
      status: 'failed',
      error: failed.error,
      cancelRequestedAt: failed.cancelRequestedAt,
    });
  });
});

function baseRun(): RunRecord {
  return {
    runId: 'run-queued',
    ownerId: 'owner-private',
    ownerCreated: 'owner-private#2026-08-24T10:00:00.000Z#run-queued',
    status: 'queued',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    expiresAt: 1_800_000_000,
    requestHash: 'd'.repeat(64),
    input: artifact('input.json'),
    sourceKind: 'api',
  };
}

function artifact(key: string) {
  return { bucket: 'private-bucket', key, sha256: 'c'.repeat(64) };
}
