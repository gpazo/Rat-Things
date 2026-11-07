import { AgentsApiError } from '../domain/agents-api-validation.js';

export interface ActivityEvent {
  event_id?: string;
  type?: string;
  activity?: unknown;
}

export interface ActivityAuthority {
  role: string;
  permissions: readonly string[];
}

/** Adapt the durable async stream to SSE while keeping cancellation and authorization at the boundary. */
export function activityStream(
  events: (signal: AbortSignal) => AsyncIterable<ActivityEvent>,
  parentSignal: AbortSignal,
  requestId: string | undefined,
  authorize: () => Promise<ActivityAuthority>,
) {
  const abort = new AbortController();
  const signal = abort.signal;
  const iterator = events(signal)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let pending: Promise<IteratorResult<ActivityEvent>> | undefined;
  let previousRole: string | undefined;
  let stopped = false;
  let cancelled = false;
  let removeAbortListener = () => {};

  const stop = () => {
    if (stopped) return;
    stopped = true;
    removeAbortListener();
    abort.abort();
    // return() can wait behind a pending next(). Observe its failure without making
    // response cancellation wait indefinitely for a non-cooperative iterator.
    try { void Promise.resolve(iterator.return?.()).catch(() => undefined); }
    catch { /* Cancellation must not turn into a second stream failure. */ }
  };
  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    stop();
    if (!cancelled) controller.close();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        if (signal.aborted || stopped) { close(controller); return; }
        await authorize();
        if (signal.aborted || stopped) { close(controller); return; }
        pending ??= Promise.resolve(iterator.next());
        const outcome = await Promise.race([
          pending.then(value => ({ kind: 'event' as const, value })),
          new Promise<{ kind: 'heartbeat' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'heartbeat' }), 1000); }),
          new Promise<{ kind: 'abort' }>(resolve => {
            onAbort = () => resolve({ kind: 'abort' });
            signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
        if (outcome.kind === 'abort' || stopped || signal.aborted) { close(controller); return; }
        if (outcome.kind === 'heartbeat') {
          const authority = await authorize();
          if (signal.aborted || stopped) { close(controller); return; }
          if (previousRole !== authority.role) controller.enqueue(encoder.encode(`event: rat.space.permissions\ndata: ${JSON.stringify({ type: 'rat.space.permissions', role: authority.role, permissions: authority.permissions })}\n\n`));
          else controller.enqueue(encoder.encode(': keepalive\n\n'));
          previousRole = authority.role;
          return;
        }
        pending = undefined;
        if (outcome.value.done) { close(controller); return; }

        // Revalidate after the read so a queued event is never sent after revocation.
        const current = await authorize();
        if (signal.aborted || stopped) { close(controller); return; }
        previousRole = current.role;
        const event = { ...outcome.value.value, role: current.role, permissions: current.permissions,
          ...(outcome.value.value.activity && typeof outcome.value.value.activity === 'object' ? { activity: { ...outcome.value.value.activity, role: current.role, permissions: current.permissions } } : {}) };
        controller.enqueue(encoder.encode(`${event.event_id ? `id: ${event.event_id}\n` : ''}event: ${event.type ?? 'rat.session.activity'}\ndata: ${JSON.stringify(event)}\n\n`));
      } catch (error) {
        if (signal.aborted || stopped || isExpectedShutdown(error)) { close(controller); return; }
        stop();
        controller.error(error);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    },
    cancel() { cancelled = true; stop(); },
  });

  parentSignal.addEventListener('abort', stop, { once: true });
  removeAbortListener = () => parentSignal.removeEventListener('abort', stop);
  if (parentSignal.aborted) stop();
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(requestId ? { 'x-request-id': requestId } : {}) } });
}

function isExpectedShutdown(error: unknown): boolean {
  return error instanceof AgentsApiError && (error.status === 404 && error.code === 'resource_not_found' || error.status === 401 || error.status === 403);
}
