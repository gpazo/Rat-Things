import type { ArtifactReference, RunError, RunRecord } from '../domain/contracts.js';

export type DispatchAdmission =
  | { kind: 'ignore' }
  | { kind: 'dispatch'; run: RunRecord; input: ArtifactReference };

export type ExecutorStartFailure =
  | { kind: 'retry' }
  | { kind: 'fail'; error: RunError };

export function dispatchAdmission(run: RunRecord | undefined): DispatchAdmission {
  if (!run || !isDispatchable(run)) return { kind: 'ignore' };
  // Conversation input must be prepared before an accidental or reconciler wake-up can dispatch it.
  if (run.conversation && !run.executionInput) return { kind: 'ignore' };
  return { kind: 'dispatch', run, input: run.executionInput ?? run.input };
}

/** Classify the caught failure before the service chooses whether to persist it or retry delivery. */
export function executorStartFailure(error: unknown): ExecutorStartFailure {
  if (retryableStartError(error)) return { kind: 'retry' };
  return { kind: 'fail', error: { code: 'executor_start_failed', message: safeMessage(error), retryable: false } };
}

function isDispatchable(run: RunRecord): boolean {
  return run.status === 'queued' ||
    (run.status === 'dispatching' && (!run.execution || run.execution.id === 'pending')) ||
    (run.status === 'running' && (!run.execution || run.execution.id === 'pending'));
}

function retryableStartError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  if (['ThrottlingException', 'ServiceUnavailableException', 'TooManyRequestsException'].includes(name)) {
    return true;
  }
  const message = safeMessage(error).toLowerCase();
  // Lambda MicroVM control-plane gateway failures have occasionally returned
  // HTML. The AWS SDK surfaces those as a JSON deserialization SyntaxError
  // rather than a ServiceUnavailableException, but retrying the idempotent
  // RunMicrovm request is still the correct response.
  if (message.includes('deserialization error') && message.includes('is not valid json')) {
    return true;
  }
  const status = awsHttpStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  return name === 'ConflictException' &&
    message.includes('creation in progress') &&
    message.includes('clienttoken');
}

function awsHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    $metadata?: { httpStatusCode?: unknown };
    $response?: { statusCode?: unknown; status?: unknown };
  };
  const status = candidate.$metadata?.httpStatusCode ??
    candidate.$response?.statusCode ??
    candidate.$response?.status;
  return typeof status === 'number' ? status : undefined;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
