import { renderMarkdown } from './markdown.js';

const $ = (id) => document.getElementById(id);
const collections = {
  sessions: { path: '/v1/agents/sessions', title: 'Sessions', singular: 'session' },
  agents: { path: '/v1/agents', title: 'Agents', singular: 'agent' },
  templates: { path: '/v1/agents/environments/templates', title: 'Environment templates', singular: 'environment template' },
  vaults: { path: '/v1/vaults', title: 'Vaults', singular: 'vault' },
};
const state = { view: 'sessions', resources: [], after: null, selected: null, generation: 0, listGeneration: 0, stream: null, timer: null, refreshing: false, refreshAgain: false, editor: null };

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(text, action) {
  const element = node('button', text);
  element.type = 'button';
  element.addEventListener('click', () => perform(action, element));
  return element;
}
function notice(error, target = $('error')) {
  target.hidden = !error;
  target.textContent = error instanceof Error ? error.message : String(error ?? '');
}
async function perform(action, control) {
  if (control) control.disabled = true;
  notice(null);
  try { await action(); } catch (error) { notice(error); }
  finally { if (control) control.disabled = false; }
}
async function api(path, method = 'GET', body, idempotencyKey) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { ...(method !== 'GET' ? { 'x-rat-console-request': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return undefined;
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? `Request failed (${response.status})`);
  return value;
}
const resourceTitle = (resource) => resource.name ?? resource.metadata?.name ?? resource.agent?.name ?? resource.id;
const resourcePath = (view, id) => `${collections[view].path}/${encodeURIComponent(id)}`;
const sessionPath = (id) => resourcePath('sessions', id);

function renderList() {
  const fragment = document.createDocumentFragment();
  for (const resource of state.resources) {
    const row = button('', () => select(resource.id));
    row.className = `resource${state.selected?.id === resource.id ? ' selected' : ''}`;
    row.append(node('strong', resourceTitle(resource)), node('small', [resource.status, resource.model ?? resource.agent?.model].filter(Boolean).join(' · ') || resource.id));
    fragment.append(row);
  }
  if (!state.resources.length) fragment.append(node('p', `No ${collections[state.view].title.toLowerCase()} yet.`, 'empty'));
  $('resources').replaceChildren(fragment);
  $('more').hidden = !state.after;
}
async function refreshList(append = false) {
  const view = state.view;
  const generation = ++state.listGeneration;
  const query = new URLSearchParams({ limit: '25', order: 'desc' });
  if (view === 'vaults') query.set('status', 'active');
  if (append && state.after) query.set('after', state.after);
  const page = await api(`${collections[view].path}?${query}`);
  if (view !== state.view || generation !== state.listGeneration) return;
  state.resources = append ? [...state.resources, ...page.data.filter((row) => !state.resources.some((old) => old.id === row.id))] : page.data;
  state.after = page.has_more ? page.data.at(-1)?.id : null;
  renderList();
}
function stopStream() {
  state.stream?.close();
  state.stream = null;
  clearTimeout(state.timer);
  state.timer = null;
}
async function navigate(view) {
  stopStream();
  state.generation++;
  state.view = view;
  state.selected = null;
  state.resources = [];
  state.after = null;
  for (const item of $('navigation').querySelectorAll('button')) {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  $('list-title').textContent = collections[view].title;
  $('new-resource').textContent = `New ${collections[view].singular}`;
  $('title').textContent = collections[view].title;
  $('resource-kind').textContent = 'Workspace';
  $('status').textContent = '';
  $('delete').hidden = true;
  $('session').hidden = true;
  $('details').hidden = true;
  $('welcome').hidden = false;
  renderList();
  await refreshList();
}
async function select(id) {
  stopStream();
  const generation = ++state.generation;
  const view = state.view;
  const resource = await api(resourcePath(view, id));
  if (generation !== state.generation) return;
  state.selected = resource;
  renderList();
  renderHeader(resource);
  $('welcome').hidden = true;
  $('session').hidden = view !== 'sessions';
  $('details').hidden = view === 'sessions';
  if (view === 'sessions') {
    $('transcript').dataset.signature = '';
    $('transcript').replaceChildren(node('p', 'Loading saved items…', 'empty'));
    // Subscribe before fetching history. Events carry live updates and never replay history.
    startStream(id, generation);
    await refreshSession(id, generation);
  } else await renderDetails(resource, view, generation);
}
function renderHeader(resource) {
  $('title').textContent = resourceTitle(resource);
  $('resource-kind').textContent = collections[state.view].singular;
  $('status').textContent = resource.status ?? '';
  $('delete').hidden = false;
}
async function allPages(path, query = {}) {
  const rows = [];
  const seen = new Set();
  let after;
  do {
    const page = await api(`${path}?${new URLSearchParams({ ...query, limit: '100', ...(after ? { after } : {}) })}`);
    rows.push(...page.data);
    const lastId = page.data.at(-1)?.id;
    if (!page.has_more || !lastId || seen.has(lastId)) break;
    after = lastId;
    seen.add(after);
  } while (true);
  return rows;
}
async function refreshSession(id, generation) {
  const [session, items, turns, artifacts] = await Promise.all([
    api(sessionPath(id)), allPages(`${sessionPath(id)}/items`, { order: 'asc' }),
    allPages(`${sessionPath(id)}/turns`, { order: 'desc' }), allPages(`${sessionPath(id)}/artifacts`, { order: 'asc' }),
  ]);
  if (generation !== state.generation || id !== state.selected?.id) return;
  state.selected = session;
  renderHeader(session);
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
  const signature = JSON.stringify(items);
  if ($('transcript').dataset.signature !== signature) {
    $('transcript').replaceChildren(...items.map(renderItem));
    if (!items.length) $('transcript').append(node('p', 'No saved items yet.', 'empty'));
    $('transcript').dataset.signature = signature;
  }
  const turn = turns.find((turn) => turn.subagent_id === null);
  $('turn-status').textContent = turn ? `Turn ${turn.status.replaceAll('_', ' ')}` : 'Ready for input';
  $('cancel').hidden = !turn || !['queued', 'in_progress', 'waiting'].includes(turn.status);
  renderEnvironment(session);
  renderActions(session);
  $('artifacts').replaceChildren(...artifacts.map((artifact) => {
    const link = node('a', `${artifact.path} · ${artifact.size_bytes.toLocaleString()} bytes`);
    link.href = `/api${sessionPath(id)}/artifacts/${encodeURIComponent(artifact.id)}/content`;
    link.download = artifact.path.split('/').at(-1);
    return link;
  }));
  if (session.error) notice(new Error(session.error));
  if (nearBottom) window.scrollTo({ top: document.documentElement.scrollHeight });
}
function renderItem(item) {
  const article = node('article', undefined, `item${item.role === 'user' ? ' user' : ''}`);
  article.dataset.itemId = item.id;
  article.append(node('div', item.type === 'message' ? (item.role === 'user' ? 'You' : item.phase === 'commentary' ? 'Agent · working' : 'Agent') : item.type.replaceAll('_', ' '), 'label'));
  if (item.type === 'message') {
    for (const part of item.content) {
      if (part.type === 'output_text') article.append(markdown(part.text));
      else if (part.type === 'input_text') article.append(node('p', part.text));
      else article.append(node('p', part.type === 'input_image' ? 'Image input' : part.type.replaceAll('_', ' ')));
    }
  } else {
    const details = node('details');
    details.append(node('summary', item.name ?? item.command ?? item.type.replaceAll('_', ' ')), node('pre', JSON.stringify(item, null, 2)));
    article.append(details);
  }
  return article;
}
function markdown(text) {
  return renderMarkdown(text, {
    link(href) {
      try {
        const url = new URL(href);
        if (['https:', 'http:'].includes(url.protocol)) {
          const anchor = node('a');
          anchor.href = url.href;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          return anchor;
        }
      } catch { /* Relative and non-web links remain text. */ }
      return node('span');
    },
    codeBlock(text) { const pre = node('pre'); pre.append(node('code', text)); return pre; },
  });
}
function renderEnvironment(session) {
  const environment = session.environment;
  $('environment').hidden = environment.type === 'none';
  if (environment.type === 'none') return;
  const nodes = [node('span', `${environment.type.replaceAll('_', ' ')} · ${environment.id}`)];
  if (session.required_actions.some((action) => action.type === 'environment_connection')) {
    nodes.push(node('p', 'Connect the executor to continue this session.'), node('code', `rat-things environments connect ${environment.id}`));
  }
  $('environment').replaceChildren(...nodes);
}
function renderActions(session) {
  const actions = session.required_actions.filter((action) => action.type === 'function_call');
  const signature = JSON.stringify(actions);
  if ($('required-actions').dataset.signature === signature) return;
  $('required-actions').dataset.signature = signature;
  $('required-actions').replaceChildren(...actions.map((action) => {
    const section = node('section', undefined, 'tool-result');
    const form = node('form');
    const input = node('textarea');
    input.rows = 3;
    input.setAttribute('aria-label', `Result for ${action.name}`);
    const failed = node('input');
    failed.type = 'checkbox';
    const failureLabel = node('label');
    failureLabel.append(failed, document.createTextNode(' Report as failed'));
    const submit = node('button', 'Send tool result');
    submit.type = 'submit';
    form.append(input, failureLabel, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void perform(async () => {
        await sendEvents(session.id, [{ type: 'agent.session.input.tool_result', turn_id: action.turn_id, call_id: action.call_id, ...(failed.checked ? { error: input.value } : { output: input.value }), success: !failed.checked }]);
        queueRefresh(session.id, state.generation);
      }, submit);
    });
    section.append(node('h2', `Function result needed: ${action.name}`), node('pre', JSON.stringify(action.arguments, null, 2)), form);
    return section;
  }));
}
function queueRefresh(id, generation) {
  if (generation !== state.generation) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void perform(async () => {
    if (state.refreshing) { state.refreshAgain = true; return; }
    state.refreshing = true;
    try { await refreshSession(id, generation); }
    finally {
      state.refreshing = false;
      if (state.refreshAgain) { state.refreshAgain = false; queueRefresh(state.selected?.id, state.generation); }
    }
  }), 150);
}
function startStream(id, generation) {
  const stream = new EventSource(`/api${sessionPath(id)}/events`);
  state.stream = stream;
  const update = () => queueRefresh(id, generation);
  for (const name of [
    'idle', 'in_progress', 'requires_action', 'failed', 'error',
    'environment.pending', 'environment.connected', 'environment.ready', 'environment.disconnected', 'environment.failed',
    'turn.created', 'turn.in_progress', 'turn.completed', 'turn.cancelled', 'turn.failed',
    'turn.item.added', 'turn.item.done', 'turn.output_text.delta', 'turn.output_text.done',
    'turn.reasoning_summary_text.delta', 'turn.reasoning_summary_text.done', 'subagent.created', 'subagent.active', 'subagent.closed',
  ]) stream.addEventListener(`agent.session.${name}`, update);
  stream.onopen = update;
  stream.onerror = update; // EventSource reconnects; reload durable history to fill any gap.
}
async function sendEvents(id, events) {
  return api(`${sessionPath(id)}/events`, 'POST', { events }, crypto.randomUUID());
}
async function renderDetails(resource, view, generation) {
  $('resource-json').textContent = JSON.stringify(resource, null, 2);
  $('edit').hidden = view === 'vaults';
  $('start-session').hidden = view !== 'agents';
  $('add-credential').hidden = view !== 'vaults';
  $('credentials').replaceChildren();
  if (view !== 'vaults') return;
  const credentials = await allPages(`${resourcePath(view, resource.id)}/credentials`, { status: 'active' });
  if (generation !== state.generation) return;
  $('credentials').replaceChildren(...credentials.map((credential) => {
    const row = node('section', undefined, 'credential');
    row.append(node('h2', credential.name), node('pre', JSON.stringify(credential, null, 2)),
      button('Rotate credential', () => openEditor('Rotate credential', { auth: credential.auth.type === 'static_bearer' ? { type: 'static_bearer', token: '' } : { type: 'mcp_oauth', access_token: '' } }, `${resourcePath(view, resource.id)}/credentials/${encodeURIComponent(credential.id)}`, view, resource.id, 'Save')),
      button('Delete credential', async () => {
        await api(`${resourcePath(view, resource.id)}/credentials/${encodeURIComponent(credential.id)}`, 'DELETE');
        await renderDetails(resource, view, generation);
      }));
    return row;
  }));
}
function openEditor(title, initial, path, view, selectId, verb = 'Create') {
  state.editor = { path, view, selectId };
  $('editor-title').textContent = title;
  $('editor-description').textContent = title.includes('credential') ? 'Secret values are write-only. This editor clears them when closed.' : 'Use the OpenAI Agents API request fields. Set a model available through your deployment.';
  $('configuration').value = JSON.stringify(initial, null, 2);
  $('submit-editor').textContent = verb;
  notice(null, $('editor-error'));
  $('editor').showModal();
  $('configuration').focus();
}
function newResource(view = state.view, agentId) {
  const initial = {
    sessions: { ...(agentId ? { agent_id: agentId } : { agent: { model: 'your-model-id' } }), environment: { type: 'none' }, input: 'Describe the work to perform' },
    agents: { name: 'New agent', model: 'your-model-id', instructions: 'Describe the role and working instructions.', tools: [] },
    templates: { name: 'New environment', files: [], packages: { npm: [], python: [], system: [] }, network: { access: 'disabled' } },
    vaults: { name: 'New vault' },
  }[view];
  openEditor(`New ${collections[view].singular}`, initial, collections[view].path, view);
}
function editResource() {
  const { selected: resource, view } = state;
  const fields = view === 'agents' ? ['name', 'model', 'instructions', 'tools', 'reasoning', 'multi_agent', 'text', 'service_tier', 'metadata'] : ['name', 'capability_directories', 'network', 'packages'];
  // Template files and capability ZIPs are write-only: omit their public summaries.
  const body = Object.fromEntries(fields.filter((key) => resource[key] !== undefined).map((key) => [key, resource[key]]));
  openEditor(`Edit ${collections[view].singular}`, body, resourcePath(view, resource.id), view, resource.id, 'Save');
}

$('navigation').addEventListener('click', (event) => {
  const view = event.target.closest('button')?.dataset.view;
  if (view) void perform(() => navigate(view));
});
$('refresh').addEventListener('click', () => perform(async () => { await refreshList(); if (state.selected) await select(state.selected.id); }));
$('more').addEventListener('click', () => perform(() => refreshList(true), $('more')));
$('new-resource').addEventListener('click', () => newResource());
$('welcome-create').addEventListener('click', () => newResource('sessions'));
$('edit').addEventListener('click', editResource);
$('start-session').addEventListener('click', () => newResource('sessions', state.selected.id));
$('add-credential').addEventListener('click', () => openEditor('Add credential', { name: 'MCP credential', auth: { type: 'static_bearer', mcp_server_url: 'https://example.com/mcp', token: '' } }, `${resourcePath('vaults', state.selected.id)}/credentials`, 'vaults', state.selected.id));
$('close-editor').addEventListener('click', () => $('editor').close());
$('editor').addEventListener('close', () => { $('configuration').value = ''; state.editor = null; });
$('editor-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const editor = state.editor;
  const submit = $('submit-editor');
  submit.disabled = true;
  notice(null, $('editor-error'));
  void (async () => {
    try {
      const body = JSON.parse($('configuration').value);
      if (body.stream) throw new Error('The console subscribes after creation. Omit stream from this request.');
      const result = await api(editor.path, 'POST', body);
      $('editor').close();
      if (state.view !== editor.view) await navigate(editor.view);
      else await refreshList();
      await select(editor.selectId ?? result.id);
    } catch (error) { notice(error, $('editor').open ? $('editor-error') : $('error')); }
    finally { submit.disabled = false; }
  })();
});
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const message = $('message').value;
  const id = state.selected.id;
  void perform(async () => {
    await sendEvents(id, [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }] }]);
    if (id === state.selected?.id && $('message').value === message) $('message').value = '';
    queueRefresh(id, state.generation);
  }, $('composer').querySelector('[type=submit]'));
});
$('cancel').addEventListener('click', () => perform(async () => { const id = state.selected.id; await sendEvents(id, [{ type: 'agent.session.input.cancel' }]); queueRefresh(id, state.generation); }, $('cancel')));
$('delete').addEventListener('click', () => perform(async () => {
  const { view, selected } = state;
  await api(resourcePath(view, selected.id), 'DELETE');
  if (view === state.view && selected.id === state.selected?.id) await navigate(view);
}, $('delete')));
window.addEventListener('pagehide', stopStream);
void perform(async () => { await navigate('sessions'); document.documentElement.dataset.consoleReady = 'true'; });
