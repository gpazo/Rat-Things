import type { SessionLaunch } from '../domain/session-execution.js';
import { managedCodexConfiguration } from '../domain/codex-managed-policy.js';

/** The hosted discriminator is the upstream wire name; execution remains in an isolated AWS worker. */
export function hostedCodexArguments(base: string[] | undefined, network: Extract<SessionLaunch['environment'], { type: 'openai_hosted' }>['network'], credentialProxy = false, workspace = '/workspace'): string[] {
  const arguments_ = base ?? ['app-server'];
  const config = managedCodexConfiguration({ workspace, network, credentialProxy });
  return [...Object.entries(config).flatMap(([key, value]) => ['-c', `${key} = ${toml(value)}`]), ...arguments_];
}

function toml(value: unknown): string {
  if (typeof value === 'object' && value !== null) return `{ ${Object.entries(value).map(([key, child]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${toml(child)}`).join(', ')} }`;
  return JSON.stringify(value);
}


export function hostedProcessEnvironment(configured: Record<string, string>, path?: string, workspace = '/workspace'): Record<string, string> {
  return { ...configured, TMPDIR: workspace, TMP: workspace, TEMP: workspace,
    PATH: `${workspace}/.packages/bin:${path ?? '/usr/local/bin:/usr/bin:/bin'}`, PYTHONPATH: [`${workspace}/.packages/python`, configured.PYTHONPATH].filter(Boolean).join(':') };
}
