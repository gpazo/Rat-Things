export class KnownNotDeliveredError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'KnownNotDeliveredError';
  }
}

export function requiredDeliveryCredential(reference: string | undefined, setting: string): string {
  if (!reference) throw new KnownNotDeliveredError(`Configure ${setting} before delivering results.`, false);
  return reference;
}
