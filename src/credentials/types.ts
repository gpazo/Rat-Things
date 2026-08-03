export interface SecretReader {
  get(reference: string): Promise<string>;
}

export interface CredentialValue {
  reference: string;
  value: string;
}
