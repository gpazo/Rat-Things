/** Signing material is readable only by the trusted delivery service. */
export interface WebhookSecrets {
  create(ownerId: string, endpointId: string, secret: string): Promise<string>;
  read(reference: string): Promise<string>;
  revoke(reference: string): Promise<void>;
}
