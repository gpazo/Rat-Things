import { expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';

it.each([false, true])('keeps inherited usage out of the first child Turn, including replacement=%s', async replace => {
  const create = (previous?: import('../../src/core/session-runtime-planning.js').SessionRuntimeState) => new SessionRuntime({ sessionId: 'child', agentId: 'agent', ...(previous ? { previous } : { fork: { rootThreadId: 'source', lastNativeTurnId: 'old-turn' } }),
    request: { binary: 'unused', workspace: '/workspace', environment: {}, timeoutMs: 1000, prompt: '', sandbox: 'read-only', persistent: true, model: 'fixture', modelProvider: 'openai', networkAccess: false },
    client: options => ({ initialize: async () => {}, close: async () => {}, call: async method => {
      if (method === 'thread/fork' || method === 'thread/resume') return { thread: { id: 'child-native', turns: [{ id: 'old-turn' }] } };
      if (method === 'turn/start') {
        options.onEvent!({ method: 'thread/tokenUsage/updated', params: { threadId: 'child-native', turnId: 'old-turn', tokenUsage: { total: { inputTokens: 2, outputTokens: 3 } } } });
        options.onEvent!({ method: 'turn/started', params: { threadId: 'child-native', turn: { id: 'new-turn', status: 'inProgress' } } });
        options.onEvent!({ method: 'thread/tokenUsage/updated', params: { threadId: 'child-native', turnId: 'new-turn', tokenUsage: { total: { inputTokens: 4, outputTokens: 6 } } } });
        options.onEvent!({ method: 'turn/completed', params: { threadId: 'child-native', turn: { id: 'new-turn', status: 'completed' } } });
        return { turn: { id: 'new-turn' } };
      }
      return {};
    } }),
  });
  let runtime = create();
  try {
    expect((await runtime.initialize()).turns).toEqual([]);
    if (replace) { const previous = runtime.snapshot(); await runtime.close(); runtime = create(previous); expect((await runtime.initialize()).turns).toEqual([]); }
    await runtime.start({ id: 'api-child-turn', object: 'agent.session.turn', session_id: 'child', agent_id: 'agent', subagent_id: null, status: 'queued', created_at: 1, started_at: null, completed_at: null, error: null, usage: null }, [{ role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }]);
    expect(runtime.snapshot().turns).toHaveLength(1);
    expect(runtime.snapshot().turns[0]).toMatchObject({ nativeTurnId: 'new-turn', turn: { id: 'api-child-turn', status: 'completed', usage: { total_tokens: 5 } } });
  } finally { await runtime.close(); }
});
