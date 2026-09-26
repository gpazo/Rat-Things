import { randomBytes } from 'node:crypto';
import type { SecretReader } from '../credentials/types.js';
import { parseSessionEnvironmentSecret } from '../credentials/session-tools.js';
import type { SessionLaunch } from '../domain/session-execution.js';
import { validateEnvironmentCredentialPolicy } from '../domain/environment-credential-planning.js';
import { createEnvironmentCredentialProxy } from './environment-credential-proxy.js';

export interface SessionEnvironmentCredentialsRuntime {
  /** Only placeholders and public connection/trust configuration cross the UID boundary. */
  shellEnvironment: Record<string, string>;
  processEnvironment: Record<string, string>;
  close(): Promise<void>;
}

export async function prepareSessionEnvironmentCredentials(ownerId: string, launch: SessionLaunch, secrets: SecretReader, signal?: AbortSignal): Promise<SessionEnvironmentCredentialsRuntime | undefined> {
  const binding = launch.environmentCredentials;
  if (!binding) return undefined;
  if (launch.environment.type !== 'openai_hosted' || binding.environmentId !== launch.environment.id) throw new Error('Environment credential binding does not match its sandbox');
  const identity = { ownerId, sessionId: launch.sessionId, environmentId: binding.environmentId };
  const credentials = (await Promise.all(binding.references.map(async reference => parseSessionEnvironmentSecret(await secrets.get(reference), identity).credentials))).flat();
  const policy = { environmentId: binding.environmentId, network: launch.environment.network, env: launch.hostedConfiguration?.env ?? {} };
  validateEnvironmentCredentialPolicy(credentials, policy);
  if (!credentials.length) throw new Error('Environment credential binding is empty');
  const values = credentials.map(credential => ({ name: credential.secret_name, placeholder: `rat_secret_${randomBytes(32).toString('hex')}`,
    secret: credential.secret_value, allowedHosts: credential.networking.type === 'limited' ? credential.networking.allowed_hosts.map(host => host.toLowerCase()) : policy.network.allowed_domains.map(host => host.toLowerCase()),
  }));
  const proxy = await createEnvironmentCredentialProxy({ credentials: values, network: policy.network, ...(signal ? { signal } : {}) });
  const common = {
    ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'WS_PROXY', 'WSS_PROXY'].map(name => [name, proxy.url])),
    ...Object.fromEntries(['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'CARGO_HTTP_CAINFO', 'PIP_CERT', 'BUNDLE_SSL_CA_CERT', 'npm_config_cafile', 'NPM_CONFIG_CAFILE', 'CODEX_CA_CERTIFICATE'].map(name => [name, proxy.certificate])),
  };
  return {
    // Native's network proxy explicitly chains upstream, independently of
    // NO_PROXY. The harness HTTP clients bypass it so sandbox policy never
    // controls model-provider or host-side MCP traffic.
    processEnvironment: { ...common, NO_PROXY: '*', no_proxy: '*' },
    shellEnvironment: { ...Object.fromEntries(values.map(value => [value.name, value.placeholder])), ...common, NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1' },
    close: proxy.close,
  };
}
