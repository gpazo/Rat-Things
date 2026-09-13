import type { RunSource } from '../domain/contracts.js';
import { sourceBindingMatches } from '../domain/capabilities.js';
import type { SourceSessionResolver } from '../ingress/types.js';
import type { IntegrationStore } from './integration-types.js';

export class StoredSourceSessionResolver implements SourceSessionResolver {
  public constructor(private readonly store: IntegrationStore) {}
  public async resolve(source: RunSource) {
    if (source.kind === 'api') return undefined;
    const matches = (await this.store.matchingSourceBindings(source.kind))
      .filter((binding) => sourceBindingMatches(binding, source))
      .sort((left, right) => Object.keys(right.selector).length - Object.keys(left.selector).length);
    const binding = matches[0];
    if (!binding) return undefined;
    if (matches[1] && Object.keys(matches[1].selector).length === Object.keys(binding.selector).length) throw new Error('Multiple equally specific source bindings match this request');
    // Old stored policy bindings cannot silently select a model or agent.
    if (!binding.agentId || !binding.environment) throw new Error('Source binding requires an Agent and environment');
    return binding;
  }
}
