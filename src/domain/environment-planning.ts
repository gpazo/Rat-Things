import type { EnvironmentTemplate, EnvironmentParam, TemplateCreateParams, TemplateUpdateParams } from './agents-api.js';
import { invalid } from './agents-api-validation.js';

export type HostedEnvironmentConfiguration = Omit<Extract<EnvironmentParam, { type: 'openai_hosted' }>, 'type' | 'environment_template_id'>;

/** Resolve each supplied field as a replacement, retaining confidential inputs privately. */
export function templateConfiguration(input: TemplateCreateParams | TemplateUpdateParams, previous?: TemplateCreateParams): TemplateCreateParams {
  const configured = { ...previous, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };
  if (configured.name && [...configured.name].length > 128) invalid('name is too long', 'name');
  if ((configured.files?.length ?? 0) > 50) invalid('An environment accepts at most 50 input files', 'files');
  let inlineBytes = 0;
  for (const [index, file] of (configured.files ?? []).entries()) {
    workspacePath(file.path, `files.${index}.path`);
    if (file.type === 'inline') {
      const bytes = decodeBase64(file.data, `files.${index}.data`).byteLength;
      inlineBytes += bytes;
      if (bytes > 5 * 1024 * 1024 || inlineBytes > 10 * 1024 * 1024) invalid('Inline files exceed the environment upload limit', 'files');
    }
  }
  for (const capability of [...configured.plugins ?? [], ...configured.skills ?? []]) {
    if (capability.type === 'inline') decodeBase64(capability.source.data, 'source.data');
  }
  for (const directory of configured.capability_directories ?? []) absolutePath(directory, 'capability_directories');
  for (const setup of configured.setup_commands ?? []) {
    if (!setup.command.trim() || setup.command.includes('\0')) invalid('Setup commands must not be empty', 'setup_commands');
    if (setup.cwd) absolutePath(setup.cwd, 'setup_commands.cwd');
  }
  for (const name of Object.keys(configured.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^(PATH|HOME|SHELL|USER|LOGNAME|LD_.*|DYLD_.*|NODE_OPTIONS|BASH_ENV|ENV|OPENAI_API_KEY|CODEX_.*|AWS_.*|RAT_.*)$/.test(name)) invalid('Environment variable name is reserved', 'env');
  }
  for (const packages of Object.values(configured.packages ?? {})) for (const name of packages ?? []) {
    if (!name.trim() || name.startsWith('-') || /[\0\r\n]/.test(name)) invalid('Invalid package name', 'packages');
  }
  for (const domain of configured.network?.allowed_domains ?? []) validateDomain(domain);
  if (configured.network?.access === 'restricted' && (!configured.network.allowed_domains?.length || configured.network.allowed_domains.length > 100)) invalid('Restricted network access requires 1–100 exact hostnames', 'network.allowed_domains');
  return configured;
}

/** An inline session can narrow a template's network envelope, never widen it. */
export function resolveHostedEnvironment(template: TemplateCreateParams | undefined, inline: HostedEnvironmentConfiguration): HostedEnvironmentConfiguration {
  const configured = templateConfiguration(inline, template);
  const inherited = template?.network;
  if (inherited && inherited.access !== 'enabled' && inline.network !== undefined) {
    const requested = inline.network;
    if (!requested || requested.access === 'enabled' || (inherited.access === 'disabled' && requested.access !== 'disabled')) invalid('Session network access cannot broaden the template policy', 'environment.network');
    if (requested.access === 'restricted' && (requested.allowed_domains ?? []).some((domain) => !(inherited.allowed_domains ?? []).some((allowed) => domainWithin(domain, allowed)))) invalid('Session domains must be within the template policy', 'environment.network.allowed_domains');
  }
  const { name: _name, ...environment } = configured;
  return environment;
}

/** Project an allowlist of public fields; no confidential input is spread into a response. */
export function publicTemplate(input: TemplateCreateParams, identity: Pick<EnvironmentTemplate, 'id' | 'created_at' | 'updated_at'>): EnvironmentTemplate {
  return {
    ...identity, object: 'agent.environment.template', name: input.name ?? null,
    capability_directories: input.capability_directories ?? [],
    network: { access: input.network?.access ?? 'enabled', allowed_domains: input.network?.allowed_domains ?? [] },
    packages: { npm: input.packages?.npm ?? [], python: input.packages?.python ?? [], system: input.packages?.system ?? [] },
    files: (input.files ?? []).map((file) => file.type === 'file_id' ? { type: file.type, path: file.path, file_id: file.file_id } : { type: file.type, path: file.path, size_bytes: decodeBase64(file.data, 'files.data').byteLength }),
    plugins: (input.plugins ?? []).map(({ type, name, description }) => ({ type, name, description })),
    skills: (input.skills ?? []).map((skill) => skill.type === 'inline' ? { type: skill.type, name: skill.name, description: skill.description } : { type: skill.type, skill_id: skill.skill_id, version: skill.version ?? null }),
  };
}

export function absolutePath(value: string, param: string): string {
  if (!value.startsWith('/') || value.includes('\0') || value.split('/').some((part) => part === '..' || part === '.')) invalid('An absolute path without traversal segments is required', param);
  return value;
}

export function workspacePath(value: string, param: string): string {
  absolutePath(value, param);
  if (!value.startsWith('/workspace/') || value.endsWith('/')) invalid('Files must be inside /workspace', param);
  return value;
}

export function decodeBase64(value: string, param: string): Uint8Array {
  // Repeated capture groups overflow V8's regexp stack on valid multi-MiB files.
  // A flat alphabet check plus the canonical round trip also validates padding.
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) invalid('Standard base64 data is required', param);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) invalid('Canonical base64 data is required', param);
  return bytes;
}

function validateDomain(value: string): void {
  if (value.length > 253 || !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(value)) invalid('Network allowlists require exact hostnames without wildcards, URLs, or ports', 'network.allowed_domains');
}

function domainWithin(domain: string, allowed: string): boolean {
  const requested = domain.toLowerCase();
  const maximum = allowed.toLowerCase();
  return requested === maximum;
}
