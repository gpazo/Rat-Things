import type { SessionActor } from './session-caller.js';
import type { SessionInputProvenance } from './session-attribution.js';
import { canonicalJson } from '../domain/json.js';
import { AgentsApiError, invalid } from '../domain/agents-api-validation.js';

// Identity colors carry authorship, never status. Keep the seed palette mirrored in theme.rs/brand.css.
export const PARTICIPANT_COLORS = ['#d9adf5', '#8fc9ff', '#f3c77b', '#f2a9c2', '#b8ce91', '#c4b9ff', '#efa78b', '#9acddd'] as const;
export interface Participant { key: string; actor: SessionActor; color: string }
export interface AttributedActor { actor: SessionActor; provenance?: SessionInputProvenance; participant?: Participant | undefined }
export interface MessageReply { message_id: string; role: 'user' | 'assistant'; actor?: SessionActor; provenance?: SessionInputProvenance; text: string; truncated: boolean }
export interface TypingLease { participant: Participant; client_id: string; sequence: number; expires_at: number }
export const TYPING_SECONDS = 6;
export const participantKey = ({ actor, provenance }: AttributedActor): string => canonicalJson([provenance?.kind === 'imported' ? ['imported', provenance.operation_id] : provenance?.kind ?? 'unknown', actor.kind, actor.id]);

/** Existing slots never move. Imported identity claims occupy a different namespace. */
export function assignParticipants(previous: readonly Participant[], actors: readonly AttributedActor[]): Participant[] {
  const result = [...previous];
  const keys = new Set(previous.map(p => p.key));
  const colors = new Set(['#f7f8f8', ...previous.map(p => p.color)]);
  for (const source of actors) {
    const key = participantKey(source);
    if (keys.has(key)) continue;
    let color = source.participant?.color;
    if (!color || !/^#[a-f0-9]{6}$/.test(color) || colors.has(color) || color === '#f7f8f8') {
      let slot = result.length;
      do { color = participantColor(slot++); } while (colors.has(color));
    }
    result.push({ key, actor: source.actor, color }); keys.add(key); colors.add(color);
  }
  return result;
}
function participantColor(slot: number): string {
  if (slot < PARTICIPANT_COLORS.length) return PARTICIPANT_COLORS[slot]!;
  // A permutation of the bright RGB cube: no cycling through a small palette.
  const index = ((slot - PARTICIPANT_COLORS.length) * 104729) % (96 ** 3);
  return '#' + [Math.floor(index / 96 ** 2), Math.floor(index / 96) % 96, index % 96].map(c => (160 + c).toString(16).padStart(2, '0')).join('');
}
export function activeTypists(leases: readonly TypingLease[], now: number): Array<{ participant: Participant; expires_at: number }> {
  const byActor = new Map<string, { participant: Participant; expires_at: number }>();
  for (const lease of leases) if (lease.expires_at > now && lease.expires_at > (byActor.get(lease.participant.key)?.expires_at ?? 0)) byActor.set(lease.participant.key, { participant: lease.participant, expires_at: lease.expires_at });
  return [...byActor.values()].sort((a, b) => a.participant.key.localeCompare(b.participant.key));
}
export function typingRequest(raw: unknown): { client_id: string; sequence: number; typing: boolean } {
  const value = collaborationRecord(raw, ['client_id', 'sequence', 'typing']);
  if (typeof value.client_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.client_id) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || typeof value.typing !== 'boolean') invalid('Supply a client ID, increasing sequence and typing boolean.');
  return value as { client_id: string; sequence: number; typing: boolean };
}
export function collaborationRecord(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) invalid('Unknown collaboration field.');
  return raw as Record<string, unknown>;
}
export function requireContribution(permissions?: readonly string[]): void {
  if (permissions && !permissions.includes('contribute')) throw new AgentsApiError(403, 'Collaborator access is required.', 'insufficient_permissions');
}
