import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ArtifactStore, CreateRunResult, RunQueue, RunStore } from '../../src/core/ports.js';
import { RunService } from '../../src/core/run-service.js';
import {
  RunSubmissionService,
  type ThreadRunSubmissionPort,
  type ThreadTarget,
} from '../../src/core/run-submission-service.js';
import type { ArtifactReference, ListRunsResult, RunRecord, RunRequest } from '../../src/domain/contracts.js';
import { providerIngressContext, type ProviderKind } from '../../src/identity/context.js';
import { normalizedWork } from '../../src/ingress/providers/shared.js';
import { WebhookIngressService } from '../../src/ingress/service.js';
import type { IngressWork } from '../../src/ingress/types.js';
import { apiRunSubmissionBody } from '../../src/lambdas/control.js';
import { RuntimePluginRegistry } from '../../src/plugins/registry.js';

describe('universal Run ingress simulation', () => {
  it('returns the same durable Run contract immediately for API and every provider', async () => {
    const store = new MemoryRuns();
    const runQueue = new MemoryQueue();
    const runs = new RunService({
      store,
      artifacts: new MemoryArtifacts(),
      queue: runQueue,
      executions: { stop: async () => undefined },
      ids: {
        random: () => `random-${store.records.length + 1}`,
        deterministic: (_ownerId, key) => `run-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`,
      },
    });
    const threads = new SimulatedThreads(runs);
    const submissions = new RunSubmissionService(runs, threads);

    const apiOneShot = apiRunSubmissionBody(
      { version: '1', prompt: 'API one shot' },
      { kind: 'api' },
      'api:owner',
      'api-one-shot',
    );
    const receipts: RunRecord[] = [await submissions.submit(
      'api:owner',
      apiOneShot.request,
      { idempotencyKey: 'api-one-shot' },
    )];

    const apiThread = apiRunSubmissionBody(
      { version: '1', prompt: 'API continuation', thread: { key: 'support' } },
      { kind: 'api' },
      'api:owner',
      'api-thread-message',
    );
    receipts.push(await submissions.submit('api:owner', apiThread.request, {
      idempotencyKey: 'api-thread-message',
      ...(apiThread.thread ? { thread: apiThread.thread } : {}),
    }));

    for (const provider of ['github', 'gitlab', 'teams', 'slack'] as const) {
      const work = providerWork(provider);
      const registry = new RuntimePluginRegistry([{
        manifest: { name: provider, version: '1', description: `${provider} fixture`, provider },
        ingress: {
          provider,
          receive: async () => ({ kind: 'run' as const, work }),
          acknowledge: (run) => ({ statusCode: 202, body: run }),
        },
      }]);
      const response = await new WebhookIngressService(registry, submissions)
        .receive(provider, { body: '{}', headers: {} });
      receipts.push(response.body as RunRecord);
    }

    expect(receipts).toHaveLength(6);
    expect(receipts.every((record) => record.status === 'queued')).toBe(true);
    expect(receipts.every((record) => Boolean(record.runId && record.input))).toBe(true);
    expect(receipts.map((record) => record.sourceKind)).toEqual([
      'api', 'api', 'github', 'gitlab', 'teams', 'slack',
    ]);
    expect(store.records).toHaveLength(6);
    expect(runQueue.messages).toHaveLength(3);
    expect(threads.targets[0]?.conversationId).toMatch(/^api:[a-f0-9]{32}:support$/);
    expect(threads.targets.slice(1).map((target) => target.conversationId)).toEqual([
      'teams:tenant-1:user-1:conversation-1',
      'slack:team-1:user-1:channel-1:thread-1',
    ]);
    expect(store.records.filter((record) => record.conversation)).toHaveLength(3);
  });
});

class SimulatedThreads implements ThreadRunSubmissionPort {
  public readonly targets: ThreadTarget[] = [];

  public constructor(private readonly runs: RunService) {}

  public async submitThread(
    ownerId: string,
    request: RunRequest,
    options: Parameters<RunService['submit']>[2],
    thread: ThreadTarget,
  ): Promise<RunRecord> {
    this.targets.push(structuredClone(thread));
    return this.runs.submit(ownerId, request, {
      ...options,
      enqueue: false,
      conversation: { conversationId: thread.conversationId, messageId: thread.messageId },
    });
  }
}

function providerWork(provider: Exclude<ProviderKind, 'api'>): IngressWork {
  const source = provider === 'github'
    ? { kind: 'github' as const, deliveryId: 'delivery-1', event: 'pull_request', repository: 'acme/repo' }
    : provider === 'gitlab'
      ? { kind: 'gitlab' as const, event: 'Merge Request Hook', projectId: 'project-1' }
      : provider === 'teams'
        ? {
            kind: 'teams' as const,
            tenantId: 'tenant-1',
            conversationId: 'conversation-1',
            activityId: 'activity-1',
            senderId: 'user-1',
          }
        : {
            kind: 'slack' as const,
            teamId: 'team-1',
            channelId: 'channel-1',
            threadTs: 'thread-1',
            eventId: 'event-1',
            userId: 'user-1',
          };
  return normalizedWork({
    ownerId: `${provider}:owner`,
    idempotencyKey: `${provider}:event-1`,
    request: { version: '1', prompt: `${provider} request`, source },
  }, `${provider}-trace`);
}

class MemoryArtifacts implements ArtifactStore {
  public async putJson(key: string, value: unknown): Promise<ArtifactReference> {
    return {
      bucket: 'artifacts',
      key,
      sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    };
  }
  public async getJson<T>(): Promise<T> { throw new Error('not implemented'); }
  public async putBytes(): Promise<ArtifactReference> { throw new Error('not implemented'); }
  public async getBytes(): Promise<Uint8Array> { throw new Error('not implemented'); }
  public async putStream(): Promise<ArtifactReference> { throw new Error('not implemented'); }
  public async getStream(): Promise<AsyncIterable<Uint8Array>> { throw new Error('not implemented'); }
  public async copy(): Promise<ArtifactReference> { throw new Error('not implemented'); }
}

class MemoryQueue implements RunQueue {
  public readonly messages: Array<{ version: '1'; runId: string; traceId: string }> = [];
  public async enqueue(message: { version: '1'; runId: string; traceId: string }): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

class MemoryRuns implements RunStore {
  public readonly records: RunRecord[] = [];
  public async create(record: RunRecord): Promise<CreateRunResult> {
    this.records.push(structuredClone(record));
    return { created: true, record: structuredClone(record) };
  }
  public async get(runId: string): Promise<RunRecord | undefined> {
    return structuredClone(this.records.find((record) => record.runId === runId));
  }
  public async list(): Promise<ListRunsResult> { return { items: structuredClone(this.records) }; }
  public async transition(): Promise<RunRecord> { throw new Error('not implemented'); }
  public async prepareConversation(): Promise<RunRecord> { throw new Error('not implemented'); }
  public async attachExecution(): Promise<RunRecord> { throw new Error('not implemented'); }
  public async complete(): Promise<RunRecord> { throw new Error('not implemented'); }
  public async fail(): Promise<RunRecord> { throw new Error('not implemented'); }
}
