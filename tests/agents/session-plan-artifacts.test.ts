import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { SessionArtifactCapture } from '../../src/core/session-artifact-capture.js';
import { initialSessionRuntime, type SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';

function fixture(admitted = true) {
  const files = new Map([['/workspace/outputs/result.txt', 'first version'], ['/workspace/outputs/other.txt', 'unrelated']]);
  const reads = vi.fn((path: string) => {
    const text = files.get(path)!;
    return { path, size_bytes: Buffer.byteLength(text), version: text, data: Buffer.from(text).toString('base64') };
  });
  const writes: string[] = [];
  const options = {
    ownerId: 'owner',
    launch: { sessionId: 'session', turnId: 'turn', input: [], ...(admitted ? { planTool: true as const } : {}),
      agent: sessionAgent({ model: 'fixture', tools: admitted ? [{ type: 'function', name: 'rat_things_plan_update', description: '', parameters: {} }] : [] }, 'agent', 1),
      environment: { type: 'openai_hosted' as const, id: 'env', capability_directories: [], files: [], plugins: [], skills: [], network: { access: 'disabled' as const, allowed_domains: [] }, packages: { npm: [], python: [], system: [] } },
    },
    files: { execute: async (operation: import('../../src/core/environment-file-ports.js').EnvironmentFileOperation) => {
      if (operation.operation === 'list') return [...files].map(([path, text]) => ({ path, size_bytes: Buffer.byteLength(text) }));
      if (operation.operation !== 'read') throw new Error('Unexpected operation');
      return reads(operation.path);
    } },
    artifacts: { putBytes: async (key: string, bytes: Uint8Array, contentType: string) => {
      writes.push(Buffer.from(bytes).toString());
      return { bucket: 'private', key, contentType, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    } },
  };
  const state: SessionRuntimeState = { ...initialSessionRuntime('session', 'agent', 'root'),
    turns: [{ threadId: 'root', nativeTurnId: 'native', items: [], turn: {
      id: 'turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null,
      status: 'waiting', created_at: 1, started_at: 1, completed_at: null, usage: null, error: null,
    } }],
    requiredActions: [{ type: 'function_call', call_id: 'call', turn_id: 'turn', name: 'rat_things_plan_update',
      arguments: { expected_revision: 0, items: [{ id: 'result', text: 'Fix the result', state: 'addressed', reason: 'Updated', source_message_ids: [], result_links: [{ kind: 'output', path: '/workspace/outputs/result.txt' }] }] } }],
  };
  return { files, reads, writes, state, capture: () => new SessionArtifactCapture(options) };
}

it('freezes requested output versions at the agent call and retains them after terminal recapture', async () => {
  const f = fixture();
  const captured = await f.capture().capture(f.state);
  expect(f.writes).toEqual(['first version']);
  const original = captured.turns[0]!.artifacts![0]!;
  expect(captured.turns[0]!.planArtifactCalls).toEqual({ call: [{ path: original.artifact.path, artifact_id: original.artifact.id, version_sha256: original.content.sha256 }] });
  expect(f.state.turns[0]!.artifacts).toBeUndefined();
  f.files.set('/workspace/outputs/result.txt', 'updated version');
  const recovered = f.capture();
  expect(await recovered.capture(captured)).toEqual(captured);
  expect(f.reads).toHaveBeenCalledTimes(1);
  const complete: SessionRuntimeState = { ...captured, requiredActions: [], turns: captured.turns.map(turn => ({ ...turn, turn: { ...turn.turn, status: 'completed', completed_at: 3 } })) };
  const final = await recovered.capture(complete);
  expect(final.turns[0]!.artifacts).toHaveLength(3);
  expect(final.turns[0]!.artifacts).toContainEqual(original);
  expect(final.turns[0]!.planArtifactCalls).toEqual(captured.turns[0]!.planArtifactCalls);
  expect(f.writes).toEqual(['first version', 'updated version', 'unrelated']);
  expect(await f.capture().capture(final)).toEqual(final);
  expect(f.writes).toHaveLength(3);
});

it('fails a missing output closed without failing the Turn or retrying a changed file under the same call', async () => {
  const f = fixture();
  f.files.delete('/workspace/outputs/result.txt');
  const captured = await f.capture().capture(f.state);
  expect(captured.turns[0]!.planArtifactCalls).toEqual({ call: [] });
  expect(captured.turns[0]!.turn.status).toBe('waiting');
  f.files.set('/workspace/outputs/result.txt', 'appeared later');
  expect(await f.capture().capture(captured)).toEqual(captured);
  expect(f.writes).toEqual([]);
  expect(f.reads).not.toHaveBeenCalled();
});

it('does not snapshot a reserved call without the admitted tool, or from a child agent', async () => {
  const unadmitted = fixture(false);
  expect(await unadmitted.capture().capture(unadmitted.state)).toEqual(unadmitted.state);
  expect(unadmitted.reads).not.toHaveBeenCalled();
  const child = fixture();
  const state = { ...child.state, turns: child.state.turns.map(turn => ({ ...turn, threadId: 'child' })) };
  expect(await child.capture().capture(state)).toEqual(state);
  expect(child.reads).not.toHaveBeenCalled();
});
