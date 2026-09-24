import type { CredentialAuth, CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import type { AgentSession } from './agents-api.js';
import { invalid } from './agents-api-validation.js';
import { credentialHost } from './vault-planning.js';

export type EnvironmentCredentialAuth = Extract<CredentialAuthCreateParam, { type: 'environment_variable' }>;
export type EnvironmentCredentialMetadata = Extract<CredentialAuth, { type: 'environment_variable' }>;
export interface HostedCredentialPolicy {
  environmentId: string;
  network: Extract<AgentSession['environment'], { type: 'openai_hosted' }>['network'];
  env: Record<string, string>;
}

/** Validate the intersection of the credential grant and the sandbox policy before secret reads. */
export function validateEnvironmentCredentialPolicy(credentials: EnvironmentCredentialMetadata[], policy: HostedCredentialPolicy): void {
  if (!credentials.length) return;
  const names = credentials.map(credential => credential.secret_name);
  if (new Set(names).size !== names.length) invalid('Attached environment credentials must have distinct secret_name values', 'vault_ids');
  if (names.some(name => Object.hasOwn(policy.env, name))) invalid('Credential names must not also appear in environment.env', 'environment.env');
  if (policy.network.access === 'disabled') invalid('Environment credentials require network access', 'environment.network');
  const allowed = new Set(policy.network.allowed_domains.map(host => host.toLowerCase()));
  for (const credential of credentials) {
    if (credential.networking.type === 'unrestricted') {
      if (policy.network.access !== 'restricted' || !allowed.size) invalid('Unrestricted credentials require a restricted environment with allowed_domains', 'environment.network');
    } else if (policy.network.access === 'restricted' && credential.networking.allowed_hosts.some(host => !allowed.has(credentialHost(host)))) {
      invalid('The environment network must allow every credential host', 'environment.network.allowed_domains');
    }
  }
}

export interface EnvironmentCredentialSubstitution {
  placeholder: string;
  secret: string;
  allowedHosts: string[];
}

/** A secret is substituted only inside HTTPS headers to the exact admitted host and port. */
export function substituteEnvironmentHeaders(
  headers: Record<string, string | string[] | undefined>, destination: URL,
  credentials: EnvironmentCredentialSubstitution[],
): Record<string, string | string[] | undefined> {
  if (destination.protocol !== 'https:' || !['', '443', '8443'].includes(destination.port) || destination.username || destination.password) return { ...headers };
  const admitted = credentials.filter(credential => credential.allowedHosts.includes(destination.hostname.toLowerCase()));
  const replacements = new Map(admitted.filter(credential => credential.placeholder.length).map(credential => [credential.placeholder, credential.secret]));
  if (!replacements.size) return { ...headers };
  const pattern = new RegExp([...replacements.keys()].sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const substitute = (value: string) => value.replace(pattern, placeholder => replacements.get(placeholder)!);
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, value === undefined ? undefined : Array.isArray(value) ? value.map(substitute) : substitute(value)]));
}
