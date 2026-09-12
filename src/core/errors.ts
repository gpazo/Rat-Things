export class ConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}
