/** Serializes a Session's storage admission and worker effects through shutdown. */
export class LocalRuntimeLifecycle {
  private readonly pending = new Map<string, Promise<unknown>>();
  private closing: Promise<void> | undefined;

  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Local runtime is shutting down'));
    const result = (this.pending.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.pending.set(sessionId, result);
    void result.finally(() => { if (this.pending.get(sessionId) === result) this.pending.delete(sessionId); }).catch(() => {});
    return result;
  }

  close(cleanup: () => Promise<void>): Promise<void> {
    this.closing ??= (async () => { await Promise.allSettled(this.pending.values()); await cleanup(); })();
    return this.closing;
  }
}
