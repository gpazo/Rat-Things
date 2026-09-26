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
root.tags = [...root.tags.filter((tag) => tag.name !== 'Agents'), { name: 'Agents', description: 'OpenAI Agents API resources implemented in this AWS deployment. Streaming uses agents_api_base_url.' }];
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
  if (output === 'Trace[]') {
    responseSchema.required.push('first_id', 'last_id');
    responseSchema.properties.first_id = { type: ['string', 'null'] };
    responseSchema.properties.last_id = { type: ['string', 'null'] };
  }
  const contentType = output === 'Binary' ? 'application/octet-stream' : output === 'SessionEventStream' ? 'text/event-stream' : 'application/json';
  const content = { [contentType]: { schema: responseSchema } };
  if (input === 'SessionCreate') content['text/event-stream'] = { schema: ref('SessionEvent') };
  root.paths[path] ??= {};
  root.paths[path][method.toLowerCase()] = {
    tags: ['Agents'], operationId: `${method.toLowerCase()}_${path.replace(/^\/v1\//, '').replace(/[{}]/g, '').replaceAll('/', '_')}`,
    ...(parameters.length ? { parameters } : {}),
    ...(method === 'POST' && input ? { requestBody: { required: true, content: input.endsWith('Multipart') ? { 'multipart/form-data': { schema: multipartSchema(input) } } : { 'application/json': { schema: ref(input) } } } } : {}),
    responses: {
      [output ? 200 : 204]: { description: output ? 'Successful response' : 'Events accepted', ...(output ? { content } : {}) },
      default: { description: 'OpenAI-shaped error response', content: { 'application/json': { schema: errorSchema } } },
    },
  };
}
await update('spec/openapi.json', `${JSON.stringify(root, null, 2)}\n`);
const terraformPath = 'infra/modules/agent-runner/api.tf';
let terraform = await readFile(terraformPath, 'utf8');
const marker = '    # Generated Agents API routes; run npm run agents-api:routes.';
terraform = terraform.replace(/    # Generated Agents API routes; run npm run agents-api:routes\.\n[\s\S]*?    # End generated Agents API routes\.\n/g, '');
const block = `${marker}\n${routes.map(([method, path]) => `    "${method} ${path}",`).join('\n')}\n    # End generated Agents API routes.\n`;
terraform = terraform.replace('  control_routes = toset([\n', `  control_routes = toset([\n${block}`);
// Schema discovery remains public independently of any retired schemas.
if (!terraform.includes(`    "GET ${schemaPath}",`)) terraform = terraform.replace('    "GET /openapi.json",', `    "GET /openapi.json",\n    "GET ${schemaPath}",`);
await update(terraformPath, terraform);

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
  const documented = new Set(['GET /agents/sessions/{}/traces']);
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
