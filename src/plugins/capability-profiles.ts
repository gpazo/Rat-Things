import type {
  CapabilityProfileDefinition,
  IntegrationPermissionPreset,
} from '../domain/capabilities.js';
import type { AgentInput, SandboxMode } from '../domain/contracts.js';

export class CapabilityProfileRegistry {
  private readonly profiles = new Map<string, CapabilityProfileDefinition>();

  public constructor(profiles: CapabilityProfileDefinition[]) {
    for (const profile of profiles) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(profile.id)) {
        throw new Error(`capability profile ${profile.id} is invalid`);
      }
      if (this.profiles.has(profile.id)) throw new Error(`duplicate capability profile ${profile.id}`);
      this.profiles.set(profile.id, structuredClone(profile));
    }
  }

  public list(): CapabilityProfileDefinition[] {
    return [...this.profiles.values()].map((profile) => structuredClone(profile));
  }

  public profile(id: string): CapabilityProfileDefinition {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`capability profile ${id} is not installed`);
    return structuredClone(profile);
  }
}

export function createBuiltinCapabilityProfiles(): CapabilityProfileDefinition[] {
  return [
    {
      id: 'read-only',
      sandbox: 'read-only',
      networkAccess: true,
      webSearch: 'live',
      computerUse: 'disabled',
      maximumIntegrationAccess: 'read-only',
    },
    {
      id: 'small-business',
      sandbox: 'danger-full-access',
      networkAccess: true,
      webSearch: 'live',
      computerUse: 'browser',
      maximumIntegrationAccess: 'read-write',
    },
    {
      id: 'microvm-full',
      sandbox: 'danger-full-access',
      networkAccess: true,
      webSearch: 'live',
      computerUse: 'browser',
      maximumIntegrationAccess: 'full',
    },
  ];
}

export function resolveAgentProfile(
  agent: AgentInput | undefined,
  registry: CapabilityProfileRegistry,
): { agent: AgentInput | undefined; maximumIntegrationAccess?: Exclude<IntegrationPermissionPreset, 'custom'> } {
  const profileId = agent?.capabilities?.profile;
  if (!profileId) return { agent };
  const profile = registry.profile(profileId);
  const requested = agent.capabilities ?? {};
  const networkAccess = profile.networkAccess && requested.networkAccess !== false;
  const capabilities = {
    ...requested,
    networkAccess,
    webSearch: lesserWebSearch(profile.webSearch, requested.webSearch),
    computerUse: !networkAccess || profile.computerUse === 'disabled' || requested.computerUse === 'disabled'
      ? 'disabled' as const
      : 'browser' as const,
    ...allowedSelection('skills', requested.skills, profile.allowedSkills),
    ...allowedSelection('apps', requested.apps, profile.allowedApps),
    ...allowedSelection('mcpServers', requested.mcpServers, profile.allowedMcpServers),
  };
  return {
    agent: {
      ...agent,
      sandbox: lesserSandbox(profile.sandbox, agent.sandbox),
      capabilities,
    },
    maximumIntegrationAccess: profile.maximumIntegrationAccess,
  };
}

function lesserSandbox(profile: SandboxMode, requested?: SandboxMode): SandboxMode {
  if (!requested) return profile;
  const order: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
  return order[Math.min(order.indexOf(profile), order.indexOf(requested))] as SandboxMode;
}

function lesserWebSearch(
  profile: CapabilityProfileDefinition['webSearch'],
  requested?: CapabilityProfileDefinition['webSearch'],
): CapabilityProfileDefinition['webSearch'] {
  if (!requested) return profile;
  const order: CapabilityProfileDefinition['webSearch'][] = ['disabled', 'cached', 'indexed', 'live'];
  return order[Math.min(order.indexOf(profile), order.indexOf(requested))] as
    CapabilityProfileDefinition['webSearch'];
}

function allowedSelection<Key extends 'skills' | 'apps' | 'mcpServers'>(
  key: Key,
  requested: string[] | undefined,
  allowed: string[] | undefined,
): Partial<Record<Key, string[]>> {
  if (!requested) return {};
  if (!allowed) return { [key]: requested } as Partial<Record<Key, string[]>>;
  const unavailable = requested.find((item) => !allowed.includes(item));
  if (unavailable) throw new Error(`${key} capability ${unavailable} is outside profile policy`);
  return { [key]: requested } as Partial<Record<Key, string[]>>;
}
