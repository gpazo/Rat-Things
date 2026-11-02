import { describe, expect, it, vi } from 'vitest';
import { BedrockEventFilter } from '../../src/adapters/bedrock-event-filter.js';

describe('Bedrock event filter boundary', () => {
  it('sends a signed tool-less schema-constrained request and parses one decision', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ stopReason: 'end_turn', output: { message: { content: [{ text: '{"act":true,"reason":"Release failure"}' }] } } })));
    const model = new BedrockEventFilter({ model: 'approved-model', region: 'us-east-1', fetch: transport, credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' } });
    expect(await model.decide({ policies: ['Release failures'], eventText: 'help', threadText: 'thread' })).toEqual({ act: true, reason: 'Release failure' });
    const [url, request] = transport.mock.calls[0]!;
    expect(String(url)).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/approved-model/converse');
    expect(request?.redirect).toBe('error');
    expect((request?.headers as Record<string, string>).authorization).toContain('AWS4-HMAC-SHA256');
    const body = JSON.parse(String(request?.body));
    expect(body.toolConfig).toBeUndefined();
    expect(body.outputConfig.textFormat.type).toBe('json_schema');
    expect(body.messages[0].content[0].text).toContain('help');
  });
  it.each([
    { stopReason: 'tool_use', output: { message: { content: [{ text: '{"act":true,"reason":"x"}' }] } } },
    { stopReason: 'end_turn', output: { message: { content: [{ text: '{"act":true,"reason":"x","tools":[]}' }] } } },
    { stopReason: 'end_turn', output: { message: { content: [{ text: 'x'.repeat(20_000) }] } } },
  ])('rejects invalid or oversized response', async value => {
    const model = new BedrockEventFilter({ model: 'approved-model', region: 'us-east-1', fetch: async () => new Response(JSON.stringify(value)), credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    await expect(model.decide({ policies: [], eventText: '', threadText: '' })).rejects.toThrow();
  });
});
