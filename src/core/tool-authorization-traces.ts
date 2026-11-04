import { sha256Hex } from '../domain/json.js';
import type { OtlpAttribute } from '../domain/session-traces.js';
import type { ToolAuthorizationReceipt, ToolAuthorizationTrace } from '../domain/tool-authorization.js';

/** Independent identities keep unresolved calls exportable without inventing native parents. */
export function projectToolAuthorizationTrace(ownerId: string, receipt: ToolAuthorizationReceipt): ToolAuthorizationTrace {
  const { identity, outcome, credential, configuration } = receipt;
  const namespace = JSON.stringify([ownerId, identity.sessionId, receipt.id]);
  const observed = 'at' in outcome;
  const failed = receipt.decision === 'deny' || outcome.kind === 'response_received'
    && (outcome.httpStatus >= 400 || outcome.toolResult === 'error');
  const succeeded = outcome.kind === 'response_received' && outcome.httpStatus < 400 && outcome.toolResult === 'success';
  const attributes = otlpAttributes({
    'gen_ai.operation.name': 'authorize_tool', 'gen_ai.agent.id': identity.agentId,
    'gen_ai.conversation.id': identity.sessionId, 'gen_ai.tool.name': receipt.toolName,
    'rat_things.authorization.id': receipt.id, 'rat_things.authorization.request_id': receipt.requestId,
    'rat_things.authorization.attempt': receipt.attempt, 'rat_things.authorization.decision': receipt.decision,
    'rat_things.authorization.reason': receipt.reason,
    'rat_things.authorization.policy_digest': receipt.policyDigest,
    'rat_things.authorization.credential_source': credential.kind,
    'rat_things.mcp.server_label': receipt.policy.serverLabel,
    'rat_things.run.id': identity.runId, 'rat_things.execution.generation': identity.generation,
    'rat_things.runtime.epoch': identity.runtimeEpoch,
    'rat_things.attribution': receipt.context.kind,
    'rat_things.context.turn_id': receipt.context.kind === 'single_active_turn' ? receipt.context.turnId : undefined,
    'rat_things.attribution.reason': receipt.context.kind === 'unresolved' ? receipt.context.reason : undefined,
    'rat_things.configuration.kind': configuration?.subject.kind,
    'rat_things.configuration.id': configuration?.subject.id,
    'rat_things.configuration.revision': configuration?.revision,
    'rat_things.vault.id': credential.kind === 'vault' ? credential.vault.subject.id : undefined,
    'rat_things.vault.revision': credential.kind === 'vault' ? credential.vault.revision : undefined,
    'rat_things.credential.id': credential.kind === 'vault' ? credential.credential.subject.id : undefined,
    'rat_things.credential.revision': credential.kind === 'vault' ? credential.credential.revision : undefined,
    'rat_things.outcome': outcome.kind,
    'rat_things.outcome.reason': outcome.kind === 'unknown' ? outcome.reason : undefined,
    'rat_things.tool_result': outcome.kind === 'response_received' ? outcome.toolResult : undefined,
    'http.response.status_code': outcome.kind === 'response_received' ? outcome.httpStatus : undefined,
    'rat_things.timing': observed ? 'observed' : 'incomplete',
  });
  return { id: receipt.id, otlp: { resourceSpans: [{
    resource: { attributes: otlpAttributes({ 'service.name': 'rat-things' }) },
    scopeSpans: [{ scope: { name: 'rat-things.authorization' }, spans: [{
      traceId: sha256Hex(`authorization-trace:${namespace}`).slice(0, 32),
      spanId: sha256Hex(`authorization-span:${namespace}`).slice(0, 16),
      name: 'authorize_tool', kind: 1,
      startTimeUnixNano: nanos(receipt.at), endTimeUnixNano: nanos(Math.max(receipt.at, observed ? outcome.at : receipt.at)),
      attributes, status: { code: failed ? 2 : succeeded ? 1 : 0 },
    }] }],
  }] } };
}

function nanos(seconds: number): string { return (BigInt(Math.round(seconds * 1_000_000)) * 1_000n).toString(); }
function otlpAttributes(values: Record<string, string | number | undefined>): OtlpAttribute[] {
  return Object.entries(values).flatMap(([key, value]) => value === undefined ? []
    : [{ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } }]);
}
