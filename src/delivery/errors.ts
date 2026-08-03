export class KnownNotDeliveredError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'KnownNotDeliveredError';
  }
}
