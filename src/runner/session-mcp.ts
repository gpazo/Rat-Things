import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SessionLaunch } from '../domain/session-execution.js';
import type { SecretReader } from '../credentials/types.js';
import { parseSessionToolSecret } from '../credentials/session-tools.js';
import { parseAgentsContract } from '../domain/agents-api-validation.js';
import { credentialUrl } from '../domain/vault-planning.js';
import type { VaultService } from '../core/vault-service.js';
import environmentMcpWorkerSource from './environment-mcp-worker-source.json' with { type: 'json' };
import type { McpAuthorization, McpCredentialEvidence } from '../domain/tool-authorization.js';
import { sha256Hex } from '../domain/json.js';
import { MAX_TOOL_AUTHORIZATIONS } from '../core/tool-authorization-service.js';
import { safeToolLabel, type ToolAuthorizationOperation } from '../core/tool-authorization-planning.js';
import { dispatchAuditedMcp, type SessionMcpAudit } from './session-mcp-authorization.js';
import { hostedCodexArguments } from './hosted-environment-planning.js';
import type { SessionEnvironmentCredentialsRuntime } from './session-environment-credentials.js';

export interface SessionMcpRuntime {
  servers: Record<string, unknown>;
  environment: Record<string, string>;
  close(): Promise<void>;
}

/** Resolve credentials in the trusted host, then admit exactly the configured MCP tools. */
export async function prepareSessionMcp(ownerId: string, launch: SessionLaunch, secrets: SecretReader, signal?: AbortSignal, vaults?: Pick<VaultService, 'authorization'> & { authorizeMcp?: (owner: string, vault: string, id: string, url: string, rejected?: string) => Promise<McpAuthorization> }, credentials?: SessionEnvironmentCredentialsRuntime, rememberSecrets?: (secrets: readonly string[]) => void, audit?: SessionMcpAudit): Promise<SessionMcpRuntime> {
  if (audit && (audit.ownerId !== ownerId || audit.identity.sessionId !== launch.sessionId)) throw new Error('MCP audit identity is invalid');
  const servers: Record<string, unknown> = {};
  const environment: Record<string, string> = {};
  const closers: Array<() => Promise<void>> = [];
  try {
    for (const [index, tool] of launch.agent.tools.entries()) {
      if (tool.type !== 'mcp') continue;
      const binding = launch.mcp?.find((binding) => binding.serverLabel === tool.server_label);
      const inline = binding?.inlineReference ? parseSessionToolSecret(await secrets.get(binding.inlineReference), { ownerId, sessionId: launch.sessionId, serverLabel: tool.server_label }) : undefined;
      let headers = { ...inline?.headers };
      let authorization: ((rejectedToken?: string) => Promise<string>) | undefined;
      let authorize: ((rejectedToken?: string) => Promise<McpAuthorization>) | undefined;
      if (binding?.vaultReference) {
        if (tool.transport.type !== 'http' || tool.connection_origin !== 'service') throw new Error('MCP credential destination is invalid');
        if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) throw new Error('MCP authorization must have exactly one source');
        if (vaults && binding.vaultId && binding.credentialId) {
          const serverURL = tool.transport.server_url;
          if (audit) {
            if (!vaults.authorizeMcp) throw new Error('MCP credential evidence is unavailable');
            authorize = async (rejected) => {
              const value = await vaults.authorizeMcp!(ownerId, binding.vaultId!, binding.credentialId!, serverURL, rejected);
              rememberSecrets?.([value.authorization, value.authorization.replace(/^Bearer\s+/i, '')]);
              return value;
            };
          }
          authorization = async (rejected) => {
            const value = await vaults.authorization(ownerId, binding.vaultId!, binding.credentialId!, serverURL, rejected);
            rememberSecrets?.([value, value.replace(/^Bearer\s+/i, '')]);
            return value;
          };
        } else {
          if (audit) throw new Error('MCP credential evidence is unavailable');
          const auth = parseAgentsContract('CredentialCreate', { name: 'runtime', auth: JSON.parse(await secrets.get(binding.vaultReference)) }).auth;
          if (auth.type === 'environment_variable' || credentialUrl(auth.mcp_server_url) !== credentialUrl(tool.transport.server_url)) throw new Error('MCP credential destination is invalid');
          if (auth.type === 'mcp_oauth' && auth.expires_at && Date.parse(auth.expires_at) <= Date.now()) throw new Error('The MCP OAuth credential has expired');
          headers = { ...headers, Authorization: `Bearer ${auth.type === 'static_bearer' ? auth.token : auth.access_token}` };
        }
      }
      const common = {
        enabled: true, required: tool.required, default_tools_approval_mode: 'approve',
        ...(tool.allowed_tools !== null ? { enabled_tools: tool.allowed_tools } : {}),
      };
      if (tool.transport.type === 'http' && tool.connection_origin === 'service') {
        const proxy = await createSessionMcpProxy({ serverURL: tool.transport.server_url, headers, metadata: tool.request_metadata, allowedTools: tool.allowed_tools, ...(signal ? { signal } : {}), ...(authorization ? { authorization } : {}), ...(authorize ? { authorize } : {}),
          credentialEvidence: binding?.inlineReference ? { kind: 'inline_snapshot' } : { kind: 'none' },
          ...(audit ? { audit, serverLabel: tool.server_label } : {}) });
        closers.push(proxy.close);
        const key = `RAT_MCP_CONNECTION_${index}`;
        environment[key] = proxy.key;
        servers[tool.server_label] = { ...common, url: proxy.url, bearer_token_env_var: key, environment_id: 'local' };
      } else {
        const remote = launch.environment.type === 'self_hosted';
        if (launch.environment.type === 'none') throw new Error('MCP requires an execution environment');
        const headerEnv = Object.fromEntries(Object.keys(headers).map((name, headerIndex) => [name, `RAT_MCP_HEADER_${index}_${headerIndex}`]));
        const env = { ...inline?.env, ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [headerEnv[name]!, value])), ...credentials?.shellEnvironment };
        const configuration = { transport: tool.transport, headerEnv, metadata: tool.request_metadata, allowedTools: tool.allowed_tools };
        const command = ['node', '--input-type=module', '-e', environmentMcpWorkerSource, JSON.stringify(configuration)];
        const managed = launch.environment.type === 'openai_hosted';
        servers[tool.server_label] = {
          ...common, environment_id: remote ? 'remote' : 'local',
          command: managed ? 'codex' : command[0],
          args: managed ? hostedCodexArguments(['sandbox', '--permission-profile', 'rat_managed', '--', ...command], launch.environment.type === 'openai_hosted' ? launch.environment.network : { access: 'disabled', allowed_domains: [] }, Boolean(credentials)) : command.slice(1),
          cwd: tool.transport.type === 'stdio' ? tool.transport.cwd : launch.environment.type === 'self_hosted' ? launch.environment.workspace_directory : '/workspace',
          env,
          env_vars: tool.transport.type === 'stdio' ? tool.transport.env_vars.map((name) => ({ name, source: remote ? 'remote' : 'local' })) : [],
        };
      }
    }
    return { servers, environment, close: async () => { await Promise.all(closers.map((close) => close())); } };
  } catch (error) {
    await Promise.allSettled(closers.map((close) => close()));
    throw error;
  }
}

/** Metadata and tool policy are pure transformations; HTTP and credential effects stay below. */
export function planMcpRequest(value: unknown, metadata: Record<string, unknown>, allowedTools: string[] | null, enforce = true): unknown {
  if (Array.isArray(value)) return value.map((message) => planMcpRequest(message, metadata, allowedTools, enforce));
  if (!record(value)) throw new Error('Invalid MCP message');
  const params = record(value.params) ? value.params : {};
  if (enforce && value.method === 'tools/call' && (typeof params.name !== 'string' || allowedTools !== null && !allowedTools.includes(params.name))) throw new Error('MCP tool is outside the admitted capability envelope');
  return Object.keys(metadata).length && typeof value.method === 'string'
    ? { ...value, params: { ...params, _meta: { ...(record(params._meta) ? params._meta : {}), ...metadata } } }
    : value;
}

export async function createSessionMcpProxy(options: {
  serverURL: string; headers: Record<string, string>; metadata: Record<string, unknown>;
  allowedTools: string[] | null; signal?: AbortSignal; fetch?: typeof globalThis.fetch;
  authorization?: (rejectedToken?: string) => Promise<string>;
  authorize?: (rejectedToken?: string) => Promise<McpAuthorization>;
  credentialEvidence?: McpCredentialEvidence; audit?: SessionMcpAudit; serverLabel?: string;
}) {
  // Admission values are fixed for this proxy's lifetime; only the explicitly
  // supplied runtime context and live credential checks can change.
  options = { ...options, headers: { ...options.headers }, metadata: structuredClone(options.metadata),
    allowedTools: options.allowedTools === null ? null : [...options.allowedTools],
    ...(options.audit ? { audit: { ...options.audit, identity: structuredClone(options.audit.identity), configuration: structuredClone(options.audit.configuration) } } : {}) };
  const upstream = new URL(options.serverURL);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.hash) throw new Error('Invalid service MCP destination');
  let disabled = false;
  const key = randomBytes(32).toString('base64url');
  const abort = new AbortController();
  const abortFromCaller = () => abort.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (options.signal?.aborted) abort.abort();
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== '/' || !['GET', 'POST', 'DELETE'].includes(request.method ?? '') || !equalSecret(request.headers.authorization ?? '', `Bearer ${key}`)) {
        response.writeHead(403).end(); return;
      }
      if (disabled) throw new Error('MCP request failed');
      let body: string | undefined;
      let operations: ToolAuthorizationOperation[] = [];
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) { response.writeHead(413).end(); return; }
          chunks.push(Buffer.from(chunk));
        }
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        if (!messages.length || messages.length > MAX_TOOL_AUTHORIZATIONS || messages.some(message => !record(message))) throw new Error('Invalid MCP batch');
        operations = messages.filter(message => record(message) && message.method === 'tools/call').map(message => {
          const params = record(message.params) ? message.params : {};
          const toolName = typeof params.name === 'string' ? params.name : 'invalid';
          return { toolName, valid: typeof params.name === 'string' && safeToolLabel(toolName) === toolName && (typeof message.id === 'string' || typeof message.id === 'number' && Number.isFinite(message.id)) };
        });
        // Audited requests defer denial until its immutable receipt is retained.
        body = JSON.stringify(planMcpRequest(parsed, options.metadata, options.allowedTools, !options.audit));
      }
      const headers = new Headers(options.headers);
      if (!options.audit && options.authorization) headers.set('authorization', await options.authorization());
      for (const name of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']) {
        const value = request.headers[name];
        if (typeof value === 'string' && !headers.has(name)) headers.set(name, value);
      }
      const connection = new AbortController();
      response.once('close', () => connection.abort());
      const send = () => (options.fetch ?? fetch)(upstream, {
        method: request.method!, headers, ...(body !== undefined ? { body } : {}), redirect: 'error',
        signal: AbortSignal.any([abort.signal, connection.signal, AbortSignal.timeout(120_000)]),
      });
      let result: Response;
      if (options.audit && operations.length) {
        result = await dispatchAuditedMcp({ audit: options.audit,
          policy: { serverLabel: safeToolLabel(options.serverLabel), destinationDigest: sha256Hex(credentialUrl(options.serverURL)), allowedTools: options.allowedTools }, operations,
          credential: options.authorize ?? (async () => ({ authorization: headers.get('authorization') ?? '', evidence: options.credentialEvidence ?? { kind: 'none' } })),
          refresh: Boolean(options.authorize), signal: AbortSignal.any([abort.signal, connection.signal]), disable: () => { disabled = true; },
          send: async authorization => { if (authorization) headers.set('authorization', authorization); return send(); },
        });
      } else {
        if (options.audit) {
          await options.audit.assertActive();
          if (options.authorize) headers.set('authorization', (await options.authorize()).authorization);
          await options.audit.assertActive();
        }
        result = await send();
      }
      if (options.audit && !operations.length && result.status === 401 && options.authorize) {
        const previous = headers.get('authorization')!;
        await options.audit.assertActive();
        const refreshed = await options.authorize(previous);
        if (refreshed.authorization !== previous) {
          await result.body?.cancel();
          headers.set('authorization', refreshed.authorization);
          await options.audit.assertActive();
          result = await send();
        }
      }
      if (!options.audit && result.status === 401 && options.authorization) {
        const previous = headers.get('authorization')!;
        const refreshed = await options.authorization(previous);
        if (refreshed !== previous) {
          await result.body?.cancel();
          headers.set('authorization', refreshed);
          result = await send();
        }
      }
      const outputHeaders: Record<string, string> = {};
      for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'retry-after']) {
        const value = result.headers.get(name); if (value !== null) outputHeaders[name] = value;
      }
      response.writeHead(result.status, outputHeaders);
      if (result.body) await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), response);
      else response.end();
    } catch {
      // Never expose upstream diagnostics, request bodies, or credentials in a transport error.
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'MCP request failed' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP bridge failed to listen');
  return { key, url: `http://127.0.0.1:${address.port}/`, close: async () => {
    options.signal?.removeEventListener('abort', abortFromCaller);
    abort.abort(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function equalSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
