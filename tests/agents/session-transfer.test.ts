import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { integrationFixture } from './integration-fixtures.js';
import type { SessionImport } from '../../src/domain/session-transfer.js';

async function fixture() {
  const f = await integrationFixture();
  const items = f.execution.items;
  f.execution.items = async (...args) => (await items(...args)).map(item => item.type === 'message' ? { ...item, content: item.content.map(part => part.type === 'output_text' ? { type: part.type, text: part.text } : part) } : item);
  const source = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Remember home.' });
  await f.sessions.dispatch('operator', source.id);
  const observed = [...f.observations.values()][0]!;
  f.observations.set(observed.turn.id, { ...observed, turn: { ...observed.turn, status: 'completed', completed_at: 2 } });
  const history = (await f.sessions.items('operator', source.id, { order: 'asc' })).data;
  const request: SessionImport = { version: 1, transfer_id: randomUUID(), source_session_id: source.id, session: { agent: { model: 'test' }, environment: { type: 'none' } }, history };
  return { ...f, source, request };
}
it('imports history idempotently under the destination principal and starts only on a new message', async () => {
  const f = await fixture();
  vi.mocked(f.execution.start).mockClear();
  const copied = await f.sessions.import('destination', f.request);
  expect(await f.sessions.import('destination', f.request)).toEqual(copied);
  expect((await f.sessions.items('destination', copied.id, { order: 'asc' })).data).toEqual(f.request.history);
  expect((await f.sessions.turns('destination', copied.id)).data).toEqual([]);
  expect(f.execution.start).not.toHaveBeenCalled();
  await expect(f.sessions.retrieve('operator', copied.id)).rejects.toMatchObject({ status: 404 });
  await expect(f.sessions.import('destination', { ...f.request, history: [] })).rejects.toMatchObject({ status: 409 });
  await f.sessions.events('destination', copied.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Continue in cloud.' }] }] }] });
  await f.sessions.dispatch('destination', copied.id);
  expect(JSON.stringify(vi.mocked(f.execution.start).mock.calls[0]?.[3])).toContain('Remember home.');
  await f.sessions.delete('destination', copied.id);
  await expect(f.sessions.import('destination', f.request)).rejects.toMatchObject({ status: 404 });
});
it('refuses active input and credential references before import side effects', async () => {
  const f = await fixture();
  for (const session of [{ ...f.request.session, input: 'Run now' }, { ...f.request.session, vault_ids: ['vault_old'] }, { ...f.request.session, agent_id: f.agent.id }]) {
    await expect(f.sessions.import('destination', { ...f.request, session })).rejects.toMatchObject({ status: 400 });
  }
  expect((await f.store.list('destination', 'sessions', {})).data).toHaveLength(0);
});
it('holds a snapshot lock, stops writers, and releases the source on success or failure', async () => {
  const f = await fixture();
  f.execution.close = vi.fn(async () => {});
  for (const fail of [false, true]) {
    const snapshot = f.sessions.snapshotForTransfer('operator', f.source.id, async () => {
      expect(f.execution.close).toHaveBeenCalled();
      await expect(f.sessions.delete('operator', f.source.id)).rejects.toMatchObject({ code: 'session_busy' });
      if (fail) throw new Error('Snapshot unavailable');
      return 'workspace';
    });
    if (fail) await expect(snapshot).rejects.toThrow('Snapshot unavailable');
    else expect((await snapshot).workspace).toBe('workspace');
    expect((await f.sessions.retrieve('operator', f.source.id)).id).toBe(f.source.id);
  }
  await f.sessions.delete('operator', f.source.id);
});

it('does not snapshot while environment setup can still write to the workspace', async () => {
  const f = await fixture();
  f.execution.environment = async () => ({ id: 'env_setup', type: 'openai_hosted', status: 'pending', error: null });
  const snapshot = vi.fn(async () => []);
  await expect(f.sessions.snapshotForTransfer('operator', f.source.id, snapshot)).rejects.toMatchObject({ code: 'session_busy' });
  expect(snapshot).not.toHaveBeenCalled();
});
