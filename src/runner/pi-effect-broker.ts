import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, chown, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type, type TSchema } from 'typebox';
import AjvModule from 'ajv';
import { CodexRpcClient } from '../adapters/codex-rpc.js';
import type { NativeLease } from '../core/session-native-store.js';
import type { SessionLaunch } from '../domain/session-execution.js';
import type { CodexLaunchPlan } from './agent-planning.js';
import type { SessionMcpRuntime } from './session-mcp.js';
import type { SessionEnvironmentCredentialsRuntime } from './session-environment-credentials.js';
import { hostedCodexArguments, hostedProcessEnvironment } from './hosted-environment-planning.js';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';
import type { JsonObject } from '@earendil-works/pi-durable';

export interface PiEffectTool { name: string; description: string; parameters: TSchema; kind: 'managed' | 'mcp'; serverLabel?: string; toolName?: string }
export interface PiToolEffect { kind: 'managed' | 'mcp'; name: string; arguments: JsonObject; callId: string; taskId: number; conversationId: number }
const FILE_PROGRAM = `const fs=require('node:fs');const [op,path,data]=process.argv.slice(1);if(op==='read')process.stdout.write(fs.readFileSync(path,'utf8'));else if(op==='write'){fs.writeFileSync(path,data);console.log('Written');}else if(op==='list')console.log(JSON.stringify(fs.readdirSync(path,{withFileTypes:true}).map(e=>({name:e.name,directory:e.isDirectory()}))));else throw Error('Invalid file operation');`;
const Ajv = AjvModule.default;

export async function createPiEffectBroker(options: { launch: SessionLaunch; plan: CodexLaunchPlan; lease: NativeLease; mcp?: SessionMcpRuntime; credentials?: SessionEnvironmentCredentialsRuntime; signal?: AbortSignal; flushWorkspace?: () => Promise<void> }) {
  const { launch, plan } = options;
  if (launch.environment.type === 'self_hosted') throw new Error('Pi does not support self-hosted environments');
  const managed = launch.environment.type === 'openai_hosted';
  const home = await mkdtemp(join(tmpdir(), 'rat-pi-executor-'));
  if (plan.identity) await chown(home, plan.identity.uid, plan.identity.gid);
  const rpc = new CodexRpcClient({ binary: plan.binary, cwd: home,
    binaryArguments: managed ? hostedCodexArguments(['-c', 'features.plugins=false', 'app-server'], launch.environment.type === 'openai_hosted' ? launch.environment.network : { access: 'disabled', allowed_domains: [] }, Boolean(options.credentials)) : ['-c', 'features.plugins=false', 'app-server'],
    environment: { PATH: plan.environment.PATH, HOME: home, CODEX_HOME: home, CODEX_API_KEY: 'pi-tool-executor-no-inference',
      ...options.mcp?.environment, ...options.credentials?.processEnvironment },
    ...(plan.identity ? { identity: plan.identity } : {}), ...(options.signal ? { signal: options.signal } : {}),
    onServerRequest: async () => { throw new Error('Host approval is unavailable'); },
  });
  const tools: PiEffectTool[] = managed ? [
    { kind: 'managed', name: 'exec_command', description: 'Run an argument array in the managed workspace.', parameters: Type.Object({ command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }), cwd: Type.Optional(Type.String()) }, { additionalProperties: false }) },
    ...(['read_file', 'write_file', 'list_files'] as const).map(name => ({ kind: 'managed' as const, name, description: `${name.replaceAll('_', ' ')} in the managed environment.`, parameters: Type.Object({ path: Type.String({ minLength: 1 }), ...(name === 'write_file' ? { content: Type.String({ maxLength: 1024 * 1024 }) } : {}) }, { additionalProperties: false }) })),
  ] : [];
  const mcpTools = new Map<string, { server: string; tool: string }>();
  let threadId: string | undefined;
  try {
    await rpc.initialize();
    if (launch.agent.tools.some(tool => tool.type === 'mcp')) {
      const result = await rpc.call('thread/start', { cwd: managed ? plan.workspace : home, ephemeral: true, approvalPolicy: 'never',
        ...(managed ? { permissions: 'rat_managed', environments: [{ environmentId: 'local', cwd: plan.workspace }] } : { sandbox: 'read-only', environments: [] }),
        selectedCapabilityRoots: [], config: { mcp_servers: options.mcp?.servers ?? {} } });
      if (!record(result) || !record(result.thread) || typeof result.thread.id !== 'string') throw new Error('MCP executor returned no thread');
      threadId = result.thread.id;
      const inventory = await rpc.call('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' });
      if (!record(inventory) || !Array.isArray(inventory.data)) throw new Error('MCP executor returned invalid inventory');
      for (const server of inventory.data) {
        if (!record(server) || typeof server.name !== 'string' || !record(server.tools)) continue;
        const declaration = launch.agent.tools.find(tool => tool.type === 'mcp' && tool.server_label === server.name);
        if (!declaration || declaration.type !== 'mcp') continue;
        for (const [toolName, tool] of Object.entries(server.tools)) {
          if (!record(tool) || declaration.allowed_tools !== null && !declaration.allowed_tools.includes(toolName)) continue;
          const name = `rat_mcp_${createHash('sha256').update(JSON.stringify([server.name, toolName])).digest('hex').slice(0, 48)}`;
          if (mcpTools.has(name) || tools.some(tool => tool.name === name)) throw new Error('MCP tool name collision');
          mcpTools.set(name, { server: server.name, tool: toolName });
          tools.push({ kind: 'mcp', serverLabel: server.name, toolName, name, description: typeof tool.description === 'string' ? tool.description : toolName, parameters: Type.Unsafe(record(tool.inputSchema) ? tool.inputSchema : { type: 'object' }) });
        }
      }
    }
    const ajv = new Ajv({ strict: false });
    const validators = new Map(tools.map(tool => [tool.name, { kind: tool.kind, validate: ajv.compile(tool.parameters) }]));
    return {
      tools,
      execute: async (request: PiToolEffect, signal: AbortSignal): Promise<ToolExecutionResult> => {
        await options.lease.assertActive();
        signal.throwIfAborted();
        const declared = validators.get(request.name);
        if (!declared || declared.kind !== request.kind || !declared.validate(request.arguments)) throw new Error('Tool is outside the admitted capability envelope');
        if (request.kind === 'mcp') {
          const target = mcpTools.get(request.name)!;
          const response = await rpc.call('mcpServer/tool/call', { threadId, ...target, arguments: request.arguments });
          if (!record(response) || !Array.isArray(response.content)) throw new Error('Invalid MCP tool response');
          await options.flushWorkspace?.();
          return { output: response.content.flatMap<import('@earendil-works/pi-ai').TextContent | import('@earendil-works/pi-ai').ImageContent>(part => {
            if (!record(part)) return [];
            if (part.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }];
            if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') return [{ type: 'image', data: part.data, mimeType: part.mimeType }];
            return [];
          }), isError: response.isError === true };
        }
        if (!managed) throw new Error('Managed tools require an environment');
        const args = request.arguments;
        const command = request.name === 'exec_command' ? args.command as string[] : [process.execPath, '-e', FILE_PROGRAM,
          request.name === 'read_file' ? 'read' : request.name === 'write_file' ? 'write' : 'list', String(args.path), String(args.content ?? '')];
        const processId = `pi-${randomUUID()}`;
        const cancel = () => { void rpc.call('command/exec/terminate', { processId }).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          const response = await rpc.call('command/exec', { command, processId, cwd: typeof args.cwd === 'string' ? args.cwd : plan.workspace,
            env: { ...hostedProcessEnvironment(launch.hostedConfiguration?.env ?? {}, plan.environment.PATH), ...options.credentials?.shellEnvironment },
            permissionProfile: 'rat_managed', timeoutMs: 120_000, outputBytesCap: 128 * 1024 }, 125_000);
          if (!record(response)) throw new Error('Invalid managed command response');
          await options.flushWorkspace?.();
          return { output: [{ type: 'text', text: `${String(response.stdout ?? '')}${String(response.stderr ?? '')}` }], isError: response.exitCode !== 0 };
        } finally { signal.removeEventListener('abort', cancel); }
      },
      close: async () => { await rpc.close(); await rm(home, { recursive: true, force: true }); },
    };
  } catch (error) { await rpc.close(); await rm(home, { recursive: true, force: true }); throw error; }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
