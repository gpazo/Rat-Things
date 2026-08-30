import type { RoutineService } from '../core/routine-service.js';
import type { ThingService } from '../core/thing-service.js';
import type { IntegrationAccessRequest } from '../domain/capabilities.js';
import type { ConnectionService } from '../plugins/connection-service.js';

const MAX_SCANNED_DEFINITIONS = 1_000;

export type ConnectionConsumerKind =
  | 'thing'
  | 'routine'
  | 'connection-set'
  | 'source-binding';

export interface ConnectionConsumer {
  kind: ConnectionConsumerKind;
  id: string;
  name: string;
  status?: string;
  stage?: 'draft' | 'active';
  via?: string;
}

export interface ConnectionConsumerResult {
  version: '1';
  connectionId: string;
  consumers: ConnectionConsumer[];
  complete: boolean;
}

export interface ConnectionConsumerServiceOptions {
  connections: Pick<ConnectionService, 'get' | 'listSets' | 'listSourceBindings'>;
  things: Pick<ThingService, 'list' | 'getPublic'>;
  routines: Pick<RoutineService, 'list' | 'getRequest'>;
}

/**
 * Derives owner-scoped dependency edges from their authoritative definitions.
 * It never reads credentials and is reachable only from the authenticated control plane.
 */
export class ConnectionConsumerService {
  public constructor(private readonly options: ConnectionConsumerServiceOptions) {}

  public async list(
    ownerId: string,
    connectionIdOrAlias: string,
  ): Promise<ConnectionConsumerResult> {
    const { connection } = await this.options.connections.get(ownerId, connectionIdOrAlias);
    const [sets, sourceBindings] = await Promise.all([
      this.options.connections.listSets(ownerId),
      this.options.connections.listSourceBindings(ownerId),
    ]);
    const selectedSets = sets.filter((set) => set.connectionIds.includes(connection.connectionId));
    const selectedSetNames = new Set(selectedSets.flatMap((set) => [set.connectionSetId, set.name]));
    const consumers: ConnectionConsumer[] = selectedSets.map((set) => ({
      kind: 'connection-set',
      id: set.connectionSetId,
      name: set.name,
    }));

    for (const binding of sourceBindings) {
      if (!binding.connectionSetId || !selectedSetNames.has(binding.connectionSetId)) continue;
      consumers.push({
        kind: 'source-binding',
        id: binding.bindingId,
        name: `${binding.sourceKind} source`,
        via: binding.connectionSetId,
      });
    }

    let scanned = 0;
    let complete = true;
    let thingToken: string | undefined;
    do {
      const page = await this.options.things.list(ownerId, 100, thingToken);
      const available = MAX_SCANNED_DEFINITIONS - scanned;
      const summaries = page.items.slice(0, available);
      scanned += summaries.length;
      if (summaries.length < page.items.length) complete = false;
      const things = await Promise.all(summaries.map(
        (summary) => this.options.things.getPublic(ownerId, summary.thingId),
      ));
      for (const thing of things) {
        const activeMatches = thing.active && selectsConnection(
          thing.active.spec.connections,
          connection.connectionId,
          connection.alias,
          selectedSetNames,
        );
        if (activeMatches) {
          consumers.push({
            kind: 'thing',
            id: thing.thingId,
            name: thing.active!.name,
            status: thing.status,
            stage: 'active',
          });
        }
        const hasDistinctDraft = !thing.active || thing.active.revision !== thing.draft.revision;
        if (hasDistinctDraft && selectsConnection(
          thing.draft.spec.connections,
          connection.connectionId,
          connection.alias,
          selectedSetNames,
        )) {
          consumers.push({
            kind: 'thing',
            id: thing.thingId,
            name: thing.draft.name,
            status: thing.status,
            stage: 'draft',
          });
        }
      }
      if (scanned >= MAX_SCANNED_DEFINITIONS && page.nextToken) complete = false;
      if (!complete) break;
      thingToken = page.nextToken;
    } while (thingToken);

    let routineToken: string | undefined;
    while (complete) {
      const page = await this.options.routines.list(ownerId, 100, routineToken);
      const available = MAX_SCANNED_DEFINITIONS - scanned;
      const routines = page.items.slice(0, available);
      scanned += routines.length;
      if (routines.length < page.items.length) complete = false;
      const requests = await Promise.all(routines.map(
        (routine) => this.options.routines.getRequest(ownerId, routine.routineId),
      ));
      for (const [index, routine] of routines.entries()) {
        const request = requests[index]!;
        if (!selectsConnection(
          request.integrations,
          connection.connectionId,
          connection.alias,
          selectedSetNames,
        )) continue;
        consumers.push({
          kind: 'routine',
          id: routine.routineId,
          name: routine.name,
          status: routine.status,
        });
      }
      if (scanned >= MAX_SCANNED_DEFINITIONS && page.nextToken) complete = false;
      if (!complete || !page.nextToken) break;
      routineToken = page.nextToken;
    }

    return {
      version: '1',
      connectionId: connection.connectionId,
      consumers: consumers.sort(compareConsumers),
      complete,
    };
  }
}

function selectsConnection(
  request: IntegrationAccessRequest | { set?: string; accounts?: Array<{ account: string }> } | undefined,
  connectionId: string,
  alias: string,
  selectedSets: ReadonlySet<string>,
): boolean {
  if (!request) return false;
  const selectors = request as {
    connectionSet?: string;
    connections?: Array<{ connection: string }>;
    set?: string;
    accounts?: Array<{ account: string }>;
  };
  const set = selectors.connectionSet ?? selectors.set;
  const accounts = selectors.connections?.map((candidate) => candidate.connection) ??
    selectors.accounts?.map((candidate) => candidate.account);
  return Boolean(
    (set && selectedSets.has(set)) ||
    accounts?.some((selector) => selector === connectionId || selector === alias),
  );
}

function compareConsumers(a: ConnectionConsumer, b: ConnectionConsumer): number {
  return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
