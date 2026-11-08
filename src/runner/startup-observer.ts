import { performance } from 'node:perf_hooks';
import type { SessionRuntimeState } from '../core/session-runtime-planning.js';

const startupPhases = [
  'runner_entered',
  'run_loaded',
  'driver_ready',
  'native_initialize_started',
  'native_initialized',
  'thread_ready',
  'turn_requested',
  'first_assistant_text',
  'first_text_persisted',
] as const;

export type StartupPhase = typeof startupPhases[number];
export type StartupTraceOutcome = 'first_text_persisted' | 'failed' | 'shutdown';

export interface StartupPhaseObservation {
  readonly phase: StartupPhase;
  readonly offsetMs: number;
}

export interface StartupTraceRecord {
  readonly event: 'runner_startup_trace';
  readonly version: 1;
  readonly wallOrigin?: string;
  readonly phases: readonly StartupPhaseObservation[];
  readonly outcome: StartupTraceOutcome;
}

export interface StartupTraceObserver {
  readonly active: boolean;
  mark(phase: StartupPhase): void;
  finish(outcome: StartupTraceOutcome): void;
}

export interface StartupTraceDependencies {
  monotonicNow?: () => number;
  wallNow?: () => string;
  emit?: (record: StartupTraceRecord) => void;
}

const phaseSet = new Set<string>(startupPhases);

export function createStartupTraceObserver(dependencies: StartupTraceDependencies = {}): StartupTraceObserver {
  return new RunnerStartupTrace(dependencies);
}

/** Detect output from the accepted root Turn, excluding whitespace and prior or child Turns. */
export function hasFirstRootAssistantText(state: SessionRuntimeState, turnId: string): boolean {
  const binding = state.turns.find((candidate) => candidate.turn.id === turnId
    && candidate.threadId === state.rootThreadId && candidate.turn.subagent_id === null);
  return binding?.items.some((item) => item.type === 'message' && item.role === 'assistant'
    && item.content.some((part) => part.type === 'output_text' && part.text.trim().length > 0)) ?? false;
}

export async function publishStartupSnapshot(
  state: SessionRuntimeState,
  turnId: string,
  observer: StartupTraceObserver,
  publish: (state: SessionRuntimeState) => Promise<boolean>,
): Promise<boolean> {
  const saved = await publish(state);
  if (saved && observer.active && hasFirstRootAssistantText(state, turnId)) {
    observer.mark('first_text_persisted');
    observer.finish('first_text_persisted');
  }
  return saved;
}

class RunnerStartupTrace implements StartupTraceObserver {
  private readonly origin: number | undefined;
  private readonly wallOrigin: string | undefined;
  private readonly seen = new Set<StartupPhase>();
  private readonly phases: StartupPhaseObservation[] = [];
  private lastOffset = -Infinity;
  private finished = false;
  private timingUnavailable = false;

  public constructor(private readonly dependencies: StartupTraceDependencies) {
    this.origin = this.readMonotonic();
    this.wallOrigin = this.readWallOrigin();
    this.timingUnavailable = this.origin === undefined;
  }

  public get active(): boolean { return !this.finished && !this.timingUnavailable; }

  public mark(phase: StartupPhase): void {
    if (this.finished || this.seen.has(phase) || !phaseSet.has(phase) || this.phases.length >= startupPhases.length || this.origin === undefined) return;
    const now = this.readMonotonic();
    if (now === undefined) { this.timingUnavailable = true; return; }
    if (now < this.origin) return;
    const offsetMs = now - this.origin;
    if (offsetMs < this.lastOffset) return;
    this.seen.add(phase);
    this.phases.push({ phase, offsetMs });
    this.lastOffset = offsetMs;
  }

  public finish(outcome: StartupTraceOutcome): void {
    if (this.finished) return;
    this.finished = true;
    const record: StartupTraceRecord = {
      event: 'runner_startup_trace',
      version: 1,
      ...(this.wallOrigin ? { wallOrigin: this.wallOrigin } : {}),
      phases: this.phases,
      outcome,
    };
    try { (this.dependencies.emit ?? defaultEmit)(record); } catch { /* Telemetry cannot affect worker execution. */ }
  }

  private readMonotonic(): number | undefined {
    try {
      const now = (this.dependencies.monotonicNow ?? (() => performance.now()))();
      return Number.isFinite(now) ? now : undefined;
    } catch { return undefined; }
  }

  private readWallOrigin(): string | undefined {
    try {
      const origin = (this.dependencies.wallNow ?? (() => new Date().toISOString()))();
      return typeof origin === 'string' && origin.length ? origin : undefined;
    } catch { return undefined; }
  }
}

function defaultEmit(record: StartupTraceRecord): void {
  console.info(JSON.stringify(record));
}
