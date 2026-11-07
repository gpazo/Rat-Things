import { validators } from './agents-api-validators.generated.mjs';
import type { AgentsApiContracts } from './agents-api.js';

export class AgentsApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly code: string | null = null,
    public readonly param: string | null = null,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AgentsApiError';
  }

  public get type(): string {
    return this.status === 401 ? 'authentication_error'
      : this.status === 403 ? 'permission_error'
      : this.status === 429 ? 'rate_limit_error'
      : this.status >= 500 ? 'server_error' : 'invalid_request_error';
  }
}

/** Distinguish a rejected storage write from public lifecycle conflicts. */
export class AgentsResourceConflictError extends AgentsApiError {
  public constructor() {
    super(409, 'Resource changed concurrently. Retry the request.', 'conflict');
  }
}

/** Validate before effects; never coerce, remove fields, or log request values. */
export function parseAgentsContract<K extends keyof AgentsApiContracts>(
  name: K,
  value: unknown,
): AgentsApiContracts[K] {
  const validate = validators[name];
  if (!validate) throw new Error(`Missing generated Agents API validator for ${name}.`);
  if (!validate(value)) {
    const error = validate.errors?.[0];
    const param = error?.instancePath.replace(/^\//, '').replaceAll('/', '.') || null;
    throw new AgentsApiError(400, `Invalid ${name}: ${error?.message ?? 'invalid request'}.`, 'invalid_request', param);
  }
  return value as AgentsApiContracts[K];
}

export function validateAgentMetadata(metadata: Record<string, string> | null | undefined): void {
  if (!metadata) return;
  if (Object.keys(metadata).length > 16) invalid('metadata supports at most 16 entries', 'metadata');
  for (const [key, value] of Object.entries(metadata)) {
    if ([...key].length > 64 || [...value].length > 512) {
      invalid('metadata keys must be at most 64 characters and values at most 512 characters', 'metadata');
    }
  }
}

export function invalid(message: string, param: string | null = null): never {
  throw new AgentsApiError(400, message, 'invalid_request', param);
}

export function resourceNotFound(): never {
  throw new AgentsApiError(404, 'Resource not found.', 'resource_not_found');
}
