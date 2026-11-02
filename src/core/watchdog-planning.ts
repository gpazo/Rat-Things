import { createHash } from 'node:crypto';
import type { AgentSessionItem } from '../domain/agents-api.js';
import type { WatchdogCandidate, WatchdogDigest, WatchdogPolicy, WatchdogVerdict } from '../domain/watchdog.js';
import type { SessionState, SessionTurnBinding } from './session-ports.js';
import type { SessionStreamSnapshot } from './session-stream.js';
import { canonicalJson } from '../domain/json.js';

const transientErrors = new Set(['rate_limit_exceeded', 'server_overloaded', 'connection_failed', 'server_error', 'request_timeout']);
export const isWatchdogTransientError = (code: string | undefined): boolean => code !== undefined && transientErrors.has(code);
const identityWithWindow = (candidate: WatchdogCandidate, window: number | null): string => `wd_${createHash('sha256').update(canonicalJson([candidate.ownerId, candidate.reason, candidate.subjectId, candidate.turnId ?? null, window, candidate.reason === 'alarm' ? candidate.since : null])).digest('hex')}`;
export const watchdogIdentity = (candidate: WatchdogCandidate): string => identityWithWindow(candidate, candidate.reason === 'long_running' ? null : candidate.window ?? null);
export const watchdogIncidentCandidate = ({ window, ...candidate }: WatchdogCandidate): WatchdogCandidate => candidate.reason === 'long_running' || window === undefined ? candidate : { ...candidate, window };
/** Upgrade lookup is bounded; older windows are adopted when the collector encounters them. */
export function watchdogLegacyIdentities(candidate: WatchdogCandidate, now: number, policy: WatchdogPolicy): string[] {
  if (candidate.reason !== 'long_running') return [];
  const window = candidate.window ?? Math.floor(now / Math.max(1, policy.longRunningSeconds));
  return [identityWithWindow(candidate, window), identityWithWindow(candidate, window - 1)];
}
export const watchdogRetryKey = (turnId: string): string => `watchdog-retry:${turnId}`;
export const isWatchdogJudge = (state: SessionState): boolean => /^sess_wd_[a-f0-9]{64}_judge$/.test(state.session.id);
export const isToolItem = (item: AgentSessionItem): boolean => item.type !== 'message' && item.type !== 'reasoning' && item.type !== 'agent_message';

export function watchdogSafeText(value: string, maximum = 600): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, '[URL]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, maximum);
}

export function watchdogDigest(items: AgentSessionItem[], maximum = 100): WatchdogDigest {
  const sampled = items.slice(-maximum);
  const calls = sampled.filter(item => isToolItem(item) && item.type !== 'function_call_output');
  const names = calls.map(item => 'name' in item && typeof item.name === 'string' ? item.name : item.type);
  const toolNames = Object.fromEntries([...new Set(names)].slice(0, 20).map(name => [watchdogSafeText(name, 80), names.filter(value => value === name).length]));
  const signatures = calls.map(item => canonicalJson({ type: item.type, ...('name' in item ? { name: item.name } : {}), ...('arguments' in item ? { arguments: item.arguments } : {}), ...('command' in item ? { command: item.command } : {}), ...('action' in item ? { action: item.action } : {}) }));
  const repeatedIdenticalCalls = Math.max(0, ...signatures.map(signature => signatures.filter(value => value === signature).length));
  const last = [...sampled].reverse().find(item => item.type === 'message' && item.role === 'assistant');
  const text = last?.type === 'message' ? last.content.flatMap(part => part.type === 'output_text' ? [part.text] : []).join('\n') : '';
  return { totalItems: items.length, sampledItems: sampled.length, toolCalls: calls.length, toolNames, repeatedIdenticalCalls, lastAssistantText: watchdogSafeText(text) };
}

export function watchdogSessionCandidates(ownerId: string, state: SessionState, snapshot: SessionStreamSnapshot, now: number, policy: WatchdogPolicy): WatchdogCandidate[] {
  if (isWatchdogJudge(state)) return [];
  const base = { ownerId, sessionId: state.session.id, subjectId: state.session.id };
  return snapshot.turns.filter(turn => turn.subagent_id === null).flatMap((turn): WatchdogCandidate[] => {
    const since = turn.started_at ?? turn.created_at;
    const digest = watchdogDigest(snapshot.items.filter(item => item.turn_id === turn.id));
    if (turn.status === 'in_progress' && now - since >= policy.longRunningSeconds) return [{ ...base, turnId: turn.id, reason: 'long_running' as const, since, window: Math.floor(now / Math.max(1, policy.longRunningSeconds)), digest }];
    if (turn.status === 'failed' && isWatchdogTransientError(turn.error?.code) && now - (turn.completed_at ?? since) <= policy.recentFailureSeconds && now - (turn.completed_at ?? since) >= policy.retryBackoffSeconds) return [{ ...base, turnId: turn.id, reason: 'transient_failure' as const, since: turn.completed_at ?? since, digest }];
    return [];
  });
}

export function watchdogRetryEligible(state: SessionState, binding: SessionTurnBinding | undefined, now: number, policy: WatchdogPolicy): boolean {
  if (!binding || state.closing || state.session.status === 'failed' || state.forkLock || isWatchdogJudge(state)) return false;
  if (state.turns.at(-1)?.turn.id !== binding.turn.id || binding.turn.status !== 'failed' || !isWatchdogTransientError(binding.turn.error?.code)) return false;
  if (binding.turn.completed_at === null || now - binding.turn.completed_at < policy.retryBackoffSeconds || now - binding.turn.completed_at > policy.recentFailureSeconds) return false;
  if (!binding.savedItems || binding.savedItems.some(isToolItem) || !binding.input.length) return false;
  const priorRetries = Object.entries(state.receipts).filter(([key]) => key.startsWith('watchdog_')).flatMap(([, receipt]) => receipt.commands);
  return !priorRetries.some(command => command.turnId === binding.turn.id);
}

export function parseWatchdogVerdict(text: string): WatchdogVerdict | undefined {
  if (text.length > 4096) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['verdict', 'confidence', 'evidence'].includes(key)) || !['progressing', 'looping', 'drifting', 'blocked'].includes(String(raw.verdict)) || typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1 || !Array.isArray(raw.evidence) || raw.evidence.length > 5 || raw.evidence.some(item => typeof item !== 'string' || item.length > 300)) return undefined;
  return { verdict: raw.verdict as WatchdogVerdict['verdict'], confidence: raw.confidence, evidence: raw.evidence.map(item => watchdogSafeText(item as string, 300)) };
}
