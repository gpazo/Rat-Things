import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { compileThingSpec, parseThingSpec } from '../../src/core/thing-service.js';

describe('published machine contracts', () => {
  it('accepts the checked-in create and version examples through the runtime parser', async () => {
    const create = await json('examples/thing-create.json') as {
      version: unknown;
    };
    const version = await json('examples/thing-version.json') as {
      version: unknown;
    };

    expect(create.version).toBe('1');
    expect(version.version).toBe('1');
    const parsedCreate = parseThingSpec(create, {
      allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
    });
    const parsedVersion = parseThingSpec(version, {
      allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
    });
    expect(compileThingSpec(parsedCreate)).toMatchObject({
      prompt: expect.stringContaining('Review support messages'),
      integrations: {
        connectionSet: 'customer-operations',
        connections: [
          { connection: 'slack-support', preset: 'read-only' },
          {
            connection: 'stripe-business',
            preset: 'read-write',
            denyOperations: ['stripe.refunds.create'],
          },
        ],
      },
    });
    expect(parsedVersion.trigger).toEqual({ kind: 'schedule', expression: 'rate(30 minutes)' });
  });

  it('keeps the complete published API and installed API Gateway routes in lockstep', async () => {
    const openapi = await json('spec/openapi.json') as {
      paths: Record<string, Record<string, unknown>>;
    };
    const terraform = await readFile('infra/modules/agent-runner/api.tf', 'utf8');
    const documentedRoutes = new Set<string>();
    const operationIds = new Set<string>();
    for (const [path, pathItem] of Object.entries(openapi.paths)) {
      for (const method of ['get', 'post']) {
        const operation = pathItem[method] as { operationId?: string } | undefined;
        if (!operation) continue;
        documentedRoutes.add(`${method.toUpperCase()} ${path}`);
        if (operation.operationId) {
          expect(operationIds.has(operation.operationId)).toBe(false);
          operationIds.add(operation.operationId);
        }
      }
    }
    const installedRoutes = new Set(
      [...terraform.matchAll(/"(GET|POST) ([^"$]+)"/g)]
        .map((match) => `${match[1]} ${match[2]}`),
    );
    expect([...documentedRoutes].sort()).toEqual([...installedRoutes].sort());
    expect(operationIds.size).toBe(documentedRoutes.size);
  });

  it('contains no dangling local OpenAPI references', async () => {
    const openapi = await json('spec/openapi.json') as Record<string, unknown>;
    const references: string[] = [];
    collectReferences(openapi, references);
    for (const reference of references.filter((candidate) => candidate.startsWith('#/'))) {
      let resolved: unknown = openapi;
      for (const segment of reference.slice(2).split('/')) {
        const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
        resolved = isObject(resolved) ? resolved[key] : undefined;
      }
      expect(resolved, `missing OpenAPI reference ${reference}`).not.toBeUndefined();
    }
    expect(new Set(references.filter((candidate) => candidate.startsWith('/schemas/')))).toEqual(
      new Set([
        '/schemas/thing-v1.json',
        '/schemas/thing-version-v1.json',
      ]),
    );
  });

  it('publishes aligned schema identifiers and strict top-level Thing fields', async () => {
    const [thing, create, version] = await Promise.all([
      json('spec/schemas/thing-v1.json'),
      json('spec/schemas/thing-create-v1.json'),
      json('spec/schemas/thing-version-v1.json'),
    ]) as Array<{
      $id: string;
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, unknown>;
      $ref?: string;
      $defs?: Record<string, Record<string, unknown>>;
    }>;
    expect(thing?.$id).toMatch(/thing-v1\.json$/);
    expect(create?.$id).toMatch(/thing-create-v1\.json$/);
    expect(create?.$ref).toBe('thing-v1.json');
    expect(version?.$id).toMatch(/thing-version-v1\.json$/);
    expect(thing?.additionalProperties).toBe(false);
    expect(new Set(thing?.required)).toEqual(new Set(['version', 'name', 'goal', 'trigger']));
    expect(Object.keys(thing?.properties ?? {}).sort()).toEqual([
      'agent',
      'connections',
      'deliver',
      'execution',
      'goal',
      'metadata',
      'name',
      'repository',
      'trigger',
      'version',
    ]);
    expect(thing?.$defs?.execution?.properties).toMatchObject({
      timeoutSeconds: { type: 'integer', minimum: 30, maximum: 28_000 },
    });
    expect(thing?.$defs?.connections?.anyOf).toEqual([
      { required: ['set'] },
      { required: ['accounts'], properties: { accounts: { minItems: 1 } } },
    ]);
    expect(thing?.$defs?.repository?.properties).not.toHaveProperty('credentialSecretArn');
  });

  it('publishes typed success responses for version history and Thing runs', async () => {
    const openapi = await json('spec/openapi.json') as {
      paths: Record<string, Record<string, {
        responses?: Record<string, {
          content?: { 'application/json'?: { schema?: Record<string, unknown> } };
        }>;
      }>>;
      components: { schemas: Record<string, unknown> };
    };

    expect(
      openapi.paths['/v1/things/{thingId}/versions']?.get?.responses?.['200']
        ?.content?.['application/json']?.schema,
    ).toMatchObject({
      properties: {
        versions: {
          items: { $ref: '#/components/schemas/ThingVersionSummary' },
        },
      },
    });
    expect(
      openapi.paths['/v1/things/{thingId}/versions/{revision}']?.get?.responses?.['200']
        ?.content?.['application/json']?.schema,
    ).toEqual({ $ref: '#/components/schemas/ThingVersion' });
    expect(
      openapi.paths['/v1/things/{thingId}/run']?.post?.responses?.['202']
        ?.content?.['application/json']?.schema,
    ).toEqual({ $ref: '#/components/schemas/RunReceipt' });
    expect(openapi.components.schemas).toMatchObject({
      ThingVersionSummary: expect.any(Object),
      ThingVersion: expect.any(Object),
      RunReceipt: expect.any(Object),
    });
  });
});

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function collectReferences(value: unknown, references: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return;
  }
  if (!isObject(value)) return;
  if (typeof value.$ref === 'string') references.push(value.$ref);
  for (const item of Object.values(value)) collectReferences(item, references);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
