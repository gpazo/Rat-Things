import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodexRpcClient } from '../adapters/codex-rpc.js';
import { isolatedCodexArguments } from '../domain/local-codex-arguments.js';

export interface LocalCodexHost {
  readonly binary: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}
export type LocalCodexHostProvider = () => LocalCodexHost;

export function developmentLocalCodexHost(directory: string, environment: Readonly<NodeJS.ProcessEnv> = process.env): LocalCodexHostProvider {
  const captured = Object.freeze(planLocalCodexEnvironment(directory, environment));
  const host = Object.freeze({ binary: captured.CODEX_BINARY ?? 'codex', environment: captured });
  return () => host;
}

/** A host-only Codex home keeps personal CLI tools and startup settings out of Rat Things Sessions. */
export function localCodexEnvironment(directory: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const plan = planLocalCodexEnvironment(directory, environment);
  mkdirSync(plan.CODEX_HOME!, { recursive: true, mode: 0o700 });
  chmodSync(plan.CODEX_HOME!, 0o700);
  return plan;
}

export function planLocalCodexEnvironment(directory: string, environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const home = join(directory, 'codex');
  const transport = ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const allowed = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR',
    'CODEX_BINARY', 'CODEX_CHATGPT_MODEL', ...transport];
  const base = Object.fromEntries(allowed.flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]]]));
  return { ...base, HOME: home, CODEX_HOME: home, CODEX_AUTH_MODE: 'chatgpt', DEFAULT_SANDBOX_MODE: 'read-only',
    ALLOW_AGENT_AWS_CREDENTIAL_CHAIN: 'false', AGENT_PASSTHROUGH_ENV: transport.join(',') };
}

/** Disable host integrations before app-server startup, including background plugin synchronization. */
export function localCodexArguments(args: string[]): string[] {
  return ['-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"', ...isolatedCodexArguments(args)];
}

/** Reject ambient MCP configuration before any thread can start a host tool process. */
export function localCodexClient(options: ConstructorParameters<typeof CodexRpcClient>[0]) {
  const rpc = new CodexRpcClient(options);
  return {
    async initialize() {
      await rpc.initialize();
      const result = await rpc.call('config/read', { cwd: options.cwd, includeLayers: false });
      if (!record(result) || !record(result.config)) throw new Error('Local Codex configuration is unavailable');
      const servers = result.config.mcp_servers;
      if (servers != null && (!record(servers) || Object.keys(servers).length)) throw new Error('Host MCP configuration is not admitted in local Sessions');
    },
    call: rpc.call.bind(rpc), close: rpc.close.bind(rpc),
  };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
