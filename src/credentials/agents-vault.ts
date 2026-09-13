import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';

/** Secrets are immutable versions; only the control plane can read or replace their references. */
export interface AgentCredentialSecrets {
  create(ownerId: string, credentialId: string, auth: CredentialAuthCreateParam): Promise<string>;
  read(reference: string): Promise<CredentialAuthCreateParam>;
  revoke(reference: string): Promise<void>;
}
