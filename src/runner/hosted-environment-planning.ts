import type { SessionLaunch } from '../domain/session-execution.js';

/** The hosted discriminator is the upstream wire name; execution remains in an isolated AWS worker. */
export function hostedCodexArguments(base: string[] | undefined, network: Extract<SessionLaunch['environment'], { type: 'openai_hosted' }>['network']): string[] {
  const arguments_ = base ?? ['app-server'];
  const domains = network.allowed_domains.map((host) => `${JSON.stringify(host)} = "allow"`).join(', ');
  const proxy = network.access === 'restricted';
  return ['-c', 'default_permissions = "rat_managed"', '-c', `features.network_proxy = ${proxy}`, '-c',
    `permissions.rat_managed = { filesystem = { ":root" = "read", "/workspace" = "write", "/tmp" = "write" }, network = { enabled = ${network.access !== 'disabled'}, mode = "full", domains = { ${domains} }, proxy_url = "http://127.0.0.1:0", socks_url = "http://127.0.0.1:0", enable_socks5 = true, enable_socks5_udp = false, allow_local_binding = false, allow_upstream_proxy = false } }`,
    ...arguments_];
}


export function hostedProcessEnvironment(configured: Record<string, string>, path?: string): Record<string, string> {
  return { ...configured, PATH: `/workspace/.packages/bin:${path ?? '/usr/local/bin:/usr/bin:/bin'}`, PYTHONPATH: ['/workspace/.packages/python', configured.PYTHONPATH].filter(Boolean).join(':') };
}
