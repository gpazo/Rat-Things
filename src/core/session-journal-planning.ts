import type { SessionRuntimeState } from './session-runtime-planning.js';
import type { AgentSessionItem } from '../domain/agents-api.js';
import { canonicalJson } from '../domain/json.js';

/** Only adjacent append deltas to the same part may share a journal write. */
export function runtimeDeltaAddress(previous: SessionRuntimeState, next: SessionRuntimeState): string | undefined {
  const addresses: string[] = [];
  const turns = previous.turns.map((binding, turnIndex) => ({ ...binding, items: binding.items.map((item, itemIndex) => {
    const current = next.turns[turnIndex]?.items[itemIndex];
    if (!current || canonicalJson(item) === canonicalJson(current)) return item;
    const part = appendPart(item, current);
    if (part === undefined) return item;
    addresses.push(JSON.stringify([binding.turn.id, item.id, part]));
    return current;
  }) }));
  return addresses.length === 1 && canonicalJson({ ...previous, turns }) === canonicalJson(next) ? addresses[0] : undefined;
}

function appendPart(previous: AgentSessionItem, next: AgentSessionItem): string | undefined {
  if (!('status' in previous) || previous.status !== 'in_progress') return undefined;
  if (previous.type === 'command_execution' && next.type === 'command_execution' && next.output?.startsWith(previous.output ?? '') && canonicalJson({ ...previous, output: next.output }) === canonicalJson(next)) return 'output';
  if (previous.type === 'message' && next.type === 'message') {
    const changed = next.content.flatMap((part, index) => {
      const before = previous.content[index];
      return part.type === 'output_text' && before?.type === 'output_text' && part.text !== before.text && part.text.startsWith(before.text) ? [index] : [];
    });
    const index = changed[0];
    if (changed.length === 1 && index !== undefined && canonicalJson({ ...previous, content: previous.content.map((part, i) => i === index ? next.content[i] : part) }) === canonicalJson(next)) return `content:${index}`;
  }
  if (previous.type === 'reasoning' && next.type === 'reasoning') {
    const changed = next.summary.flatMap((part, index) => part.text !== previous.summary[index]?.text && part.text.startsWith(previous.summary[index]?.text ?? '') ? [index] : []);
    const index = changed[0];
    if (changed.length === 1 && index !== undefined && canonicalJson({ ...previous, summary: previous.summary.map((part, i) => i === index ? next.summary[i] : part) }) === canonicalJson(next)) return `summary:${index}`;
  }
  return undefined;
}
