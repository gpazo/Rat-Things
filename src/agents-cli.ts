import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createAgentsClient } from './agents-client.js';
import { connectExecutor } from './executor-connection.js';
import { parseAgentsContract } from './domain/agents-api-validation.js';

/** CLI inputs and outputs use the upstream resource shapes without a second request language. */
export async function runAgentsCli(argv: string[]): Promise<boolean> {
  const group = argv[0];
  if (!group || !['agents', 'sessions', 'environments', 'vaults', 'files'].includes(group)) return false;
  const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, options: {
    output: { type: 'string' }, purpose: { type: 'string' },
    'api-url': { type: 'string' }, region: { type: 'string' }, file: { type: 'string' },
    input: { type: 'string' }, model: { type: 'string' }, 'agent-id': { type: 'string' },
    after: { type: 'string' }, limit: { type: 'string' }, order: { type: 'string' },
    'idempotency-key': { type: 'string' }, stream: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [operation = 'list', id, childId, nestedId] = positionals;
  if (values.help) {
    process.stdout.write('rat-things agents create|list|get|update|delete [ID] [--file request.json]\nrat-things sessions create|list|get|update|delete|send|cancel|items|turns|artifacts|events [ID]\nrat-things environments get|connect ENVIRONMENT_ID\nrat-things environments templates create|list|get|update|delete [ID] [--file request.json]\nrat-things vaults create|list|get|delete [ID] [--file request.json]\nrat-things sessions artifacts SESSION_ID [ARTIFACT_ID]\nrat-things sessions artifact-content|artifact-delete SESSION_ID ARTIFACT_ID [--output PATH]\nrat-things files create --file PATH [--purpose user_data]\nrat-things files list|get|delete|content [ID] [--output PATH]\nUse --api-url with agents_api_base_url and --region with the deployment AWS region.\nSession creation accepts --model MODEL --input TEXT, --agent-id ID, --stream, or a standard JSON request file.\n');
    return true;
  }
  const baseURL = values['api-url'] ?? process.env.RAT_THINGS_AGENTS_API_URL ?? process.env.RAT_THINGS_API_URL;
  const region = values.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!baseURL || !region) throw new Error('Set RAT_THINGS_AGENTS_API_URL and AWS_REGION, or use --api-url and --region');
  const endpoint = baseURL.replace(/\/$/, '');
  const client = createAgentsClient({ baseURL: endpoint.endsWith('/v1') ? endpoint : `${endpoint}/v1`, region });
  const agents = client.beta.agents;
  const body: unknown = values.file && group !== 'files' ? JSON.parse(await readFile(values.file, 'utf8')) : {};
  const query = { ...(values.after ? { after: values.after } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}), ...(values.order ? { order: values.order } : {}) };
  const requiredId = () => { if (!id) throw new Error(`${group} ${operation} requires an ID`); return id; };
  const json = (value: unknown) => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
  const saveContent = async (load: () => Promise<Response>) => {
    if (!values.output) throw new Error('Use --output PATH to save file content');
    const content = await load();
    await writeFile(values.output, new Uint8Array(await content.arrayBuffer()));
  };
  if (group === 'files') {
    if (operation === 'create') {
      if (!values.file) throw new Error('files create requires --file PATH');
      const input = parseAgentsContract('UploadedFileCreate', { purpose: values.purpose ?? 'user_data' });
      json(await client.files.create({ ...input, file: createReadStream(values.file) }));
    } else if (operation === 'list') json(await client.files.list(parseAgentsContract('UploadedFileList', { ...query, ...(values.purpose ? { purpose: values.purpose } : {}) })));
    else if (operation === 'get') json(await client.files.retrieve(requiredId()));
    else if (operation === 'delete') json(await client.files.delete(requiredId()));
    else if (operation === 'content') await saveContent(() => client.files.content(requiredId()));
    else throw new Error(`Unknown files operation: ${operation}`);
  } else if (group === 'agents') {
    if (operation === 'create') json(await agents.create(parseAgentsContract('AgentCreate', body)));
    else if (operation === 'list') json(await agents.list(parseAgentsContract('AgentList', query)));
    else if (operation === 'get') json(await agents.retrieve(requiredId()));
    else if (operation === 'update') json(await agents.update(requiredId(), parseAgentsContract('AgentUpdate', body)));
    else if (operation === 'delete') json(await agents.delete(requiredId()));
    else throw new Error(`Unknown agents operation: ${operation}`);
  } else if (group === 'sessions') {
    if (operation === 'create') {
      const input = parseAgentsContract('SessionCreate', {
        ...(values.file ? body as Record<string, unknown> : { environment: { type: 'none' } }),
        ...(values.model ? { agent: { model: values.model } } : {}), ...(values['agent-id'] ? { agent_id: values['agent-id'] } : {}),
        ...(values.input !== undefined ? { input: values.input } : {}), ...(values.stream ? { stream: true } : {}),
      });
      if (input.stream) for await (const event of await agents.sessions.create({ ...input, stream: true })) json(event);
      else json(await agents.sessions.create({ ...input, stream: false }));
    } else if (operation === 'list') json(await agents.sessions.list(parseAgentsContract('SessionList', { ...query, ...(values['agent-id'] ? { agent_id: values['agent-id'] } : {}) })));
    else if (operation === 'get') json(await agents.sessions.retrieve(requiredId()));
    else if (operation === 'update') json(await agents.sessions.update(requiredId(), parseAgentsContract('SessionUpdate', body)));
    else if (operation === 'delete') json(await agents.sessions.delete(requiredId()));
    else if (operation === 'items') json(await agents.sessions.items.list(requiredId(), parseAgentsContract('ItemList', query)));
    else if (operation === 'turns') json(childId ? await agents.sessions.turns.retrieve(childId, { session_id: requiredId() }) : await agents.sessions.turns.list(requiredId(), parseAgentsContract('TurnList', query)));
    else if (operation === 'artifacts') json(childId ? await agents.sessions.artifacts.retrieve(childId, { session_id: requiredId() }) : await agents.sessions.artifacts.list(requiredId(), parseAgentsContract('ArtifactList', query)));
    else if (operation === 'artifact-content' || operation === 'artifact-delete') {
      if (!childId) throw new Error(`${operation} requires SESSION_ID ARTIFACT_ID`);
      const params = { session_id: requiredId() };
      if (operation === 'artifact-content') await saveContent(() => agents.sessions.artifacts.content(childId, params));
      else json(await agents.sessions.artifacts.delete(childId, params));
    }
    else if (operation === 'events') for await (const event of await agents.sessions.events.stream(requiredId())) json(event);
    else if (operation === 'send' || operation === 'cancel') {
      const events = parseAgentsContract('SessionEvents', operation === 'cancel' ? { events: [{ type: 'agent.session.input.cancel' }] } : values.input !== undefined ? { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: values.input }] }] }] } : body);
      await agents.sessions.events.create(requiredId(), { ...events, ...(values['idempotency-key'] ? { 'Idempotency-Key': values['idempotency-key'] } : {}) });
    } else throw new Error(`Unknown sessions operation: ${operation}`);
  } else if (group === 'environments') {
    if (operation === 'get') json(await agents.environments.retrieve(requiredId()));
    else if (operation === 'connect') {
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { await connectExecutor(client, requiredId(), { signal: abort.signal }); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    } else if (operation === 'templates') {
      const templates = agents.environments.templates;
      if (id === 'create') json(await templates.create(parseAgentsContract('EnvironmentTemplateCreate', body)));
      else if (id === 'list' || !id) json(await templates.list(parseAgentsContract('EnvironmentTemplateList', query)));
      else if (id === 'get' && childId) json(await templates.retrieve(childId));
      else if (id === 'update' && childId) json(await templates.update(childId, parseAgentsContract('EnvironmentTemplateUpdate', body)));
      else if (id === 'delete' && childId) json(await templates.delete(childId));
      else throw new Error('Use environments templates create|list|get|update|delete [ID]');
    } else throw new Error(`Unknown environments operation: ${operation}`);
  } else {
    if (operation === 'create') json(await agents.vaults.create(parseAgentsContract('VaultCreate', body)));
    else if (operation === 'list') json(await agents.vaults.list(parseAgentsContract('VaultList', query)));
    else if (operation === 'get') json(await agents.vaults.retrieve(requiredId()));
    else if (operation === 'delete') json(await agents.vaults.delete(requiredId()));
    else if (operation === 'credentials' && childId) {
      const credentials = agents.vaults.credentials;
      if (id === 'create') json(await credentials.create(childId, parseAgentsContract('CredentialCreate', body)));
      else if (id === 'list') json(await credentials.list(childId, parseAgentsContract('CredentialList', query)));
      else if (id === 'get' && nestedId) json(await credentials.retrieve(nestedId, { vault_id: childId }));
      else if (id === 'update' && nestedId) json(await credentials.update(nestedId, { vault_id: childId, ...parseAgentsContract('CredentialUpdate', body) }));
      else if (id === 'delete' && nestedId) json(await credentials.delete(nestedId, { vault_id: childId }));
      else throw new Error('Use vaults credentials create|list|get|update|delete VAULT_ID [CREDENTIAL_ID]');
    } else throw new Error(`Unknown vaults operation: ${operation}`);
  }
  return true;
}
