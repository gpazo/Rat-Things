import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ratThingsDiscovery } from '../../src/app/discovery.js';

describe('published machine contracts', () => {

  it('keeps the complete published API and installed API Gateway routes in lockstep', async () => {
    const openapi = await json('spec/openapi.json') as {
      paths: Record<string, Record<string, unknown>>;
    };
    const terraform = await readFile('infra/modules/agent-runner/api.tf', 'utf8');
    const documentedRoutes = new Set<string>();
    const operationIds = new Set<string>();
    for (const [path, pathItem] of Object.entries(openapi.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
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
      [...terraform.matchAll(/"(GET|POST|PUT|PATCH|DELETE) ([^"$]+)"/g)]
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
    expect(new Set(references.filter((candidate) => candidate.startsWith('/schemas/')).map((reference) => reference.split('#')[0]))).toEqual(
      new Set([
        '/schemas/agents-api.schema.json',
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

  it('types every JSON success response in the authenticated control API', async () => {
    const openapi = await json('spec/openapi.json') as {
      paths: Record<string, Record<string, {
        security?: unknown[];
        responses?: Record<string, {
          content?: { 'application/json'?: { schema?: unknown }; 'text/event-stream'?: { schema?: unknown }; 'application/octet-stream'?: { schema?: unknown } };
        }>;
      }>>;
    };

    for (const [path, pathItem] of Object.entries(openapi.paths)) {
      if (!path.startsWith('/v1/')) continue;
      for (const method of ['get', 'post']) {
        const operation = pathItem[method];
        if (!operation) continue;
        if (Array.isArray(operation.security) && operation.security.length === 0) continue;
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (!/^2\d\d$/.test(status)) continue;
          if (status === '204') continue;
          expect(
            response.content?.['application/json']?.schema ?? response.content?.['text/event-stream']?.schema ?? response.content?.['application/octet-stream']?.schema,
            `${method.toUpperCase()} ${path} ${status} has no success schema`,
          ).toBeDefined();
        }
      }
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
