const elements = {
  sidebar: document.querySelector('#sidebar'),
  sidebarToggle: document.querySelector('#sidebar-toggle'),
  sidebarScrim: document.querySelector('#sidebar-scrim'),
  workspace: document.querySelector('#workspace'),
  list: document.querySelector('#conversation-list'),
  count: document.querySelector('#conversation-count'),
  filter: document.querySelector('#conversation-filter'),
  searchState: document.querySelector('#conversation-search-state'),
  viewLabel: document.querySelector('#conversation-view-label'),
  hiddenToggle: document.querySelector('#hidden-conversations'),
  refresh: document.querySelector('#refresh-list'),
  newThread: document.querySelector('#new-thread'),
  dialog: document.querySelector('#new-thread-dialog'),
  dialogForm: document.querySelector('#new-thread-form'),
  threadKey: document.querySelector('#thread-key'),
  title: document.querySelector('#conversation-title'),
  subtitle: document.querySelector('#conversation-subtitle'),
  badge: document.querySelector('#status-badge'),
  transcript: document.querySelector('#transcript'),
  empty: document.querySelector('#empty-state'),
  jumpLatest: document.querySelector('#jump-latest'),
  composer: document.querySelector('#composer'),
  composerContext: document.querySelector('#composer-context'),
  composerAttachments: document.querySelector('#composer-attachments'),
  prompt: document.querySelector('#prompt'),
  delivery: document.querySelector('#delivery'),
  attachFiles: document.querySelector('#attach-files'),
  fileInput: document.querySelector('#file-input'),
  send: document.querySelector('#send'),
  interrupt: document.querySelector('#interrupt-run'),
  notice: document.querySelector('#notice'),
  viewer: document.querySelector('#artifact-viewer'),
  viewerTitle: document.querySelector('#viewer-title'),
  viewerBody: document.querySelector('#viewer-body'),
  viewerDetail: document.querySelector('#viewer-detail'),
  viewerOpen: document.querySelector('#viewer-open'),
  closeViewer: document.querySelector('#close-viewer'),
};

const LIST_PAGE_SIZE = 25;
const EVENT_PAGE_SIZE = 100;
const AUTO_REFRESH_MS = 15_000;
const MAX_RETAINED_EVENTS = 200;
const DRAFT_PREFIX = 'rat-things.draft.';
const WORK_PREFIX = 'rat-things.work.';

const state = {
  conversations: [],
  listNextToken: null,
  consumedListTokens: new Set(),
  listLoading: false,
  visibility: 'visible',
  searchQuery: '',
  searchResults: [],
  searchLoading: false,
  searchTimer: null,
  searchRevision: 0,
  selected: null,
  detail: null,
  detailLoading: false,
  draftThreadKey: null,
  activeRunId: null,
  activeRun: null,
  activeRunObservedAt: null,
  events: [],
  pendingRequests: [],
  eventAfter: 0,
  eventGap: false,
  runtimeReady: false,
  completedWork: null,
  liveWorkByConversation: new Map(),
  artifacts: [],
  uploads: [],
  replyTarget: null,
  busy: false,
  pollTimer: null,
  progressTimer: null,
  refreshTimer: null,
  selectionRevision: 0,
};

elements.newThread.addEventListener('click', openNewThread);
elements.refresh.addEventListener('click', () => void refreshConversations(true));
elements.filter.addEventListener('input', scheduleConversationSearch);
elements.filter.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && elements.filter.value) {
    elements.filter.value = '';
    scheduleConversationSearch();
  }
});
elements.hiddenToggle.addEventListener('click', () => void toggleHiddenConversations());
elements.dialogForm.addEventListener('submit', createDraftThread);
elements.composer.addEventListener('submit', submitMessage);
elements.attachFiles.addEventListener('click', () => elements.fileInput.click());
elements.fileInput.addEventListener('change', selectAttachments);
elements.closeViewer.addEventListener('click', () => elements.viewer.close());
elements.viewer.addEventListener('close', () => elements.viewerBody.replaceChildren());
elements.prompt.addEventListener('input', () => {
  resizeComposer();
  persistDraft();
});
elements.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.interrupt.addEventListener('click', interruptRun);
elements.transcript.addEventListener('scroll', updateJumpLatest);
elements.jumpLatest.addEventListener('click', () => scrollTranscriptToBottom('smooth'));
elements.sidebarToggle.addEventListener('click', () => setSidebarOpen(!sidebarIsOpen()));
elements.sidebarScrim.addEventListener('click', () => setSidebarOpen(false));
document.addEventListener('keydown', handleSidebarKeydown);
window.addEventListener('resize', () => {
  setSidebarOpen(false);
});

setSidebarOpen(false);
void initialize();

async function initialize() {
  try {
    await refreshConversations(false);
    const saved = localStorage.getItem('rat-things.selected-conversation');
    const selected = state.conversations.find((item) => item.conversationId === saved) ?? state.conversations[0];
    if (selected) await selectConversation(selected);
    else renderWorkspace({ scrollMode: 'bottom' });
    state.refreshTimer = window.setInterval(() => {
      if (!document.hidden && !state.listLoading) void refreshConversations(false);
    }, AUTO_REFRESH_MS);
  } finally {
    elements.newThread.disabled = false;
    elements.refresh.disabled = false;
    document.documentElement.dataset.consoleReady = 'true';
  }
}

async function refreshConversations(showNotice) {
  if (state.listLoading) return;
  state.listLoading = true;
  elements.refresh.disabled = true;
  try {
    const result = await api(
      `/v1/conversations?limit=${LIST_PAGE_SIZE}&visibility=${encodeURIComponent(state.visibility)}`,
    );
    const firstPage = Array.isArray(result.items) ? result.items : [];
    state.conversations = mergeConversations(firstPage, state.conversations);
    state.listNextToken = typeof result.nextToken === 'string' && !state.consumedListTokens.has(result.nextToken)
      ? result.nextToken
      : null;
    syncSelectedSummary();
    renderConversationList();
    await refreshSelectedDetailIfStale();
    if (showNotice) {
      notice(`Refreshed ${state.conversations.length} conversation${state.conversations.length === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    notice(message(error), true);
  } finally {
    state.listLoading = false;
    elements.refresh.disabled = false;
  }
}

async function refreshSelectedDetailIfStale() {
  const selected = state.selected;
  const detail = state.detail;
  if (
    !selected?.conversationId ||
    !detail ||
    state.detailLoading ||
    state.draftThreadKey ||
    state.activeRunId
  ) return;
  const summaryUpdatedAt = Date.parse(selected.updatedAt);
  const detailUpdatedAt = Date.parse(detail.updatedAt);
  if (
    !Number.isFinite(summaryUpdatedAt) ||
    (Number.isFinite(detailUpdatedAt) && summaryUpdatedAt <= detailUpdatedAt)
  ) return;

  const revision = state.selectionRevision;
  const [refreshed, artifacts] = await Promise.all([
    api(`/v1/conversations/${encodeURIComponent(selected.conversationId)}`),
    loadConversationArtifacts(selected),
  ]);
  if (
    revision !== state.selectionRevision ||
    state.selected?.conversationId !== selected.conversationId ||
    state.activeRunId
  ) return;
  state.detail = refreshed;
  state.artifacts = artifacts;
  renderWorkspace({ scrollMode: 'auto' });
}

async function loadMoreConversations(button) {
  if (!state.listNextToken || state.listLoading) return;
  const nextToken = state.listNextToken;
  state.listLoading = true;
  button.disabled = true;
  try {
    const result = await api(
      `/v1/conversations?limit=${LIST_PAGE_SIZE}&nextToken=${encodeURIComponent(nextToken)}`
        + `&visibility=${encodeURIComponent(state.visibility)}`,
    );
    state.consumedListTokens.add(nextToken);
    state.conversations = mergeConversations(state.conversations, Array.isArray(result.items) ? result.items : []);
    state.listNextToken = typeof result.nextToken === 'string' ? result.nextToken : null;
    renderConversationList();
  } catch (error) {
    button.disabled = false;
    notice(message(error), true);
  } finally {
    state.listLoading = false;
  }
}

function mergeConversations(primary, secondary) {
  const byId = new Map();
  for (const conversation of [...primary, ...secondary]) {
    if (!byId.has(conversation.conversationId)) byId.set(conversation.conversationId, conversation);
  }
  return [...byId.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function syncSelectedSummary() {
  if (!state.selected && state.draftThreadKey) {
    const created = state.conversations.find((item) => item.threadKey === state.draftThreadKey);
    if (created) state.selected = created;
  }
  if (!state.selected) return;
  const current = state.conversations.find((item) => item.conversationId === state.selected.conversationId);
  if (current) state.selected = current;
}

function renderConversationList() {
  const query = state.searchQuery;
  elements.viewLabel.textContent = query ? 'Search results' : state.visibility === 'hidden' ? 'Hidden' : 'Conversations';
  elements.hiddenToggle.lastElementChild.textContent = state.visibility === 'hidden'
    ? 'Back to conversations'
    : 'Show hidden conversations';
  elements.count.textContent = String(query ? state.searchResults.length : state.conversations.length);
  elements.list.replaceChildren();
  elements.searchState.hidden = !query;
  elements.searchState.textContent = state.searchLoading
    ? `Searching all conversations for “${query}”…`
    : query.length < 2
      ? 'Type at least two characters to search messages and files.'
      : `${state.searchResults.length} result${state.searchResults.length === 1 ? '' : 's'} across messages and files.`;
  if (query) {
    if (state.searchLoading) elements.list.append(searchLoadingNode());
    if (!state.searchLoading && query.length >= 2 && state.searchResults.length === 0) {
      elements.list.append(emptyConversationList('No messages or files matched this search.'));
    }
    for (const hit of state.searchResults) elements.list.append(searchResultNode(hit));
    return;
  }
  if (state.conversations.length === 0) {
    elements.list.append(emptyConversationList(
      state.visibility === 'hidden' ? 'No hidden conversations.' : 'No durable conversations yet.',
    ));
  }
  const sections = state.visibility === 'hidden'
    ? [['Hidden', state.conversations]]
    : conversationSections(state.conversations);
  for (const [label, conversations] of sections) {
    if (conversations.length === 0) continue;
    const section = document.createElement('section');
    section.className = 'conversation-section';
    const heading = document.createElement('h2');
    heading.textContent = label;
    section.append(heading);
    for (const conversation of conversations) section.append(conversationNode(conversation));
    elements.list.append(section);
  }
  if (state.listNextToken) {
    const loadMore = document.createElement('button');
    loadMore.type = 'button';
    loadMore.className = 'load-more-conversations';
    loadMore.textContent = `Load more ${state.visibility === 'hidden' ? 'hidden ' : ''}conversations`;
    loadMore.addEventListener('click', () => void loadMoreConversations(loadMore));
    elements.list.append(loadMore);
  }
}

function emptyConversationList(text) {
  const empty = document.createElement('p');
  empty.className = 'conversation-list-empty';
  empty.textContent = text;
  return empty;
}

function conversationSections(conversations) {
  const pinned = conversations.filter((conversation) => conversation.pinned);
  const remaining = conversations.filter((conversation) => !conversation.pinned);
  const attention = remaining.filter((conversation) => conversationAttention(conversation) !== 'ready');
  const attentionIds = new Set(attention.map((conversation) => conversation.conversationId));
  return [
    ['Pinned', pinned],
    ['Needs attention', attention],
    ['Recent', remaining.filter((conversation) => !attentionIds.has(conversation.conversationId))],
  ];
}

function scheduleConversationSearch() {
  window.clearTimeout(state.searchTimer);
  const query = elements.filter.value.trim();
  state.searchQuery = query;
  state.searchResults = [];
  state.searchLoading = query.length >= 2;
  const revision = ++state.searchRevision;
  renderConversationList();
  if (query.length < 2) return;
  state.searchTimer = window.setTimeout(() => void performConversationSearch(query, revision), 250);
}

async function performConversationSearch(query, revision) {
  try {
    const result = await api(`/v1/conversations/search?q=${encodeURIComponent(query)}&limit=25`);
    if (revision !== state.searchRevision || query !== state.searchQuery) return;
    state.searchResults = Array.isArray(result.items) ? result.items : [];
  } catch (error) {
    if (revision !== state.searchRevision) return;
    notice(message(error), true);
    state.searchResults = [];
  } finally {
    if (revision === state.searchRevision) {
      state.searchLoading = false;
      renderConversationList();
    }
  }
}

function searchLoadingNode() {
  const shell = document.createElement('div');
  shell.className = 'conversation-search-loading';
  shell.setAttribute('aria-label', 'Searching conversations');
  for (let index = 0; index < 3; index += 1) shell.append(document.createElement('span'));
  return shell;
}

function searchResultNode(hit) {
  const result = document.createElement('article');
  result.className = 'conversation-search-result';
  const conversation = hit.conversation;
  const primary = hit.matches?.[0];
  result.append(conversationNode(conversation, () => void selectSearchResult(hit, primary)));
  const matches = document.createElement('div');
  matches.className = 'conversation-search-matches';
  for (const match of (hit.matches ?? []).slice(0, 3)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-search-match';
    button.addEventListener('click', () => void selectSearchResult(hit, match));
    const kind = document.createElement('span');
    kind.textContent = match.kind === 'file' ? 'File' : match.role === 'user' ? 'You' : 'Rat';
    const snippet = document.createElement('span');
    snippet.textContent = match.snippet;
    button.append(kind, snippet);
    matches.append(button);
  }
  if (conversation.hidden) {
    const hidden = document.createElement('span');
    hidden.className = 'conversation-search-hidden';
    hidden.textContent = 'Hidden conversation';
    matches.append(hidden);
  }
  result.append(matches);
  return result;
}

async function selectSearchResult(hit, match) {
  await selectConversation(hit.conversation);
  if (match) await focusSearchMatch(match);
}

async function focusSearchMatch(match) {
  if (!state.detail) return;
  if (match.kind === 'file' && match.artifactId) {
    const artifact = elements.transcript.querySelector(`[data-artifact-id="${CSS.escape(match.artifactId)}"]`);
    if (artifact) highlightSearchTarget(artifact);
    return;
  }
  const tokens = searchTerms(state.searchQuery);
  let targetIndex = bestTranscriptMatch(state.detail.transcript.messages, tokens);
  for (let attempt = 0; targetIndex < 0 && state.detail.transcript.nextToken && attempt < 10; attempt += 1) {
    const older = await api(
      `/v1/conversations/${encodeURIComponent(state.detail.conversationId)}?limit=50`
        + `&nextToken=${encodeURIComponent(state.detail.transcript.nextToken)}`,
    );
    state.detail.transcript.messages = [
      ...(older.transcript?.messages ?? []),
      ...state.detail.transcript.messages,
    ];
    state.detail.transcript.nextToken = older.transcript?.nextToken;
    targetIndex = bestTranscriptMatch(state.detail.transcript.messages, tokens);
  }
  renderWorkspace({ scrollMode: 'keep' });
  const rows = [...elements.transcript.querySelectorAll('.message-row')];
  if (targetIndex >= 0 && rows[targetIndex]) highlightSearchTarget(rows[targetIndex]);
}

function bestTranscriptMatch(messages, tokens) {
  let best = { index: -1, score: 0 };
  for (const [index, item] of messages.entries()) {
    const content = String(item.content ?? '').normalize('NFKC').toLocaleLowerCase('en-US');
    const score = tokens.filter((token) => content.includes(token)).length;
    if (score > best.score) best = { index, score };
  }
  return best.index;
}

function searchTerms(value) {
  return [...new Set(
    (value.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])
      .filter((token) => token.length >= 2),
  )];
}

function highlightSearchTarget(node) {
  node.classList.add('search-target');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => node.classList.remove('search-target'), 4_000);
}

function conversationNode(conversation, onSelect = () => void selectConversation(conversation)) {
  const row = document.createElement('div');
  row.className = 'conversation-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'conversation-item';
  button.setAttribute('aria-current', state.selected?.conversationId === conversation.conversationId ? 'page' : 'false');
  const attention = conversationAttention(conversation);
  button.dataset.state = attention;
  button.setAttribute('aria-label', `${labelFor(conversation)}, ${attentionLabel(attention)}`);
  button.addEventListener('click', onSelect);

  const avatar = document.createElement('span');
  avatar.className = 'conversation-avatar';
  avatar.textContent = labelFor(conversation).slice(0, 1);
  const dot = document.createElement('span');
  dot.className = 'conversation-state-dot';
  dot.dataset.state = attention;
  dot.setAttribute('aria-hidden', 'true');
  avatar.append(dot);

  const body = document.createElement('span');
  body.className = 'conversation-body';
  const name = document.createElement('span');
  name.className = 'conversation-name';
  name.textContent = labelFor(conversation);
  if (conversation.pinned) name.dataset.pinned = 'true';
  const preview = document.createElement('span');
  preview.className = 'conversation-preview';
  preview.textContent = conversationPreview(conversation);
  body.append(name, preview);

  const meta = document.createElement('span');
  meta.className = 'conversation-meta';
  const time = document.createElement('time');
  time.className = 'conversation-time';
  time.dateTime = conversation.updatedAt;
  time.textContent = relativeTime(conversation.updatedAt);
  meta.append(time);
  if (attention !== 'ready') {
    const status = document.createElement('span');
    status.className = 'conversation-state-label';
    status.textContent = attentionLabel(attention);
    meta.append(status);
  }
  button.append(avatar, body, meta);
  row.append(button, conversationActions(conversation));
  return row;
}

function conversationActions(conversation) {
  const details = document.createElement('details');
  details.className = 'conversation-actions';
  const summary = document.createElement('summary');
  summary.setAttribute('aria-label', `Conversation actions for ${labelFor(conversation)}`);
  summary.title = `Conversation actions for ${labelFor(conversation)}`;
  summary.textContent = '•••';
  const menu = document.createElement('div');
  menu.className = 'conversation-actions-menu';
  const actions = [
    [conversation.pinned ? 'Unpin' : 'Pin', { pinned: !conversation.pinned }],
    [conversation.unread ? 'Mark as read' : 'Mark as unread', { read: conversation.unread }],
    [conversation.hidden ? 'Unhide' : 'Hide', { hidden: !conversation.hidden }],
  ];
  for (const [label, update] of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      details.removeAttribute('open');
      void updateConversationOrganization(conversation, update);
    });
    menu.append(button);
  }
  details.append(summary, menu);
  return details;
}

async function updateConversationOrganization(conversation, update, options = {}) {
  try {
    const updated = await api(
      `/v1/conversations/${encodeURIComponent(conversation.conversationId)}/organization`,
      { method: 'POST', body: update },
    );
    replaceConversationSummary(updated);
    if (state.selected?.conversationId === updated.conversationId) {
      state.selected = { ...state.selected, ...updated };
      if (state.detail) state.detail = { ...state.detail, ...updated };
    }
    const belongsInView = state.visibility === 'hidden' ? updated.hidden : !updated.hidden;
    if (!belongsInView) {
      state.conversations = state.conversations.filter((item) => item.conversationId !== updated.conversationId);
    }
    renderConversationList();
    renderWorkspace({ scrollMode: 'keep' });
    if (!options.silent) notice(organizationNotice(update, updated));
    return updated;
  } catch (error) {
    if (!options.silent) notice(message(error), true);
    return conversation;
  }
}

function replaceConversationSummary(updated) {
  state.conversations = mergeConversations(
    state.conversations.map((item) => item.conversationId === updated.conversationId ? updated : item),
    [],
  );
  state.searchResults = state.searchResults.map((hit) => hit.conversation.conversationId === updated.conversationId
    ? { ...hit, conversation: updated }
    : hit);
}

function organizationNotice(update, conversation) {
  if ('pinned' in update) return update.pinned ? 'Conversation pinned.' : 'Conversation unpinned.';
  if ('hidden' in update) return update.hidden ? 'Conversation hidden.' : 'Conversation restored.';
  return conversation.unread ? 'Conversation marked unread.' : 'Conversation marked read.';
}

async function markConversationRead(conversation) {
  if (!conversation.unread) return conversation;
  return updateConversationOrganization(conversation, { read: true }, { silent: true });
}

async function toggleHiddenConversations() {
  state.visibility = state.visibility === 'hidden' ? 'visible' : 'hidden';
  state.conversations = [];
  state.listNextToken = null;
  state.consumedListTokens.clear();
  elements.filter.value = '';
  state.searchQuery = '';
  state.searchResults = [];
  state.searchLoading = false;
  state.searchRevision += 1;
  renderConversationList();
  await refreshConversations(false);
}

async function selectConversation(conversation) {
  persistDraft();
  cacheLiveWork();
  const revision = ++state.selectionRevision;
  state.selected = conversation;
  state.draftThreadKey = null;
  state.detail = null;
  state.detailLoading = true;
  resetLiveRunState();
  state.completedWork = restoreCompletedWork(conversation.conversationId);
  state.artifacts = [];
  clearComposerExtras();
  localStorage.setItem('rat-things.selected-conversation', conversation.conversationId);
  if (conversation.unread) void markConversationRead(conversation);
  restoreDraft();
  renderConversationList();
  renderWorkspace({ scrollMode: 'bottom' });
  setSidebarOpen(false);
  try {
    const [detail, artifacts] = await Promise.all([
      api(`/v1/conversations/${encodeURIComponent(conversation.conversationId)}`),
      loadConversationArtifacts(conversation),
    ]);
    if (
      revision !== state.selectionRevision ||
      state.draftThreadKey ||
      state.selected?.conversationId !== conversation.conversationId
    ) return;
    state.detail = detail;
    state.artifacts = artifacts;
    state.detailLoading = false;
    state.activeRunId = detail.activeRunId ?? null;
    if (state.activeRunId) restoreLiveWork(conversation.conversationId, state.activeRunId);
    renderWorkspace({ scrollMode: 'bottom' });
    if (state.activeRunId) await pollRun();
  } catch (error) {
    if (revision === state.selectionRevision) {
      state.detailLoading = false;
      renderWorkspace({ scrollMode: 'keep' });
      notice(message(error), true);
    }
  }
}

async function loadConversationArtifacts(conversation) {
  if (!conversation.threadKey) return [];
  try {
    const result = await api(`/v1/conversations/${encodeURIComponent(conversation.threadKey)}/artifacts`);
    return Array.isArray(result.files) ? result.files : [];
  } catch {
    return [];
  }
}

function openNewThread() {
  elements.threadKey.value = '';
  elements.dialog.showModal();
  window.setTimeout(() => elements.threadKey.focus(), 0);
}

function createDraftThread(event) {
  event.preventDefault();
  if (!elements.dialogForm.reportValidity()) return;
  persistDraft();
  state.selectionRevision += 1;
  state.selected = null;
  state.detail = null;
  state.detailLoading = false;
  state.draftThreadKey = elements.threadKey.value.trim();
  resetLiveRunState();
  state.completedWork = null;
  state.artifacts = [];
  clearComposerExtras();
  localStorage.removeItem('rat-things.selected-conversation');
  elements.dialog.close();
  restoreDraft();
  renderConversationList();
  renderWorkspace({ scrollMode: 'bottom' });
  elements.prompt.focus();
}

function selectAttachments() {
  const selected = [...(elements.fileInput.files ?? [])];
  elements.fileInput.value = '';
  if (selected.length === 0) return;
  const combined = [...state.uploads];
  for (const file of selected) {
    if (combined.some((item) => item.name === file.name)) {
      notice(`A file named ${file.name} is already attached.`, true);
      continue;
    }
    if (file.size > 4 * 1024 * 1024) {
      notice(`${file.name} exceeds the 4 MiB per-file limit.`, true);
      continue;
    }
    combined.push(file);
  }
  if (combined.length > 6) {
    notice('A message can include at most 6 files.', true);
    return;
  }
  if (combined.reduce((total, file) => total + file.size, 0) > 6 * 1024 * 1024) {
    notice('Attachments exceed the 6 MiB per-message limit.', true);
    return;
  }
  state.uploads = combined;
  renderWorkspace({ scrollMode: 'keep' });
}

function clearComposerExtras() {
  state.uploads = [];
  state.replyTarget = null;
  if (elements.fileInput) elements.fileInput.value = '';
}

function renderComposerContext(writable, conversation) {
  elements.composerContext.replaceChildren();
  if (!writable) {
    elements.composerContext.hidden = false;
    elements.composerContext.textContent = conversation
      ? 'Provider conversations are read-only here. Replies must return through their authenticated channel.'
      : 'Create a conversation before sending a message.';
    return;
  }
  if (!state.replyTarget) {
    elements.composerContext.hidden = true;
    return;
  }
  elements.composerContext.hidden = false;
  elements.composerContext.classList.add('composer-reply-context');
  const copy = document.createElement('span');
  copy.textContent = `Replying to ${state.replyTarget.role === 'user' ? 'you' : 'Rat Things'} · ${previewText(state.replyTarget.content, 110)}`;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.setAttribute('aria-label', 'Cancel reply');
  cancel.textContent = '×';
  cancel.addEventListener('click', () => {
    state.replyTarget = null;
    renderWorkspace({ scrollMode: 'keep' });
  });
  elements.composerContext.append(copy, cancel);
}

function renderComposerAttachments() {
  elements.composerAttachments.replaceChildren();
  elements.composerAttachments.hidden = state.uploads.length === 0;
  for (const file of state.uploads) {
    const chip = document.createElement('span');
    chip.className = 'composer-attachment';
    const label = document.createElement('span');
    label.textContent = `${file.name} · ${formatBytes(file.size)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.disabled = state.busy;
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.uploads = state.uploads.filter((candidate) => candidate !== file);
      renderWorkspace({ scrollMode: 'keep' });
    });
    chip.append(label, remove);
    elements.composerAttachments.append(chip);
  }
}

function renderWorkspace(options = {}) {
  const scroll = options.scrollSnapshot ?? captureTranscriptScroll();
  const conversation = state.detail ?? state.selected;
  const threadKey = state.draftThreadKey ?? conversation?.threadKey;
  elements.title.textContent = state.draftThreadKey ?? conversation?.title ?? (conversation ? labelFor(conversation) : 'New conversation');
  const sourceKind = conversation?.sourceKind ?? state.selected?.sourceKind;
  const updatedAt = conversation?.updatedAt ?? state.selected?.updatedAt;
  elements.subtitle.textContent = conversation
    ? `${sourceLabel(sourceKind)}${updatedAt ? ` · updated ${relativeTime(updatedAt)}` : ''}`
    : 'Durable, isolated execution';
  const status = state.activeRun?.status ?? conversation?.status ?? (state.activeRunId ? 'queued' : 'idle');
  elements.badge.dataset.state = status;
  elements.badge.textContent = state.pendingRequests.length > 0 ? 'Needs input' : statusLabel(status);
  elements.interrupt.hidden = true;

  const messages = state.detail?.transcript?.messages ?? [];
  const work = currentWork(status);
  elements.transcript.replaceChildren();
  if (state.detailLoading) {
    elements.transcript.append(transcriptLoadingNode());
  } else if (messages.length === 0 && !work) {
    elements.transcript.append(elements.empty);
  } else {
    renderTranscript(messages, work);
  }

  const writable = Boolean(threadKey);
  elements.prompt.disabled = !writable || state.busy;
  elements.send.disabled = !writable || state.busy;
  elements.delivery.disabled = !writable || state.busy;
  elements.attachFiles.disabled = !writable || state.busy;
  renderComposerContext(writable, conversation);
  renderComposerAttachments();

  restoreTranscriptScroll(scroll, options.scrollMode ?? 'auto');
  updateProgressTimer(Boolean(state.activeRunId));
}

function renderTranscript(messages, work) {
  const compacted = state.detail?.transcript?.compactedMessages ?? 0;
  if (compacted > 0) {
    const note = document.createElement('p');
    note.className = 'compaction-notice';
    note.textContent = `${compacted} older transcript item${compacted === 1 ? '' : 's'} compacted into durable context.`;
    elements.transcript.append(note);
  }
  if (state.detail?.transcript?.nextToken) {
    const loadOlder = document.createElement('button');
    loadOlder.type = 'button';
    loadOlder.className = 'load-older';
    loadOlder.textContent = 'Load earlier messages';
    loadOlder.addEventListener('click', () => void loadEarlierMessages(loadOlder));
    elements.transcript.append(loadOlder);
  }

  let workIndex = -1;
  if (work) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        workIndex = index;
        break;
      }
    }
  }
  for (const [index, item] of messages.entries()) {
    elements.transcript.append(messageNode(item));
    if (index === workIndex) elements.transcript.append(workNode(work));
  }
  if (work && workIndex < 0) elements.transcript.append(workNode(work));
  renderUnattachedArtifacts(messages);
}

async function loadEarlierMessages(button) {
  const conversationId = state.detail?.conversationId;
  const nextToken = state.detail?.transcript?.nextToken;
  if (!conversationId || !nextToken) return;
  button.disabled = true;
  const scroll = captureTranscriptScroll();
  try {
    const older = await api(
      `/v1/conversations/${encodeURIComponent(conversationId)}?limit=50&nextToken=${encodeURIComponent(nextToken)}`,
    );
    state.detail.transcript.messages = [
      ...(older.transcript?.messages ?? []),
      ...state.detail.transcript.messages,
    ];
    state.detail.transcript.nextToken = older.transcript?.nextToken;
    renderWorkspace({ scrollMode: 'anchor', scrollSnapshot: scroll });
  } catch (error) {
    button.disabled = false;
    notice(message(error), true);
  }
}

function messageNode(item) {
  const row = document.createElement('article');
  row.className = 'message-row';
  row.dataset.role = item.role;
  if (item.messageId) row.dataset.messageId = item.messageId;

  const shell = document.createElement('div');
  shell.className = 'message-shell';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = document.createElement('span');
  author.textContent = item.role === 'user' ? 'You' : 'Rat Things';
  meta.append(author);
  if (item.receivedAt) {
    const time = document.createElement('time');
    time.dateTime = item.receivedAt;
    time.title = new Date(item.receivedAt).toLocaleString();
    time.textContent = relativeTime(item.receivedAt);
    meta.append(time);
  }
  const content = document.createElement('div');
  content.className = 'message';
  if (item.replyToMessageId) {
    const quote = document.createElement('button');
    quote.type = 'button';
    quote.className = 'message-reply-quote';
    const target = transcriptMessage(item.replyToMessageId);
    quote.textContent = target
      ? `${target.role === 'user' ? 'You' : 'Rat Things'}: ${previewText(target.content, 120)}`
      : 'Replying to an earlier message';
    quote.addEventListener('click', () => focusTranscriptMessage(item.replyToMessageId));
    content.append(quote);
  }
  content.append(markdownFragment(item.content));
  shell.append(meta, content);
  if (Array.isArray(item.attachments) && item.attachments.length > 0) {
    const attachments = document.createElement('div');
    attachments.className = 'message-attachments';
    for (const attachment of item.attachments) attachments.append(attachmentNode(attachment.id));
    shell.append(attachments);
  }
  if (Array.isArray(item.pendingAttachments) && item.pendingAttachments.length > 0) {
    const attachments = document.createElement('div');
    attachments.className = 'message-attachments';
    for (const attachment of item.pendingAttachments) {
      const chip = document.createElement('span');
      chip.className = 'attachment-chip';
      chip.textContent = `${attachment.name} · ${formatBytes(attachment.bytes)}`;
      attachments.append(chip);
    }
    shell.append(attachments);
  }
  if (item.messageId) shell.append(messageActionsNode(item));
  row.append(shell);
  return row;
}

function messageActionsNode(item) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const reply = document.createElement('button');
  reply.type = 'button';
  reply.textContent = '↩ Reply';
  reply.addEventListener('click', () => {
    state.replyTarget = { messageId: item.messageId, role: item.role, content: item.content };
    renderWorkspace({ scrollMode: 'keep' });
    elements.prompt.focus();
  });
  actions.append(reply);
  const reactions = new Map((item.reactions ?? []).map((reaction) => [reaction.emoji, reaction]));
  for (const emoji of ['👍', '❤️', '🎉', '👀']) {
    const reaction = reactions.get(emoji);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reaction-button';
    button.dataset.reacted = String(reaction?.reacted === true);
    button.setAttribute('aria-label', `${reaction?.reacted ? 'Remove' : 'Add'} ${emoji} reaction`);
    button.textContent = `${emoji}${reaction?.count ? ` ${reaction.count}` : ''}`;
    button.addEventListener('click', () => void toggleReaction(item, emoji, button));
    actions.append(button);
  }
  return actions;
}

async function toggleReaction(item, emoji, button) {
  const conversationId = state.detail?.conversationId;
  if (!conversationId || !item.messageId || button.disabled) return;
  const current = (item.reactions ?? []).find((reaction) => reaction.emoji === emoji);
  const reacted = !current?.reacted;
  button.disabled = true;
  try {
    await api(
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(item.messageId)}/reactions`,
      { method: 'POST', body: { emoji, reacted } },
    );
    const count = Math.max(0, (current?.count ?? 0) + (reacted ? 1 : -1));
    item.reactions = [
      ...(item.reactions ?? []).filter((reaction) => reaction.emoji !== emoji),
      ...(count ? [{ emoji, count, reacted }] : []),
    ];
    renderWorkspace({ scrollMode: 'keep' });
  } catch (error) {
    button.disabled = false;
    notice(message(error), true);
  }
}

function transcriptMessage(messageId) {
  return (state.detail?.transcript?.messages ?? []).find((message) => message.messageId === messageId);
}

function focusTranscriptMessage(messageId) {
  const target = elements.transcript.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('search-target');
  window.setTimeout(() => target.classList.remove('search-target'), 2_400);
}

function markdownFragment(value) {
  const fragment = document.createDocumentFragment();
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      fragment.append(codeBlockNode(code.join('\n'), fence[1].trim()));
      continue;
    }
    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
    if (heading) {
      const node = document.createElement(`h${Math.min(heading[1].length + 2, 5)}`);
      appendInlineMarkdown(node, heading[2]);
      fragment.append(node);
      index += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const list = document.createElement('ul');
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*]\s+(.+)$/);
        if (!item) break;
        const listItem = document.createElement('li');
        appendInlineMarkdown(listItem, item[1]);
        list.append(listItem);
        index += 1;
      }
      fragment.append(list);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const list = document.createElement('ol');
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+\.\s+(.+)$/);
        if (!item) break;
        const listItem = document.createElement('li');
        appendInlineMarkdown(listItem, item[1]);
        list.append(listItem);
        index += 1;
      }
      fragment.append(list);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      const quoted = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      appendInlineMarkdown(quote, quoted.join('\n'));
      fragment.append(quote);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !markdownBlockStart(lines[index], paragraph.length > 0)) {
      paragraph.push(lines[index++]);
    }
    if (paragraph.length === 0) paragraph.push(lines[index++]);
    const node = document.createElement('p');
    appendInlineMarkdown(node, paragraph.join('\n'));
    fragment.append(node);
  }
  return fragment;
}

function markdownBlockStart(line, paragraphStarted) {
  if (!paragraphStarted) return false;
  return /^\s*```|^\s*#{1,3}\s+|^\s*[-*]\s+|^\s*\d+\.\s+|^\s*>\s?/.test(line);
}

function appendInlineMarkdown(parent, value) {
  const pattern = /(`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<]+)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > cursor) appendTextWithBreaks(parent, value.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else {
      const markdownLink = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      const link = document.createElement('a');
      link.href = markdownLink?.[2] ?? trimLinkPunctuation(token);
      link.textContent = markdownLink?.[1] ?? trimLinkPunctuation(token);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      parent.append(link);
      const trailing = markdownLink ? '' : token.slice(trimLinkPunctuation(token).length);
      if (trailing) parent.append(document.createTextNode(trailing));
    }
    cursor = match.index + token.length;
  }
  if (cursor < value.length) appendTextWithBreaks(parent, value.slice(cursor));
}

function appendTextWithBreaks(parent, value) {
  const parts = value.split('\n');
  for (const [index, part] of parts.entries()) {
    if (index > 0) parent.append(document.createElement('br'));
    parent.append(document.createTextNode(part));
  }
}

function trimLinkPunctuation(value) {
  return value.replace(/[),.;!?]+$/, '');
}

function codeBlockNode(value, language) {
  const shell = document.createElement('div');
  shell.className = 'code-block';
  const header = document.createElement('div');
  header.className = 'code-block-header';
  const label = document.createElement('span');
  label.textContent = language || 'code';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = 'Copied';
      window.setTimeout(() => { copy.textContent = 'Copy'; }, 1_500);
    } catch {
      notice('Clipboard access is unavailable.', true);
    }
  });
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = value;
  pre.append(code);
  header.append(label, copy);
  shell.append(header, pre);
  return shell;
}

function attachmentNode(id) {
  const artifact = state.artifacts.find((item) => item.id === id || item.sha256 === id);
  if (artifact) return artifactNode(artifact, true);
  const chip = document.createElement('span');
  chip.className = 'attachment-chip';
  chip.textContent = `Attachment · ${String(id).slice(0, 10)}`;
  chip.title = String(id);
  return chip;
}

function renderUnattachedArtifacts(messages) {
  if (state.artifacts.length === 0) return;
  const referenced = new Set(messages.flatMap((item) =>
    Array.isArray(item.attachments) ? item.attachments.map((attachment) => attachment.id) : [],
  ));
  const files = state.artifacts.filter((artifact) => !referenced.has(artifact.id) && !referenced.has(artifact.sha256));
  if (files.length === 0) return;
  const section = document.createElement('section');
  section.className = 'artifact-shelf';
  const heading = document.createElement('h2');
  heading.textContent = 'Conversation files';
  const grid = document.createElement('div');
  grid.className = 'artifact-grid';
  for (const artifact of files) grid.append(artifactNode(artifact, false));
  section.append(heading, grid);
  elements.transcript.append(section);
}

function artifactNode(artifact, compact) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = compact ? 'artifact-card artifact-card-compact' : 'artifact-card';
  if (artifact.id) button.dataset.artifactId = artifact.id;
  button.addEventListener('click', () => void openArtifact(artifact, button));
  const icon = document.createElement('span');
  icon.className = 'artifact-icon';
  icon.textContent = artifactIcon(artifact.mediaType);
  const body = document.createElement('span');
  body.className = 'artifact-body';
  const name = document.createElement('strong');
  name.textContent = artifact.path ?? artifact.name ?? 'Artifact';
  const detail = document.createElement('span');
  detail.textContent = [artifact.mediaType, formatBytes(artifact.bytes)].filter(Boolean).join(' · ');
  body.append(name, detail);
  const action = document.createElement('span');
  action.className = 'artifact-action';
  action.textContent = 'Open ↗';
  button.append(icon, body, action);
  return button;
}

async function openArtifact(artifact, button) {
  const threadKey = state.detail?.threadKey ?? state.selected?.threadKey;
  if (!threadKey || !artifact.id) return;
  button.disabled = true;
  try {
    const url = `/api/v1/conversations/${encodeURIComponent(threadKey)}/artifacts/${encodeURIComponent(artifact.id)}/content`;
    elements.viewerTitle.textContent = artifact.path ?? artifact.name ?? 'Artifact';
    elements.viewerDetail.textContent = [artifact.mediaType, formatBytes(artifact.bytes)].filter(Boolean).join(' · ');
    elements.viewerOpen.href = url;
    elements.viewerBody.replaceChildren(viewerLoadingNode());
    elements.viewer.showModal();
    await renderArtifactContent(artifact, url);
  } catch (error) {
    notice(message(error), true);
  } finally {
    button.disabled = false;
  }
}

function viewerLoadingNode() {
  const loading = document.createElement('p');
  loading.className = 'viewer-loading';
  loading.textContent = 'Loading private file…';
  return loading;
}

async function renderArtifactContent(artifact, url) {
  const mediaType = String(artifact.mediaType ?? 'application/octet-stream').toLowerCase();
  let node;
  if (mediaType.startsWith('image/')) {
    node = document.createElement('img');
    node.alt = artifact.path ?? artifact.name ?? 'Conversation artifact';
    node.src = url;
  } else if (mediaType.startsWith('video/')) {
    node = document.createElement('video');
    node.controls = true;
    node.src = url;
  } else if (mediaType.startsWith('audio/')) {
    node = document.createElement('audio');
    node.controls = true;
    node.src = url;
  } else if (mediaType === 'application/pdf') {
    node = document.createElement('iframe');
    node.title = artifact.path ?? 'PDF artifact';
    node.src = url;
  } else if (
    mediaType.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(mediaType)
  ) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Artifact viewer returned ${response.status}`);
    const text = await response.text();
    node = document.createElement('pre');
    node.className = 'viewer-text';
    node.textContent = text.length > 2_000_000 ? `${text.slice(0, 2_000_000)}\n\n[viewer truncated]` : text;
  } else {
    node = document.createElement('div');
    node.className = 'viewer-unknown';
    node.textContent = 'This file type does not have an inline preview. Open it in a new tab to download it.';
  }
  if (elements.viewer.open) elements.viewerBody.replaceChildren(node);
}

function currentWork(status) {
  if (state.activeRunId) {
    return {
      runId: state.activeRunId,
      status,
      active: true,
      startedAt: state.activeRunObservedAt,
      events: state.events,
      pendingRequests: state.pendingRequests,
      eventGap: state.eventGap,
      ready: state.runtimeReady,
    };
  }
  return state.completedWork;
}

function workNode(work) {
  const progress = progressText(work.status, state.detail?.latestProgress?.text ?? state.selected?.latestProgress?.text);
  const activities = coalesceActivities(work.events ?? []);
  const section = document.createElement('section');
  section.id = 'run-progress';
  section.className = 'work-card';
  section.dataset.state = work.status;
  section.setAttribute('aria-live', work.active ? 'polite' : 'off');

  const header = document.createElement('div');
  header.className = 'work-card-header';
  const indicator = document.createElement('span');
  indicator.className = 'work-indicator';
  indicator.dataset.state = work.status;
  indicator.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('div');
  copy.className = 'work-copy';
  const title = document.createElement('strong');
  title.id = 'run-progress-title';
  title.textContent = work.pendingRequests?.length ? 'Agent needs input' : progress.title;
  const detail = document.createElement('p');
  detail.id = 'run-progress-detail';
  detail.textContent = work.pendingRequests?.length
    ? work.pendingRequests[0].detail ?? work.pendingRequests[0].title
    : progress.detail;
  copy.append(title, detail);
  const elapsed = document.createElement('time');
  elapsed.id = 'run-progress-elapsed';
  elapsed.className = 'work-elapsed';
  elapsed.textContent = workDuration(work);
  header.append(indicator, copy, elapsed);
  if (work.active) {
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'work-stop';
    stop.textContent = 'Stop';
    stop.addEventListener('click', interruptRun);
    header.append(stop);
  }
  section.append(header);

  const details = document.createElement('details');
  details.className = 'work-details';
  details.open = Boolean(work.active);
  const summary = document.createElement('summary');
  summary.textContent = `${activities.length} action${activities.length === 1 ? '' : 's'}`;
  details.append(summary);
  const body = document.createElement('div');
  body.className = 'work-activity';
  if (work.eventGap) {
    const gap = document.createElement('p');
    gap.className = 'activity-gap';
    gap.textContent = 'Some early live activity expired from the bounded runtime window. Durable terminal evidence remains in S3.';
    body.append(gap);
  }
  for (const pending of work.pendingRequests ?? []) body.append(pendingRequestNode(pending));
  if (activities.length === 0) {
    const waiting = document.createElement('p');
    waiting.className = 'activity-empty';
    waiting.textContent = work.active
      ? work.ready ? 'Runtime ready; waiting for the next activity update…' : 'Connecting to the isolated runtime…'
      : 'No live activity was retained in this browser.';
    body.append(waiting);
  } else {
    for (const activity of activities) body.append(activityNode(activity));
  }
  details.append(body);
  section.append(details);
  return section;
}

function pendingRequestNode(request) {
  const node = document.createElement('div');
  node.className = 'pending-request';
  const icon = document.createElement('span');
  icon.textContent = '!';
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = request.title;
  const detail = document.createElement('p');
  detail.textContent = request.detail ?? 'The agent is waiting for ordinary input before it can continue.';
  copy.append(title, detail);
  if (Array.isArray(request.questions) && request.questions.length > 0) {
    copy.append(questionResponseForm(request));
  }
  node.append(icon, copy);
  return node;
}

function questionResponseForm(request) {
  const form = document.createElement('form');
  form.className = 'question-form';
  for (const question of request.questions) {
    const fieldset = document.createElement('fieldset');
    fieldset.dataset.questionId = question.id;
    const legend = document.createElement('legend');
    legend.textContent = question.header ?? question.question;
    fieldset.append(legend);
    if (question.header) {
      const prompt = document.createElement('p');
      prompt.textContent = question.question;
      fieldset.append(prompt);
    }
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length > 0) {
      for (const [index, option] of options.entries()) {
        fieldset.append(questionOption(question, option, index));
      }
      if (question.isOther) {
        fieldset.append(questionOption(question, { label: 'Other' }, options.length, true));
        const other = document.createElement('input');
        other.className = 'question-other';
        other.name = `other:${question.id}`;
        other.type = question.isSecret ? 'password' : 'text';
        other.placeholder = 'Enter another answer';
        other.autocomplete = 'off';
        fieldset.append(other);
      }
    } else {
      const input = document.createElement('input');
      input.name = `answer:${question.id}`;
      input.type = question.isSecret ? 'password' : 'text';
      input.autocomplete = 'off';
      input.required = true;
      input.placeholder = question.isSecret ? 'Enter private answer' : 'Enter your answer';
      fieldset.append(input);
    }
    form.append(fieldset);
  }
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'question-submit';
  submit.textContent = 'Send response';
  form.append(submit);
  form.addEventListener('submit', (event) => void respondToQuestions(event, request, form, submit));
  return form;
}

function questionOption(question, option, index, other = false) {
  const label = document.createElement('label');
  label.className = 'question-option';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = `answer:${question.id}`;
  input.value = other ? '__other__' : option.label;
  input.required = index === 0;
  const copy = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = option.label;
  copy.append(title);
  if (option.description) {
    const description = document.createElement('small');
    description.textContent = option.description;
    copy.append(description);
  }
  label.append(input, copy);
  return label;
}

async function respondToQuestions(event, request, form, submit) {
  event.preventDefault();
  const runId = state.activeRunId;
  if (!runId || !form.reportValidity() || submit.disabled) return;
  const data = new FormData(form);
  const answers = {};
  for (const question of request.questions) {
    let answer = data.get(`answer:${question.id}`);
    if (answer === '__other__') answer = data.get(`other:${question.id}`);
    if (typeof answer !== 'string' || !answer.trim()) {
      notice(`Answer ${question.header ?? question.question} before continuing.`, true);
      return;
    }
    answers[question.id] = { answers: [answer.trim()] };
  }
  submit.disabled = true;
  submit.textContent = 'Sending…';
  try {
    await api(
      `/v1/runs/${encodeURIComponent(runId)}/requests/${encodeURIComponent(request.requestId)}/respond`,
      { method: 'POST', body: { result: { answers } } },
    );
    state.pendingRequests = state.pendingRequests.filter((pending) => pending.requestId !== request.requestId);
    renderWorkspace({ scrollMode: 'keep' });
    notice('Response delivered to the isolated agent.');
    void pollRun();
  } catch (error) {
    submit.disabled = false;
    submit.textContent = 'Send response';
    notice(message(error), true);
  }
}

function coalesceActivities(events) {
  const result = [];
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.status === 'updated') {
      const existing = [...result].reverse().find((item) =>
        item.kind === event.kind && item.status === 'updated' && item.title === event.title,
      );
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
        existing.occurredAt = event.occurredAt;
        if (event.detail) existing.detail = event.detail;
        existing.sequence = event.sequence;
        continue;
      }
    }
    if (event.status === 'completed' || event.status === 'failed') {
      const started = [...result].reverse().find((item) => item.kind === event.kind && item.status === 'started');
      if (started) {
        Object.assign(started, event, { startedAt: started.occurredAt });
        continue;
      }
    }
    result.push({ ...event });
  }
  return result;
}

function activityNode(activity) {
  const row = document.createElement('div');
  row.className = 'activity-item';
  row.dataset.kind = activity.kind;
  row.dataset.status = activity.status;
  const icon = document.createElement('span');
  icon.className = 'activity-icon';
  icon.textContent = activityIcon(activity.kind, activity.status);
  const copy = document.createElement('div');
  copy.className = 'activity-copy';
  const title = document.createElement('strong');
  title.textContent = activity.title;
  const detail = document.createElement('span');
  detail.textContent = [activity.detail, activity.count > 1 ? `${activity.count} updates` : undefined]
    .filter(Boolean).join(' · ');
  copy.append(title, detail);
  const time = document.createElement('time');
  time.dateTime = activity.occurredAt;
  time.title = new Date(activity.occurredAt).toLocaleString();
  time.textContent = new Date(activity.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  row.append(icon, copy, time);
  return row;
}

async function submitMessage(event) {
  event.preventDefault();
  const prompt = elements.prompt.value.trim();
  const threadKey = state.draftThreadKey ?? state.detail?.threadKey ?? state.selected?.threadKey;
  if (!prompt || !threadKey || state.busy) return;
  const files = [...state.uploads];
  const replyTarget = state.replyTarget;
  state.busy = true;
  renderWorkspace({ scrollMode: 'keep' });
  try {
    const attachments = await Promise.all(files.map(filePayload));
    const run = await api('/v1/runs', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: {
        version: '1',
        prompt,
        thread: {
          key: threadKey,
          delivery: elements.delivery.value,
          ...(attachments.length ? { attachments } : {}),
          ...(replyTarget?.messageId ? { replyToMessageId: replyTarget.messageId } : {}),
        },
      },
    });
    activateRun(run);
    elements.prompt.value = '';
    clearDraft();
    clearComposerExtras();
    resizeComposer();
    appendOptimisticMessage(prompt, files, replyTarget);
    renderWorkspace({ scrollMode: 'bottom' });
    notice(`Run ${run.runId} accepted.`);
    await refreshConversations(false);
    await pollRun();
  } catch (error) {
    notice(message(error), true);
  } finally {
    state.busy = false;
    renderWorkspace({ scrollMode: 'auto' });
  }
}

function appendOptimisticMessage(prompt, files = [], replyTarget = null) {
  if (!state.detail) {
    state.detail = {
      ...(state.selected ?? {}),
      threadKey: state.draftThreadKey,
      status: 'pending',
      transcript: { messages: [], compactedMessages: 0 },
    };
  }
  state.detail.transcript.messages.push({
    role: 'user',
    content: prompt,
    receivedAt: new Date().toISOString(),
    ...(files.length ? { pendingAttachments: files.map((file) => ({ name: file.name, bytes: file.size })) } : {}),
    ...(replyTarget?.messageId ? { replyToMessageId: replyTarget.messageId } : {}),
  });
}

async function filePayload(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return {
    name: file.name,
    mediaType: file.type || 'application/octet-stream',
    base64: bytesToBase64(bytes),
    sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

async function pollRun() {
  window.clearTimeout(state.pollTimer);
  if (!state.activeRunId) return;
  const runId = state.activeRunId;
  const after = state.eventAfter;
  try {
    const [run, snapshot] = await Promise.all([
      api(`/v1/runs/${encodeURIComponent(runId)}`),
      api(`/v1/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${EVENT_PAGE_SIZE}`).catch(() => null),
    ]);
    const eventPageFull = Boolean(
      snapshot && Array.isArray(snapshot.events) && snapshot.events.length >= EVENT_PAGE_SIZE,
    );
    if (snapshot) consumeRuntimeSnapshot(snapshot, after);
    if (isTerminal(run.status)) {
      await finishRun(run);
      return;
    }
    state.activeRun = run;
    state.activeRunObservedAt ??= runStartedAt(run);
    if (state.detail) state.detail.status = run.status;
    renderWorkspace({ scrollMode: 'auto' });
    renderConversationList();
    state.pollTimer = window.setTimeout(() => void pollRun(), eventPageFull ? 50 : 1_400);
  } catch (error) {
    notice(message(error), true);
    state.pollTimer = window.setTimeout(() => void pollRun(), 3_000);
  }
}

function consumeRuntimeSnapshot(snapshot, requestedAfter) {
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const oldest = Number(snapshot.oldestSequence);
  if (Number.isSafeInteger(oldest) && oldest > requestedAfter + 1) state.eventGap = true;
  const merged = new Map(state.events.map((event) => [event.sequence, event]));
  for (const event of events) merged.set(event.sequence, event);
  state.events = [...merged.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_RETAINED_EVENTS);
  const newest = state.events.at(-1)?.sequence;
  if (Number.isSafeInteger(newest)) state.eventAfter = Math.max(state.eventAfter, newest);
  state.pendingRequests = Array.isArray(snapshot.pendingRequests) ? snapshot.pendingRequests : [];
  state.runtimeReady = snapshot.ready === true;
}

async function finishRun(run) {
  const completedAt = run.updatedAt ?? new Date().toISOString();
  state.completedWork = {
    runId: run.runId,
    status: run.status,
    active: false,
    startedAt: state.activeRunObservedAt,
    completedAt,
    durationMs: run.result?.durationMs,
    events: [...state.events],
    pendingRequests: [],
    eventGap: state.eventGap,
    ready: state.runtimeReady,
  };
  persistCompletedWork(state.completedWork);
  const conversationId = state.detail?.conversationId ?? state.selected?.conversationId;
  if (conversationId) state.liveWorkByConversation.delete(conversationId);
  clearActiveRun();
  await refreshConversations(false);
  const threadKey = state.draftThreadKey ?? state.detail?.threadKey;
  const current = state.conversations.find((item) => item.threadKey && item.threadKey === threadKey);
  if (current) {
    state.selected = current;
    markConversationRead(current);
    const detail = await waitForConversationProjection(current, run);
    const artifacts = await loadConversationArtifacts(current);
    state.detail = detail;
    state.artifacts = artifacts;
    state.draftThreadKey = null;
    localStorage.setItem('rat-things.selected-conversation', current.conversationId);
  }
  renderConversationList();
  renderWorkspace({ scrollMode: 'bottom' });
  notice(run.status === 'succeeded' ? 'Run completed.' : `Run ${run.status}.`, run.status === 'failed');
}

async function waitForConversationProjection(conversation, run) {
  let latest = state.detail;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    latest = await api(`/v1/conversations/${encodeURIComponent(conversation.conversationId)}`);
    if (conversationProjectionSettled(latest, run)) return latest;
    await delay(500);
  }
  return latest;
}

function conversationProjectionSettled(detail, run) {
  if (!detail || detail.activeRunId || detail.status !== 'idle') return false;
  const detailUpdatedAt = Date.parse(detail.updatedAt);
  const runUpdatedAt = Date.parse(run.updatedAt);
  if (Number.isFinite(runUpdatedAt) && (!Number.isFinite(detailUpdatedAt) || detailUpdatedAt < runUpdatedAt)) {
    return false;
  }
  if (run.status !== 'succeeded') return true;
  const messages = detail.transcript?.messages ?? [];
  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user');
  return messages.slice(latestUserIndex + 1).some((message) => message.role === 'assistant');
}

function activateRun(run) {
  state.activeRunId = run.runId;
  state.activeRun = run;
  state.activeRunObservedAt = runStartedAt(run);
  state.events = [];
  state.pendingRequests = [];
  state.eventAfter = 0;
  state.eventGap = false;
  state.runtimeReady = false;
  state.completedWork = null;
}

function clearActiveRun() {
  state.activeRunId = null;
  state.activeRun = null;
  state.activeRunObservedAt = null;
  state.events = [];
  state.pendingRequests = [];
  state.eventAfter = 0;
  state.eventGap = false;
  state.runtimeReady = false;
  window.clearInterval(state.progressTimer);
  state.progressTimer = null;
}

function resetLiveRunState() {
  window.clearTimeout(state.pollTimer);
  clearActiveRun();
}

function cacheLiveWork() {
  const conversationId = state.detail?.conversationId ?? state.selected?.conversationId;
  if (!conversationId || !state.activeRunId) return;
  state.liveWorkByConversation.set(conversationId, {
    runId: state.activeRunId,
    run: state.activeRun,
    observedAt: state.activeRunObservedAt,
    events: [...state.events],
    pendingRequests: [...state.pendingRequests],
    eventAfter: state.eventAfter,
    eventGap: state.eventGap,
    runtimeReady: state.runtimeReady,
  });
}

function restoreLiveWork(conversationId, runId) {
  const cached = state.liveWorkByConversation.get(conversationId);
  if (!cached || cached.runId !== runId) {
    state.activeRunObservedAt = Date.now();
    return;
  }
  state.activeRun = cached.run;
  state.activeRunObservedAt = cached.observedAt ?? Date.now();
  state.events = cached.events;
  state.pendingRequests = cached.pendingRequests;
  state.eventAfter = cached.eventAfter;
  state.eventGap = cached.eventGap;
  state.runtimeReady = cached.runtimeReady;
}

function updateProgressTimer(active) {
  if (!active) {
    window.clearInterval(state.progressTimer);
    state.progressTimer = null;
    return;
  }
  updateProgressElapsed();
  state.progressTimer ??= window.setInterval(updateProgressElapsed, 1_000);
}

function updateProgressElapsed() {
  const elapsed = document.querySelector('#run-progress-elapsed');
  if (!elapsed || !state.activeRunId || !state.activeRunObservedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - state.activeRunObservedAt) / 1_000));
  elapsed.dateTime = `PT${seconds}S`;
  elapsed.textContent = formatElapsed(seconds);
}

function runStartedAt(run) {
  const createdAt = Date.parse(run?.createdAt);
  return Number.isFinite(createdAt) ? Math.min(createdAt, Date.now()) : Date.now();
}

function progressText(status, latestProgress) {
  switch (status) {
    case 'dispatching':
      return {
        title: 'Starting isolated environment',
        detail: 'Preparing the owner-bound MicroVM and durable workspace. First-use storage can take tens of seconds.',
      };
    case 'running':
      return {
        title: latestProgress || 'Agent is working',
        detail: latestProgress
          ? 'The isolated runtime is ready and reported this progress.'
          : 'The isolated runtime is ready and processing this turn.',
      };
    case 'cancelling':
      return {
        title: 'Stopping safely',
        detail: 'The runtime is handling the interruption and preserving durable state.',
      };
    case 'succeeded':
      return { title: 'Work completed', detail: 'The response and conversation state are durable.' };
    case 'failed':
      return { title: 'Work failed', detail: 'The failure is recorded with the Run for diagnosis.' };
    case 'cancelled':
      return { title: 'Work stopped', detail: 'The interruption completed and durable state was preserved.' };
    default:
      return {
        title: 'Queued for isolated execution',
        detail: 'Your message is durable and waiting for an owner-bound worker.',
      };
  }
}

function statusLabel(status) {
  return ({
    idle: 'Ready', pending: 'Saving', queued: 'Queued', dispatching: 'Starting', running: 'Working',
    awaiting_resume: 'Resuming', cancelling: 'Stopping', succeeded: 'Complete', failed: 'Failed', cancelled: 'Cancelled',
  })[status] ?? String(status).replaceAll('_', ' ');
}

async function interruptRun() {
  if (!state.activeRunId) return;
  try {
    await api(`/v1/runs/${encodeURIComponent(state.activeRunId)}/interrupt`, {
      method: 'POST',
      body: {},
    });
    notice('Interrupt requested.');
  } catch (error) {
    notice(message(error), true);
  }
}

function captureTranscriptScroll() {
  return {
    top: elements.transcript.scrollTop,
    height: elements.transcript.scrollHeight,
    nearBottom: transcriptNearBottom(),
  };
}

function restoreTranscriptScroll(previous, mode) {
  window.requestAnimationFrame(() => {
    if (mode === 'bottom' || (mode === 'auto' && previous.nearBottom)) {
      scrollTranscriptToBottom('auto');
    } else if (mode === 'anchor') {
      elements.transcript.scrollTop = previous.top + (elements.transcript.scrollHeight - previous.height);
    } else {
      elements.transcript.scrollTop = previous.top;
      updateJumpLatest();
    }
  });
}

function transcriptNearBottom() {
  return elements.transcript.scrollHeight - elements.transcript.scrollTop - elements.transcript.clientHeight < 96;
}

function scrollTranscriptToBottom(behavior) {
  elements.transcript.scrollTo({ top: elements.transcript.scrollHeight, behavior });
  window.requestAnimationFrame(updateJumpLatest);
}

function updateJumpLatest() {
  elements.jumpLatest.hidden = transcriptNearBottom();
}

function transcriptLoadingNode() {
  const shell = document.createElement('div');
  shell.className = 'transcript-loading';
  shell.setAttribute('aria-label', 'Loading conversation');
  for (let index = 0; index < 3; index += 1) {
    const line = document.createElement('span');
    shell.append(line);
  }
  return shell;
}

function persistDraft() {
  const key = draftStorageKey();
  if (!key) return;
  if (elements.prompt.value) localStorage.setItem(key, elements.prompt.value);
  else localStorage.removeItem(key);
}

function restoreDraft() {
  elements.prompt.value = localStorage.getItem(draftStorageKey() ?? '') ?? '';
  resizeComposer();
}

function clearDraft() {
  const key = draftStorageKey();
  if (key) localStorage.removeItem(key);
}

function draftStorageKey() {
  const identity = state.selected?.conversationId ?? (state.draftThreadKey ? `new-${state.draftThreadKey}` : undefined);
  return identity ? `${DRAFT_PREFIX}${identity}` : undefined;
}

function persistCompletedWork(work) {
  const conversationId = state.detail?.conversationId ?? state.selected?.conversationId;
  if (!conversationId) return;
  try {
    localStorage.setItem(`${WORK_PREFIX}${conversationId}`, JSON.stringify(work));
  } catch {
    // The UI still retains the safe summary for this session when storage is unavailable.
  }
}

function restoreCompletedWork(conversationId) {
  try {
    const raw = localStorage.getItem(`${WORK_PREFIX}${conversationId}`);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && value.active === false ? value : null;
  } catch {
    return null;
  }
}

function conversationAttention(conversation) {
  if (state.selected?.conversationId === conversation.conversationId && state.pendingRequests.length > 0) return 'needs-input';
  if (conversation.status === 'failed') return 'failed';
  if (['pending', 'running', 'awaiting_resume'].includes(conversation.status) || conversation.pendingCount > 0) return 'working';
  if (conversation.unread) return 'unread';
  return 'ready';
}

function attentionLabel(value) {
  return ({ 'needs-input': 'Needs input', failed: 'Failed', working: 'Working', unread: 'New', ready: 'Ready' })[value];
}

function conversationPreview(conversation) {
  return conversation.latestProgress?.text && ['pending', 'running', 'awaiting_resume'].includes(conversation.status)
    ? conversation.latestProgress.text
    : conversation.lastMessagePreview ?? statusText(conversation);
}

function sidebarIsOpen() {
  return elements.sidebar.dataset.open === 'true';
}

function setSidebarOpen(open) {
  const compact = compactLayout();
  const wasOpen = sidebarIsOpen();
  const next = compact && open;
  elements.sidebar.dataset.open = String(next);
  elements.sidebarToggle.setAttribute('aria-expanded', String(next));
  elements.sidebarScrim.dataset.open = String(next);
  elements.workspace.inert = next;
  elements.sidebar.inert = compact && !next;
  if (compact) elements.sidebar.setAttribute('aria-hidden', String(!next));
  else elements.sidebar.removeAttribute('aria-hidden');
  if (next) {
    window.requestAnimationFrame(() => elements.filter.focus());
  } else if (wasOpen && compact) {
    window.requestAnimationFrame(() => elements.sidebarToggle.focus());
  }
}

function handleSidebarKeydown(event) {
  if (!sidebarIsOpen()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    setSidebarOpen(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...elements.sidebar.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function compactLayout() {
  return window.matchMedia('(max-width: 900px)').matches;
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers ?? {}) };
  const init = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['x-rat-console-request'] = '1';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`/api${path}`, init);
  const text = await response.text();
  const value = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(value.error?.message ?? `Request failed with HTTP ${response.status}`);
  return value;
}

function labelFor(conversation) {
  if (conversation.title) return conversation.title;
  if (conversation.threadKey) return conversation.threadKey;
  return `${sourceLabel(conversation.sourceKind)} conversation`;
}

function sourceLabel(source) {
  return ({ api: 'API', github: 'GitHub', gitlab: 'GitLab', teams: 'Teams', slack: 'Slack' })[source] ?? 'Agent';
}

function statusText(conversation) {
  if (conversation.pendingCount > 0) return `${conversation.pendingCount} message${conversation.pendingCount === 1 ? '' : 's'} waiting`;
  if (conversation.status === 'idle') return 'Ready for the next message';
  return statusLabel(conversation.status);
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function workDuration(work) {
  if (Number.isFinite(work.durationMs)) return formatDuration(work.durationMs);
  const started = typeof work.startedAt === 'number' ? work.startedAt : Date.parse(work.startedAt);
  const completed = work.active ? Date.now() : Date.parse(work.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return work.active ? '0s' : 'Completed';
  return formatElapsed(Math.max(0, Math.floor((completed - started) / 1_000)));
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatDuration(milliseconds) {
  return formatElapsed(Math.max(0, Math.round(milliseconds / 1_000)));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function previewText(value, maximum) {
  const compact = String(value ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > maximum ? `${compact.slice(0, maximum - 1).trimEnd()}…` : compact;
}

function artifactIcon(mediaType) {
  if (mediaType?.startsWith('image/')) return 'IMG';
  if (mediaType?.startsWith('video/')) return 'VID';
  if (mediaType === 'application/pdf') return 'PDF';
  if (mediaType?.includes('json')) return '{}';
  return 'FILE';
}

function activityIcon(kind, status) {
  if (status === 'failed' || kind === 'error') return '!';
  return ({
    agent: '●', message: '↗', reasoning: '◇', command: '›_', file: '±', tool: '◆', web_search: '⌕',
    computer: '▣', plan: '☷', compaction: '↻', usage: '#', activity: '·',
  })[kind] ?? '·';
}

function isTerminal(status) {
  return ['succeeded', 'failed', 'cancelled'].includes(status);
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function resizeComposer() {
  elements.prompt.style.height = 'auto';
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`;
}

function notice(text, isError = false) {
  elements.notice.textContent = text;
  elements.notice.dataset.error = String(isError);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
