import type {
  AgentRuntimeEventRecord,
  AgentRuntimeSnapshot,
  PendingAgentRequest,
} from '../domain/interaction.js';

export type PublicAgentActivityKind =
  | 'agent'
  | 'message'
  | 'reasoning'
  | 'command'
  | 'file'
  | 'tool'
  | 'web_search'
  | 'computer'
  | 'plan'
  | 'compaction'
  | 'usage'
  | 'error'
  | 'activity';

export type PublicAgentActivityStatus =
  | 'started'
  | 'updated'
  | 'completed'
  | 'failed'
  | 'info';

export interface PublicAgentActivity {
  sequence: number;
  occurredAt: string;
  kind: PublicAgentActivityKind;
  status: PublicAgentActivityStatus;
  title: string;
  detail?: string;
}

export interface PublicPendingAgentRequest {
  requestId: string;
  kind: 'input' | 'authentication' | 'tool' | 'other';
  title: string;
  detail?: string;
  receivedAt: string;
  questions?: PublicAgentQuestion[];
}

export interface PublicAgentQuestion {
  id: string;
  header?: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: Array<{ label: string; description?: string }>;
}

export interface PublicAgentRuntimeSnapshot {
  runId: string;
  active: boolean;
  ready: boolean;
  oldestSequence: number;
  nextSequence: number;
  events: PublicAgentActivity[];
  pendingRequests: PublicPendingAgentRequest[];
}

/**
 * Converts provider/App Server protocol traffic into a stable product contract.
 * Raw methods, parameters, prompts, commands, results, and native thread IDs stay private.
 */
export function projectPublicAgentRuntime(
  snapshot: AgentRuntimeSnapshot,
): PublicAgentRuntimeSnapshot {
  return {
    runId: snapshot.runId,
    active: snapshot.active,
    ready: snapshot.ready,
    oldestSequence: snapshot.oldestSequence,
    nextSequence: snapshot.nextSequence,
    events: snapshot.events.map(projectEvent),
    pendingRequests: snapshot.pendingRequests.map(projectPendingRequest),
  };
}

function projectEvent(event: AgentRuntimeEventRecord): PublicAgentActivity {
  const base = { sequence: event.sequence, occurredAt: event.occurredAt };
  if (event.method === 'turn/started') {
    return { ...base, kind: 'agent', status: 'started', title: 'Agent turn started' };
  }
  if (event.method === 'turn/completed') {
    const turn = record(event.params.turn);
    const status = turn?.status;
    return status === 'failed'
      ? { ...base, kind: 'error', status: 'failed', title: 'Agent turn failed' }
      : status === 'interrupted'
        ? { ...base, kind: 'agent', status: 'completed', title: 'Agent turn interrupted' }
        : { ...base, kind: 'agent', status: 'completed', title: 'Agent turn completed' };
  }
  if (event.method === 'error') {
    return { ...base, kind: 'error', status: 'failed', title: 'Agent runtime error' };
  }
  if (event.method === 'thread/tokenUsage/updated') {
    const usage = record(record(event.params.tokenUsage)?.last);
    const detail = usageDetail(usage);
    return {
      ...base,
      kind: 'usage',
      status: 'updated',
      title: 'Context usage updated',
      ...(detail ? { detail } : {}),
    };
  }
  if (event.method === 'turn/plan/updated' || event.method === 'item/plan/delta') {
    const plan = Array.isArray(event.params.plan) ? event.params.plan : undefined;
    return {
      ...base,
      kind: 'plan',
      status: 'updated',
      title: 'Plan updated',
      ...(plan ? { detail: `${plan.length} step${plan.length === 1 ? '' : 's'}` } : {}),
    };
  }
  if (event.method === 'turn/diff/updated' || event.method === 'item/fileChange/outputDelta') {
    return { ...base, kind: 'file', status: 'updated', title: 'File changes updated' };
  }
  if (event.method === 'item/agentMessage/delta') {
    return { ...base, kind: 'message', status: 'updated', title: 'Writing response' };
  }
  if (event.method.startsWith('item/reasoning/')) {
    return { ...base, kind: 'reasoning', status: 'updated', title: 'Reasoning updated' };
  }
  if (
    event.method === 'command/exec/outputDelta' ||
    event.method === 'item/commandExecution/outputDelta' ||
    event.method === 'item/commandExecution/terminalInteraction'
  ) {
    return { ...base, kind: 'command', status: 'updated', title: 'Command running' };
  }
  if (event.method === 'item/mcpToolCall/progress') {
    return { ...base, kind: 'tool', status: 'updated', title: 'Tool call running' };
  }
  if (event.method === 'thread/compacted') {
    return { ...base, kind: 'compaction', status: 'completed', title: 'Context compacted' };
  }
  if (event.method === 'item/started' || event.method === 'item/completed') {
    return projectItem(event, event.method === 'item/started' ? 'started' : 'completed');
  }
  if (event.method === 'hook/started' || event.method === 'hook/completed') {
    return {
      ...base,
      kind: 'activity',
      status: event.method.endsWith('/started') ? 'started' : 'completed',
      title: event.method.endsWith('/started') ? 'Automation started' : 'Automation completed',
    };
  }
  if (event.method === 'serverRequest/resolved') {
    return { ...base, kind: 'activity', status: 'completed', title: 'Requested input received' };
  }
  return { ...base, kind: 'activity', status: 'info', title: 'Agent activity' };
}

function projectItem(
  event: AgentRuntimeEventRecord,
  lifecycle: 'started' | 'completed',
): PublicAgentActivity {
  const base = { sequence: event.sequence, occurredAt: event.occurredAt };
  const item = record(event.params.item);
  const type = typeof item?.type === 'string' ? item.type : 'unknown';
  const status = itemStatus(item, lifecycle);
  switch (type) {
    case 'userMessage':
      return { ...base, kind: 'message', status, title: 'Message received' };
    case 'agentMessage':
      return {
        ...base,
        kind: 'message',
        status,
        title: lifecycle === 'started' ? 'Drafting response' : 'Response completed',
      };
    case 'reasoning':
      return {
        ...base,
        kind: 'reasoning',
        status,
        title: lifecycle === 'started' ? 'Reasoning started' : 'Reasoning completed',
      };
    case 'plan':
      return { ...base, kind: 'plan', status, title: 'Plan updated' };
    case 'commandExecution': {
      const detail = executionDetail(item);
      return {
        ...base,
        kind: 'command',
        status,
        title: status === 'failed'
          ? 'Command failed'
          : lifecycle === 'started' ? 'Command started' : 'Command completed',
        ...(detail ? { detail } : {}),
      };
    }
    case 'fileChange': {
      const changes = Array.isArray(item?.changes) ? item.changes.length : undefined;
      return {
        ...base,
        kind: 'file',
        status,
        title: status === 'failed'
          ? 'File changes failed'
          : lifecycle === 'started' ? 'Editing files' : 'File changes applied',
        ...(changes !== undefined
          ? { detail: `${changes} file${changes === 1 ? '' : 's'}` }
          : {}),
      };
    }
    case 'mcpToolCall':
      return toolActivity(base, item, lifecycle, status, 'MCP tool');
    case 'dynamicToolCall':
      return toolActivity(base, item, lifecycle, status, 'Integration tool');
    case 'collabAgentToolCall':
      return {
        ...base,
        kind: 'tool',
        status,
        title: lifecycle === 'started' ? 'Sub-agent task started' : 'Sub-agent task completed',
      };
    case 'webSearch':
      return {
        ...base,
        kind: 'web_search',
        status,
        title: lifecycle === 'started' ? 'Web search started' : 'Web search completed',
      };
    case 'imageView':
      return { ...base, kind: 'computer', status, title: 'Image inspected' };
    case 'imageGeneration':
      return {
        ...base,
        kind: 'computer',
        status,
        title: lifecycle === 'started' ? 'Generating image' : 'Image generated',
      };
    case 'contextCompaction':
      return {
        ...base,
        kind: 'compaction',
        status,
        title: lifecycle === 'started' ? 'Compacting context' : 'Context compacted',
      };
    case 'enteredReviewMode':
      return { ...base, kind: 'activity', status, title: 'Review started' };
    case 'exitedReviewMode':
      return { ...base, kind: 'activity', status, title: 'Review completed' };
    default:
      return { ...base, kind: 'activity', status, title: 'Agent activity' };
  }
}

function projectPendingRequest(request: PendingAgentRequest): PublicPendingAgentRequest {
  if (request.method.includes('requestUserInput') || request.method.includes('elicitation')) {
    const questions = projectQuestions(request.params.questions);
    return {
      requestId: request.requestId,
      kind: 'input',
      title: 'Agent needs input',
      receivedAt: request.receivedAt,
      ...(questions.length ? { questions } : {}),
    };
  }
  if (request.method.toLowerCase().includes('oauth') || request.method.includes('authentication')) {
    return {
      requestId: request.requestId,
      kind: 'authentication',
      title: 'Authentication required',
      receivedAt: request.receivedAt,
    };
  }
  if (request.method.includes('tool')) {
    return {
      requestId: request.requestId,
      kind: 'tool',
      title: 'Tool needs input',
      receivedAt: request.receivedAt,
    };
  }
  return {
    requestId: request.requestId,
    kind: 'other',
    title: 'Agent needs input',
    receivedAt: request.receivedAt,
  };
}

function projectQuestions(value: unknown): PublicAgentQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((candidate) => {
    const input = record(candidate);
    const id = boundedCopy(input?.id, 128);
    const question = boundedCopy(input?.question, 2_000);
    if (!id || !question) return [];
    const rawOptions = Array.isArray(input?.options) ? input.options : [];
    const options = rawOptions.slice(0, 12).flatMap((option) => {
      const projected = record(option);
      const label = boundedCopy(projected?.label, 256);
      if (!label) return [];
      const description = boundedCopy(projected?.description, 1_000);
      return [{ label, ...(description ? { description } : {}) }];
    });
    const header = boundedCopy(input?.header, 256);
    return [{
      id,
      ...(header ? { header } : {}),
      question,
      isOther: input?.isOther === true,
      isSecret: input?.isSecret === true,
      ...(options.length ? { options } : {}),
    }];
  });
}

function toolActivity(
  base: Pick<PublicAgentActivity, 'sequence' | 'occurredAt'>,
  item: Record<string, unknown> | undefined,
  lifecycle: 'started' | 'completed',
  status: PublicAgentActivityStatus,
  fallback: string,
): PublicAgentActivity {
  const tool = safeLabel(item?.tool);
  const label = tool ? `${fallback}: ${tool}` : fallback;
  return {
    ...base,
    kind: 'tool',
    status,
    title: status === 'failed'
      ? `${label} failed`
      : lifecycle === 'started' ? `${label} started` : `${label} completed`,
    ...durationDetail(item),
  };
}

function itemStatus(
  item: Record<string, unknown> | undefined,
  lifecycle: 'started' | 'completed',
): PublicAgentActivityStatus {
  const status = item?.status;
  return status === 'failed' || status === 'declined'
    ? 'failed'
    : lifecycle;
}

function executionDetail(item: Record<string, unknown> | undefined): string | undefined {
  const parts: string[] = [];
  if (typeof item?.exitCode === 'number') parts.push(`exit ${item.exitCode}`);
  if (typeof item?.durationMs === 'number') parts.push(formatDuration(item.durationMs));
  return parts.length ? parts.join(' · ') : undefined;
}

function durationDetail(item: Record<string, unknown> | undefined): { detail?: string } {
  return typeof item?.durationMs === 'number'
    ? { detail: formatDuration(item.durationMs) }
    : {};
}

function usageDetail(usage: Record<string, unknown> | undefined): string | undefined {
  const input = number(usage?.inputTokens);
  const output = number(usage?.outputTokens);
  if (input === undefined && output === undefined) return undefined;
  return [
    ...(input === undefined ? [] : [`${input.toLocaleString('en-US')} input`]),
    ...(output === undefined ? [] : [`${output.toLocaleString('en-US')} output`]),
  ].join(' · ');
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000
    ? `${Math.max(0, Math.round(milliseconds))} ms`
    : `${(milliseconds / 1_000).toFixed(1)} s`;
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/[^A-Za-z0-9._:/-]/g, ' ').replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 80) : undefined;
}

function boundedCopy(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
