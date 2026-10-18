import { describe, expect, it, vi } from 'vitest';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
const captured = { configurations: [] as Array<Record<string, unknown>>, requests: [] as Array<Record<string, unknown>> };
vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async function(this: BedrockRuntimeClient, command: unknown) {
  const config = this.config;
  captured.configurations.push({ region: await config.region(), token: typeof config.token === 'function' ? await config.token() : config.token, schemes: await config.authSchemePreference?.() });
  captured.requests.push((command as { input: Record<string, unknown> }).input);
  return { $metadata: { requestId: 'fixture' }, stream: (async function* () {
    yield { messageStart: { role: 'assistant' } };
    yield { contentBlockStart: { contentBlockIndex: 0, start: {} } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Bedrock fixture' } } };
    yield { contentBlockStop: { contentBlockIndex: 0 } };
    yield { messageStop: { stopReason: 'end_turn' } };
    yield { metadata: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } };
  })() };
});
import { createPiModels, piCatalog } from '../../src/runner/pi/provider.js';
import { resolveRuntime } from '../../src/domain/session-runtime.js';

describe('actual Pi Converse stream authentication', () => {
  it('uses rotating host bearers and the pinned region on every inference without a credential chain', async () => {
    const pin = resolveRuntime({ rat_things_runtime: 'pi' }, null, piCatalog(['amazon.nova-micro-v1:0'], 'eu-west-1'));
    if (pin.kind !== 'pi') throw new Error('Pi fixture');
    let counter = 0;
    const models = createPiModels(pin, async () => `ephemeral-${++counter}`);
    const model = models.getModel('amazon-bedrock', pin.catalog[0]!.id)!;
    for (let index = 0; index < 2; index++) {
      const stream = models.streamSimple(model, { messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] });
      const result = await stream.result();
      expect(result.stopReason, JSON.stringify(result)).toBe('stop');
      expect(result.content).toEqual([{ type: 'text', text: 'Bedrock fixture' }]);
    }
    expect(captured.configurations).toHaveLength(2);
    expect(captured.configurations.map(config => config.region)).toEqual(['eu-west-1', 'eu-west-1']);
    expect(captured.configurations.map(config => config.token)).toEqual([{ token: 'ephemeral-1' }, { token: 'ephemeral-2' }]);
    expect(captured.configurations.every(config => JSON.stringify(config.schemes).includes('httpBearerAuth'))).toBe(true);
    expect(captured.requests.map(request => request.modelId)).toEqual(['amazon.nova-micro-v1:0', 'amazon.nova-micro-v1:0']);
    const unavailable = createPiModels(pin, async () => '');
    expect((await unavailable.streamSimple(model, { messages: [] }).result()).stopReason).toBe('error');
    expect(captured.configurations).toHaveLength(2);
  });
});
