import type { ExecutionReference } from '../domain/contracts.js';

export interface ExecutionHeartbeatStore {
  heartbeatExecution(
    runId: string,
    execution: ExecutionReference,
    heartbeatAt: string,
  ): Promise<boolean>;
}

export interface ExecutionHeartbeatOptions {
  store: ExecutionHeartbeatStore;
  runId: string;
  execution: ExecutionReference;
  intervalMs: number;
  now?: () => Date;
  onAuthorityLost: () => void;
  onError?: (error: unknown) => void;
}

/** Serial, abort-aware heartbeat loop for one exact execution generation. */
export class ExecutionHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  public constructor(private readonly options: ExecutionHeartbeatOptions) {
    if (
      !Number.isInteger(options.intervalMs) ||
      options.intervalMs < 10 ||
      options.intervalMs > 300_000
    ) throw new Error('heartbeat interval is invalid');
    if (!options.execution.generation) throw new Error('execution heartbeat requires a generation');
  }

  public start(): void {
    if (this.stopped || this.timer || this.inFlight) return;
    this.schedule();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = undefined;
        this.schedule();
      });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const heartbeatAt = (this.options.now ?? (() => new Date()))().toISOString();
      const retained = await this.options.store.heartbeatExecution(
        this.options.runId,
        this.options.execution,
        heartbeatAt,
      );
      if (!retained) {
        this.stopped = true;
        this.options.onAuthorityLost();
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
