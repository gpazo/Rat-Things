import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Choice, Provenance, Trace } from './model.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const maxBytes = 32 * 1024 * 1024;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  requireCondition(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => [...required, ...optional].includes(key)),
    'Unexpected or missing artifact fields.',
  );
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function parseChoice(value: unknown): Choice {
  requireCondition(record(value), 'Invalid choice.');
  switch (value.kind) {
    case 'start':
    case 'crash':
    case 'resume':
      keys(value, ['kind', 'actor']);
      requireCondition(
        typeof value.actor === 'string' && /^(?:[abc]|restart-[12])$/.test(value.actor),
        'Invalid actor.',
      );
      break;
    case 'apply':
      keys(value, ['kind', 'op', 'result']);
      requireCondition(
        typeof value.result === 'string' && ['normal', 'fail-before'].includes(value.result),
        'Invalid apply result.',
      );
      break;
    case 'ack':
      keys(value, ['kind', 'op', 'delivery']);
      requireCondition(
        typeof value.delivery === 'string' && ['normal', 'error', 'lost'].includes(value.delivery),
        'Invalid acknowledgement.',
      );
      break;
    case 'advance':
      keys(value, ['kind', 'to']);
      requireCondition(integer(value.to, 1, 1000), 'Invalid virtual time.');
      break;
    default:
      throw new Error('Invalid choice kind.');
  }
  if ('op' in value) {
    requireCondition(
      typeof value.op === 'string' && /^(?:[abc]|restart-[12]):[1-9]\d{0,3}$/.test(value.op),
      'Invalid operation id.',
    );
  }
  return value as Choice;
}

export function parseTrace(value: unknown): Trace {
  requireCondition(record(value), 'Expected a trace object.');
  keys(value, ['format', 'fixture', 'provenance', 'seed', 'stepLimit', 'events', 'result'], ['parent']);
  requireCondition(
    value.format === 1 && integer(value.seed, 1, 0xffffffff) && integer(value.stepLimit, 1, 2000),
    'Invalid format, seed, or step limit.',
  );
  const fixture = value.fixture;
  requireCondition(record(fixture), 'Invalid fixture.');
  keys(fixture, ['actors', 'restarts', 'deadline', 'staleTarget', 'faultModel', 'maxFaults', 'maxTime']);
  requireCondition(
    Array.isArray(fixture.actors) &&
      fixture.actors.length >= 1 &&
      fixture.actors.length <= 3 &&
      fixture.actors.every((id) => ['a', 'b', 'c'].includes(id)) &&
      new Set(fixture.actors).size === fixture.actors.length,
    'Invalid actor workload.',
  );
  requireCondition(
    integer(fixture.restarts, 0, 2) &&
      integer(fixture.deadline, 1, 500) &&
      integer(fixture.maxTime, fixture.deadline, 1000) &&
      integer(fixture.maxFaults, 0, 10) &&
      typeof fixture.staleTarget === 'boolean' &&
      typeof fixture.faultModel === 'string' &&
      ['correct', 'unsafe-claim-cas'].includes(fixture.faultModel),
    'Invalid fixture bounds.',
  );
  const provenance = value.provenance;
  requireCondition(record(provenance), 'Invalid provenance.');
  keys(provenance, ['sources', 'runtime', 'git']);
  requireCondition(
    record(provenance.sources) &&
      Object.keys(provenance.sources).length <= 5000 &&
      Object.entries(provenance.sources).every(([path, identity]) => path.length < 500 && digest(identity)) &&
      typeof provenance.git === 'string' &&
      provenance.git.length < 1000,
    'Invalid source identities.',
  );
  requireCondition(record(provenance.runtime), 'Invalid runtime.');
  keys(provenance.runtime, ['node', 'tsx', 'platform', 'arch']);
  requireCondition(
    Object.values(provenance.runtime).every((item) => typeof item === 'string' && item.length < 100),
    'Invalid runtime identity.',
  );
  requireCondition(
    Array.isArray(value.events) && value.events.length <= value.stepLimit,
    'Invalid event bounds.',
  );
  for (const event of value.events) {
    requireCondition(record(event), 'Invalid event.');
    keys(event, ['index', 'choice', 'observations', 'world', 'worldHash', 'previousHash', 'hash']);
    requireCondition(
      integer(event.index, 1, 2000) &&
        Array.isArray(event.observations) &&
        event.observations.length <= 20 &&
        record(event.world) &&
        digest(event.worldHash) &&
        digest(event.previousHash) &&
        digest(event.hash),
      'Invalid event shape.',
    );
    parseChoice(event.choice);
  }
  requireCondition(record(value.result), 'Invalid result.');
  keys(value.result, ['status', 'violations', 'steps', 'effects']);
  requireCondition(
    typeof value.result.status === 'string' &&
      ['violation', 'completed', 'parked', 'budget-exhausted'].includes(value.result.status) &&
      Array.isArray(value.result.violations) &&
      value.result.violations.length <= 5 &&
      integer(value.result.steps, 0, 2000) &&
      integer(value.result.effects, 0, 5),
    'Invalid result bounds.',
  );
  for (const violation of value.result.violations) {
    requireCondition(
      record(violation) &&
        Object.keys(violation).length === 2 &&
        violation.command === 'command' &&
        typeof violation.property === 'string' &&
        [
          'at-most-once',
          'claim-before-effect',
          'deadline-at-invocation',
          'stale-target',
          'atomic-response',
        ].includes(violation.property),
      'Invalid violation.',
    );
  }
  if (value.parent !== undefined) {
    requireCondition(record(value.parent), 'Invalid parent proof.');
    keys(value.parent, ['digest', 'at', 'prefixHash']);
    requireCondition(
      digest(value.parent.digest) &&
        digest(value.parent.prefixHash) &&
        integer(value.parent.at, 0, value.events.length),
      'Invalid parent proof.',
    );
  }
  return value as Trace;
}

export async function provenance(): Promise<Provenance> {
  async function files(path: string): Promise<string[]> {
    const entries = await readdir(join(root, path), { withFileTypes: true });
    return (
      await Promise.all(
        entries.map(async (entry) =>
          entry.isDirectory() ? files(`${path}/${entry.name}`) : [`${path}/${entry.name}`],
        ),
      )
    ).flat();
  }
  const paths = [
    ...(await files('src')),
    ...(await files('testing/time-travel')),
    'tests/agents/fixtures.ts',
    'package-lock.json',
    'package.json',
    'tsconfig.json',
    'spec/schemas/agents-api.schema.json',
  ].sort();
  const sources = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ]),
    ),
  );
  let git = 'unavailable';
  try {
    git = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  const tsx = JSON.parse(await readFile(join(root, 'node_modules/tsx/package.json'), 'utf8')) as {
    version: string;
  };
  return {
    sources,
    runtime: { node: process.version, tsx: tsx.version, platform: process.platform, arch: process.arch },
    git,
  };
}

export async function readTrace(path: string): Promise<Trace> {
  requireCondition((await stat(path)).size <= maxBytes, 'Trace exceeds 32 MiB.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Trace is not valid JSON.');
  }
  return parseTrace(parsed);
}

export async function save(path: string, value: unknown): Promise<void> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  requireCondition(Buffer.byteLength(bytes) <= maxBytes, 'Artifact exceeds 32 MiB.');
  await writeFile(path, bytes, { flag: 'wx' });
}
