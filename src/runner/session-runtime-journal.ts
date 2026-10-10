import type { SessionRuntimeState } from '../core/session-runtime-planning.js';
import { runtimeDeltaAddress } from '../core/session-journal-planning.js';

/** Serialize accepted states without dropping intermediate lifecycle transitions. */
export class SessionRuntimeJournal {
  private readonly pending: SessionRuntimeState[] = [];
  private writing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: Error | undefined;

  public constructor(private readonly options: {
    publish(state: SessionRuntimeState): Promise<boolean>;
    onFailure(error: Error): void;
    intervalMs?: number;
    maxPending?: number;
  }) {}

  public changed = (state: SessionRuntimeState): void => {
    if (this.failure) return;
    const last = this.pending.at(-1);
    const before = this.pending.at(-2);
    const delta = before && last ? runtimeDeltaAddress(before, last) : undefined;
    if (delta && last && delta === runtimeDeltaAddress(last, state)) this.pending[this.pending.length - 1] = state;
    else this.pending.push(state);
    if (this.pending.length > (this.options.maxPending ?? 1000)) {
      this.failure = new Error('Session journal cannot keep up with execution');
      this.options.onFailure(this.failure);
      return;
    }
    if (!this.timer && !this.writing) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, this.options.intervalMs ?? 250);
      this.timer.unref();
    }
  };

  public flush = async (): Promise<void> => {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.failure) throw this.failure;
    if (this.writing) return this.writing;
    this.writing = this.drain();
    try { await this.writing; }
    catch (error) {
      this.failure = error instanceof Error ? error : new Error('Session state could not be saved');
      this.options.onFailure(this.failure);
      throw this.failure;
    } finally { this.writing = undefined; }
  };

  private async drain(): Promise<void> {
    while (this.pending.length) {
      if (this.failure) throw this.failure;
      const state = this.pending.shift()!;
      if (!await this.options.publish(state)) throw new Error('Session execution authority changed');
    }
  }
}
