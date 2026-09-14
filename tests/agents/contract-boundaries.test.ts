import { describe, expect, it, vi } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { MemoryAgentsStore } from './fixtures.js';

const maxAgentTextCharacters = 1_048_576;

function fixture() {
  const store = new MemoryAgentsStore();
  const put = vi.spyOn(store, 'put');
  const service = new AgentService({
    store,
    ids: { next: () => 'agent_boundary' },
    clock: { now: () => 1_800_000_000 },
  });
  return { service, put };
}

describe('Agent text contract boundaries', () => {
  // The official create/update reference uses JSON Schema maxLength (Unicode
  // code points), not JavaScript's UTF-16 code-unit length.
  it.each(['model', 'instructions'] as const)('accepts %s at the Unicode character limit without altering its content', async (field) => {
    const { service, put } = fixture();
    const text = '😀'.repeat(maxAgentTextCharacters);
    const agent = await service.create('owner', { model: 'requested-model', [field]: text });
    expect(agent[field]).toBe(text);
    expect((await service.retrieve('owner', agent.id))[field]).toBe(text);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it.each(['model', 'instructions'] as const)('rejects %s above the character limit before persisting a resource', async (field) => {
    const { service, put } = fixture();
    await expect(service.create('owner', {
      model: 'requested-model', [field]: '😀'.repeat(maxAgentTextCharacters) + 'x',
    })).rejects.toMatchObject({ status: 400, code: 'invalid_request', param: field });
    expect(put).not.toHaveBeenCalled();
  });

  it('preserves the saved agent after an invalid update and accepts an exact-limit replacement', async () => {
    const { service, put } = fixture();
    const initial = await service.create('owner', { model: 'requested-model', instructions: 'original' });
    const text = '😀'.repeat(maxAgentTextCharacters);
    await expect(service.update('owner', initial.id, { instructions: text + 'x' }))
      .rejects.toMatchObject({ status: 400, param: 'instructions' });
    expect(await service.retrieve('owner', initial.id)).toEqual(initial);
    expect(put).toHaveBeenCalledTimes(1);
    const updated = await service.update('owner', initial.id, { instructions: text });
    expect(updated.instructions).toBe(text);
    expect(updated.model).toBe(initial.model);
    expect(put).toHaveBeenCalledTimes(2);
  });
});
