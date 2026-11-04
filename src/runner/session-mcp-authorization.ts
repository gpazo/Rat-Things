import { randomUUID } from 'node:crypto';
import type { ConfigurationRevisionRef } from '../domain/configuration-history.js';
import type { McpAuthorization, McpCredentialEvidence, ServiceMcpPolicy, ToolAuthorizationDecision, ToolDispatchOutcome, ToolExecutionIdentity, ToolTurnContext } from '../domain/tool-authorization.js';
import type { ToolAuthorizationService } from '../core/tool-authorization-service.js';
import { denyToolDecisions, planToolAuthorization, safeToolLabel, toolPolicyDigest, type ToolAuthorizationOperation } from '../core/tool-authorization-planning.js';
import type { SessionRuntimeState } from '../core/session-runtime-planning.js';

export interface SessionMcpAudit {
  ownerId: string;
  identity: ToolExecutionIdentity;
  configuration: ConfigurationRevisionRef | null;
  service: Pick<ToolAuthorizationService, 'record' | 'recordOutcome'>;
  context(): ToolTurnContext;
  assertActive(): Promise<void>;
}

/** Current trusted runtime context is deliberately weaker than an invocation link. */
export function activeMcpTurnContext(state: SessionRuntimeState | undefined): ToolTurnContext {
  if (!state) return { kind: 'unresolved', reason: 'unavailable' };
  const active = state.turns.filter(({ turn }) => turn.status === 'in_progress');
  if (!active.length) return { kind: 'unresolved', reason: 'no_active_turn' };
  if (active.length !== 1) return { kind: 'unresolved', reason: 'multiple_active_turns' };
  return { kind: 'single_active_turn', turnId: active[0]!.turn.id };
}

/** Effects are ordered here; immutable decisions must precede every network attempt. */
export async function dispatchAuditedMcp(options: {
  audit: SessionMcpAudit; policy: ServiceMcpPolicy; operations: ToolAuthorizationOperation[];
  credential(rejectedToken?: string): Promise<McpAuthorization>;
  refresh: boolean; signal: AbortSignal; send(authorization: string): Promise<Response>;
  disable(): void;
}): Promise<Response> {
  const { audit, policy, operations } = options;
  const requestId = randomUUID();
  const admissions = planToolAuthorization(policy, operations);
  const now = () => Math.floor(Date.now() / 1000);
  const decisions = (attempt: number, credential: McpCredentialEvidence): ToolAuthorizationDecision[] => {
    const context = structuredClone(audit.context());
    return operations.map((operation, index) => ({ id: randomUUID(), object: 'rat_things.tool_authorization', requestId, attempt, at: now(),
      identity: structuredClone(audit.identity), configuration: structuredClone(audit.configuration), context,
      policy: structuredClone(policy), policyDigest: toolPolicyDigest(policy), toolName: safeToolLabel(operation.toolName), credential,
      ...admissions[index]! }));
  };
  const persist = async (value: ToolAuthorizationDecision[]) => {
    try { await audit.service.record(audit.ownerId, value); }
    catch { options.disable(); throw new Error('MCP request failed'); }
  };
  const observe = async (value: ToolAuthorizationDecision[], outcome: ToolDispatchOutcome) => {
    try { await audit.service.recordOutcome(audit.ownerId, audit.identity.sessionId, value.map(decision => decision.id), outcome); }
    catch { options.disable(); throw new Error('MCP request failed'); }
  };
  const deny = async (value: ToolAuthorizationDecision[]): Promise<never> => {
    await persist(value);
    await observe(value, { kind: 'not_dispatched', at: now() });
    throw new Error('MCP request failed');
  };
  if (admissions.some(member => member.decision === 'deny')) return deny(decisions(1, { kind: 'unavailable' }));

  const authorize = async (attempt: number, rejectedToken?: string) => {
    try { options.signal.throwIfAborted(); await audit.assertActive(); }
    catch { return deny(denyToolDecisions(decisions(attempt, { kind: 'unavailable' }), 'execution_inactive')); }
    let credential: McpAuthorization;
    try { credential = await options.credential(rejectedToken); }
    catch { return deny(denyToolDecisions(decisions(attempt, { kind: 'unavailable' }), 'credential_unavailable')); }
    return { credential, decisions: decisions(attempt, credential.evidence) };
  };
  const dispatch = async (value: Awaited<ReturnType<typeof authorize>>): Promise<Response> => {
    await persist(value.decisions);
    try { options.signal.throwIfAborted(); await audit.assertActive(); }
    catch {
      await observe(value.decisions, { kind: 'not_dispatched', at: now() });
      throw new Error('MCP request failed');
    }
    let response: Response;
    try { response = await options.send(value.credential.authorization); }
    catch {
      await observe(value.decisions, { kind: 'unknown', reason: options.signal.aborted ? 'cancelled' : 'transport_failure', at: now() });
      throw new Error('MCP request failed');
    }
    try {
      // Headers prove only an HTTP observation. JSON-RPC and SSE tool results
      // are not parsed here, and no business effect is declared successful.
      await observe(value.decisions, { kind: 'response_received', at: now(), httpStatus: response.status, toolResult: 'unobserved' });
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return response;
  };
  const first = await authorize(1);
  const response = await dispatch(first);
  if (response.status !== 401 || !options.refresh) return response;
  let retry: Awaited<ReturnType<typeof authorize>>;
  try { retry = await authorize(2, first.credential.authorization); }
  catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  if (retry.credential.authorization === first.credential.authorization) return response;
  await response.body?.cancel();
  return dispatch(retry);
}
