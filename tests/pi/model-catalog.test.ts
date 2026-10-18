import { clampThinkingLevel, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import { describe, expect, it } from 'vitest';
import supportedModels from '../../src/adapters/pi-bedrock-models.json' with { type: 'json' };
import { piCatalog, piRegistryModel } from '../../src/adapters/pi-model-catalog.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { resolveRuntime, validateRuntimeAgent } from '../../src/domain/session-runtime.js';

describe('pinned Pi Converse model matrix', () => {
  it('resolves every documented ID from a pinned same-model descriptor without clamping efforts', () => {
    const registry = amazonBedrockProvider().getModels();
    const ids = supportedModels.entries.flatMap(entry => entry.invocationIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(supportedModels.piVersion).toBe('1.3.0');
    for (const entry of supportedModels.entries) {
      const registered = registry.find(model => model.id === entry.registryId);
      expect(registered, entry.registryId).toBeDefined();
      expect(entry.source).toMatch(/^https:\/\/docs\.aws\.amazon\.com\/bedrock\/latest\/userguide\/model-card-/);
      for (const id of entry.invocationIds) {
        const model = piRegistryModel(id);
        const source = registry.find(model => model.id === id) ?? registered!;
        expect(model).toEqual({ ...source, id });
        expect(model.api).toBe('bedrock-converse-stream');
        expect(model.input.every(input => input === 'text' || input === 'image')).toBe(true);
        for (const effort of entry.reasoning) {
          const thinking = (effort === 'none' ? 'off' : effort) as ModelThinkingLevel;
          expect(clampThinkingLevel(model, thinking), `${id}: ${effort}`).toBe(thinking);
        }
        if (model.reasoning) expect(entry.reasoning).not.toContain('none');
      }
    }
  });

  it('rejects profile-only base IDs, invented profiles, unsupported APIs, and absent registry models', () => {
    for (const id of [
      'anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic.claude-sonnet-4-6',
      'anthropic.claude-opus-4-8', 'anthropic.claude-opus-5', 'openai.gpt-5.4',
      'openai.gpt-5.6-terra', 'openai.gpt-6-astra', 'xai.grok-4.6',
      'au.amazon.nova-micro-v1:0', 'eu.openai.gpt-5.4', 'global.qwen.qwen3-coder-next',
      'google.gemma-4-31b', 'openai.gpt-5.5', 'xai.grok-4.3', 'deepseek.r1-v1:0',
    ]) expect(() => piRegistryModel(id), id).toThrow('Unsupported Pi Converse model');
  });

  it('retains documented aliases and limits input to the Pi-supported modalities', () => {
    const ids = ['us.openai.gpt-5.4', 'au.anthropic.claude-sonnet-5-5',
      'us-gov.anthropic.claude-opus-4-8', 'in.moonshotai.kimi-k3',
      'us-gov.nvidia.nemotron-nano-3-30b', 'zai.glm-5.3',
      'mistral.voxtral-small-24b-2507', 'qwen.qwen3-vl-235b-a22b'];
    const catalog = piCatalog(ids, 'us-west-2');
    expect(catalog.map(model => model.id)).toEqual(ids);
    expect(catalog.find(model => model.id === 'mistral.voxtral-small-24b-2507')?.input).toEqual(['text']);
    expect(catalog.find(model => model.id === 'qwen.qwen3-vl-235b-a22b')?.input).toEqual(['text', 'image']);
  });

  it.each([
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', ['minimal', 'low', 'medium', 'high']],
    ['us.anthropic.claude-sonnet-4-6', ['low', 'medium', 'high']],
    ['us.anthropic.claude-opus-4-6-v1', ['low', 'medium', 'high', 'max']],
    ['global.anthropic.claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['global.anthropic.claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['openai.gpt-oss-120b-1:0', ['low', 'medium', 'high']],
    ['global.openai.gpt-6-sol', ['low', 'medium', 'high', 'xhigh']],
    ['meta.llama4-scout-17b-instruct-v1:0', ['none']],
    ['qwen.qwen3-coder-next', ['none']],
  ])('advertises only the adapter-supported efforts for %s', (id, reasoning) => {
    expect(piCatalog([id as string], 'us-west-2')[0]?.reasoning).toEqual(reasoning);
  });

  it.each(['amazon.nova-2-lite-v1:0', 'deepseek.v3.2', 'moonshotai.kimi-k2.5',
    'qwen.qwen3-32b-v1:0', 'mistral.magistral-small-2509', 'minimax.minimax-m2.5',
    'nvidia.nemotron-super-3-120b', 'writer.palmyra-x5-v1:0', 'us.xai.grok-4.6', 'zai.glm-5.3',
  ])('accepts provider-default reasoning and rejects explicit effort for %s', id => {
    const catalog = piCatalog([id], 'us-west-2');
    expect(catalog[0]?.reasoning).toEqual([]);
    const pin = resolveRuntime({ rat_things_runtime: 'pi' }, null, catalog);
    const agent = { ...sessionAgent({ model: id }, 'session', 0), reasoning: { effort: null, summary: null } };
    expect(() => validateRuntimeAgent(pin, agent)).not.toThrow();
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(() => validateRuntimeAgent(pin, { ...agent, reasoning: { effort, summary: null } })).toThrow('reasoning effort');
    }
  });
});
