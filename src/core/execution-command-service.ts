import type { AgentResource, AgentsStore } from './agents-ports.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { claimCommand, commandCollection, commandResponseCollection, validExecutionCommand, type ExecutionCommand, type ExecutionCommandRequest, type ExecutionCommandTarget } from './execution-command-planning.js';

/** Durable private RPC: the claim is committed before the effect, and never replayed. */
export class ExecutionCommandService {
  public constructor(private readonly options: {
    store: AgentsStore; now(): number; id(): string; pause(ms: number): Promise<void>;
  }) {}

  public async request(ownerId: string, target: ExecutionCommandTarget, request: ExecutionCommandRequest) {
    if (!validExecutionCommand(target, request)) throw new Error('Invalid execution command.');
    if (Buffer.byteLength(JSON.stringify(request)) > 6 * 1024 * 1024) throw new Error('Execution command exceeds its size limit.');
    const now = this.options.now();
    const resource: AgentResource<ExecutionCommand> = {
      id: this.options.id(), ownerId, collection: commandCollection(target.runId),
      createdAt: now, revision: 1, expiresAt: Math.floor(now / 1000) + 3600,
      value: { status: 'queued', target, request, deadline: now + 28_000 },
    };
    await this.options.store.put(resource, 0);
    while (this.options.now() < resource.value.deadline) {
      const saved = await this.options.store.get<ExecutionCommand>(ownerId, commandResponseCollection(target.runId), resource.id);
      if (saved?.value.status === 'completed' || saved?.value.status === 'failed') {
        if (saved.value.status === 'failed') throw new Error(saved.value.message);
        return saved.value.response;
      }
      await this.options.pause(250);
    }
    // Do not delete or requeue an ambiguous claim. The host may already be executing it.
    throw new Error('Execution command acknowledgement timed out.');
  }

  public async drain(ownerId: string, target: ExecutionCommandTarget, perform: (
    request: ExecutionCommandRequest, deadline: number,
  ) => Promise<{ status: number; body: unknown }>): Promise<void> {
    let after: string | undefined;
    do {
      const page = await this.options.store.list<ExecutionCommand>(ownerId, commandCollection(target.runId), {
        order: 'asc', limit: 100, ...(after ? { after } : {}),
      }).catch(async (error: unknown) => {
        // Completed commands leave the pending index. Re-scan if its cursor
        // was removed; claimed records remain non-executable.
        if (!after || !(error instanceof AgentsApiError) || error.status !== 400 || error.param !== 'after') throw error;
        return this.options.store.list<ExecutionCommand>(ownerId, commandCollection(target.runId), { order: 'asc', limit: 100 });
      });
      for (const saved of page.data) {
        const decision = claimCommand(saved.value, target, this.options.now());
        if (decision.kind === 'ignore') continue;
        const claimed: AgentResource<ExecutionCommand> = { ...saved, revision: saved.revision + 1,
          value: decision.kind === 'execute' ? decision.command : { ...saved.value, status: 'failed', message: decision.message } };
        try { await this.options.store.put(claimed, saved.revision); }
        catch (error) { if (error instanceof AgentsApiError && error.status === 409) continue; throw error; }
        if (decision.kind === 'reject') { await this.respond(claimed, claimed.value); continue; }
        let value: ExecutionCommand;
        try {
          // Storage latency may consume the remaining deadline after the initial calculation.
          if (this.options.now() >= claimed.value.deadline) throw new Error('Expired');
          const response = await perform(claimed.value.request, claimed.value.deadline);
          value = { ...claimed.value, status: 'completed', response };
        } catch {
          value = { ...claimed.value, status: 'failed', message: 'Execution command failed after acceptance; it will not be replayed.' };
        }
        await this.respond(claimed, value);
      }
      const last = page.data.at(-1)?.id;
      after = page.has_more ? last : undefined;
    } while (after);
  }

  private respond(claimed: AgentResource<ExecutionCommand>, value: ExecutionCommand): Promise<void> {
    return this.options.store.delete(claimed, [{
      resource: { ...claimed, collection: commandResponseCollection(claimed.value.target.runId), revision: 1, value },
      expectedRevision: 0,
    }]);
  }
}
