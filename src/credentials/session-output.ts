import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import type { SessionLaunch } from '../domain/session-execution.js';
import { parseAgentsContract } from '../domain/agents-api-validation.js';
import type { SecretReader } from './types.js';
import { parseSessionEnvironmentSecret, parseSessionToolSecret } from './session-tools.js';

export async function readSessionOutputSecrets(ownerId: string, launch: Pick<SessionLaunch, 'sessionId' | 'mcp' | 'environmentCredentials'>, secrets: SecretReader): Promise<string[]> {
  const environment = launch.environmentCredentials;
  const values = await Promise.all([
    ...environment?.references.map(async reference => parseSessionEnvironmentSecret(await secrets.get(reference), { ownerId, sessionId: launch.sessionId, environmentId: environment.environmentId }).credentials.map(auth => auth.secret_value)) ?? [],
    ...(launch.mcp ?? []).map(async binding => {
      const inline = binding.inlineReference ? parseSessionToolSecret(await secrets.get(binding.inlineReference), { ownerId, sessionId: launch.sessionId, serverLabel: binding.serverLabel }) : undefined;
      const auth = binding.vaultReference ? parseAgentsContract('CredentialCreate', { name: 'output-protection', auth: JSON.parse(await secrets.get(binding.vaultReference)) }).auth : undefined;
      return [...Object.values(inline?.headers ?? {}).flatMap(value => [value, value.replace(/^Bearer\s+/i, '')]), ...Object.values(inline?.env ?? {}),
        ...(auth ? credentialValues(auth) : [])];
    }),
  ]);
  return [...new Set(values.flat())];
}

function credentialValues(auth: CredentialAuthCreateParam): string[] {
  if (auth.type === 'environment_variable') return [auth.secret_value];
  if (auth.type === 'static_bearer') return [auth.token];
  const refresh = auth.refresh;
  return [auth.access_token, ...(refresh ? [refresh.refresh_token, ...(refresh.token_endpoint_auth.type === 'none' ? [] : [refresh.token_endpoint_auth.client_secret])] : [])];
}
