import type { ExecutionBackend } from '../domain/contracts.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export interface SessionPlacementPolicy {
  ec2Workloads: ReadonlyArray<{ owner_id: string; agent_id: string }>;
  availableBackends: readonly ExecutionBackend[];
}

export function selectSessionBackend(policy: SessionPlacementPolicy | undefined, ownerId: string, savedAgentId?: string): ExecutionBackend {
  return savedAgentId && policy?.ec2Workloads.some((workload) => workload.owner_id === ownerId && workload.agent_id === savedAgentId) ? 'ec2' : 'microvm';
}

export function requireSessionBackend(policy: SessionPlacementPolicy | undefined, backend: ExecutionBackend): void {
  if (!(policy?.availableBackends ?? ['microvm']).includes(backend)) {
    throw new AgentsApiError(503, `The Session requires the ${backend} backend, which is not enabled in this deployment.`, 'service_unavailable');
  }
}

export function sessionPlacementFromEnv(env: NodeJS.ProcessEnv): SessionPlacementPolicy {
  const workloads: unknown = JSON.parse(env.EC2_SESSION_WORKLOADS_JSON ?? '[]');
  if (!Array.isArray(workloads) || workloads.some((value: unknown) => !validWorkload(value))) {
    throw new Error('EC2_SESSION_WORKLOADS_JSON must be an array of owner_id and agent_id pairs.');
  }
  const policy: SessionPlacementPolicy = {
    ec2Workloads: workloads,
    availableBackends: [
      ...(env.MICROVM_ENABLED !== 'false' ? ['microvm' as const] : []),
      ...(env.EC2_WORKER_ENABLED === 'true' ? ['ec2' as const] : []),
    ],
  };
  if (policy.ec2Workloads.length) requireSessionBackend(policy, 'ec2');
  return policy;
}

function validWorkload(value: unknown): value is SessionPlacementPolicy['ec2Workloads'][number] {
  if (!value || typeof value !== 'object') return false;
  const workload = value as Record<string, unknown>;
  return Object.keys(workload).length === 2 && ['owner_id', 'agent_id'].every((key) => typeof workload[key] === 'string' && workload[key].trim().length > 0);
}
