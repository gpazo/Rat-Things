import { Type } from 'typebox';
import type { JsonValue } from '@earendil-works/chord';
import type { NativeCommit, NativeHead, NativeImage } from '../../core/session-native-store.js';
import { parseAgentsContract } from '../../domain/agents-api-validation.js';
import { parseSessionModelSettings, type SessionReplayCommand } from '../../domain/session-execution.js';
import type { PiEffectTool, PiToolEffect } from './protocol.js';

export type PiReplayCommand = Exclude<SessionReplayCommand, { type: 'tool_result' }> | { type: 'tool_result'; turnId?: string; callId: string; success: boolean; output: unknown };
export interface PiRequestValues {
  load: undefined;
  reserve: { count: number; requestId: string };
  commit: NativeCommit;
  projection: { snapshot: { sessionId: string; agentId: string }; seq: number };
  token: undefined;
  effect: PiToolEffect;
  effect_cancel: string;
}
export type PiOpaqueToolResult = Record<string, unknown>;
export type PiOpaqueCheckpoint = Record<string, unknown>;
export interface PiRequestResults {
  load: NativeImage;
  reserve: { first: number; last: number };
  commit: NativeHead;
  projection: void;
  token: string;
  effect: PiOpaqueToolResult;
  effect_cancel: void;
}
export interface PiCommandValues {
  initialize: { launch: unknown; tools: readonly PiEffectTool[]; mode: 'persistent' | 'bounded'; allowedModelIds: readonly string[] };
  replay: PiReplayCommand;
  resume: undefined;
  checkpoint: undefined;
  close: undefined;
}
export interface PiCommandResults { initialize: void; replay: void; resume: void; checkpoint: PiOpaqueCheckpoint; close: void }
type Operations<Values> = { [K in keyof Values]: Values[K] extends undefined ? { method: K; value?: undefined } : { method: K; value: Values[K] } }[keyof Values];
export type PiRequestOperation = Operations<PiRequestValues>;
export type PiCommandOperation = Operations<PiCommandValues>;
export type PiRequest = PiRequestOperation & { kind: 'request'; id: string };
export type PiCommand = PiCommandOperation & { kind: 'command'; id: string };
export type PiReply<K extends 'result' | 'response'> = { kind: K; id: string; ok: false } | { kind: K; id: string; ok: true; value?: unknown };
export type PiChildMessage = PiRequest | PiReply<'result'> | { kind: 'finished' };
export type PiHostMessage = PiCommand | PiReply<'response'>;
export type PiHostOperation = keyof PiRequestValues | 'unsupported';
type InvalidReply<K extends 'result' | 'response'> = { kind: `invalid-${K}`; id: string };
type DecodedChildMessage = PiChildMessage | InvalidReply<'result'> | { kind: 'invalid-request'; id: string; operation: PiHostOperation } | { kind: 'invalid'; kill: boolean };
type DecodedHostMessage = PiHostMessage | InvalidReply<'response'> | { kind: 'invalid-command'; id: string } | { kind: 'ignored' };

export function decodePiChildMessage(value: unknown): DecodedChildMessage {
  if (!record(value)) return { kind: 'invalid', kill: true };
  if (value.kind === 'finished') return { kind: 'finished' };
  if (value.kind === 'result' && typeof value.id === 'string') return reply('result', value);
  if (value.kind !== 'request' || typeof value.id !== 'string') return { kind: 'invalid', kill: false };
  const operation = hostOperation(value.method);
  try { return { kind: 'request', id: value.id, ...decodeRequest(value.method, value.value) }; }
  catch { return { kind: 'invalid-request', id: value.id, operation }; }
}

export function decodePiHostMessage(value: unknown): DecodedHostMessage {
  if (!record(value)) return { kind: 'ignored' };
  if (value.kind === 'response' && typeof value.id === 'string') return reply('response', value);
  if (value.kind !== 'command' || typeof value.id !== 'string') return { kind: 'ignored' };
  try { return { kind: 'command', id: value.id, ...decodeCommand(value.method, value.value) }; }
  catch { return { kind: 'invalid-command', id: value.id }; }
}

function reply<K extends 'result' | 'response'>(kind: K, value: Record<string, unknown>): PiReply<K> | InvalidReply<K> {
  const id = string(value.id);
  if (typeof value.ok !== 'boolean') return { kind: `invalid-${kind}`, id };
  return value.ok ? { kind, id, ok: true, value: value.value } : { kind, id, ok: false };
}
function hostOperation(value: unknown): PiHostOperation {
  switch (value) {
    case 'load': case 'reserve': case 'commit': case 'projection': case 'token': case 'effect': case 'effect_cancel': return value;
    default: return 'unsupported';
  }
}
function decodeRequest(method: unknown, value: unknown): PiRequestOperation {
  switch (method) {
    case 'load': case 'token': return { method };
    case 'reserve': {
      const data = object(value);
      const count = integer(data.count, 1);
      if (count > 65_536) throw invalid();
      return { method, value: { count, requestId: identifier(data.requestId) } };
    }
    case 'commit': return { method, value: nativeCommit(value) };
    case 'projection': {
      const data = object(value); const snapshot = object(data.snapshot);
      return { method, value: { snapshot: { ...snapshot, sessionId: string(snapshot.sessionId), agentId: string(snapshot.agentId) }, seq: integer(data.seq, 0) } };
    }
    case 'effect': {
      const data = object(value);
      if (data.kind !== 'managed' && data.kind !== 'mcp') throw invalid();
      return { method, value: { ...data, kind: data.kind, name: string(data.name), arguments: jsonObject(data.arguments), callId: string(data.callId), taskId: integer(data.taskId, 1), conversationId: integer(data.conversationId, 1) } };
    }
    case 'effect_cancel': return { method, value: string(value) };
    default: throw invalid();
  }
}
function decodeCommand(method: unknown, value: unknown): PiCommandOperation {
  switch (method) {
    case 'resume': case 'checkpoint': case 'close': return { method };
    case 'replay': return { method, value: replay(value) };
    case 'initialize': {
      const data = object(value); const launch = object(data.launch);
      if (object(launch.runtime).kind !== 'pi' || data.mode !== 'persistent' && data.mode !== 'bounded' || !Array.isArray(data.tools) || !Array.isArray(data.allowedModelIds)) throw invalid();
      return { method, value: { launch, tools: data.tools.map(effectTool), mode: data.mode, allowedModelIds: data.allowedModelIds.map(string) } };
    }
    default: throw invalid();
  }
}
function replay(value: unknown): PiReplayCommand {
  const data = object(value);
  switch (data.type) {
    case 'start': return { type: 'start', turn: parseAgentsContract('Turn', data.turn), input: input(data.input), ...(data.settings === undefined ? {} : { settings: parseSessionModelSettings(data.settings) }) };
    case 'steer': return { type: 'steer', turnId: string(data.turnId), input: input(data.input), operationId: string(data.operationId) };
    case 'cancel': return { type: 'cancel', turnId: string(data.turnId) };
    case 'tool_result': {
      if (typeof data.success !== 'boolean') throw invalid();
      return { type: 'tool_result', callId: string(data.callId), success: data.success, output: data.output, ...(data.turnId === undefined ? {} : { turnId: string(data.turnId) }) };
    }
    default: throw invalid();
  }
}
function input(value: unknown) {
  const event = parseAgentsContract('SessionEvents', { events: [{ type: 'agent.session.input.message', input: value }] }).events[0];
  if (event?.type !== 'agent.session.input.message') throw invalid();
  return event.input;
}
function effectTool(value: unknown): PiEffectTool {
  const data = object(value);
  const fields = { ...data, name: string(data.name), description: string(data.description), parameters: Type.Unsafe(object(data.parameters)) };
  if (data.kind === 'managed') return { ...fields, kind: 'managed' };
  if (data.kind === 'mcp') return { ...fields, kind: 'mcp', serverLabel: string(data.serverLabel), toolName: string(data.toolName) };
  throw invalid();
}
function nativeHead(value: unknown): NativeHead {
  const data = object(value); const digest = string(data.digest);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw invalid();
  return { ...data, seq: integer(data.seq, 1), commitId: identifier(data.commitId), digest };
}
function nativeCommit(value: unknown): NativeCommit {
  const data = object(value);
  if (data.schema !== 1 || !Array.isArray(data.writes)) throw invalid();
  const parent = data.parent === null ? null : nativeHead(data.parent);
  const seq = integer(data.seq, 1);
  if (seq !== (parent?.seq ?? 0) + 1) throw invalid();
  return { ...data, schema: 1, commitId: identifier(data.commitId), parent, seq, idHighWater: integer(data.idHighWater, 1), writes: data.writes };
}
const requestResults: { [K in keyof PiRequestResults]: (value: unknown) => PiRequestResults[K] } = {
  load: value => {
    const data = object(value);
    if (!Array.isArray(data.commits)) throw invalid();
    return { ...data, head: data.head === null ? null : nativeHead(data.head), highWater: integer(data.highWater, 1), commits: data.commits.map(nativeCommit) };
  },
  reserve: value => {
    const data = object(value); const first = integer(data.first, 1); const last = integer(data.last, first);
    return { ...data, first, last };
  },
  commit: nativeHead,
  projection: () => undefined,
  token: string,
  effect: object,
  effect_cancel: () => undefined,
};
const commandResults: { [K in keyof PiCommandResults]: (value: unknown) => PiCommandResults[K] } = {
  initialize: () => undefined, replay: () => undefined, resume: () => undefined, close: () => undefined, checkpoint: object,
};
export function decodePiRequestResult<K extends keyof PiRequestResults>(method: K, value: unknown): PiRequestResults[K] { return requestResults[method](value); }
export function decodePiCommandResult<K extends keyof PiCommandResults>(method: K, value: unknown): PiCommandResults[K] { return commandResults[method](value); }
function invalid(): Error { return new Error('Invalid Pi protocol'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function object(value: unknown): Record<string, unknown> { if (!record(value)) throw invalid(); return value; }
function string(value: unknown): string { if (typeof value !== 'string') throw invalid(); return value; }
function identifier(value: unknown): string { const text = string(value); if (!/^[a-zA-Z0-9_-]{1,128}$/.test(text)) throw invalid(); return text; }
function integer(value: unknown, minimum: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid(); return value; }
function jsonValue(value: unknown): value is JsonValue {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
    || Array.isArray(value) && value.every(jsonValue) || record(value) && Object.values(value).every(jsonValue);
}
function jsonObject(value: unknown): Record<string, JsonValue> {
  if (!isJsonObject(value)) throw invalid();
  return value;
}
function isJsonObject(value: unknown): value is Record<string, JsonValue> { return record(value) && Object.values(value).every(jsonValue); }
