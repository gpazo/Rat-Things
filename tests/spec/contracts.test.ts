import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ratThingsDiscovery } from '../../src/app/discovery.js';
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
      prompt: expect.stringContaining('Do not use external services'),
      agent: {
        sandbox: 'read-only',
        capabilities: {
          profile: 'read-only',
          networkAccess: false,
          webSearch: 'disabled',
          computerUse: 'disabled',
        },
      },
      destinations: [{ kind: 'none' }],
    });
    expect(compileThingSpec(parsedCreate)).not.toHaveProperty('integrations');
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

  it('makes configured OAuth application ARNs available to the refresh broker in MicroVMs', async () => {
    const [microvm, iam] = await Promise.all([
      readFile('infra/modules/agent-runner/microvm.tf', 'utf8'),
      readFile('infra/modules/agent-runner/iam.tf', 'utf8'),
    ]);
    expect(microvm).toContain('length(var.integration_oauth_app_secret_arns) > 0');
    expect(microvm).toContain('key   = "INTEGRATION_OAUTH_APP_SECRET_ARNS"');
    const workerPolicy = iam.slice(iam.indexOf('data "aws_iam_policy_document" "worker"'));
    expect(workerPolicy).toContain('sid       = "OAuthApplications"');
    expect(workerPolicy).toContain('resources = local.integration_oauth_app_secret_arns');
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

  it('keeps installed discovery valid against its strict OpenAPI schema', async () => {
    const openapi = await json('spec/openapi.json') as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const schema = openapi.components.schemas.Discovery;
    if (!schema) {
      throw new Error('OpenAPI components.schemas.Discovery is missing');
    }
    expect(validateJsonSchema(ratThingsDiscovery(), schema, openapi as unknown as Record<string, unknown>))
      .toEqual([]);
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
    expect(thing?.$id).toBe('thing-v1.json');
    expect(create?.$id).toBe('thing-create-v1.json');
    expect(create?.$ref).toBe('thing-v1.json');
    expect(version?.$id).toBe('thing-version-v1.json');
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
        security?: unknown[];
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
    ).toEqual({ $ref: '#/components/schemas/ThingRunReceipt' });
    expect(openapi.components.schemas).toMatchObject({
      ThingVersionSummary: expect.any(Object),
      ThingVersion: expect.any(Object),
      RunReceipt: expect.any(Object),
      ThingRunReceipt: expect.any(Object),
    });
  });

  it('types every JSON success response in the authenticated control API', async () => {
    const openapi = await json('spec/openapi.json') as {
      paths: Record<string, Record<string, {
        security?: unknown[];
        responses?: Record<string, {
          content?: { 'application/json'?: { schema?: unknown } };
        }>;
      }>>;
    };

    for (const [path, pathItem] of Object.entries(openapi.paths)) {
      if (!path.startsWith('/v1/') || path.startsWith('/v1/shares/')) continue;
      for (const method of ['get', 'post']) {
        const operation = pathItem[method];
        if (!operation) continue;
        if (Array.isArray(operation.security) && operation.security.length === 0) continue;
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (!/^2\d\d$/.test(status)) continue;
          expect(
            response.content?.['application/json']?.schema,
            `${method.toUpperCase()} ${path} ${status} has no JSON success schema`,
          ).toBeDefined();
        }
      }
    }
  });

  it('keeps the agent quickstart progressive and aligned with installed routes', async () => {
    const [guide, siteBuilder, docsConfig, openapi] = await Promise.all([
      readFile('docs/agents.md', 'utf8'),
      readFile('scripts/build-pages.mjs', 'utf8'),
      json('site/docs.json'),
      json('spec/openapi.json'),
    ]) as [string, string, {
      groups: Array<{ title: string; documents: string[] }>;
      archive: string[];
      agentCorpusExclude: string[];
    }, {
      paths: Record<string, unknown>;
    }];

    expect(docsConfig.groups.find((group) => group.title === 'Choose your path')?.documents)
      .toContain('agents.md');
    expect(docsConfig.groups.find((group) => group.title === 'Choose your path')?.documents?.[0])
      .toBe('operating-model.md');
    expect(docsConfig.archive).toEqual(expect.arrayContaining([
      'grok-bot-0.18-port-audit.md',
      'grok-bot-current-comparison.md',
    ]));
    expect(docsConfig.agentCorpusExclude).toContain('status-and-roadmap.md');
    expect(siteBuilder).toContain('## Agent quickstart');
    expect(siteBuilder).toContain('Do not load the full corpus for a simple Thing run');
    expect(siteBuilder).toContain('Every accepted execution returns one Run');
    expect(guide).toContain('Prefer the Thing lifecycle for reusable work');
    expect(guide).toContain('Go deeper only when the task needs it');
    expect(guide).toContain('not a Thing trigger in v1');
    expect(guide).toContain('skills, apps, or MCP');
    expect(guide).toContain('engineering preview');
    expect(guide).toContain('do not have idempotency keys in v1');

    const documentedPaths = new Set(
      [...guide.matchAll(/`(?:GET|POST) (\/[^`\s]+)/g)]
        .map((match) => match[1]?.split('?')[0])
        .filter((path): path is string => Boolean(path)),
    );
    for (const path of documentedPaths) {
      expect(openapi.paths, `agent guide route ${path} is absent from OpenAPI`).toHaveProperty(path);
    }
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

function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  path = '$',
): string[] {
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    let resolved: unknown = root;
    for (const segment of schema.$ref.slice(2).split('/')) {
      resolved = isObject(resolved) ? resolved[segment] : undefined;
    }
    return isObject(resolved)
      ? validateJsonSchema(value, resolved, root, path)
      : [`${path}: unresolved ${schema.$ref}`];
  }
  if ('const' in schema && value !== schema.const) return [`${path}: expected constant ${String(schema.const)}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${path}: value is outside enum`];
  if (schema.type === 'object') {
    if (!isObject(value)) return [`${path}: expected object`];
    const errors: string[] = [];
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) errors.push(`${path}.${key}: required`);
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key}: additional property`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value && isObject(child)) {
        errors.push(...validateJsonSchema(value[key], child, root, `${path}.${key}`));
      }
    }
    return errors;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    if (!isObject(schema.items)) return [];
    return value.flatMap((item, index) => validateJsonSchema(item, schema.items as Record<string, unknown>, root, `${path}[${index}]`));
  }
  if (schema.type === 'string' && typeof value !== 'string') return [`${path}: expected string`];
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [`${path}: expected boolean`];
  if (schema.type === 'number' && typeof value !== 'number') return [`${path}: expected number`];
  if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path}: expected integer`];
  return [];
}
