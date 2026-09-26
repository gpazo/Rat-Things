import type OpenAI from 'openai';
import type { OtlpTraceData, SessionTracePage, TraceListParams } from './domain/session-traces.js';

/** SDK escape hatch until upstream ships the documented traces resource. */
export function sessionTracePage(client: OpenAI, sessionId: string, query: TraceListParams = {}): Promise<SessionTracePage> {
  return client.get(`/agents/sessions/${encodeURIComponent(sessionId)}/traces`, { query, headers: { 'OpenAI-Beta': 'agents=v1' } });
}

export async function exportSessionTraces(load: (query: TraceListParams) => Promise<SessionTracePage>, query: TraceListParams = {}): Promise<OtlpTraceData> {
  const resourceSpans: OtlpTraceData['resourceSpans'] = [];
  const seen = new Set<string>();
  let after = query.after;
  while (true) {
    const page = await load({ ...query, order: query.order ?? 'asc', ...(after ? { after } : {}) });
    resourceSpans.push(...page.data.flatMap(trace => trace.otlp.resourceSpans));
    if (!page.has_more) return { resourceSpans };
    if (!page.last_id || page.last_id === after || seen.has(page.last_id)) throw new Error('Trace pagination did not advance');
    seen.add(page.last_id);
    after = page.last_id;
  }
}
