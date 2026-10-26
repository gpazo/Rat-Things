import type { SessionLaunch } from './session-execution.js';

export interface ManagedCodexPolicy {
  workspace: string;
  network: Extract<SessionLaunch['environment'], { type: 'openai_hosted' }>['network'];
  credentialProxy: boolean;
}

/** Public network intent is enforced by the proxy; its empty allowlist denies all egress. */
export function managedCodexConfiguration(policy: ManagedCodexPolicy) {
  const proxy = policy.network.access !== 'enabled';
  const domains = Object.fromEntries((policy.network.access === 'restricted' ? policy.network.allowed_domains : []).map(host => [host.toLowerCase(), 'allow']));
  return {
    approval_policy: 'never', default_permissions: 'rat_managed',
    features: { network_proxy: { enabled: proxy, credential_broker: false } },
    projects: { [policy.workspace]: { trust_level: 'untrusted' } },
    permissions: { rat_managed: {
      filesystem: { ':root': 'read', [policy.workspace]: 'write' },
      network: { enabled: true, mode: 'full', domains, unix_sockets: {},
        proxy_url: 'http://127.0.0.1:0', socks_url: 'http://127.0.0.1:0',
        enable_socks5: true, enable_socks5_udp: false, allow_local_binding: false,
        allow_upstream_proxy: policy.credentialProxy && policy.network.access !== 'disabled',
        dangerously_allow_non_loopback_proxy: false, dangerously_allow_all_unix_sockets: false },
    } },
  };
}

/** Validate the merged public configuration, not merely the flags we requested. */
export function managedCodexPolicyMatches(value: unknown, requirements: unknown, policy: ManagedCodexPolicy): boolean {
  if (!record(value) || !record(value.config) || !record(requirements) || requirements.requirements !== null) return false;
  const config = value.config;
  const expected = managedCodexConfiguration(policy);
  return config.approval_policy === expected.approval_policy
    && config.default_permissions === expected.default_permissions
    && record(config.permissions) && equivalent(config.permissions.rat_managed, expected.permissions.rat_managed)
    && record(config.features) && equivalent(config.features.network_proxy, expected.features.network_proxy)
    && equivalent(config.projects, expected.projects);
}

function equivalent(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

// The public config reader serializes absent profile fields as null. Null adds no grant.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== null)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
