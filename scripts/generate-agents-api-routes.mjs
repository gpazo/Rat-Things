import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

const routes = JSON.parse(await readFile('spec/agents-api-routes.json', 'utf8'));
await verifySdkRouteCoverage(routes);
const schema = JSON.parse(await readFile('spec/schemas/agents-api.schema.json', 'utf8'));
const schemaPath = '/schemas/agents-api.schema.json';
const ref = (name) => ({ $ref: `${schemaPath}#/definitions/AgentsApiContracts/properties/${name}` });
const errorSchema = {
  type: 'object', required: ['error'],
  properties: { error: {
    type: 'object', required: ['message', 'type', 'param', 'code'],
    properties: {
      message: { type: 'string' }, type: { type: 'string' },
      param: { type: ['string', 'null'] }, code: { type: ['string', 'null'] },
    },
  } },
};
const root = JSON.parse(await readFile('spec/openapi.json', 'utf8'));
root.tags = [
  ...root.tags.filter((tag) => !['Agents', 'Authentication', 'Spaces'].includes(tag.name)),
  { name: 'Agents', description: 'OpenAI Agents API resources served by the Lambda Web Function. Use api.agentsBaseUrl from /.well-known/rat-things (or the Terraform agents_api_base_url output) as the server for every Agents operation. The checked-in OpenAPI uses relative paths; deployments publish an OpenAPI document with the Web Function server attached.' },
  { name: 'Authentication', description: 'IAM-authenticated credentials for calling the Agents Web Function.' },
  { name: 'Spaces', description: 'IAM bootstrap operation for creating the initial space and manager binding.' },
];
root.components.securitySchemes.bearerAuth = {
  type: 'http', scheme: 'bearer', bearerFormat: 'Rat Things API key',
  description: 'Short-lived Rat Things API key issued by POST /v1/auth/tokens. Send it as an Authorization: Bearer token.',
};
root.paths[schemaPath] = { get: { operationId: 'getAgentsApiSchema', tags: ['Discovery'], security: [], responses: { 200: { description: 'Pinned OpenAI Agents API schemas', content: { 'application/schema+json': { schema: { type: 'object' } } } } } } };
for (const [method, path, input, output] of routes) {
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } }));
  if (method === 'GET' && input) {
    const rootDefinition = schema.definitions.AgentsApiContracts.properties[input];
    const definition = rootDefinition.$ref ? schema.definitions[rootDefinition.$ref.split('/').at(-1)] : rootDefinition;
    for (const [name, value] of Object.entries(definition.properties ?? {})) parameters.push({ name, in: 'query', schema: externalRefs(value) });
  }
  if (input === 'SessionEvents') parameters.push({ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Retries with the same key and events do not create another operation.' });
  const responseSchema = output?.endsWith('[]') ? {
    type: 'object', required: ['data', 'has_more', ...(output === 'EnvironmentFile[]' ? ['next'] : [])], properties: { ...(output === 'EnvironmentFile[]' ? { next: { type: ['string', 'null'] } } : { object: { const: 'list' } }), data: { type: 'array', items: ref(output.slice(0, -2)) }, has_more: { type: 'boolean' } },
  } : output === 'Binary' ? { type: 'string', format: 'binary' } : ref(output === 'SessionEventStream' ? 'SessionEvent' : output);
  if (['Trace[]', 'ConfigurationRevision[]', 'ToolAuthorization[]', 'AuthorizationTrace[]'].includes(output)) {
    responseSchema.required.push('first_id', 'last_id');
    responseSchema.properties.first_id = { type: ['string', 'null'] };
    responseSchema.properties.last_id = { type: ['string', 'null'] };
  }
  const contentType = output === 'Binary' ? 'application/octet-stream' : output === 'SessionEventStream' ? 'text/event-stream' : 'application/json';
  const content = { [contentType]: { schema: responseSchema } };
  if (input === 'SessionCreate') content['text/event-stream'] = { schema: ref('SessionEvent') };
  root.paths[path] ??= {};
  root.paths[path][method.toLowerCase()] = {
    tags: ['Agents'], security: [{ bearerAuth: [] }], operationId: `${method.toLowerCase()}_${path.replace(/^\/v1\//, '').replace(/[{}]/g, '').replaceAll('/', '_')}`,
    ...(parameters.length ? { parameters } : {}),
    ...(method === 'POST' && input ? { requestBody: { required: true, content: input.endsWith('Multipart') ? { 'multipart/form-data': { schema: multipartSchema(input) } } : { 'application/json': { schema: ref(input) } } } } : {}),
    responses: {
      [path.endsWith('/fork') ? 201 : output ? 200 : 204]: { description: output ? 'Successful response' : 'Events accepted', ...(output ? { content } : {}) },
      default: { description: 'OpenAI-shaped error response', content: { 'application/json': { schema: errorSchema } } },
    },
  };
}
// The deployment model catalog is Rat Things-specific rather than an SDK resource route.
root.paths['/v1/models'].get.security = [{ bearerAuth: [] }];
root.paths['/v1/auth/tokens'] = {
  post: {
    tags: ['Authentication'], operationId: 'issueAgentsApiToken', security: [{ awsSigV4: [] }],
    summary: 'Issue a short-lived Agents API key',
    description: 'Requires IAM authentication. The returned API key is a secret and expires after 15 minutes. Use its base_url and scopes with the Agents API.',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { scopes: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['api.agents.read', 'api.agents.write', 'api.responses.write', 'api.vaults.read', 'api.vaults.write', 'api.traces.read'] } } } } } } },
    responses: {
      200: { description: 'Short-lived API key. Treat api_key as a secret.', content: { 'application/json': { schema: { type: 'object', required: ['api_key', 'expires_at', 'base_url', 'scopes'], properties: { api_key: { type: 'string', writeOnly: true }, expires_at: { type: 'integer', description: 'Unix time in seconds.' }, base_url: { type: 'string', format: 'uri' }, scopes: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } } } },
      default: { description: 'OpenAI-shaped error response', content: { 'application/json': { schema: errorSchema } } },
    },
  },
};
root.paths['/v1/rat/spaces'] = {
  post: {
    tags: ['Spaces'], operationId: 'bootstrapRatSpace', security: [{ awsSigV4: [] }],
    summary: 'Create a space and bind its initial manager',
    description: 'Requires IAM authentication and api.agents.write scope. This bootstrap operation is the only space route exposed through the IAM control API. Resource operations use the Agents API endpoint advertised by discovery.',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'manager'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 128 }, manager: { type: 'object', required: ['issuer', 'subject'], additionalProperties: false, properties: { issuer: { type: 'string', format: 'uri', description: 'HTTPS OIDC issuer URL.' }, subject: { type: 'string', minLength: 1, maxLength: 1024 }, label: { type: 'string', minLength: 1, maxLength: 128 }, kind: { type: 'string', enum: ['human'], description: 'The bootstrap manager must be human; omitted defaults to human.' } } } } } } } },
    responses: {
      201: { description: 'Created space and manager binding', content: { 'application/json': { schema: { type: 'object', required: ['id', 'name', 'active'], properties: { id: { type: 'string' }, name: { type: 'string' }, active: { type: 'boolean', const: true } }, additionalProperties: false } } } },
      default: { description: 'OpenAI-shaped error response', content: { 'application/json': { schema: errorSchema } } },
    },
  },
};
await update('spec/openapi.json', `${JSON.stringify(root, null, 2)}\n`);

function externalRefs(value) {
  if (Array.isArray(value)) return value.map(externalRefs);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === '$ref' && child.startsWith('#/') ? `${schemaPath}${child}` : externalRefs(child)]));
}

function multipartSchema(input) {
  if (input === 'UploadedFileMultipart') {
    const root = schema.definitions.AgentsApiContracts.properties.UploadedFileCreate;
    const definition = externalRefs(root.$ref ? schema.definitions[root.$ref.split('/').at(-1)] : root);
    return { ...definition, required: [...(definition.required ?? []), 'file'], properties: { ...definition.properties, file: { type: 'string', format: 'binary' } } };
  }
  return { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } }, ...(input === 'SkillVersionMultipart' ? { default: { type: 'boolean' } } : {}) } };
}

async function update(path, value) {
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== value) throw new Error(`${path} is stale; run npm run agents-api:routes`);
  } else await writeFile(path, value);
}

/** Compare against SDK operations independently of our hand-maintained inventory. */
async function verifySdkRouteCoverage(routes) {
  const files = [
    ...await sourceFiles('node_modules/openai/src/resources/beta/agents'),
    ...await sourceFiles('node_modules/openai/src/resources/skills'),
    'node_modules/openai/src/resources/files.ts',
  ];
  const expected = new Set((await Promise.all(files.map(async (file) =>
    sdkRoutes(file, await readFile(file, 'utf8')),
  ))).flat());
  const actual = new Set(routes.map(([method, path]) => `${method} ${normalizeRoute(path)}`));
  const missing = [...expected].filter((route) => !actual.has(route));
  // Documented operations not yet present in the pinned SDK remain explicit.
  const documented = new Set(['GET /agents/sessions/{}/traces', 'POST /agents/sessions/{}/fork', 'GET /agents/sessions/{}/lineage', 'GET /agents/sessions/{}/runtime', 'GET /agents/sessions/import', 'POST /agents/sessions/import']);
  for (const path of ["/v1/agents/{agent_id}/revisions", "/v1/vaults/{vault_id}/revisions", "/v1/vaults/{vault_id}/credentials/{credential_id}/revisions", "/v1/agents/sessions/{session_id}/configurations"]) {
    documented.add(`GET ${normalizeRoute(path)}`);
    documented.add(`GET ${normalizeRoute(path)}/{}`);
  }
  for (const path of ["/v1/agents/sessions/{session_id}/authorizations", "/v1/agents/sessions/{session_id}/authorizations/{authorization_id}", "/v1/agents/sessions/{session_id}/authorizations/otlp"]) documented.add(`GET ${normalizeRoute(path)}`);
  const extra = [...actual].filter((route) => !expected.has(route) && !documented.has(route));
  missing.push(...[...documented].filter(route => !actual.has(route)));
  if (!expected.size || actual.size !== routes.length || missing.length || extra.length) {
    throw new Error(`Agents API route inventory differs from the pinned SDK: ${JSON.stringify({ missing, extra, duplicateRoutes: routes.length - actual.size })}`);
  }
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sourceFiles(join(directory, entry.name))
    : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []))).flat();
}

function normalizeRoute(path) {
  return path.replaceAll(/\$\{[^}]+\}|\{[^}]+\}/g, '{}').replace(/^\/v1\//, '/');
}

function sdkRoutes(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const routes = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'this._client') {
      const method = node.expression.name.text;
      if (['get', 'post', 'delete', 'patch', 'put', 'getAPIList'].includes(method)) {
        let path = node.arguments[0];
        if (path && ts.isTaggedTemplateExpression(path)) path = path.template;
        if (!path || !(ts.isStringLiteral(path) || ts.isNoSubstitutionTemplateLiteral(path) || ts.isTemplateExpression(path))) {
          throw new Error(`Unrecognized SDK route in ${file}; review route coverage extraction`);
        }
        routes.push(`${method === 'getAPIList' ? 'GET' : method.toUpperCase()} ${normalizeRoute(path.getText(source).slice(1, -1))}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return routes;
}
