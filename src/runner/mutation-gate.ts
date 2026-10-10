export class MutationGate {
  private tail: Promise<unknown> = Promise.resolve();
  public run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
}
