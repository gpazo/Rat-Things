import { parseArgs } from 'node:util';

export interface PerformanceConfig {
  output: string; viewers: number[]; writers: number; historyItems: number[]; rounds: number;
  durationMs: number; timeoutMs: number; idleMs: number; streamIntervalMs: number; syntheticDelayMs: number;
  streamMode: 'persistent' | 'desktop' | 'both';
}
export const defaults: PerformanceConfig = { output: 'multiplayer-performance.json', viewers: [1, 5, 10, 20, 50], writers: 20,
  historyItems: [0, 200], rounds: 2, durationMs: 180_000, timeoutMs: 10_000, idleMs: 1500, streamIntervalMs: 500, syntheticDelayMs: 10, streamMode: 'persistent' };

export function parsePerformanceArguments(args: string[]): PerformanceConfig {
  const { values } = parseArgs({ args, options: Object.fromEntries(['output', 'viewers', 'writers', 'history-items', 'rounds', 'duration-ms', 'timeout-ms', 'idle-ms', 'stream-interval-ms', 'synthetic-delay-ms', 'stream-mode'].map(name => [name, { type: 'string' as const }])) });
  const streamMode = values['stream-mode'] ?? defaults.streamMode;
  if (streamMode !== 'persistent' && streamMode !== 'desktop' && streamMode !== 'both') throw new Error('stream-mode must be persistent, desktop or both');
  const integer = (key: string, fallback: number, minimum: number, maximum: number) => {
    const raw = values[key]; const value = raw === undefined ? fallback : /^\d+$/.test(String(raw)) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
    return value;
  };
  const list = (key: string, fallback: number[], minimum: number, maximum: number) => {
    const value = values[key] === undefined ? fallback : String(values[key]).split(',').map(entry => /^\d+$/.test(entry) ? Number(entry) : NaN);
    if (!value.length || value.length > 10 || new Set(value).size !== value.length || value.some(n => !Number.isSafeInteger(n) || n < minimum || n > maximum)) throw new Error(`${key} must be unique comma-separated integers from ${minimum} to ${maximum}`);
    return value;
  };
  return { output: String(values.output ?? defaults.output), viewers: list('viewers', defaults.viewers, 1, 50), writers: integer('writers', defaults.writers, 1, 20),
    historyItems: list('history-items', defaults.historyItems, 0, 1000), rounds: integer('rounds', defaults.rounds, 1, 20),
    durationMs: integer('duration-ms', defaults.durationMs, 1000, 600_000), timeoutMs: integer('timeout-ms', defaults.timeoutMs, 100, 30_000),
    idleMs: integer('idle-ms', defaults.idleMs, 100, 10_000), streamIntervalMs: integer('stream-interval-ms', defaults.streamIntervalMs, 10, 2000),
    syntheticDelayMs: integer('synthetic-delay-ms', defaults.syntheticDelayMs, 0, 1000), streamMode };
}

export interface LatencySample {
  correlation: string; viewer?: number; status: 'observed' | 'error' | 'timeout' | 'not_accepted' | 'not_started';
  milliseconds?: number; lowerBoundMs?: number; lateObservationMs?: number; detail?: string;
}
/** Nearest-rank empirical quantiles; no interpolation or invented samples. */
export function quantile(values: readonly number[], percentile: number): number | null {
  if (!(percentile > 0 && percentile <= 1) || values.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid latency distribution');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(percentile * sorted.length) - 1]! : null;
}
export function summarize(samples: readonly LatencySample[]) {
  const observed = samples.filter(sample => sample.status === 'observed').map(sample => sample.milliseconds!);
  if (observed.some(value => !Number.isFinite(value))) throw new Error('Observed sample has no duration');
  return { expected: samples.length, observed: observed.length, errors: samples.filter(sample => sample.status === 'error').length,
    timeouts: samples.filter(sample => sample.status === 'timeout').length, notAccepted: samples.filter(sample => sample.status === 'not_accepted').length,
    notStarted: samples.filter(sample => sample.status === 'not_started').length, censored: samples.length - observed.length,
    p50Ms: quantile(observed, .5), p95Ms: quantile(observed, .95), p99Ms: quantile(observed, .99), maxMs: quantile(observed, 1) };
}
export function targetCheck(samples: readonly LatencySample[], p95Ms: number, p99Ms: number) {
  const summary = summarize(samples);
  return { thresholds: { p95Ms, p99Ms }, passed: summary.expected > 0 && summary.censored === 0 && summary.p95Ms! <= p95Ms && summary.p99Ms! <= p99Ms,
    empiricalOnly: true, atLeast100ObservedSamples: summary.observed >= 100, ...summary };
}

