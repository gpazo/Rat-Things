import type { JsonValue } from '../domain/contracts.js';
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
    try {
      const call = dynamicToolCall(request.params);
      if (call.namespace === BROWSER_TOOL_NAMESPACE) {
        if (!options.browser) throw new Error('browser tools are not enabled');
        return await options.browser.call(call, options.signal);
      }
      if (!options.integrations) throw new Error('integration tools are not enabled');
      const result = await options.integrations.call(call, options.signal);
      return {
        success: true,
        contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        success: false,
        contentItems: [{
          type: 'inputText',
          text: error instanceof Error ? error.message.slice(0, 2_000) : 'dynamic tool failed',
        }],
      };
    }
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
