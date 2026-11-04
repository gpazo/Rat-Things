import { canonicalJson, sha256Hex } from '../domain/json.js';
import type { ServiceMcpPolicy, ToolAuthorizationDecision, ToolDenialReason } from '../domain/tool-authorization.js';

export interface ToolAuthorizationOperation { toolName: string; valid: boolean }
export type ToolAdmission = { decision: 'allow' } | { decision: 'deny'; reason: ToolDenialReason };

/** No secret reads or transport effects: a batch is admitted as one envelope. */
export function planToolAuthorization(policy: ServiceMcpPolicy, operations: readonly ToolAuthorizationOperation[]): ToolAdmission[] {
  const members: ToolAdmission[] = operations.map(operation => !operation.valid ? { decision: 'deny', reason: 'invalid_call' }
    : policy.allowedTools !== null && !policy.allowedTools.includes(operation.toolName) ? { decision: 'deny', reason: 'tool_not_admitted' }
      : { decision: 'allow' });
  return members.some(member => member.decision === 'deny')
    ? members.map(member => member.decision === 'allow' ? { decision: 'deny', reason: 'batch_denied' } : member) : members;
}

export function toolPolicyDigest(policy: ServiceMcpPolicy): string { return sha256Hex(canonicalJson(policy)); }
export function safeToolLabel(value: unknown): string { return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : 'invalid'; }

export function denyToolDecisions(decisions: readonly ToolAuthorizationDecision[], reason: ToolDenialReason): ToolAuthorizationDecision[] {
  return decisions.map(decision => ({ ...decision, decision: 'deny', reason }));
}
