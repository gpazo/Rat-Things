import type { HostedEnvironmentConfiguration } from './environment-planning.js';
import type { LocalWorkspaceIntent } from './local-workspace.js';

/** Each setup step has a 600s execution limit and a 610s RPC deadline. */
export function localWorkspaceSetupTimeoutMs(
  configuration: Pick<HostedEnvironmentConfiguration, 'packages' | 'setup_commands'> | undefined,
  kind: LocalWorkspaceIntent['kind'],
): number {
  const packages = configuration?.packages;
  const system = Number(Boolean(packages?.system?.length));
  // Workspace packages and commands are preserved on resume; root packages are reinstalled.
  const workspace = kind === 'resume' ? 0 : Number(Boolean(packages?.npm?.length))
    + Number(Boolean(packages?.python?.length)) + (configuration?.setup_commands?.length ?? 0);
  return 60_000 + (system + workspace) * 610_000;
}
