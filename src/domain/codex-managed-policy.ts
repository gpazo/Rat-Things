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
  if (!record(value) || !record(value.config) || !managedCodexRequirementsSafe(requirements)) return false;
  const config = value.config;
  const expected = managedCodexConfiguration(policy);
  return config.approval_policy === expected.approval_policy
    && config.default_permissions === expected.default_permissions
    && record(config.permissions) && equivalent(config.permissions.rat_managed, expected.permissions.rat_managed)
    && record(config.features) && equivalent(config.features.network_proxy, expected.features.network_proxy)
    && equivalent(config.projects, expected.projects);
}

// These public 0.164 requirements can affect execution, startup or persistence.
// Absence is understood; an active requirement needs its own policy review.
const inactiveRequirementFields = new Set([
  'modelProvider', 'modelProviders', 'cliAuthCredentialsStore', 'chatgptBaseUrl',
  'additionalDeveloperInstructions', 'allowedApprovalPolicies', 'allowedApprovalsReviewers',
  'allowedSandboxModes', 'allowedWindowsSandboxImplementations', 'allowedPermissionProfiles',
  'defaultPermissions', 'allowedWebSearchModes', 'allowManagedHooksOnly', 'allowBrowserAndComputerUse',
  'allowAppshots', 'allowRemoteControl', 'computerUse', 'browserUse', 'inAppBrowser',
  'featureRequirements', 'hooks', 'enforceResidency', 'network', 'application', 'autoReview',
  'models', 'sqliteHome', 'logDir', 'modelCatalogJson', 'checkForUpdateOnStartup', 'allowLoginShell', 'feedback',
]);

/** Authentication restrictions do not grant execution authority or change the selected profile. */
export function managedCodexRequirementsSafe(value: unknown): boolean {
  if (!record(value) || !Object.hasOwn(value, 'requirements')) return false;
  if (Object.keys(value).some(key => key !== 'requirements' && key !== 'supportsIndependentSpeedModes')) return false;
  if (value.supportsIndependentSpeedModes != null && typeof value.supportsIndependentSpeedModes !== 'boolean') return false;
  if (value.requirements === null) return true;
  if (!record(value.requirements)) return false;
  return Object.entries(value.requirements).every(([key, restriction]) => {
    if (key !== 'allowedLoginMethods') return inactiveRequirementFields.has(key) && restriction === null;
    // Upstream permits an empty list (no login), and serializes known methods in lowercase.
    return restriction === null || Array.isArray(restriction)
      && restriction.every(method => method === 'api' || method === 'chatgpt')
      && new Set(restriction).size === restriction.length;
  });
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
