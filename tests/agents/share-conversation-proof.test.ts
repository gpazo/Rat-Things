import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { AgentSessionItem, AgentSessionMessage } from '../../src/domain/agents-api.js';
import { commandProof, cloudCommand } from '../../testing/local-runtime/installed-cloud-transfer.mjs';
import { expectedProof, subscriptionScenario, verificationProgram } from '../../testing/local-runtime/installed-subscription.mjs';
import { conversationRecallProof, hostedContinuationInput } from '../../testing/local-runtime/share-scenario.js';

const nonce = '11111111-2222-4333-8444-555555555555';
const marker = 'context_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const directory = '/private/source-profile';
const model = 'proof-model';
const verifiedCommand: AgentSessionItem = { id: 'cmd_hosted', type: 'command_execution', turn_id: 'turn_hosted', status: 'completed', command: 'verified fixture', output: 'verified output', exit_code: 0, cwd: '/workspace', duration_ms: 1 };
const program = verificationProgram(nonce, directory);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function localScenario(contextMarker?: string) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const observations: Record<string, unknown> = {};
  let resumed = false;
  const session = { id: 'sess_proof', agent: { model }, environment: { type: 'openai_hosted', id: 'env_proof' } };
  const restart = vi.fn(async () => undefined);
  const result = await subscriptionScenario({ nonce, directory, model, ...(contextMarker === undefined ? {} : { contextMarker }) }, {
    request: async (method: string, path: string, body: unknown) => {
      calls.push({ method, path, body });
      const phase = resumed ? 'resume' : 'first';
      const turn = resumed ? 'turn_resume' : 'turn_first';
      if (path.endsWith('/events')) { resumed = true; return; }
      if (path.includes('/turns?')) return { data: [{ id: turn, status: 'completed' }] };
      if (path.includes('/items?')) return { data: [{ id: `cmd_${phase}`, type: 'command_execution', turn_id: turn, status: 'completed', exit_code: 0,
        command: `node /workspace/rat-acceptance.cjs ${phase}`, output: `RAT_INSTALLED_SUBSCRIPTION_PROOF ${JSON.stringify(expectedProof(nonce, program, phase))}` }] };
      if (path.includes('/files?')) return { data: expectedProof(nonce, program, phase).files.map(file => ({ object: 'agent.environment.file',
        environment_id: session.environment.id, path: `/workspace/${file.path}`, size_bytes: file.bytes })) };
      return session;
    },
    restart, record: async (name: string, value: unknown) => { observations[name] = value; },
    signal: new AbortController().signal,
  });
  return { calls, result, observations, restart };
}

function answer(text: string, edits: Partial<AgentSessionMessage> = {}): AgentSessionMessage {
  return { id: 'msg_hosted', type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', turn_id: 'turn_hosted',
    content: [{ type: 'output_text', text }], ...edits };
}

it('places the marker only in the two source conversation inputs and leaves proof files and default callers unchanged', async () => {
  const marked = await localScenario(marker);
  const normal = await localScenario();
  expect(marked.restart).toHaveBeenCalledOnce();
  expect(marked.calls.filter(call => call.method === 'POST')).toHaveLength(2);
  expect(marked.result).toEqual(normal.result);
  expect(marked.observations).toEqual(normal.observations);
  const create = marked.calls[0]!.body as { input: string; environment: { files: { data: string }[] } };
  const plainCreate = normal.calls[0]!.body as { input: string };
  expect(create.input).toContain(marker);
  expect(create.input.startsWith(plainCreate.input)).toBe(true);
  const { input: _input, ...configuration } = create;
  expect(JSON.stringify(configuration)).not.toContain(marker);
  expect(Buffer.from(create.environment.files[0]!.data, 'base64').toString()).toBe(program);
  const resumed = marked.calls.find(call => call.path.endsWith('/events'))!.body;
  expect(JSON.stringify(resumed)).toContain(marker);
  expect(JSON.stringify(normal.calls)).not.toContain('conversation-only marker');
  expect(JSON.stringify(marked.observations)).not.toContain(marker);
});

it('keeps the marker out of the hosted input and exact workspace command', () => {
  const command = cloudCommand(nonce, { sessionId: 'sess_proof', files: expectedProof(nonce, program, 'resume').files });
  const input = hostedContinuationInput(command.command, true);
  expect(input).toContain('RAT_CONVERSATION_RECALL');
  expect(input).toContain(command.command);
  expect(input).not.toContain(marker);
  expect(JSON.stringify(command)).not.toContain(marker);
  expect(hostedContinuationInput(command.command)).toBe(`Continue our shared workspace. Run this exact command once, then report the output.\n${command.command}`);
});

it('requires exact recall in the new completed assistant final answer and retains only bounded proof metadata', () => {
  const text = `Workspace verified.\nRAT_CONVERSATION_RECALL ${marker}\n`;
  expect(conversationRecallProof([verifiedCommand, answer(text)], 'turn_hosted', marker, 'cmd_hosted')).toEqual({ turnId: 'turn_hosted', messageId: 'msg_hosted',
    markerSha256: sha256(marker), source: 'assistant.final_answer', recalled: true });
  for (const wrong of [answer(text, { turn_id: 'turn_source' }), answer(text, { role: 'user' }), answer(text, { phase: 'commentary' }),
    answer(text, { status: 'in_progress' }), answer(`${text.trim()}-extra`), answer('Workspace verified.'), answer('x'.repeat(65 * 1024))]) {
    expect(() => conversationRecallProof([verifiedCommand, wrong], 'turn_hosted', marker, 'cmd_hosted')).toThrow();
  }
  expect(() => conversationRecallProof([verifiedCommand, answer(text), answer(text)], 'turn_hosted', marker, 'cmd_hosted')).toThrow();
});

it('rejects visible-history-only continuation even when the hosted workspace command succeeds', () => {
  const proof = cloudCommand(nonce, { sessionId: 'sess_proof', files: expectedProof(nonce, program, 'resume').files });
  const command: AgentSessionItem = { id: 'cmd_hosted', type: 'command_execution', turn_id: 'turn_hosted', status: 'completed',
    command: proof.command, output: proof.output, exit_code: 0, cwd: '/workspace', duration_ms: 1 };
  const items = [answer(`RAT_CONVERSATION_RECALL ${marker}`, { turn_id: 'turn_source' }), command, answer('Workspace verified.')];
  expect(commandProof(items, 'turn_hosted', proof).turnId).toBe('turn_hosted');
  expect(() => conversationRecallProof(items, 'turn_hosted', marker, 'cmd_hosted')).toThrow('did not recall');
});

it('rejects recall obtained by an extra hosted command or other tool activity', () => {
  const recalled = answer(`RAT_CONVERSATION_RECALL ${marker}`);
  const extra = { ...verifiedCommand, id: 'cmd_read_marker', command: 'cat /workspace/context.txt', output: marker };
  expect(() => conversationRecallProof([verifiedCommand, extra, recalled], 'turn_hosted', marker, 'cmd_hosted')).toThrow('additional retrieval');
  expect(() => conversationRecallProof([{ ...verifiedCommand, output: marker }, recalled], 'turn_hosted', marker, 'cmd_hosted')).toThrow('hosted tool activity');
  const otherTool = { id: 'call_extra', type: 'function_call' as const, turn_id: 'turn_hosted', call_id: 'call_extra', name: 'read_file', arguments: '{}', status: 'completed' as const };
  expect(() => conversationRecallProof([verifiedCommand, otherTool, recalled], 'turn_hosted', marker, 'cmd_hosted')).toThrow('additional retrieval');
});
