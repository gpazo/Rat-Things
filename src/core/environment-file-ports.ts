export type EnvironmentFileOperation =
  | { operation: 'list'; path: string; missingOk?: boolean }
  | { operation: 'write'; path: string; data: string }
  | { operation: 'write_chunk'; path: string; data: string; uploadId: string; offset: number; size: number; sha256: string }
  | { operation: 'write_abort'; path: string; uploadId: string }
  | { operation: 'read'; path: string; offset: number; length: number };

/** Private managed workspace file access, separate from the public artifact store. */
export interface EnvironmentFileOperations {
  execute(operation: EnvironmentFileOperation): Promise<unknown>;
}
