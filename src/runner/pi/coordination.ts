import { Type } from '@earendil-works/pi-ai';
import { configure, defineTask, defineTool, type Harness, type ToolRegistration } from '@earendil-works/pi-durable';
import type { SessionLaunch } from '../../domain/session-execution.js';
import { piModel } from '../../domain/session-runtime.js';
import { waitForDocument } from './functions.js';
import { LinksDoc, CommandsDoc, activeTurn, admitPiInput, asConversationId, asTaskId, childTurn, json, type PiChildLink } from './protocol.js';

export const ChildKeeperTask = defineTask<{ spawnTaskId: number }, { phase: 'open' }, null>({
  name: 'rat.child', version: 1, initial: () => ({ phase: 'open' }),
  phases: { open: async (_task, runtime, context) => {
    const child = await waitForDocument(runtime, LinksDoc, links => Object.values(links.children).find(child => child.keeperId === runtime.taskId && child.closing), context);
    const conversation = await runtime.conversation(asConversationId(child.conversationId), context);
    if (conversation) await conversation.abort(context, { background: true });
    await runtime.commit(async tx => {
      const links = await tx.doc(LinksDoc);
      links.children[child.id]!.closedAt = Math.floor(runtime.now() / 1000);
      return { status: 'terminal', outcome: { status: 'completed', result: null } };
    }, context);
  } },
  abort: async (_task, runtime, context) => {
    await runtime.commit(async tx => {
      const links = await tx.doc(LinksDoc);
      const child = Object.values(links.children).find(child => child.keeperId === runtime.taskId);
      if (child) { child.closing = true; child.closedAt = Math.floor(runtime.now() / 1000); }
      return { status: 'terminal', outcome: { status: 'aborted' } };
    }, context);
  },
});

export function coordinationTools(launch: SessionLaunch, harness: () => Harness, now: () => number): ToolRegistration[] {
  if (!launch.agent.multi_agent.enabled) return [];
  const spawn = defineTool({
    name: 'spawn_agent', description: 'Start a durable background subagent. Its ID remains available across turns and recovery.', replay: 'safe',
    parameters: Type.Object({ message: Type.String(), name: Type.String(), model: Type.Optional(Type.String()) }),
    execute: async (args, api, context) => {
      const child = await api.commit(async tx => {
        const links = await tx.doc(LinksDoc);
        const found = Object.values(links.children).find(child => child.spawnTaskId === api.taskId);
        if (found) return json(found);
        const parent = await activeTurn(tx, api.conversationId);
        if (Object.values(links.children).filter(child => child.closedAt === undefined).length >= (launch.agent.multi_agent.max_concurrent_subagents ?? 6)) throw new Error('Session subagent limit reached');
        if (args.model) {
          if (launch.runtime?.kind !== 'pi') throw new Error('Pi runtime pin is required');
          piModel(launch.runtime, args.model);
        }
        const keeperId = await tx.createTask(ChildKeeperTask, { spawnTaskId: api.taskId }, { ownership: { kind: 'conversation' }, background: true, abandonOnRestart: false, conversationId: api.conversationId });
        const conversation = await tx.createConversation({ ownership: { kind: 'task', taskId: keeperId } });
        if (args.model) await configure(tx, conversation.id, { model: { provider: 'amazon-bedrock', modelId: args.model } });
        const child: PiChildLink = { id: `pi_agent_${conversation.id}`, conversationId: conversation.id, keeperId, spawnTaskId: api.taskId,
          parentId: parent.turn.agent_id, parentTurnId: parent.turn.id, name: args.name, prompt: args.message, openedAt: Math.floor(now() / 1000), closing: false };
        const requestId = `spawn:${api.taskId}`;
        const submissionId = await admitPiInput(tx, conversation.id, requestId, args.message, now(), 'reject', true);
        const turn = childTurn(links, child, requestId, now());
        links.children[child.id] = child;
        links.turns[turn.id] = { turn: json(turn), conversationId: conversation.id, requestId, submissionId, parentTurnId: parent.turn.id };
        return child;
      }, context);
      return { output: [{ type: 'text', text: JSON.stringify({ agent_id: child.id }) }] };
    },
  });
  const send = defineTool({
    name: 'send_input', description: 'Send a follow-up message to a durable subagent. Busy children queue the message.', replay: 'safe',
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    execute: async (args, api, context) => {
      const requestId = `send:${api.taskId}`;
      const turnId = await api.commit(async tx => {
        const links = await tx.doc(LinksDoc);
        const commands = await tx.doc(CommandsDoc);
        if (commands.operations[requestId]) return commands.operations[requestId]!.turnId;
        const child = links.children[args.id];
        if (!child || child.closing) throw new Error('Subagent is unavailable');
        const submissionId = await admitPiInput(tx, asConversationId(child.conversationId), requestId, args.message, now(), 'followUp');
        const turn = childTurn(links, json(child), requestId, now());
        links.turns[turn.id] = { turn: json(turn), conversationId: child.conversationId, requestId, submissionId, parentTurnId: child.parentTurnId };
        commands.operations[requestId] = { kind: 'send', turnId: turn.id, status: 'settled', fingerprint: JSON.stringify(args), submissionId };
        return turn.id;
      }, context);
      return { output: [{ type: 'text', text: JSON.stringify({ turn_id: turnId }) }] };
    },
  });
  const wait = defineTool({
    name: 'wait_agent', description: 'Wait for the latest accepted Turn of each child and return its committed answer.', replay: 'safe',
    parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1 }) }),
    execute: async (args, api, context) => {
      let selected = await api.memo<{ id: string; submissionId: number; conversationId: number }[]>('wait-targets', context);
      if (!selected) {
        const links = await api.snapshot(LinksDoc, context);
        if (!links) throw new Error('Missing Pi links');
        const targets = args.ids.map(id => {
          const child = links.children[id];
          if (!child) throw new Error('Unknown subagent');
          const turn = Object.values(links.turns).filter(turn => turn.conversationId === child.conversationId).sort((a, b) => b.submissionId - a.submissionId)[0];
          if (!turn) throw new Error('Subagent has no Turn');
          return { id, submissionId: turn.submissionId, conversationId: child.conversationId };
        });
        selected = await api.memo('wait-targets', targets, context);
      }
      const results = await Promise.all(selected.map(async target => {
        const submission = await harness().submission(target.submissionId as never, context);
        if (!submission) throw new Error('Missing subagent submission');
        const settled = await submission.wait(context);
        const answer = settled.status === 'done' && settled.type === 'input' ? await api.commit(tx => tx.entry(settled.answer), context) : undefined;
        const text = answer?.model?.filter(message => message.role === 'assistant').flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text)).join('\n') ?? '';
        return { agent_id: target.id, status: settled.status, output: text };
      }));
      return { output: [{ type: 'text', text: JSON.stringify(results) }] };
    },
  });
  const close = defineTool({
    name: 'close_agent', description: 'Close a durable child and cancel all of its remaining work.', replay: 'safe',
    parameters: Type.Object({ id: Type.String() }),
    execute: async (args, api, context) => {
      const keeperId = await api.commit(async tx => {
        const links = await tx.doc(LinksDoc);
        const child = links.children[args.id];
        if (!child) throw new Error('Unknown subagent');
        child.closing = true;
        const commands = await tx.doc(CommandsDoc);
        commands.operations[`close:${api.taskId}`] = { kind: 'close', turnId: child.parentTurnId, status: 'accepted', fingerprint: args.id, taskId: child.keeperId };
        return child.keeperId;
      }, context);
      await api.waitForTask(asTaskId(keeperId), context);
      return { output: [{ type: 'text', text: JSON.stringify({ agent_id: args.id, status: 'closed' }) }] };
    },
  });
  return [spawn, send, wait, close];
}
