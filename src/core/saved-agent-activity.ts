import { createHash } from 'node:crypto';
import type { ArtifactReference, JsonValue, RunRecord } from '../domain/contracts.js';
import { projectPublicAgentRuntime, type PublicAgentActivity } from './agent-activity-projection.js';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
const MAX_EVENTS = 200;

/** Project the bounded tail of immutable evidence; raw protocol data never leaves the host.
 * Saved and live sequences have different origins and must never be merged by sequence.
 */
export async function savedAgentActivity(
  run: RunRecord,
  reference: ArtifactReference,
  stream: AsyncIterable<Uint8Array>,
) {
  const hash = createHash('sha256');
  const decoder = new TextDecoder();
  const events: PublicAgentActivity[] = [];
  let bytes = 0;
  let sequence = 0;
  let pending = '';
  let incomplete = false;
  function consume(line: string) {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { incomplete = true; return; }
    if (!record || typeof record !== 'object' || typeof record.method !== 'string' || 'id' in record) return;
    const occurredAt = typeof record.emittedAtMs === 'number' && Number.isFinite(new Date(record.emittedAtMs).getTime())
      ? new Date(record.emittedAtMs).toISOString() : run.updatedAt;
    const params = record.params && typeof record.params === 'object' && !Array.isArray(record.params)
      ? record.params as Record<string, JsonValue> : {};
    const projected = projectPublicAgentRuntime({
      runId: run.runId, active: false, ready: false, oldestSequence: 1, nextSequence: sequence + 2,
      events: [{sequence: ++sequence, occurredAt, method: record.method, params}], pendingRequests: [],
    });
    events.push(...projected.events);
    if (events.length > MAX_EVENTS) events.shift();
  }
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BYTES) throw new Error('Saved Activity exceeds the preview limit');
    hash.update(chunk);
    pending += decoder.decode(chunk, {stream: true});
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      if (Buffer.byteLength(pending.slice(0, end), 'utf8') > MAX_LINE) throw new Error('Saved Activity line exceeds the preview limit');
      consume(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
    if (Buffer.byteLength(pending, 'utf8') > MAX_LINE) throw new Error('Saved Activity line exceeds the preview limit');
  }
  pending += decoder.decode();
  consume(pending);
  if (hash.digest('hex') !== reference.sha256) throw new Error('Saved Activity checksum mismatch');
  return {
    runId: run.runId, source: 'durable' as const, active: false, ready: false,
    oldestSequence: events[0]?.sequence ?? 1, nextSequence: sequence + 1,
    events, pendingRequests: [], truncated: incomplete || sequence > MAX_EVENTS,
  };
}
