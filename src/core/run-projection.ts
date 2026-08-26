import type {
  PublishedArtifact,
  RunRecord,
  RunResult,
} from '../domain/contracts.js';

/** Owner-visible artifact metadata without private object-store coordinates. */
export interface PublicRunArtifact extends Omit<PublishedArtifact, 'file'> {
  sha256: string;
}

/** Terminal result metadata; bytes remain behind owner-checked artifact routes. */
export interface PublicRunResult extends Omit<
  RunResult,
  'output' | 'events' | 'workspacePatch' | 'agentThreadId' | 'artifacts'
> {
  artifacts?: PublicRunArtifact[];
}

/**
 * Stable client projection of a Run. Internal ownership keys, storage
 * references, execution handles, agent thread IDs, and provenance never cross
 * the control API boundary.
 */
export interface PublicRunRecord {
  runId: RunRecord['runId'];
  status: RunRecord['status'];
  createdAt: RunRecord['createdAt'];
  updatedAt: RunRecord['updatedAt'];
  expiresAt: RunRecord['expiresAt'];
  sourceKind: RunRecord['sourceKind'];
  thing?: RunRecord['thing'];
  execution?: {
    backend: NonNullable<RunRecord['execution']>['backend'];
    startedAt?: string;
  };
  result?: PublicRunResult;
  error?: RunRecord['error'];
  cancelRequestedAt?: string;
}

export function projectPublicRun(run: RunRecord): PublicRunRecord {
  return {
    runId: run.runId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    expiresAt: run.expiresAt,
    sourceKind: run.sourceKind,
    ...(run.thing ? { thing: { ...run.thing } } : {}),
    ...(run.execution ? {
      execution: {
        backend: run.execution.backend,
        ...(run.execution.startedAt ? { startedAt: run.execution.startedAt } : {}),
      },
    } : {}),
    ...(run.result ? { result: projectResult(run.result) } : {}),
    ...(run.error ? { error: { ...run.error } } : {}),
    ...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt } : {}),
  };
}

function projectResult(result: RunResult): PublicRunResult {
  return {
    preview: result.preview,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(result.usage ? { usage: { ...result.usage } } : {}),
    ...(result.artifacts ? {
      artifacts: result.artifacts.map(({ file, ...artifact }) => ({
        ...artifact,
        sha256: file.sha256,
      })),
    } : {}),
  };
}
