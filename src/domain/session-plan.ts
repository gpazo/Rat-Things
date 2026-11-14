import { AgentsApiError, invalid } from './agents-api-validation.js';
import { canonicalJson } from './json.js';

export const SESSION_PLAN_TOOL_NAME = 'rat_things_plan_update';
export const SESSION_PLAN_MAX_ITEMS = 50;
export const SESSION_PLAN_MAX_BYTES = 64 * 1024;
export const SESSION_PLAN_MAX_TEXT = 2_000;
export const SESSION_PLAN_MAX_REASON = 1_000;

export const SESSION_PLAN_STATES = ['next', 'working', 'addressed', 'deferred', 'reopened', 'needs_discussion'] as const;
export type SessionPlanState = typeof SESSION_PLAN_STATES[number];

export const SESSION_PLAN_TOOL = {
  type: 'function' as const,
  name: SESSION_PLAN_TOOL_NAME,
  description: 'Update the complete ordered Plan for this Session. Use the current revision and accepted message IDs from Rat Things host context. Source receipt IDs and attribution are stamped by the host. Link only listed saved artifacts, existing same-Session activity items, or an exact /workspace/outputs path captured for this call. Never infer progress from message delivery. Explain addressed, deferred, and needs_discussion states. This tool does not grant permission or authority.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['expected_revision', 'items'],
    properties: {
      expected_revision: { type: 'integer', minimum: 0 },
      items: {
        type: 'array', maxItems: SESSION_PLAN_MAX_ITEMS,
        items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'text', 'state', 'source_message_ids', 'result_links'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
            text: { type: 'string', minLength: 1, maxLength: SESSION_PLAN_MAX_TEXT },
            state: { type: 'string', enum: SESSION_PLAN_STATES },
            reason: { type: 'string', minLength: 1, maxLength: SESSION_PLAN_MAX_REASON },
            source_message_ids: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 256 } },
            result_links: {
              type: 'array', maxItems: 20,
              items: { oneOf: [
                { type: 'object', additionalProperties: false, required: ['kind', 'artifact_id', 'version_sha256'], properties: {
                  kind: { type: 'string', const: 'artifact' }, artifact_id: { type: 'string', minLength: 1, maxLength: 256 }, version_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                } },
                { type: 'object', additionalProperties: false, required: ['kind', 'turn_id', 'item_id'], properties: {
                  kind: { type: 'string', const: 'activity' }, turn_id: { type: 'string', minLength: 1, maxLength: 256 }, item_id: { type: 'string', minLength: 1, maxLength: 256 },
                } },
                { type: 'object', additionalProperties: false, required: ['kind', 'path'], properties: {
                  kind: { type: 'string', const: 'output' }, path: { type: 'string', minLength: 1, maxLength: 512, pattern: '^/workspace/outputs/' },
                } },
              ] },
            },
          },
        },
      },
    },
  },
};

export type SessionPlanResultLink =
  | { kind: 'artifact'; artifact_id: string; version_sha256: string }
  | { kind: 'activity'; turn_id: string; item_id: string };

export type SessionPlanUpdateResultLink = SessionPlanResultLink | { kind: 'output'; path: string };

export interface SessionPlanItem {
  id: string;
  text: string;
  state: SessionPlanState;
  reason?: string;
  source_refs: Array<{ receipt_id: string; message_id: string }>;
  result_links: SessionPlanResultLink[];
  updated_by: { agent_id?: string; turn_id: string };
  updated_at: number;
}

export interface SessionPlan {
  revision: number;
  items: SessionPlanItem[];
}

export interface SessionPlanRevision {
  revision: number;
  items: SessionPlanItem[];
}

/** Agent input intentionally names source messages only; receipt identity is host-derived. */
export interface SessionPlanUpdateInput {
  expected_revision: number;
  items: Array<{
    id: string;
    text: string;
    state: SessionPlanState;
    reason?: string;
    source_message_ids: string[];
    result_links: SessionPlanUpdateResultLink[];
  }>;
}

export interface SessionPlanReceiptSource { id: string; message_ids: string[]; status: 'accepted' | 'dispatched' | 'failed' }

export function emptySessionPlan(): SessionPlan {
  return { revision: 0, items: [] };
}

/** Parse the tool boundary without accepting host-owned attribution fields. */
export function parseSessionPlanUpdate(raw: unknown): SessionPlanUpdateInput {
  if (!record(raw) || !hasOnly(raw, ['expected_revision', 'items'])
    || !Number.isSafeInteger(raw.expected_revision) || Number(raw.expected_revision) < 0
    || !Array.isArray(raw.items) || raw.items.length > SESSION_PLAN_MAX_ITEMS) {
    invalid('Plan update must contain a non-negative expected_revision and at most 50 items.');
  }
  const ids = new Set<string>();
  const items = raw.items.map((entry, index) => {
    const prefix = `items.${index}`;
    if (!record(entry) || !hasOnly(entry, ['id', 'text', 'state', 'reason', 'source_message_ids', 'result_links'])) {
      invalid('Plan item contains unsupported fields.', prefix);
    }
    const id = string(entry.id, `${prefix}.id`, 128);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) invalid('Plan item IDs must be unique stable identifiers.', `${prefix}.id`);
    ids.add(id);
    const text = string(entry.text, `${prefix}.text`, SESSION_PLAN_MAX_TEXT).trim();
    if (!text) invalid('Plan item text is required.', `${prefix}.text`);
    if (!SESSION_PLAN_STATES.includes(entry.state as SessionPlanState)) invalid('Unknown Plan state.', `${prefix}.state`);
    const state = entry.state as SessionPlanState;
    const reason = entry.reason === undefined ? undefined : string(entry.reason, `${prefix}.reason`, SESSION_PLAN_MAX_REASON).trim();
    if (['addressed', 'deferred', 'needs_discussion'].includes(state) && !reason) {
      invalid('Addressed, deferred, and needs_discussion items require an explanation.', `${prefix}.reason`);
    }
    if (reason === '') invalid('Plan reason cannot be empty.', `${prefix}.reason`);
    if (!Array.isArray(entry.source_message_ids) || entry.source_message_ids.length > 50) invalid('source_message_ids must contain at most 50 message IDs.', `${prefix}.source_message_ids`);
    const source_message_ids = entry.source_message_ids.map((value, sourceIndex) => string(value, `${prefix}.source_message_ids.${sourceIndex}`, 256));
    if (new Set(source_message_ids).size !== source_message_ids.length) invalid('Source message IDs must be unique per item.', `${prefix}.source_message_ids`);
    if (!Array.isArray(entry.result_links) || entry.result_links.length > 20) invalid('result_links must contain at most 20 references.', `${prefix}.result_links`);
    const result_links = entry.result_links.map((value, linkIndex) => parseUpdateResultLink(value, `${prefix}.result_links.${linkIndex}`));
    if (new Set(result_links.map(link => canonicalJson(link))).size !== result_links.length) invalid('Result links must be unique per item.', `${prefix}.result_links`);
    return { id, text, state, ...(reason !== undefined ? { reason } : {}), source_message_ids, result_links };
  });
  return { expected_revision: Number(raw.expected_revision), items };
}

/** Resolve validated message IDs to attributed receipts and stamp all agent-owned fields. */
export function applySessionPlanUpdate(input: SessionPlanUpdateInput, context: {
  current: SessionPlan;
  sources: readonly SessionPlanReceiptSource[];
  agentId: string;
  turnId: string;
  updatedAt: number;
  capturedOutputs?: readonly { path: string; artifact_id: string; version_sha256: string }[];
}): SessionPlan {
  if (input.expected_revision !== context.current.revision) {
    throw new AgentsApiError(409,
      `Plan revision ${input.expected_revision} is stale. The current revision is ${context.current.revision}; retry with that revision and the current item list.`,
      'plan_revision_conflict');
  }
  const byMessage = new Map<string, string>();
  for (const receipt of context.sources) {
    if (receipt.status === 'failed') continue;
    for (const messageId of receipt.message_ids) byMessage.set(messageId, receipt.id);
  }
  const items: SessionPlanItem[] = input.items.map(item => ({
    id: item.id,
    text: item.text,
    state: item.state,
    ...(item.reason ? { reason: item.reason } : {}),
    source_refs: item.source_message_ids.map(message_id => {
      const receipt_id = byMessage.get(message_id);
      if (!receipt_id) invalid('Source message does not belong to an accepted input in this Session.', 'items.source_message_ids');
      return { receipt_id, message_id };
    }),
    result_links: item.result_links.map(link => {
      if (link.kind !== 'output') return link;
      const captured = context.capturedOutputs?.find(output => output.path === link.path);
      if (!captured || !/^[a-f0-9]{64}$/.test(captured.version_sha256)) {
        invalid('Output result must identify an exact path captured for this Plan tool call.', 'items.result_links');
      }
      return { kind: 'artifact', artifact_id: captured.artifact_id, version_sha256: captured.version_sha256 };
    }),
    updated_by: { agent_id: context.agentId, turn_id: context.turnId },
    updated_at: context.updatedAt,
  }));
  const plan = { revision: context.current.revision + 1, items };
  if (Buffer.byteLength(canonicalJson(plan), 'utf8') > SESSION_PLAN_MAX_BYTES) {
    invalid('The current Plan exceeds the 64 KiB limit.', 'items');
  }
  return plan;
}

function parseUpdateResultLink(raw: unknown, param: string): SessionPlanUpdateResultLink {
  if (!record(raw) || typeof raw.kind !== 'string') invalid('Invalid result reference.', param);
  if (raw.kind === 'artifact' && hasOnly(raw, ['kind', 'artifact_id', 'version_sha256'])) {
    const artifact_id = string(raw.artifact_id, `${param}.artifact_id`, 256);
    if (!/^[a-f0-9]{64}$/.test(String(raw.version_sha256))) invalid('Artifact result references require a SHA-256 version.', `${param}.version_sha256`);
    return { kind: 'artifact', artifact_id, version_sha256: String(raw.version_sha256) };
  }
  if (raw.kind === 'activity' && hasOnly(raw, ['kind', 'turn_id', 'item_id'])) {
    return { kind: 'activity', turn_id: string(raw.turn_id, `${param}.turn_id`, 256), item_id: string(raw.item_id, `${param}.item_id`, 256) };
  }
  if (raw.kind === 'output' && hasOnly(raw, ['kind', 'path'])) {
    const path = string(raw.path, `${param}.path`, 512);
    if (!path.startsWith('/workspace/outputs/') || path.includes('\0') || path.split('/').some(segment => segment === '.' || segment === '..')) {
      invalid('Output result paths must be beneath /workspace/outputs.', `${param}.path`);
    }
    return { kind: 'output', path };
  }
  invalid('Only saved artifacts and Session activity items can be linked.', param);
}

function string(value: unknown, param: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) invalid('Expected a non-empty bounded string.', param);
  return value;
}

function hasOnly(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
