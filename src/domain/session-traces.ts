/** OTLP JSON uses hexadecimal IDs and decimal strings for nanosecond timestamps. */
export interface OtlpAttribute { key: string; value: { stringValue: string } | { intValue: string } }
export interface OtlpSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startTimeUnixNano: string; endTimeUnixNano: string;
  attributes: OtlpAttribute[]; status: { code: number };
}
export interface OtlpTraceData {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>;
  }>;
}
export interface SessionTrace { id: string; object: 'agent.session.trace'; session_id: string; turn_id: string; otlp: OtlpTraceData }
export interface TraceListParams { after?: string; limit?: number; order?: 'asc' | 'desc' }
export interface SessionTracePage { object: 'list'; data: SessionTrace[]; has_more: boolean; first_id: string | null; last_id: string | null }

/** Content-free observations; never copy arbitrary native payloads into telemetry. */
export interface TraceStep {
  id: string; kind: 'tool' | 'generation'; name: string; toolName?: string; serverLabel?: string;
  startedAt?: number; completedAt?: number; failed?: boolean;
  inputTokens?: number | undefined; outputTokens?: number | undefined;
}
