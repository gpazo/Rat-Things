import type { RunRecord, RunRequest } from '../domain/contracts.js';
import type { RunService, SubmitOptions } from './run-service.js';

export interface ThreadTarget {
  /** Owner-scoped internal thread identifier selected by trusted ingress. */
  conversationId: string;
  /** Stable provider/API occurrence identifier. */
  messageId: string;
  delivery?: 'interrupt' | 'defer';
}

export interface RunSubmissionOptions extends SubmitOptions {
  /** Optional continuity. Its absence is a one-shot Run, not another pipeline. */
  thread?: ThreadTarget;
}

export interface ThreadRunSubmissionPort {
  submitThread(
    ownerId: string,
    request: RunRequest,
    options: SubmitOptions,
    thread: ThreadTarget,
  ): Promise<RunRecord>;
}

/**
 * The only accepted-work entrypoint below API/provider/Thing adapters.
 * Every call reserves one durable Run; a thread only delays dispatch until
 * trusted continuation state has been attached to that same Run.
 */
export class RunSubmissionService {
  public constructor(
    private readonly runs: Pick<RunService, 'canonicalize' | 'submit' | 'get'>,
    private readonly threads: ThreadRunSubmissionPort,
  ) {}

  public submit(
    ownerId: string,
    rawRequest: unknown,
    options: RunSubmissionOptions = {},
  ): Promise<RunRecord> {
    const request = this.runs.canonicalize(rawRequest);
    const { thread, ...runOptions } = options;
    return thread
      ? this.threads.submitThread(ownerId, request, runOptions, thread)
      : this.runs.submit(ownerId, request, runOptions);
  }

  public get(ownerId: string, runId: string): Promise<RunRecord> {
    return this.runs.get(ownerId, runId);
  }
}
