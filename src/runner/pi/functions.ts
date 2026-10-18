import { awaitWithContext } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import type { TSchema } from '@earendil-works/pi-ai';
import { defineTool, type DocumentObserver, type DocumentReader, type Session, type SessionDocToken, type JsonObject, type ToolRegistration } from '@earendil-works/pi-durable';
import { canonicalJson } from '../../domain/json.js';
import type { SessionLaunch } from '../../domain/session-execution.js';
import { FunctionsDoc, PI_CONTEXT, activeTurn, json, piInput, publicCallId, type PiFunctionResult } from './protocol.js';

export async function waitForDocument<T extends JsonObject, R>(reader: DocumentObserver & DocumentReader, token: SessionDocToken<T>, select: (value: Readonly<T>) => R | undefined, context: Context): Promise<R> {
  const watch = await reader.watchDoc(token, context);
  if (!watch) throw new Error(`Missing durable document ${token.definition.kind}`);
  try {
    const initial = watch.value === null ? undefined : select(watch.value);
    if (initial !== undefined) return initial;
    const result = new Promise<R>((resolve, reject) => {
      watch.start(async value => { if (value !== null) { const found = select(value); if (found !== undefined) resolve(found); } });
      void watch.closed.then(end => reject(new Error(`Pi document wait ended: ${end.reason}`)));
    });
    return await awaitWithContext(result, context);
  } finally { await watch.stop(); }
}

export function functionTools(launch: SessionLaunch): ToolRegistration[] {
  return launch.agent.tools.filter(tool => tool.type === 'function').map(tool => defineTool({
    name: tool.name, description: tool.description ?? '', parameters: tool.parameters as TSchema, replay: 'safe',
    execute: async (args, api, context) => {
      const callId = publicCallId(api.taskId);
      await api.commit(async tx => {
        const turn = await activeTurn(tx, api.conversationId);
        const functions = await tx.doc(FunctionsDoc);
        if (!functions.calls[callId]) functions.calls[callId] = { taskId: api.taskId, conversationId: api.conversationId, turnId: turn.turn.id, name: tool.name, arguments: json(args) };
      }, context);
      const result = await waitForDocument(api, FunctionsDoc, value => value.calls[callId]?.result, context);
      const output = typeof result.output === 'string' ? [{ type: 'text' as const, text: result.output }]
        : Array.isArray(result.output) ? piInput([{ role: 'user', content: result.output as unknown as Parameters<typeof piInput>[0][number]['content'] }])
          : [{ type: 'text' as const, text: result.success ? JSON.stringify(result.output ?? null) : result.error ?? 'Function failed' }];
      return { output: typeof output === 'string' ? [{ type: 'text', text: output }] : output, isError: !result.success };
    },
  }));
}

export async function resolvePiFunction(session: Session, callId: string, result: PiFunctionResult): Promise<void> {
  const value = json(result);
  await session.commit(async tx => {
    const functions = await tx.doc(FunctionsDoc);
    const call = functions.calls[callId];
    if (!call) throw new Error('Unknown Pi function call');
    if (call.result) {
      if (canonicalJson(call.result) !== canonicalJson(value)) throw new Error('Pi function result already committed with different content');
      return;
    }
    call.result = value;
  }, PI_CONTEXT);
}
