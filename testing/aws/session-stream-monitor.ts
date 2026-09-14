/** A live subscription must stay open until the probe explicitly cancels it. */
export function monitorSessionStream<T>(events: AsyncIterable<T>, signal: AbortSignal, onEvent: (event: T) => void) {
  let failure: Error | undefined;
  const done = (async () => {
    try {
      for await (const event of events) onEvent(event);
      if (!signal.aborted) failure = new Error('Live Session stream ended before the probe cancelled it.');
    } catch (error) { if (!signal.aborted) failure = error instanceof Error ? error : new Error('Live Session stream failed.'); }
  })();
  return { done, check() { if (failure !== undefined) throw failure; } };
}
