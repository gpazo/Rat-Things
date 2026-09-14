import { describe, expect, it } from 'vitest';
import { projectSessionItems } from '../../src/core/session-run-projection.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';

const completed = (success: boolean, contentItems: unknown) => ({ method: 'item/completed', params: { item: {
  id: 'call', type: 'dynamicToolCall', tool: 'lookup', arguments: {}, status: success ? 'completed' : 'failed', success, contentItems,
  private_metadata: 'not public',
} } });

describe('native function result history', () => {
  it.each([true, false])('preserves empty and image content with success=%s and deduplicates completion', success => {
    const event = completed(success, [{ type: 'inputText', text: '' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,dGVzdA==' }]);
    const items = projectSessionItems('turn', [event]);
    const before = structuredClone(items);
    const replay = projectSessionItems('turn', [event], undefined, { initial: items });
    expect(items).toEqual(before);
    expect(replay).toEqual(items);
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ id: 'fresult_native_call', type: 'function_call_output', turn_id: 'turn', call_id: 'call',
      output: [{ type: 'input_text', text: '' }, { type: 'input_image', image_url: 'data:image/png;base64,dGVzdA==' }], error: null,
      status: success ? 'completed' : 'failed' });
    items.forEach(item => parseAgentsContract('Item', item));
    expect(JSON.stringify(items)).not.toContain('not public');
  });

  it('retains native failure text and separate Turn attribution for a reused call ID', () => {
    const event = completed(false, [{ type: 'inputText', text: 'Lookup failed' }]);
    const first = projectSessionItems('first', [event]);
    const child = projectSessionItems('child-turn', [event]);
    expect(first[1]).toMatchObject({ turn_id: 'first', status: 'failed', error: 'Lookup failed' });
    expect(child[1]).toMatchObject({ turn_id: 'child-turn', status: 'failed', error: 'Lookup failed' });
  });

  it('distinguishes absent output from an explicitly empty result', () => {
    expect(projectSessionItems('turn', [completed(true, null)])).toHaveLength(1);
    expect(projectSessionItems('turn', [completed(true, [])])[1]).toMatchObject({ output: [], status: 'completed' });
  });

  it('does not expose a partial result when native content is outside the public contract', () => {
    expect(projectSessionItems('turn', [completed(true, [{ type: 'inputText', text: 'Partial' }, { type: 'inputAudio', audioUrl: 'private' }])])).toHaveLength(1);
  });
});
