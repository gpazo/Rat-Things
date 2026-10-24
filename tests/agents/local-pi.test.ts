import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { startLocalServer } from '../../src/local-server.js';
import { createLocalAgentsClient, readLocalConnection } from '../../src/local-workspace.js';
import type { PiModelDescriptor } from '../../src/domain/session-runtime.js';

it('runs local Pi through HTTP and SQLite, recovers a pending function after restart, and keeps its runtime pin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-local-pi-'));
  const faux = fauxProvider({ provider: 'openai-codex', api: 'openai-codex-responses', tokensPerSecond: Infinity,
    models: [{ id: 'fixture', reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 10000 }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('lookup', { query: 'acorn' }, { id: 'lookup-one' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Durable answer from the lookup.'), fauxAssistantMessage('I remember the acorn.'), fauxAssistantMessage('Another turn in the same process.'),
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  const catalog: PiModelDescriptor[] = [{ id: 'fixture', name: 'Fixture', provider: 'openai-codex', api: 'openai-codex-responses',
    input: ['text'], contextWindow: 100000, maxTokens: 10000, reasoning: ['low', 'medium', 'high'] }];
  const launch = () => startLocalServer({ directory, model: 'fixture', maxSessions: 1, pi: { catalog, models: () => models } });
  let server = await launch();
  try {
    let client = createLocalAgentsClient(await readLocalConnection(directory));
    const discovery = await fetch(`${server.baseURL}/models?runtime=pi`, { headers: { authorization: `Bearer ${server.token}` } });
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ runtime: 'pi', capabilities: { environments: ['none'], tools: ['function'] } });
    const session = await client.beta.agents.sessions.create({ metadata: { rat_things_runtime: 'pi' },
      agent: { model: 'fixture', reasoning: { effort: 'medium' }, multi_agent: { enabled: false }, tools: [{ type: 'function', name: 'lookup', description: 'Lookup',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] }, environment: { type: 'none' }, input: 'Remember the acorn and look it up.' });
    await expect.poll(async () => (await client.beta.agents.sessions.retrieve(session.id)).required_actions.length).toBe(1);
    const action = (await client.beta.agents.sessions.retrieve(session.id)).required_actions[0]!;
    if (action.type !== 'function_call') throw new Error('Expected function');
    expect(faux.state.callCount).toBe(1);
    const queued = await client.beta.agents.sessions.create({ metadata: { rat_things_runtime: 'pi' },
      agent: { model: 'fixture', reasoning: { effort: 'medium' }, multi_agent: { enabled: false } }, environment: { type: 'none' }, input: 'Cancel before inference.' });
    await client.beta.agents.sessions.events.create(queued.id, { events: [{ type: 'agent.session.input.cancel' }] });
    await expect.poll(async () => (await client.beta.agents.sessions.turns.list(queued.id)).data[0]?.status).toBe('cancelled');
    expect(faux.state.callCount).toBe(1);
    await server.close();
    server = await launch();
    client = createLocalAgentsClient(await readLocalConnection(directory));
    await expect.poll(async () => (await client.beta.agents.sessions.retrieve(session.id)).required_actions).toEqual([action]);
    expect(faux.state.callCount).toBe(1);
    await client.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.tool_result', turn_id: action.turn_id,
      call_id: action.call_id, success: true, output: 'Acorn found.' }] });
    await expect.poll(async () => (await client.beta.agents.sessions.turns.list(session.id)).data[0]?.status).toBe('completed');
    expect(JSON.stringify(await client.beta.agents.sessions.items.list(session.id))).toContain('Durable answer from the lookup.');
    await server.close(); server = await launch(); client = createLocalAgentsClient(await readLocalConnection(directory));
    await client.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'What do you remember?' }] }] }] });
    await expect.poll(async () => JSON.stringify(await client.beta.agents.sessions.items.list(session.id))).toContain('I remember the acorn.');
    expect(faux.state.callCount).toBe(3);
    await client.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] }] }] });
    await expect.poll(async () => JSON.stringify(await client.beta.agents.sessions.items.list(session.id))).toContain('Another turn in the same process.');
    expect(faux.state.callCount).toBe(4);
    await expect(client.beta.agents.sessions.update(session.id, { metadata: { rat_things_runtime: 'codex' } })).rejects.toMatchObject({ status: 400 });
    await client.beta.agents.sessions.delete(session.id);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);
