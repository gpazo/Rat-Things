import { createHash } from 'node:crypto';
import type { AgentResource } from '../../src/core/agents-ports.js';
import type { AgentListParams } from '../../src/domain/agents-api.js';
import type {
  ExecutionCommand,
  ExecutionCommandRequest,
  ExecutionCommandTarget,
} from '../../src/core/execution-command-planning.js';

export type Write = {
  resource: AgentResource<unknown>;
  expectedRevision: number;
};

export type Operation =
  | {
      kind: 'get';
      ownerId: string;
      collection: string;
      id: string;
    }
  | {
      kind: 'list';
      ownerId: string;
      collection: string;
      query: AgentListParams;
    }
  | {
      kind: 'put';
      resource: AgentResource<unknown>;
      expectedRevision: number;
    }
  | {
      kind: 'commit';
      writes: Write[];
    }
  | {
      kind: 'delete';
      resource: AgentResource<unknown>;
      writes: Write[];
    }
  | {
      kind: 'perform';
      request: ExecutionCommandRequest;
      deadline: number;
      invokedAt: number;
    };

export type SavedError = {
  name: string;
  message: string;
  status?: number;
  code?: string | null;
  param?: string | null;
};

export type Outcome =
  | {
      kind: 'returned';
      value:
        | {
            type: 'undefined';
          }
        | {
            type: 'json';
            value: unknown;
          };
    }
  | {
      kind: 'threw';
      error: SavedError;
    };

export type Gate = {
  id: string;
  actor: string;
  operation: Operation;
} & (
  | {
      phase: 'invoked';
    }
  | {
      phase: 'applied' | 'ready' | 'lost';
      outcome: Outcome;
    }
);

export type Actor = {
  id: string;
  status: 'new' | 'waiting' | 'done' | 'dead';
  calls: number;
  completion?: Outcome;
};

export type Choice =
  | {
      kind: 'start' | 'resume' | 'crash';
      actor: string;
    }
  | {
      kind: 'apply';
      op: string;
      result: 'normal' | 'fail-before';
    }
  | {
      kind: 'ack';
      op: string;
      delivery: 'normal' | 'error' | 'lost';
    }
  | {
      kind: 'advance';
      to: number;
    };

export type Fixture = {
  actors: string[];
  restarts: number;
  deadline: number;
  staleTarget: boolean;
  faultModel: 'correct' | 'unsafe-claim-cas';
  maxFaults: number;
  maxTime: number;
};

export type Effect = {
  command: string;
  actor: string;
  invokedAt: number;
  appliedAt: number;
  deadline: number;
};

export type World = {
  now: number;
  faults: number;
  resources: AgentResource<unknown>[];
  actors: Actor[];
  gates: Gate[];
  effects: Effect[];
  claims: string[];
  invocations: {
    actor: string;
    target: ExecutionCommandTarget;
    operation: Operation;
  }[];
};

export type Violation = {
  property:
    | 'at-most-once'
    | 'claim-before-effect'
    | 'deadline-at-invocation'
    | 'stale-target'
    | 'atomic-response';
  command: 'command';
};

export type Provenance = {
  sources: Record<string, string>;
  runtime: {
    node: string;
    tsx: string;
    platform: string;
    arch: string;
  };
  git: string;
};

export type Event = {
  index: number;
  choice: Choice;
  observations: unknown[];
  world: World;
  worldHash: string;
  previousHash: string;
  hash: string;
};

export type Result = {
  status: 'violation' | 'completed' | 'parked' | 'budget-exhausted';
  violations: Violation[];
  steps: number;
  effects: number;
};

export type Trace = {
  format: 1;
  fixture: Fixture;
  provenance: Provenance;
  seed: number;
  stepLimit: number;
  events: Event[];
  result: Result;
  parent?: {
    digest: string;
    at: number;
    prefixHash: string;
  };
};

export const target: ExecutionCommandTarget = {
  runId: 'run',
  execution: { backend: 'microvm', id: 'vm', generation: 'generation' },
};

export const command = (fixture: Fixture): AgentResource<ExecutionCommand> => ({
  id: 'command',
  ownerId: 'owner',
  collection: 'execution_commands_run',
  createdAt: 0,
  revision: 1,
  value: {
    status: 'queued',
    deadline: fixture.deadline,
    target,
    request: {
      method: 'POST',
      path: '/agent-runtime/v1/runs/run/interrupt',
      body: { turnId: 'synthetic-turn' },
    },
  },
});

export const defaultFixture = (overrides: Partial<Fixture> = {}): Fixture => ({
  actors: ['a', 'b', 'c'],
  restarts: 1,
  deadline: 20,
  staleTarget: false,
  faultModel: 'correct',
  maxFaults: 3,
  maxTime: 40,
  ...overrides,
});

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  throw new Error('Non-JSON value in trace.');
}

export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

export const sourceIdentity = (provenance: Provenance) => ({
  sources: provenance.sources,
  runtime: provenance.runtime,
});

export const rootHash = (fixture: Fixture, provenance: Provenance) =>
  hash({ format: 1, fixture, provenance: sourceIdentity(provenance) });

export const returned = (value: unknown): Outcome => ({
  kind: 'returned',
  value: value === undefined ? { type: 'undefined' } : { type: 'json', value: structuredClone(value) },
});

function canStartActor(actor: Actor, actors: Actor[]): boolean {
  return (
    actor.status === 'new' &&
    (!actor.id.startsWith('restart-') || actors.some((other) => other.status === 'dead'))
  );
}

function isTerminalActor(actor: Actor, actors: Actor[]): boolean {
  return (
    ['done', 'dead'].includes(actor.status) ||
    (actor.status === 'new' &&
      actor.id.startsWith('restart-') &&
      !actors.some((other) => other.status === 'dead'))
  );
}

function isNormalChoice(choice: Choice): boolean {
  return (
    choice.kind !== 'advance' &&
    choice.kind !== 'crash' &&
    !(choice.kind === 'apply' && choice.result !== 'normal') &&
    !(choice.kind === 'ack' && choice.delivery !== 'normal')
  );
}

export function enabled(world: World, fixture: Fixture): Choice[] {
  const choices: Choice[] = [];
  for (const actor of world.actors) {
    if (canStartActor(actor, world.actors)) {
      choices.push({ kind: 'start', actor: actor.id });
    }
    if (actor.status === 'waiting') {
      if (world.gates.some((g) => g.actor === actor.id && g.phase === 'ready')) {
        choices.push({ kind: 'resume', actor: actor.id });
      }
      if (world.faults < fixture.maxFaults) {
        choices.push({ kind: 'crash', actor: actor.id });
      }
    }
  }
  for (const gate of world.gates) {
    if (gate.phase === 'invoked') {
      choices.push({ kind: 'apply', op: gate.id, result: 'normal' });
      if (world.faults < fixture.maxFaults) {
        choices.push({ kind: 'apply', op: gate.id, result: 'fail-before' });
      }
    }
    if (gate.phase === 'applied') {
      choices.push({ kind: 'ack', op: gate.id, delivery: 'normal' });
      if (world.faults < fixture.maxFaults) {
        choices.push(
          { kind: 'ack', op: gate.id, delivery: 'error' },
          { kind: 'ack', op: gate.id, delivery: 'lost' },
        );
      }
    }
  }
  if (world.actors.some((a) => a.status === 'waiting')) {
    for (const to of new Set([world.now + 1, fixture.deadline - 1, fixture.deadline, fixture.deadline + 1])) {
      if (to > world.now && to <= fixture.maxTime) {
        choices.push({ kind: 'advance', to });
      }
    }
  }
  return choices.sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

export function violations(world: World, fixture: Fixture): Violation[] {
  const properties = new Set<Violation['property']>();
  if (world.effects.length > 1) {
    properties.add('at-most-once');
  }
  for (const { actor, operation } of world.invocations) {
    if (operation.kind === 'perform') {
      if (!world.claims.includes(actor)) {
        properties.add('claim-before-effect');
      }
      if (operation.invokedAt >= operation.deadline) {
        properties.add('deadline-at-invocation');
      }
      if (fixture.staleTarget) {
        properties.add('stale-target');
      }
    }
  }
  if (
    world.resources.some((r) => r.collection === 'execution_responses_run') &&
    world.resources.some((r) => r.collection === 'execution_commands_run')
  ) {
    properties.add('atomic-response');
  }
  return [...properties].sort().map((property) => ({ property, command: 'command' }));
}

export function resultFor(world: World, fixture: Fixture, steps: number, limit: number): Result {
  const found = violations(world, fixture);
  const terminal = world.actors.every((actor) => isTerminalActor(actor, world.actors));
  let status: Result['status'];
  if (found.length) {
    status = 'violation';
  } else if (terminal) {
    status = 'completed';
  } else if (!enabled(world, fixture).length) {
    status = 'parked';
  } else {
    status = steps >= limit ? 'budget-exhausted' : 'parked';
  }
  return { status, violations: found, steps, effects: world.effects.length };
}

export function randomNext(state: number): number {
  let x = state | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

export function selectChoice(
  world: World,
  fixture: Fixture,
  state: number,
  safe = false,
): {
  choice?: Choice;
  state: number;
} {
  const next = randomNext(state || 1);
  const all = enabled(world, fixture);
  const normal = all.filter(isNormalChoice);
  const choices = (safe || next % 20 !== 0) && normal.length ? normal : all;
  const choice = choices[randomNext(next) % choices.length];
  return { ...(choice ? { choice } : {}), state: next };
}
