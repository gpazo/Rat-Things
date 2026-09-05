import type { Architecture } from '../site/architecture/types.js';

export function resolveArchitecture(catalogue: unknown, root?: string): Promise<Architecture>;
export function buildArchitecture(output: string): Promise<void>;
