import { describe, expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import { planSessionLaunch } from '../../src/runner/session-launch-planning.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { planSessionStream } from '../../src/core/session-stream.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import type { AgentSession, AgentSessionItem, Turn } from '../../src/domain/agents-api.js';

describe('AWS transport and pure harness planning', () => {
  it('signs upstream SDK requests for the AWS Lambda function URL without buffering responses', async () => {
    let request: Request | undefined;
    const client = createAgentsClient({
      baseURL: 'https://example.lambda-url.us-west-2.on.aws/v1', region: 'us-west-2',
      credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret', sessionToken: 'test-session' },
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(JSON.stringify({ data: [], has_more: false }), { headers: { 'content-type': 'application/json' } });
      },
    });
    expect((await client.beta.agents.list({ limit: 2 })).data).toEqual([]);
    expect(request!.url).toBe('https://example.lambda-url.us-west-2.on.aws/v1/agents?limit=2');
    expect(request!.headers.get('authorization')).toContain('/us-west-2/lambda/aws4_request');
    expect(request!.headers.get('x-amz-security-token')).toBe('test-session');
    expect(request!.headers.get('openai-beta')).toBe('agents=v1');
  });

  it('passes model, reasoning, text format, tier, images, and declared functions to Codex without mutation', () => {
    const agent = sessionAgent({
      model: 'requested-model', instructions: 'Follow the task', reasoning: { effort: 'max', summary: 'detailed' },
      service_tier: 'flex', text: { verbosity: 'low', format: { type: 'json_schema', schema: { type: 'object', properties: { result: { type: 'boolean' } }, required: ['result'], additionalProperties: false } } },
      tools: [{ type: 'function', name: 'lookup', description: 'Find a record', parameters: { type: 'object' }, defer_loading: false }],
    }, 'agent_test', 1);
    const launch = { sessionId: 'sess_test', turnId: 'turn_test', agent, environment: { type: 'none' as const }, input: [{ role: 'user' as const, content: [{ type: 'input_image' as const, image_url: 'data:image/png;base64,dGVzdA==' }] }] };
    const before = structuredClone(launch);
    const base = planCodexLaunch({ version: '1', prompt: 'Task', agent: { sandbox: 'read-only' } }, '/workspace', 1000, { CODEX_AUTH_MODE: 'chatgpt' });
    const planned = planSessionLaunch(base, launch);
    expect(planned).toMatchObject({
      model: 'requested-model', developerInstructions: 'Follow the task', reasoningEffort: 'max', reasoningSummary: 'detailed', serviceTier: 'flex',
      environments: [], webSearch: 'disabled', outputSchema: { type: 'object' },
      dynamicTools: [{ type: 'function', name: 'lookup', deferLoading: false }], sessionConfig: { model_verbosity: 'low', 'features.multi_agent': false },
    });
    expect(planned.input).toContainEqual({ type: 'image', url: 'data:image/png;base64,dGVzdA==' });
    expect(launch).toEqual(before);
  });

  it('emits complete output before turn completion and preserves the source snapshot', () => {
    const agent = sessionAgent({ model: 'test' }, 'agent_test', 1);
    const session: AgentSession = { id: 'sess_test', object: 'agent.session', agent, environment: { type: 'none' }, created_at: 1, last_active_at: 2, error: null, metadata: {}, required_actions: [], status: 'idle', usage: null, vault_ids: [] };
    const turn: Turn = { id: 'turn_test', object: 'agent.session.turn', session_id: session.id, agent_id: agent.id, subagent_id: null, created_at: 1, started_at: 1, completed_at: 2, status: 'completed', error: null, usage: null };
    const item: AgentSessionItem = { id: 'msg_test', type: 'message', role: 'assistant', turn_id: turn.id, phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'Answer' }] };
    const snapshot = { session, turns: [turn], items: [item] };
    const before = structuredClone(snapshot);
    const events = planSessionStream(undefined, snapshot, true);
    events.forEach((event, index) => parseAgentsContract('SessionEvent', { ...event, event_id: `evt_${index}` }));
    expect(events.findIndex((event) => event.type === 'agent.session.turn.output_text.done')).toBeLessThan(events.findIndex((event) => event.type === 'agent.session.turn.completed'));
    expect(snapshot).toEqual(before);
    expect(planSessionStream(snapshot, snapshot)).toEqual([]);
  }, 15_000); // Includes cold compilation of the complete SessionEvent schema on ARM64.
});
