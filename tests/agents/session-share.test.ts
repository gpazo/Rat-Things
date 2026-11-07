import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { integrationFixture } from './integration-fixtures.js';
import { SessionShareService } from '../../src/core/session-share-service.js';
import { LocalShareService } from '../../src/app/local-share.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { ShareStageRequest } from '../../src/core/session-share-types.js';

const message = { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }] }] };
async function fixture(fault?: 'stage_reply' | 'before_release' | 'release_reply' | 'activation_reply') {
  const f = await integrationFixture();
  const source = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Remember the goal' }, undefined, undefined, undefined, { actor: { id: 'alice', kind: 'human' } });
  await f.sessions.dispatch('operator', source.id);
  const observed = [...f.observations.values()][0]!;
  f.observations.set(observed.turn.id, { ...observed, turn: { ...observed.turn, status: 'completed', completed_at: 2,
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 } } } });
  f.execution.items = async (_owner, _session, turnId) => [
    { id: 'command', type: 'command_execution', turn_id: turnId, command: 'write result.txt', cwd: '/workspace', duration_ms: 5, exit_code: 0, output: 'saved effect', status: 'completed' },
    { id: 'answer', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', turn_id: turnId, content: [{ type: 'output_text', text: 'Finished' }] },
  ];
  f.execution.close = vi.fn(async () => {});
  const data = Buffer.from('artifact-content');
  const sha = createHash('sha256').update(data).digest('hex');
  f.execution.artifacts = async () => [{ artifact: { id: 'art_result', object: 'agent.session.artifact', session_id: source.id, turn_id: observed.turn.id,
    environment_id: 'env_historical', path: '/workspace/result.txt', size_bytes: data.length, created_at: 1 }, content: { bucket: 'old', key: 'artifact', sha256: sha } }];
  f.execution.artifactContent = async () => new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } });
  const uploaded = new Map<string, Uint8Array>();
  const files = {
    reference: async (_owner: string, id: string) => ({ bucket: 'destination', key: id, sha256: createHash('sha256').update(uploaded.get(id)!).digest('hex') }),
    retrieve: async (_owner: string, id: string) => ({ id, bytes: uploaded.get(id)!.length }),
  };
  const admit = vi.fn(async () => ({ evidence: { role: 'fixture-ceiling', digest: 'fixed-envelope' } }));
  const destination = new SessionShareService({ store: f.store, sessions: f.sessions, files: files as never, admit });
  const commit = f.store.commit.bind(f.store);
  let injected = false;
  f.store.commit = async (writes, observations) => {
    const release = writes.some(write => write.resource.collection === 'sessions' && write.resource.ownerId === 'operator' && (write.resource.value as SessionState).share?.phase === 'released');
    if (release && !injected && fault === 'before_release') { injected = true; throw new Error('Crash before source release'); }
    await commit(writes, observations);
    if (release && !injected && fault === 'release_reply') { injected = true; throw new Error('Lost source release acknowledgement'); }
  };
  let staged: ShareStageRequest | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/files')) {
      const form = await request.formData();
      const file = form.get('file') as File;
      const id = `file-${uploaded.size}`;
      uploaded.set(id, new Uint8Array(await file.arrayBuffer()));
      return Response.json({ id });
    }
    if (path.endsWith('/shares')) {
      staged = await request.json() as ShareStageRequest;
      const result = await destination.stage('destination', staged);
      expect((await f.store.get('destination', 'sessions', source.id))).toBeUndefined();
      if (!injected && fault === 'stage_reply') { injected = true; throw new Error('Lost stage acknowledgement'); }
      return Response.json(result);
    }
    if (path.endsWith('/activate')) {
      expect((await f.store.get<SessionState>('operator', 'sessions', source.id))!.value.share?.phase).toBe('released');
      const result = await destination.activate('destination', staged!.manifest.operation_id, await request.json());
      if (!injected && fault === 'activation_reply') { injected = true; throw new Error('Lost destination acknowledgement'); }
      return Response.json(result);
    }
    throw new Error('Unexpected request');
  };
  const environments = {} as EnvironmentService;
  const snapshot = vi.fn(async () => []);
  const options = { store: f.store, sessions: f.sessions, environments, owner: 'operator', snapshot,
    connection: async () => ({ baseURL: 'https://shared.example/v1', fetch: fetcher }) };
  return { ...f, source, destination, admit, options, staged: () => staged };
}

it.each(['stage_reply', 'before_release', 'release_reply', 'activation_reply'] as const)('recovers %s without reviving the source or replaying completed work', async fault => {
  const f = await fixture(fault);
  let coordinator = new LocalShareService(f.options);
  const request = { id: randomUUID(), session_id: f.source.id, endpoint: 'https://shared.example', space_id: 'space_team', connection_id: 'connection_team' };
  const plan = await coordinator.create(request);
  await expect.poll(async () => (await coordinator.retrieve(plan.id)).status).toBe('failed');
  await expect(f.sessions.events('operator', f.source.id, message)).rejects.toMatchObject({ code: 'session_shared' });
  await coordinator.close();
  coordinator = new LocalShareService(f.options);
  expect((await coordinator.create(request)).id).toBe(plan.id);
  await coordinator.execute(plan.id);
  await expect.poll(async () => coordinator.retrieve(plan.id)).toMatchObject({ status: 'complete', destination_session_id: f.source.id });
  expect((await f.sessions.retrieve('destination', f.source.id)).agent).toEqual(f.source.agent);
  expect((await f.sessions.turns('destination', f.source.id)).data).toMatchObject([{ status: 'completed', usage: { total_tokens: 13 } }]);
  expect((await f.sessions.items('destination', f.source.id, { order: 'asc' })).data.map(item => item.id)).toEqual([expect.stringMatching(/^msg_/), 'command', 'answer']);
  expect((await f.sessions.artifacts('destination', f.source.id)).data[0]?.id).toBe('art_result');
  const saved = (await f.store.get<SessionState>('destination', 'sessions', f.source.id))!.value;
  expect(saved.receipts).toEqual({});
  expect(saved.archivedInputs?.[0]?.actor.id).toBe('alice');
  expect(saved.sharedFrom?.admission).toMatchObject({ destination: { role: 'fixture-ceiling' }, source: { admitted: { digest: expect.any(String) } } });
  vi.mocked(f.execution.start).mockClear();
  await f.sessions.dispatch('operator', f.source.id);
  await f.sessions.dispatch('destination', f.source.id);
  expect(f.execution.start).not.toHaveBeenCalled();
  await f.sessions.events('destination', f.source.id, message, 'continue', { waitForConnection: false, caller: { actor: { id: 'bob', kind: 'human' } } });
  await f.sessions.dispatch('destination', f.source.id);
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(vi.mocked(f.execution.start).mock.calls[0]?.[3])).toContain('saved effect');
  expect(f.admit).toHaveBeenCalledTimes(1);
  await coordinator.close();
});

it('waits for accepted work and rejects new input, then requires positive source shutdown before staging', async () => {
  const f = await fixture();
  const observed = [...f.observations.values()][0]!;
  f.observations.set(observed.turn.id, { ...observed, turn: { ...observed.turn, status: 'in_progress', completed_at: null } });
  const service = new LocalShareService(f.options);
  const plan = await service.create({ session_id: f.source.id, endpoint: 'https://shared.example', space_id: 'space_team', connection_id: 'connection_team' });
  await expect(f.sessions.events('operator', f.source.id, message)).rejects.toMatchObject({ code: 'session_shared' });
  expect((await service.retrieve(plan.id)).status).toBe('quiescing');
  expect(f.staged()).toBeUndefined();
  f.execution.close = vi.fn(async () => { throw new Error('Process termination is unconfirmed'); });
  f.observations.set(observed.turn.id, observed);
  await expect.poll(async () => (await service.retrieve(plan.id)).status).toBe('failed');
  expect(f.staged()).toBeUndefined();
  expect((await f.store.get<SessionState>('operator', 'sessions', f.source.id))!.value.share?.phase).toBe('frozen');
  await service.close();
});

it('atomically retires a staged operation before release and permits a fresh local Turn', async () => {
  const f = await fixture('before_release');
  const service = new LocalShareService(f.options);
  const plan = await service.create({ session_id: f.source.id, endpoint: 'https://shared.example', space_id: 'space_team', connection_id: 'connection_team' });
  await expect.poll(async () => (await service.retrieve(plan.id)).status).toBe('failed');
  expect((await f.destination.retrieve('destination', plan.id)).status).toBe('staged');
  expect(await service.abort(plan.id)).toMatchObject({ status: 'aborted' });
  expect((await f.store.get<SessionState>('operator', 'sessions', f.source.id))!.value.share).toBeUndefined();
  await expect(f.sessions.releaseShare('operator', f.source.id, plan.id, f.staged()!.digest, { endpoint: 'https://shared.example/v1', spaceId: 'space_team' })).rejects.toMatchObject({ code: 'share_conflict' });
  await f.sessions.events('operator', f.source.id, message);
  expect((await service.execute(plan.id)).status).toBe('aborted');
  expect((await f.destination.retrieve('destination', plan.id)).status).toBe('staged');
  await service.close();
});

it('never aborts after a lost source release acknowledgement', async () => {
  const f = await fixture('release_reply');
  const service = new LocalShareService(f.options);
  const plan = await service.create({ session_id: f.source.id, endpoint: 'https://shared.example', space_id: 'space_team', connection_id: 'connection_team' });
  await expect.poll(async () => (await service.retrieve(plan.id)).status).toBe('failed');
  await expect(service.abort(plan.id)).rejects.toMatchObject({ code: 'session_shared' });
  await expect(f.sessions.events('operator', f.source.id, message)).rejects.toMatchObject({ code: 'session_shared' });
  await service.close();
});

it('linearizes explicit abort against irreversible release on the same durable source fence', async () => {
  const f = await fixture('before_release');
  const service = new LocalShareService(f.options);
  const plan = await service.create({ session_id: f.source.id, endpoint: 'https://shared.example', space_id: 'space_team', connection_id: 'connection_team' });
  await expect.poll(async () => (await service.retrieve(plan.id)).status).toBe('failed');
  const results = await Promise.allSettled([
    f.sessions.releaseShare('operator', f.source.id, plan.id, f.staged()!.digest, { endpoint: 'https://shared.example/v1', spaceId: 'space_team' }),
    service.abort(plan.id),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const state = (await f.store.get<SessionState>('operator', 'sessions', f.source.id))!.value;
  if (state.share) {
    expect(state.share.phase).toBe('released');
    await expect(f.sessions.events('operator', f.source.id, message)).rejects.toMatchObject({ code: 'session_shared' });
  } else {
    expect((await service.retrieve(plan.id)).status).toBe('aborted');
    await expect(f.sessions.events('operator', f.source.id, message)).resolves.toBeUndefined();
  }
  await service.close();
});
