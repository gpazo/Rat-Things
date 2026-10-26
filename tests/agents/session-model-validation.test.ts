import { expect, it } from 'vitest';
import { admitNativeServiceTier, nativeServiceTier } from '../../src/domain/session-model-validation.js';

const catalog = [
  { id: 'catalog-entry', model: 'gpt-test', serviceTiers: [{ id: 'priority' }] },
  { id: 'standard-only', model: 'standard-only', serviceTiers: [] },
];

it.each([
  [undefined, 'default'], ['auto', 'default'], ['default', 'default'],
  ['fast', 'priority'], ['priority', 'priority'], ['flex', 'flex'],
])('normalizes public tier %s to an explicit native %s', (tier, expected) => {
  expect(nativeServiceTier(tier)).toBe(expected);
});

it.each([undefined, 'auto', 'default'])('admits standard tier %s without a model catalog', tier => {
  expect(admitNativeServiceTier(tier, { model: 'custom-model', provider: 'amazon-bedrock', models: undefined })).toBe('default');
});

it('uses model/list identifiers and does not mutate its provider capability evidence', () => {
  const before = structuredClone(catalog);
  expect(admitNativeServiceTier('fast', { model: 'gpt-test', provider: 'openai', models: catalog })).toBe('priority');
  expect(admitNativeServiceTier('priority', { model: 'catalog-entry', provider: 'openai', models: catalog })).toBe('priority');
  expect(catalog).toEqual(before);
});

it('accepts stock Responses flex for a known model, while requiring advertised Bedrock tiers', () => {
  expect(admitNativeServiceTier('flex', { model: 'standard-only', provider: 'openai', models: catalog })).toBe('flex');
  expect(() => admitNativeServiceTier('flex', { model: 'standard-only', provider: 'amazon-bedrock', models: catalog }))
    .toThrow('The selected model and provider do not support this service tier');
  expect(admitNativeServiceTier('flex', { model: 'openai.gpt-test', provider: 'amazon-bedrock', models: [
    { id: 'openai.gpt-test', model: 'openai.gpt-test', serviceTiers: [{ id: 'flex' }] },
  ] })).toBe('flex');
});

it.each([
  ['priority', { model: 'standard-only', provider: 'openai', models: catalog }],
  ['priority', { model: 'openai.gpt-test', provider: 'amazon-bedrock', models: catalog }],
  ['flex', { model: 'custom-model', provider: 'fixture', models: catalog }],
  ['fast', { model: 'custom-model', provider: 'fixture', models: [] }],
  ['priority', { model: 'gpt-test', provider: 'openai', models: [{ model: 'gpt-test', additionalSpeedTiers: ['priority'] }] }],
  ['priority', { model: undefined, provider: 'openai', models: [{ serviceTiers: [{ id: 'priority' }] }] }],
  ['PRIVATE_UNKNOWN_TIER', { model: 'gpt-test', provider: 'openai', models: catalog }],
])('rejects unsupported tier %s without exposing capability diagnostics', (tier, capability) => {
  try { admitNativeServiceTier(tier, capability); throw new Error('Expected rejection'); }
  catch (error) {
    expect(error).toMatchObject({ status: 400, code: 'invalid_request', param: 'agent.service_tier' });
    expect((error as Error).message).not.toContain('PRIVATE');
  }
});
