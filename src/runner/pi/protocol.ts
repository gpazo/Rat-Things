import { copyJson, type JsonRepresentation, type JsonValue } from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Message, TSchema, UserMessage } from '@earendil-works/pi-ai';
import { GenerationTask, InboxDoc, LiveDoc, defineDoc, type ConversationId, type TaskId, type Tx, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { NativeTurnBinding } from '../../core/session-runtime-planning.js';
import type { AgentSessionInputMessageParam, Turn } from '../../domain/agents-api.js';
import type { RuntimePin } from '../../domain/session-runtime.js';

export const PI_CONTEXT: Context = BACKGROUND_CONTEXT;
export type PiTurnLink = { turn: JsonRepresentation<Turn>; conversationId: number; submissionId: number; requestId: string; steerIds?: number[]; parentTurnId?: string };
export type PiChildLink = { id: string; conversationId: number; keeperId: number; spawnTaskId: number; parentId: string; parentTurnId: string; name: string; prompt: string; openedAt: number; closing: boolean; closedAt?: number };
export type PiLinks = { sessionId: string; agentId: string; rootId: number; turns: Record<string, PiTurnLink>; children: Record<string, PiChildLink>; inherited: JsonRepresentation<NativeTurnBinding>[] };
export const LinksDoc = defineDoc<PiLinks>({ kind: 'rat.links', version: 1, scope: 'session', initial: () => ({ sessionId: '', agentId: '', rootId: 1, turns: {}, children: {}, inherited: [] }) });
export type PiCommand = { kind: 'steer' | 'cancel' | 'send' | 'close'; turnId: string; status: 'accepted' | 'stale' | 'settled'; fingerprint: string; taskId?: number; submissionId?: number };
export type PiCommands = { operations: Record<string, PiCommand> };
export const CommandsDoc = defineDoc<PiCommands>({ kind: 'rat.commands', version: 1, scope: 'session', initial: () => ({ operations: {} }) });
export type PiFunctionResult = { success: boolean; output?: unknown; error?: string | null };
export type PiFunctionCall = { taskId: number; conversationId: number; turnId: string; name: string; arguments: JsonValue; result?: JsonRepresentation<PiFunctionResult> };
export type PiFunctions = { calls: Record<string, PiFunctionCall> };
export const FunctionsDoc = defineDoc<PiFunctions>({ kind: 'rat.functions', version: 1, scope: 'session', initial: () => ({ calls: {} }) });
export type PiEffectTool = { name: string; description: string; parameters: TSchema; kind: 'managed' | 'mcp'; serverLabel?: string };
export type PiToolEffect = { kind: 'managed' | 'mcp'; name: string; arguments: Record<string, JsonValue>; callId: string; taskId: number; conversationId: number };
export type PiToolEffectHandler = (request: PiToolEffect, signal: AbortSignal) => Promise<ToolExecutionResult>;
export type PiRootCheckpoint = { schema: 1; runtime: Extract<RuntimePin, { kind: 'pi' }>; model: string; reasoning: string | null; messages: Message[]; history: NativeTurnBinding[] };

export function piInput(input: readonly AgentSessionInputMessageParam[]): UserMessage['content'] {
  return input.flatMap(message => message.content.map(part => {
    if (part.type === 'input_text') return { type: 'text' as const, text: part.text };
    const data = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(part.image_url);
    if (!data) throw new Error('Pi image input must be a resolved base64 data URL');
    return { type: 'image' as const, mimeType: data[1]!, data: data[2]! };
  }));
}

export function publicCallId(taskId: number): string { return `pi_call_${taskId}`; }
export function publicThreadId(conversationId: number): string { return `pi_thread_${conversationId}`; }
export function json<T>(value: T): JsonRepresentation<T> { return copyJson(value, { omitUndefinedProperties: true }) as JsonRepresentation<T>; }

export async function activeTurn(tx: Tx, conversationId: ConversationId): Promise<PiTurnLink> {
  const links = await tx.doc(LinksDoc);
  const live = await tx.doc(LiveDoc, conversationId);
  const link = Object.values(links.turns).find(link => link.conversationId === conversationId && live.run?.inputs.some(id => id === link.submissionId || link.steerIds?.includes(id)));
  if (!link) throw new Error('Pi task has no admitted Rat Turn');
  return json(link);
}

/** Version-pinned admission, using Pi's exported task and documents in one transaction. */
export async function admitPiInput(tx: Tx, conversationId: ConversationId, requestId: string, content: UserMessage['content'], now: number, whenBusy: 'reject' | 'followUp' = 'reject', fresh = false): Promise<number> {
  const previous = fresh ? undefined : await tx.submissionByRequest(conversationId, requestId);
  if (previous) return previous.id;
  const live = await tx.doc(LiveDoc, conversationId);
  const inbox = await tx.doc(InboxDoc, conversationId);
  if (live.run || inbox.items.length) {
    if (whenBusy === 'reject') throw new Error('Pi conversation already has an active Turn');
    const submission = await tx.createSubmission({ conversationId, requestId, type: 'input', status: 'queued' });
    inbox.items.push({ id: submission.id, mode: 'followUp', content: json(content) });
    return submission.id;
  }
  const entry = await tx.appendEntry(conversationId, { kind: 'pi.user', model: [{ role: 'user', content, timestamp: now }] });
  const submission = await tx.createSubmission({ conversationId, requestId, type: 'input', status: 'placed', entry: entry.id });
  const taskId = await tx.createTask(GenerationTask, {}, { ownership: { kind: 'conversation' }, conversationId });
  live.run = { taskId, inputs: [submission.id] };
  return submission.id;
}

export function childTurn(links: Pick<PiLinks, 'sessionId'>, child: PiChildLink, requestId: string, now: number): Turn {
  return { id: `turn_pi_${requestId}`, object: 'agent.session.turn', session_id: links.sessionId, agent_id: child.id, subagent_id: child.id,
    status: 'queued', created_at: Math.floor(now / 1000), started_at: null, completed_at: null, usage: null, error: null };
}
export function asTaskId(id: number): TaskId { return id as TaskId; }
export function asConversationId(id: number): ConversationId { return id as ConversationId; }
