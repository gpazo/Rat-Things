import { expect, it, vi } from 'vitest';
import { integrationFixture } from './integration-fixtures.js';
import { SessionCollaborationService } from '../../src/core/session-collaboration-service.js';
import { activeTypists, assignParticipants, PARTICIPANT_COLORS } from '../../src/core/session-collaboration-planning.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { importedSessionReceipts } from '../../src/core/session-attribution.js';
import { routeActions } from '../../src/domain/api-permissions.js';
const actor = (id: string) => ({ actor: { id, kind: 'human' as const, label: 'Same name' }, provenance: { kind: 'authenticated' as const } });

it('keeps existing assignments immutable, including imported claims, and does not cycle the palette', () => {
  const people = Array.from({ length: 500 }, (_, index) => actor(`person-${index}`));
  const first = assignParticipants([], people.slice(0, 20));
  const all = assignParticipants(first, [...people].reverse());
  expect(all.slice(0, 20)).toEqual(first);
  expect(new Set(all.map(p => p.color)).size).toBe(500);
  expect(all.some(p => p.color === '#f7f8f8')).toBe(false);
  const imported = importedSessionReceipts([{ ...actor('person-0'), id: 'old', sequence: 1, status: 'dispatched', accepted_at: 1, turn_ids: [], message_ids: [], participant: first[0]! }], 'share');
  const migrated = assignParticipants([], imported);
  expect(migrated[0]!.color).toBe(first[0]!.color);
  expect(assignParticipants(migrated, [people[0]!])[1]!.color).not.toBe(migrated[0]!.color);
  for (const color of [...PARTICIPANT_COLORS, ...all.map(p => p.color)]) {
    const rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    const luminance = rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
    // Brightest transcript/composer surface is #252527.
    expect((luminance + .05) / (.01865 + .05)).toBeGreaterThan(4.5);
  }
});

it('expires typing without relying on database TTL, isolates clients and ignores reordered heartbeats', async () => {
  const f = await integrationFixture();
  const session = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Goal' });
  let now = 100;
  const service = new SessionCollaborationService(f.store, () => now);
  const caller = { ...actor('alice'), permissions: ['read', 'contribute'] };
  const state = (await f.store.get<SessionState>('operator', 'sessions', session.id))!;
  await service.typing('operator', session.id, { client_id: 'device1', sequence: 1, typing: true }, caller);
  await service.typing('operator', session.id, { client_id: 'device2', sequence: 1, typing: true }, caller);
  expect(await service.presence('operator', session.id)).toHaveLength(1);
  await service.typing('operator', session.id, { client_id: 'device1', sequence: 3, typing: false }, caller);
  await service.typing('operator', session.id, { client_id: 'device1', sequence: 2, typing: true }, caller);
  expect(await service.presence('operator', session.id)).toHaveLength(1);
  now += 7;
  expect(await service.presence('operator', session.id)).toEqual([]);
  expect((await f.store.get('operator', 'sessions', session.id))!.revision).toBe(state.revision);
  expect(f.execution.start).not.toHaveBeenCalled();
  expect(activeTypists([], now)).toEqual([]);
  await expect(service.typing('operator', session.id, { client_id: 'd', sequence: 4, typing: true }, { ...caller, permissions: ['read'] })).rejects.toMatchObject({ status: 403 });
  await expect(service.typing('operator', session.id, { client_id: 'd', sequence: 4, typing: true, draft: 'secret' }, caller)).rejects.toMatchObject({ status: 400 });
  await expect(service.typing('operator', session.id, { client_id: 'd', sequence: 4, typing: true }, { ...caller, revalidate: vi.fn().mockRejectedValue(new Error('Revoked')) })).rejects.toThrow('Revoked');
});

it('classifies message and typing writes under the existing collaborator permission', () => {
  for (const endpoint of ['typing', 'messages']) {
    expect(routeActions('POST', ['v1', 'rat', 'sessions', 'sess_a', endpoint])).toEqual(['contribute']);
    expect(routeActions('GET', ['v1', 'rat', 'sessions', 'sess_a', endpoint])).toEqual([]);
  }
});
