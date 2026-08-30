import type { AgentToolCallStore } from '../core/ports.js';
import type { JsonValue } from '../domain/contracts.js';
import { canonicalJson, sha256Hex } from '../domain/json.js';
import type { ExecutionReference } from '../domain/contracts.js';
import type { IntegrationToolSession } from '../plugins/integration-types.js';
import type {
  CodexAppServerInitiatedRequest,
} from './codex-app-server.js';
import {
  BROWSER_TOOL_NAMESPACE,
  type BrowserToolSession,
} from './browser.js';

export interface DynamicToolRequestHandlerOptions {
  browser?: Pick<BrowserToolSession, 'call'>;
  integrations?: Pick<IntegrationToolSession, 'call'>;
  signal?: AbortSignal;
  fallback?: (request: CodexAppServerInitiatedRequest) => unknown | Promise<unknown>;
  ledger?: {
    store: AgentToolCallStore;
    runId: string;
    execution: ExecutionReference;
    admittedToolsDigest: string;
    now?: () => Date;
  };
}

/**
 * Routes Codex app-server dynamic tool requests to trusted host capabilities.
 * Credentials remain behind the integration session and never enter JSON-RPC.
 */
export function createDynamicToolRequestHandler(
  options: DynamicToolRequestHandlerOptions,
): (request: CodexAppServerInitiatedRequest) => Promise<unknown> {
  return async (request) => {
    if (request.method !== 'item/tool/call') {
      if (options.fallback) return options.fallback(request);
      throw new Error(`unsupported server request: ${request.method}`);
    }
    let call: ReturnType<typeof dynamicToolCall>;
    try {
      call = dynamicToolCall(request.params);
    } catch (error) {
      return failedToolResult(error);
    }
    const requestId = String(request.requestId);
    if (!requestId || Buffer.byteLength(requestId, 'utf8') > 256) {
      return failedToolResult(new Error('dynamic tool request ID is invalid'));
    }
    if (options.ledger) {
      const generation = options.ledger.execution.generation;
      if (!generation) throw new Error('dynamic tool ledger requires an execution generation');
      await options.ledger.store.beginAgentToolCall({
        version: '1',
        runId: options.ledger.runId,
        requestId,
        method: 'item/tool/call',
        executionId: options.ledger.execution.id,
        executionGeneration: generation,
        namespace: call.namespace,
        tool: call.tool,
        argumentDigest: digestJson(call.arguments),
        admittedToolsDigest: options.ledger.admittedToolsDigest,
        status: 'pending',
        startedAt: (options.ledger.now ?? (() => new Date()))().toISOString(),
      });
    }
    let result: unknown;
    try {
      if (call.namespace === BROWSER_TOOL_NAMESPACE) {
        if (!options.browser) throw new Error('browser tools are not enabled');
        result = await options.browser.call(call, options.signal);
      } else {
        if (!options.integrations) throw new Error('integration tools are not enabled');
        const integrationResult = await options.integrations.call(call, options.signal);
        result = {
          success: true,
          contentItems: [{ type: 'inputText', text: JSON.stringify(integrationResult) }],
        };
      }
    } catch (error) {
      result = failedToolResult(error);
    }
    if (options.ledger) {
      const failed = isFailedToolResult(result);
      await options.ledger.store.settleAgentToolCall({
        runId: options.ledger.runId,
        execution: options.ledger.execution,
        requestId,
        status: failed ? 'failed' : 'succeeded',
        settledAt: (options.ledger.now ?? (() => new Date()))().toISOString(),
        resultDigest: digestJson(result),
        ...(failed ? { error: failedToolMessage(result) } : {}),
      });
    }
    return result;
  };
}

export function dynamicToolCall(params: Record<string, unknown>): {
  namespace: string | null;
  tool: string;
  arguments: JsonValue;
} {
  const namespace = params.namespace;
  if (namespace !== null && typeof namespace !== 'string') {
    throw new Error('dynamic tool namespace is invalid');
  }
  if (typeof params.tool !== 'string' || !params.tool) {
    throw new Error('dynamic tool name is invalid');
  }
  assertJson(params.arguments, 'dynamic tool arguments');
  return { namespace, tool: params.tool, arguments: params.arguments };
}

function assertJson(value: unknown, label: string): asserts value is JsonValue {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded) > 128 * 1024) throw new Error();
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function failedToolResult(error: unknown): {
  success: false;
  contentItems: Array<{ type: 'inputText'; text: string }>;
} {
  return {
    success: false,
    contentItems: [{
      type: 'inputText',
      text: error instanceof Error ? error.message.slice(0, 2_000) : 'dynamic tool failed',
    }],
  };
}

function isFailedToolResult(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (
    value as Record<string, unknown>
  ).success === false);
}

function failedToolMessage(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'dynamic tool failed';
  const items = (value as Record<string, unknown>).contentItems;
  if (!Array.isArray(items)) return 'dynamic tool failed';
  const first = items[0];
  return first && typeof first === 'object' && !Array.isArray(first) &&
    typeof (first as Record<string, unknown>).text === 'string'
    ? String((first as Record<string, unknown>).text).slice(0, 500)
    : 'dynamic tool failed';
}

function digestJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
