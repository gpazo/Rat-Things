import type { AgentsStore } from '../core/agents-ports.js';
import type { ScheduleState } from '../domain/schedules.js';
import type { SessionIntegrationState } from '../domain/session-integrations.js';
import type { ConnectionService } from '../plugins/connection-service.js';

export interface ConnectionConsumer { kind: 'schedule' | 'session' | 'connection-set' | 'source-binding'; id: string; name: string; status?: string; via?: string }
export interface ConnectionConsumerResult { version: '1'; connectionId: string; consumers: ConnectionConsumer[]; complete: boolean }
export interface ConnectionConsumerServiceOptions { connections: Pick<ConnectionService, 'get' | 'listSets' | 'listSourceBindings'>; store: AgentsStore }

/** Reports actual delivery-grant consumers, without implying that every Agent has connection tools. */
export class ConnectionConsumerService {
  public constructor(private readonly options: ConnectionConsumerServiceOptions) {}
  public async list(ownerId: string, connectionIdOrAlias: string): Promise<ConnectionConsumerResult> {
    const { connection } = await this.options.connections.get(ownerId, connectionIdOrAlias);
    const [sets, bindings] = await Promise.all([this.options.connections.listSets(ownerId), this.options.connections.listSourceBindings(ownerId)]);
    const selected = sets.filter((set) => set.connectionIds.includes(connection.connectionId));
    const ids = new Set(selected.map((set) => set.connectionSetId));
    const consumers: ConnectionConsumer[] = [
      ...selected.map((set) => ({ kind: 'connection-set' as const, id: set.connectionSetId, name: set.name })),
      ...bindings.flatMap((binding) => binding.connectionSetId && ids.has(binding.connectionSetId) ? [{ kind: 'source-binding' as const, id: binding.bindingId, name: `${binding.sourceKind} source`, via: binding.connectionSetId }] : []),
    ];
    let complete = true;
    for (const collection of ['schedules', 'session_integrations'] as const) {
      let after: string | undefined;
      let scanned = 0;
      do {
        const page = await this.options.store.list<ScheduleState | SessionIntegrationState>(ownerId, collection, { limit: 100, ...(after ? { after } : {}) });
        for (const { id, value } of page.data) {
          const target = 'schedule' in value ? value.schedule : value.target;
          if (target.connectionSetId && ids.has(target.connectionSetId)) consumers.push({ id, kind: collection === 'schedules' ? 'schedule' : 'session', name: 'schedule' in value ? value.schedule.name : id, via: target.connectionSetId, ...('schedule' in value ? { status: value.schedule.status } : {}) });
        }
        scanned += page.data.length;
        if (!page.has_more) break;
        if (scanned >= 1000) { complete = false; break; }
        after = page.data.at(-1)?.id;
      } while (after);
    }
    return { version: '1', connectionId: connection.connectionId, consumers: consumers.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), complete };
  }
}
