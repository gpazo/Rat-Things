import type { ExecutionReference, ExecutionBackend } from '../domain/contracts.js';
import type { ExecutionController } from '../core/ports.js';
import type { ExecutionBackendRegistry, RunExecutor } from './types.js';

export class ExecutionRegistry implements ExecutionBackendRegistry, ExecutionController {
  private readonly executors: Map<ExecutionBackend, RunExecutor>;

  public constructor(executors: RunExecutor[]) {
    this.executors = new Map();
    for (const executor of executors) {
      if (this.executors.has(executor.backend)) {
        throw new Error(`duplicate execution backend ${executor.backend}`);
      }
      this.executors.set(executor.backend, executor);
    }
  }

  public get(backend: ExecutionBackend): RunExecutor {
    const executor = this.executors.get(backend);
    if (!executor) throw new Error(`execution backend ${backend} is not enabled`);
    return executor;
  }

  public stop(execution: ExecutionReference, reason: string): Promise<void> {
    return this.get(execution.backend).stop(execution.id, reason);
  }
}
