import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// The client both AI participants use to join the live Session started by server.ts.
const usage = `Usage: participant.ts <claude|codex> <command>
  transcript              Print attributed messages and Turn status
  say <text> [--reply-to ID] [--typing SECONDS]
  wait [--timeout SECONDS]  Wait until the shared agent is idle
  frame <file.jpg>        Reload the shared browser and save its current image`;
const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'reply-to': { type: 'string' }, typing: { type: 'string' }, timeout: { type: 'string' } } });
const [name, command, ...rest] = positionals;
const directory = resolve(process.env.RAT_THINGS_LOCAL_DIR ?? join(homedir(), '.rat-things', 'multiplayer-demo'));
const connection = JSON.parse(await readFile(join(directory, 'agents-live.json'), 'utf8')) as { url: string; sessionId: string; participants: Record<string, { token: string; label: string }> };
const me = connection.participants[name ?? ''];
if (!me || !command) { console.error(usage); process.exit(2); }
const base = `${connection.url}/api/v1/rat/sessions/${connection.sessionId}`;

async function call<T>(path: string, init: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${me!.token}`,
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.key ? { 'idempotency-key': init.key } : {}) },
  ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}
interface Activity {
  turns: Array<{ id: string; status: string }>;
  items: Array<{ id: string; type: string; role?: string; content?: Array<{ type: string; text?: string }> }>;
  inputs: Array<{ actor: { label?: string }; message_ids: string[]; reply?: { message_id: string } }>;
  pending_inputs?: unknown[];
}
const busy = (activity: Activity) => activity.turns.some(turn => !['completed', 'failed', 'cancelled', 'declined'].includes(turn.status)) || (activity.pending_inputs?.length ?? 0) > 0;

if (command === 'transcript') {
  const activity = await call<Activity>('/activity');
  const authors = new Map(activity.inputs.flatMap(input => input.message_ids.map(id => [id, input] as const)));
  for (const item of activity.items) {
    if (item.type !== 'message' || !item.content) continue;
    const text = item.content.flatMap(part => part.text ? [part.text] : []).join('\n').trim();
    const input = authors.get(item.id);
    const who = item.role === 'assistant' ? 'Shared agent' : input?.actor.label ?? 'Unknown participant';
    console.log(`[${item.id}] ${who}${input?.reply ? ` (replying to ${input.reply.message_id})` : ''}:\n${text}\n`);
  }
  console.log(`Turns: ${activity.turns.map(turn => turn.status).join(', ') || 'none'}${busy(activity) ? ' — agent is working' : ''}`);
} else if (command === 'say') {
  const text = rest.join(' ').trim();
  if (!text) { console.error(usage); process.exit(2); }
  const client = `${name}-${randomUUID().slice(0, 8)}`;
  const seconds = Number(values.typing ?? 2);
  // Typing is a real presence signal; it lets each window show the other participant composing.
  if (seconds > 0) { await call('/typing', { method: 'POST', body: { client_id: client, sequence: 1, typing: true } }); await delay(seconds * 1000); }
  await call('/messages', { method: 'POST', key: randomUUID(), body: { text, ...(values['reply-to'] ? { reply_to: values['reply-to'] } : {}) } });
  if (seconds > 0) await call('/typing', { method: 'POST', body: { client_id: client, sequence: 2, typing: false } });
  console.log('sent');
} else if (command === 'wait') {
  const deadline = Date.now() + Number(values.timeout ?? 600) * 1000;
  await delay(1500);
  while (busy(await call<Activity>('/activity'))) {
    if (Date.now() > deadline) { console.error('Timed out waiting for the shared agent.'); process.exit(1); }
    await delay(1000);
  }
  console.log('idle');
} else if (command === 'frame') {
  let frame = await call<{ epoch: number; revision: number }>('/workspace/browser');
  await call('/workspace/browser', { method: 'POST', key: randomUUID(), body: { epoch: frame.epoch, revision: frame.revision, operation: { action: 'reload' } } });
  await delay(1500);
  const image = await call<{ image: string; title?: string }>('/workspace/browser');
  await writeFile(rest[0] ?? 'frame.jpg', Buffer.from(image.image, 'base64'));
  console.log(`saved ${image.title ?? ''}`);
} else { console.error(usage); process.exit(2); }
