export type EnvironmentFileOperation =
  | { operation: 'list'; path: string; missingOk?: boolean }
  | { operation: 'write'; path: string; data: string }
  | { operation: 'write_chunk'; path: string; data: string; uploadId: string; offset: number; size: number; sha256: string }
  | { operation: 'write_abort'; path: string; uploadId: string }
  | { operation: 'read'; path: string; offset: number; length: number };

/** Execution environment access is distinct from the agent harness and saved artifacts. */
export interface EnvironmentFileOperations {
  execute(environmentId: string, credentialReference: string, operation: EnvironmentFileOperation): Promise<unknown>;
}
