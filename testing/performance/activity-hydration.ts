import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ArtifactReference } from '../../src/domain/contracts.js';
import type { AgentSession, AgentSessionItem } from '../../src/domain/agents-api.js';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { SessionService } from '../../src/core/session-service.js';
import type { SessionActivity } from '../../src/core/session-activity.js';
import { AgentService } from '../../src/core/agent-service.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { activityStream } from '../../src/lambdas/activity-stream.js';
import type { SessionFeedback } from '../../src/core/session-feedback-planning.js';
import { feedbackCollection, feedbackDigest } from '../../src/core/session-feedback-planning.js';
import type { SessionExecution, SessionState } from '../../src/core/session-ports.js';
import type { SessionStreamSnapshot } from '../../src/core/session-stream.js';
import { quantile } from './statistics.js';

type Options = { output: string; viewers: number; inputs: number; history: number; queryMs: number; objectMs: number; pollMs: number; timeoutMs: number };
type IndexRow = Record<string, unknown> & { scope: string; key: string; id: string; reference: ArtifactReference };
type Timings = { dynamoQueries: number; dynamoGets: number; objectGets: number; queryElapsedMs: number[]; objectElapsedMs: number[]; maxConcurrentObjectGets: number };

const options = readOptions(process.argv.slice(2));
const ownerId = 'synthetic-owner';
const sessionId = 'synthetic-session';
const baseKey = (value: { scope?: unknown; key?: unknown }) => JSON.stringify([value.scope, value.key]);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

class SyntheticDynamo {
  readonly rows = new Map<string, IndexRow>();
  readonly timings: Timings = { dynamoQueries: 0, dynamoGets: 0, objectGets: 0, queryElapsedMs: [], objectElapsedMs: [], maxConcurrentObjectGets: 0 };
  private activeObjectGets = 0;

  async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof GetCommand) {
      const started = performance.now();
      await pause(options.queryMs);
      this.timings.dynamoGets++;
      this.timings.queryElapsedMs.push(performance.now() - started);
      return { Item: this.rows.get(baseKey(command.input.Key ?? {})) };
    }
    if (command instanceof QueryCommand) {
      const started = performance.now();
      await pause(options.queryMs);
      this.timings.dynamoQueries++;
      this.timings.queryElapsedMs.push(performance.now() - started);
      const query = command.input;
      const scope = String(query.ExpressionAttributeValues?.[':scope']);
      const ascending = query.ScanIndexForward !== false;
      const rows = [...this.rows.values()].filter(row => row.scope === scope)
        .sort((left, right) => (ascending ? 1 : -1) * left.key.localeCompare(right.key))
        .filter(row => !query.ExclusiveStartKey || (ascending ? row.key > String(query.ExclusiveStartKey.key) : row.key < String(query.ExclusiveStartKey.key)));
      const page = rows.slice(0, query.Limit ?? rows.length);
      return { Items: page, ...(rows.length > page.length && page.length ? { LastEvaluatedKey: { scope, key: page.at(-1)!.key } } : {}) };
    }
    if (command instanceof TransactWriteCommand) {
      for (const item of command.input.TransactItems ?? []) {
        const row = item.Put?.Item as IndexRow | undefined;
        if (row) this.rows.set(baseKey(row), structuredClone(row));
      }
      return {};
    }
    throw new Error(`Unexpected Dynamo command: ${String((command as { constructor?: { name?: string } })?.constructor?.name)}`);
  }

  async getObject<T>(objects: Map<string, unknown>, reference: Pick<ArtifactReference, 'key'>): Promise<T> {
    const started = performance.now();
    this.activeObjectGets++;
    this.timings.maxConcurrentObjectGets = Math.max(this.timings.maxConcurrentObjectGets, this.activeObjectGets);
    try {
      await pause(options.objectMs);
      this.timings.objectGets++;
      const value = objects.get(reference.key);
      if (value === undefined) throw new Error(`Missing synthetic object ${reference.key}`);
      return structuredClone(value) as T;
    } finally {
      this.timings.objectElapsedMs.push(performance.now() - started);
      this.activeObjectGets--;
    }
  }
}

async function main() {
  const dynamo = new SyntheticDynamo();
  const objects = new Map<string, unknown>();
  const artifactStore = {
    putJson: async (key: string, value: unknown): Promise<ArtifactReference> => {
      objects.set(key, structuredClone(value));
      return { bucket: 'synthetic-private-bucket', key, sha256: 'synthetic' };
    },
    getJson: <T>(reference: Pick<ArtifactReference, 'key'>) => dynamo.getObject<T>(objects, reference),
  };
  const store = new DynamoAgentsStore({ send: (command: unknown) => dynamo.send(command) } as unknown as DynamoDBDocumentClient, 'synthetic-agents', artifactStore);
  const now = Math.floor(Date.now() / 1000);
  const session = syntheticSession(now);
  const state: SessionState = {
    session, turns: [], receipts: {}, deletedArtifacts: [],
    importedHistory: Array.from({ length: options.history }, (_, index) => historyItem(index)),
  };
  const observation: SessionStreamSnapshot = { session, turns: [], items: state.importedHistory! };
  await store.put({ ownerId, id: sessionId, collection: 'sessions', createdAt: now, revision: 1, value: state }, 0);
  await store.put({ ownerId, id: sessionId, collection: 'session_observations', createdAt: now, revision: 1, value: observation }, 0);

  const unexpectedExecution = async (): Promise<never> => { throw new Error('This fixture must only read durable activity'); };
  const execution: SessionExecution = {
    prepare: unexpectedExecution, start: unexpectedExecution, steer: unexpectedExecution, cancel: unexpectedExecution,
    toolResult: unexpectedExecution, observe: unexpectedExecution, items: unexpectedExecution, artifacts: unexpectedExecution, artifactContent: unexpectedExecution,
  };
  const agents = new AgentService({ store });
  const service = new SessionService({ store, agents, execution, streamIntervalMs: options.pollMs });
  const revalidate = async () => {};
  const observers = await Promise.all(Array.from({ length: options.viewers }, () => openObserver(service, revalidate)));
  try {
  const warm = await Promise.all(observers.map(observer => nextFrame(observer, options.timeoutMs)));
  if (warm.some(frame => frame.inputs.length !== 0 || frame.historyCount !== options.history)) throw new Error('Warm baseline has unexpected input or history counts');

  const feedbackTimestamp = performance.now();
  const awaitingFrames = observers.map(async observer => {
    const deadline = feedbackTimestamp + options.timeoutMs;
    let partialFrames = 0;
    try {
      while (performance.now() < deadline) {
        const frame = await nextFrame(observer, Math.max(1, deadline - performance.now()));
        if (frame.inputs.length >= options.inputs) return { status: 'observed' as const, frame, partialFrames };
        partialFrames++;
      }
      throw new Error('Timed out waiting for the complete feedback cohort');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown frame failure';
      return { status: detail.startsWith('Timed out') ? 'timeout' as const : 'error' as const, detail,
        lowerBoundMs: performance.now() - feedbackTimestamp, partialFrames };
    }
  });
  for (let index = 0; index < options.inputs; index++) {
    const subject = `writer-${index}`;
    const messageId = `msg-${index}`;
    const feedback: SessionFeedback = {
      sessionId, digest: feedbackDigest([messageId]), actor: { kind: 'human', id: subject }, acceptedAtMs: Date.now(),
      events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: `synthetic-${index}` }] }] }],
      messages: [{ id: messageId, role: 'user', content: [{ type: 'input_text', text: `synthetic-${index}` }], actor: { kind: 'human', id: subject }, provenance: { kind: 'authenticated' } }],
      turnId: `turn-${index}`, operationId: `op-${index}`,
    };
    await store.put({ ownerId, id: `feedback-${String(index).padStart(4, '0')}`, collection: feedbackCollection(sessionId), createdAt: feedback.acceptedAtMs, revision: 1, value: feedback }, 0);
  }
  const feedbackWritesCompletedAt = performance.now();
  const freshResults = await Promise.all(awaitingFrames);
  const observedAt = performance.now();
  const perViewer = freshResults.map((result, index) => result.status === 'observed' ? {
    viewer: index, status: result.status, partialFrames: result.partialFrames, frameMs: result.frame.receivedAt - feedbackWritesCompletedAt,
    receiptCount: result.frame.inputs.length,
    historyCount: result.frame.historyCount,
    attributedCount: result.frame.inputs.filter(receipt => {
      const writer = /^writer-(\d+)$/.exec(receipt.actor.id)?.[1];
      const pending = result.frame.pending_inputs?.find(input => input.receipt_id === receipt.id);
      const message = pending?.messages[0];
      return writer !== undefined && Number(writer) < options.inputs
        && receipt.id === `feedback-${writer.padStart(4, '0')}` && receipt.provenance?.kind === 'authenticated'
        && receipt.message_ids.length === 1 && receipt.message_ids[0] === `msg-${writer}`
        && pending?.messages.length === 1 && message?.id === `msg-${writer}` && message.actor?.id === receipt.actor.id
        && message.provenance?.kind === 'authenticated' && message.content.length === 1
        && message.content[0]?.type === 'input_text' && message.content[0].text === `synthetic-${writer}`;
    }).length,
    messageIds: result.frame.inputs.flatMap(receipt => receipt.message_ids),
  } : { viewer: index, status: result.status, detail: result.detail, partialFrames: result.partialFrames, lowerBoundMs: result.lowerBoundMs });
  const exact = perViewer.every(viewer => viewer.status === 'observed' && viewer.historyCount === options.history && viewer.receiptCount === options.inputs && viewer.attributedCount === options.inputs
    && viewer.messageIds.length === options.inputs && new Set(viewer.messageIds).size === options.inputs);

  const output = {
    schemaVersion: 1,
    kind: 'synthetic-dynamo-session-activity-hydration',
    source: sourceIdentity(),
    sourceClock: 'client monotonic performance.now; feedbackWriteCompletedAt is the last synthetic Dynamo put return, not an HTTP acknowledgement',
    transport: { dynamoReadLatencyMs: options.queryMs, objectGetLatencyMs: options.objectMs, implementation: 'in-memory command-compatible fake Dynamo plus synthetic object map; no AWS calls or billed inference' },
    fixture: { sessionId, ownerId, viewers: options.viewers, freshAttributedFeedbackReceipts: options.inputs, historyItems: options.history, defaultCadenceMs: options.pollMs, warmReaders: warm.length, inputWriteStartedAtMs: feedbackTimestamp, feedbackWritesCompletedAtMs: feedbackWritesCompletedAt, allPeerObservationsCompletedAtMs: observedAt },
    summary: { expected: options.viewers, peerVisibility: stats(perViewer.flatMap(value => value.status === 'observed' ? [value.frameMs] : [])), exactAttributionForAllViewers: exact,
      errors: freshResults.filter(result => result.status === 'error').length, censored: freshResults.filter(result => result.status === 'timeout').length },
    storage: { ...dynamo.timings, queryLatency: stats(dynamo.timings.queryElapsedMs), objectLatency: stats(dynamo.timings.objectElapsedMs) },
    samples: perViewer,
    exclusions: ['No HTTP input request, authorization, durable acceptance latency, real DynamoDB/S3 service latency, AWS scheduling, or native desktop rendering is measured.', 'Feedback writes are seeded through DynamoAgentsStore.put; write-completion-to-peer is synthetic storage-to-observer visibility, not ack-to-peer.', 'The fake delays each Dynamo read and S3 JSON read; writes are immediate. It does not model AWS retries, throughput limits, transfer size, partition behavior, or network variance.'],
  };
  await writeFile(resolve(options.output), `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: resolve(options.output), summary: output.summary, storage: { dynamoQueries: output.storage.dynamoQueries, dynamoGets: output.storage.dynamoGets, objectGets: output.storage.objectGets, maxConcurrentObjectGets: output.storage.maxConcurrentObjectGets } })}\n`);
  if (!exact) process.exitCode = 1;
  } finally {
    await Promise.allSettled(observers.map(observer => observer.close()));
  }
}

type Observer = { reader: ReadableStreamDefaultReader<Uint8Array>; abort: AbortController; buffer: string; close: () => Promise<void> };
type Frame = Pick<SessionActivity, 'inputs' | 'pending_inputs'> & { historyCount: number; receivedAt: number };
async function openObserver(service: SessionService, revalidate: () => Promise<void>): Promise<Observer> {
  const abort = new AbortController();
  const response = activityStream(signal => service.activityEvents(ownerId, sessionId, signal, { revalidate }), abort.signal, undefined, async () => ({ role: 'viewer', permissions: ['read'] }));
  if (!response.body) throw new Error('Activity SSE returned no body');
  const reader = response.body.getReader();
  return { reader, abort, buffer: '', close: async () => { abort.abort(); await reader.cancel().catch(() => {}); } };
}
async function nextFrame(observer: Observer, timeoutMs: number): Promise<Frame> {
  const deadline = performance.now() + timeoutMs;
  const decoder = new TextDecoder();
  while (performance.now() < deadline) {
    const remaining = deadline - performance.now();
    let boundary = observer.buffer.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = observer.buffer.slice(0, boundary);
      observer.buffer = observer.buffer.slice(boundary + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      if (data) {
        const event = JSON.parse(data) as { type?: string; activity?: SessionActivity };
        if (event.type === 'rat.session.activity' && event.activity) return { inputs: event.activity.inputs ?? [], pending_inputs: event.activity.pending_inputs ?? [], historyCount: event.activity.items.length, receivedAt: performance.now() };
      }
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      observer.reader.read().finally(() => { if (timer) clearTimeout(timer); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for activity frame after ${timeoutMs}ms`)), remaining); }),
    ]);
    if (next.done) throw new Error('Activity SSE closed before an attributed frame arrived');
    observer.buffer += decoder.decode(next.value, { stream: true });
    boundary = observer.buffer.indexOf('\n\n');
    if (boundary < 0) continue;
  }
  throw new Error('Unreachable activity frame deadline');
}
function historyItem(index: number): AgentSessionItem {
  return { id: `history-${index}`, type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', turn_id: 'history-turn', content: [{ type: 'output_text', text: `Synthetic retained history ${index} ${'x'.repeat(96)}` }] } as AgentSessionItem;
}
function syntheticSession(createdAt: number): AgentSession {
  const agent = sessionAgent({ model: 'deterministic-fixture' }, 'synthetic-agent', createdAt);
  return { id: sessionId, object: 'agent.session', agent, created_at: createdAt, last_active_at: createdAt,
    environment: { type: 'none' }, error: null, metadata: {}, status: 'idle', required_actions: [], usage: null, vault_ids: [] };
}
function stats(values: number[]) {
  if (!values.length) return { count: 0, min: null, median: null, p95: null, max: null };
  const ordered = [...values].sort((a, b) => a - b);
  return { count: ordered.length, min: ordered[0]!, median: quantile(ordered, 0.5), p95: quantile(ordered, 0.95), max: ordered.at(-1)! };
}
function sourceIdentity() {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  const script = resolve(process.argv[1]!);
  const productDiff = execFileSync('git', ['diff', '--binary', 'HEAD', '--', 'src/adapters/dynamo-agents-store.ts', 'src/core/session-service.ts', 'src/core/session-activity-polling.ts', 'src/lambdas/activity-stream.ts']);
  return { revision, dirty, productDiffSha256: createHash('sha256').update(productDiff).digest('hex'), harnessSha256: createHash('sha256').update(readFileSync(script)).digest('hex') };
}
function readOptions(args: string[]): Options {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (!name.startsWith('--') || !args[index + 1]) throw new Error(`Expected --name value, got ${name}`);
    values[name.slice(2)] = args[++index]!;
  }
  const limits: Record<string, [number, number]> = { viewers: [1, 50], inputs: [1, 20], history: [0, 200], 'query-ms': [1, 1000], 'object-ms': [1, 1000], 'poll-ms': [1, 2000], 'timeout-ms': [100, 30_000] };
  const number = (name: string, fallback: number) => {
    const value = Number(values[name] ?? fallback);
    const [minimum, maximum] = limits[name]!;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid --${name}: expected integer ${minimum}..${maximum}`);
    return value;
  };
  const output = values.output ?? `/tmp/activity-hydration-${Date.now()}.json`;
  return { output, viewers: number('viewers', 50), inputs: number('inputs', 20), history: number('history', 200), queryMs: number('query-ms', 5), objectMs: number('object-ms', 20), pollMs: number('poll-ms', 500), timeoutMs: number('timeout-ms', 15_000) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(async error => {
    await writeFile(resolve(options.output), `${JSON.stringify({ schemaVersion: 1, kind: 'synthetic-dynamo-session-activity-hydration', source: sourceIdentity(), status: 'failed', error: error instanceof Error ? error.message : 'unknown failure', timeoutMs: options.timeoutMs, boundedSyntheticTransport: { dynamoCommandLatencyMs: options.queryMs, objectGetLatencyMs: options.objectMs } }, null, 2)}\n`);
    process.stderr.write(`Activity hydration harness failed; diagnostic saved to ${resolve(options.output)}\n`);
    process.exitCode = 1;
  });
}
