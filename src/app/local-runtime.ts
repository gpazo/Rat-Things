import { createHash } from 'node:crypto';
import { LocalContainerRuntime } from '../adapters/local-container-runtime.js';
import type { LocalRuntime } from '../core/local-runtime-ports.js';

export function createLocalRuntime(directory: string): LocalRuntime {
  return new LocalContainerRuntime(createHash('sha256').update(directory).digest('hex').slice(0, 16));
}
