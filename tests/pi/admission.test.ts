import { describe, expect, it, vi } from 'vitest';
import { integrationFixture } from '../agents/integration-fixtures.js';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { PiModelDescriptor } from '../../src/domain/session-runtime.js';
import { planPiRecovery } from '../../src/core/pi-recovery-planning.js';
const descriptor: PiModelDescriptor = { id: 'test-bedrock', name: 'Test', provider: 'amazon-bedrock', api: 'bedrock-converse-stream', region: 'us-east-1', input: ['text'], reasoning: ['low', 'high'], contextWindow: 1000, maxTokens: 500 };
async function fixture() {
  const f = await integrationFixture();
  const agents = new AgentService({ store: f.store });
  const sessions = new SessionService({ store: f.store, agents, execution: f.execution, piCatalog: [descriptor] });
  const input = { agent: { model: descriptor.id }, environment: { type: 'none' }, input: 'Hello', metadata: { rat_things_runtime: 'pi' } };
  return { ...f, agents, sessions, input };
}
describe('Pi admission and immutable runtime', () => {
  it('keeps runtime private and pinned when metadata is cleared', async () => {
    const f = await fixture();
    const session = await f.sessions.create('operator', f.input);
    expect(session).not.toHaveProperty('runtime');
    await f.sessions.update('operator', session.id, { metadata: null });
    expect((await f.sessions.retrieve('operator', session.id)).metadata).toEqual({});
    expect(await f.sessions.runtime('operator', session.id)).toMatchObject({ runtime: 'pi', version: '1.3.0' });
    expect((await f.store.get<SessionState>('operator', 'sessions', session.id))?.value.runtime?.kind).toBe('pi');
    await expect(f.sessions.update('operator', session.id, { metadata: { rat_things_runtime: 'codex' } })).rejects.toThrow('fixed');
  });
  it('permits model settings within the catalog and rejects Codex-only features before environment preparation', async () => {
    const f = await fixture();
    f.execution.prepare = vi.fn(f.execution.prepare);
    await expect(f.sessions.create('operator', { ...f.input, agent: { model: descriptor.id, text: { verbosity: 'high' } } })).rejects.toThrow('verbosity');
    await expect(f.sessions.create('operator', { ...f.input, agent: { model: 'gpt-6-sol' } })).rejects.toThrow('catalog');
    expect(f.execution.prepare).not.toHaveBeenCalled();
    const session = await f.sessions.create('operator', f.input);
    expect((await f.sessions.update('operator', session.id, { agent: { reasoning: { effort: 'high' } } })).agent.reasoning.effort).toBe('high');
  });
  it('inherits saved Agent selection but lets an explicit Session override it', async () => {
    const f = await fixture();
    const agent = await f.agents.create('operator', { model: descriptor.id, metadata: { rat_things_runtime: 'pi' } });
    const inherited = await f.sessions.create('operator', { agent_id: agent.id, environment: { type: 'none' }, input: 'Hello' });
    expect((await f.sessions.runtime('operator', inherited.id)).runtime).toBe('pi');
    const overridden = await f.sessions.create('operator', { agent_id: agent.id, metadata: { rat_things_runtime: 'codex' }, environment: { type: 'none' }, input: 'Hello' });
    expect((await f.sessions.runtime('operator', overridden.id)).runtime).toBe('codex');
  });
  it('rejects unsupported input, tool identifiers and unavailable persistent managed storage before preparation', async () => {
    const f = await fixture(); f.execution.prepare = vi.fn(f.execution.prepare);
    await expect(f.sessions.create('operator', { ...f.input, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/image.png' }] }] })).rejects.toThrow('images');
    for (const name of ['bad.name', 'spawn_agent', 'rat_mcp_reserved', 'x'.repeat(65)]) await expect(f.sessions.create('operator', { ...f.input, agent: { model: descriptor.id, multi_agent: { enabled: true }, tools: [{ type: 'function', name, description: 'Fixture', parameters: { type: 'object', properties: {} } }] } })).rejects.toThrow('tool identifiers');
    await expect(f.sessions.create('operator', { ...f.input, environment: { type: 'openai_hosted' } })).rejects.toThrow('S3 Files');
    expect(f.execution.prepare).not.toHaveBeenCalled();
    const session = await f.sessions.create('operator', f.input);
    await expect(f.sessions.events('operator', session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aA==' }] }] }] })).rejects.toThrow('images');
    expect(Object.keys((await f.store.get<SessionState>('operator', 'sessions', session.id))!.value.receipts)).toEqual(['initial']);
  });
  it('requires positive worker termination and bounds replacements', () => {
    const facts = { closed: false, hasWork: true, worker: 'unknown' as const, now: 1000, failures: [] };
    expect(planPiRecovery(facts)).toEqual({ type: 'wait' });
    expect(planPiRecovery({ ...facts, worker: 'stopped' })).toEqual({ type: 'replace', failures: [1000], delaySeconds: 1 });
    expect(planPiRecovery({ ...facts, worker: 'stopped', failures: [900, 950, 999] })).toEqual({ type: 'exhausted' });
    expect(planPiRecovery({ ...facts, closed: true })).toEqual({ type: 'idle' });
  });
});
