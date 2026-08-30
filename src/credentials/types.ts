export interface SecretReader {
  get(reference: string): Promise<string>;
}

/** Stored separately from integration metadata and never serialized into run requests. */
export interface IntegrationCredentialBinding {
  version: '1';
  ownerId: string;
  connectionId: string;
  reference: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationCredentialValue {
  [key: string]: string;
}

export interface CredentialVault {
  create(name: string, value: IntegrationCredentialValue): Promise<string>;
  replace(reference: string, value: IntegrationCredentialValue): Promise<void>;
  revoke(reference: string): Promise<void>;
}
