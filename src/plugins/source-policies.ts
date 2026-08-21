import type { RunRequest, RunSource } from '../domain/contracts.js';
import { sourceBindingMatches } from '../domain/capabilities.js';
import type { SourcePolicyResolver } from '../ingress/types.js';
import type { IntegrationStore } from './integration-types.js';

export class StoredSourcePolicyResolver implements SourcePolicyResolver {
  public constructor(private readonly store: IntegrationStore) {}

  public async apply(ownerId: string, request: RunRequest, source: RunSource): Promise<{
    request: RunRequest;
    policyOwnerId?: string;
  }> {
    const matches = (await this.store.matchingSourceBindings(source.kind))
      .filter((binding) => (
        sourceBindingMatches(binding, source) &&
        // API sources have no provider installation identity through which a
        // different owner could intentionally delegate capability policy.
        (source.kind !== 'api' || binding.ownerId === ownerId)
      ))
      .sort((left, right) => Object.keys(right.selector).length - Object.keys(left.selector).length);
    const binding = matches[0];
    if (!binding) return { request };
    if (
      matches[1] &&
      Object.keys(matches[1].selector).length === Object.keys(binding.selector).length
    ) throw new Error('multiple equally specific source capability bindings match this request');
    return { policyOwnerId: binding.ownerId, request: {
      ...request,
      ...(binding.capabilityProfile ? {
        agent: sourceProfileAgent(request, binding.capabilityProfile),
      } : {}),
      ...(binding.connectionSetId ? {
        integrations: { connectionSet: binding.connectionSetId },
      } : {}),
    } };
  }
}

function sourceProfileAgent(
  request: RunRequest,
  profile: string,
): NonNullable<RunRequest['agent']> {
  // Provider normalizers use read-only as their safe fallback. An exact,
  // operator-created source binding is the trusted policy decision, so let
  // the selected profile provide its sandbox and capability defaults while
  // retaining non-policy execution hints produced by trusted normalization.
  const {
    sandbox: _sandbox,
    capabilities: _capabilities,
    ...executionHints
  } = request.agent ?? {};
  return { ...executionHints, capabilities: { profile } };
}
