import { coalesceActivities, groupActivities } from './activity.js';
import { renderMarkdown } from './markdown.js';
import { resolveArtifactLink, isMarkdownArtifact } from './artifact-links.js';
import { conversationWorkState, completionReceiptIndex, runPresentation, isTextArtifact, readTextPreview, formatBytes, shellArgument, fileCommands, answerCommands, messagePreview } from './presentation.js';

const elements = {
  shell: document.querySelector('.app-shell'),
  sidebar: document.querySelector('#sidebar'),
  sidebarResizer: document.querySelector('#sidebar-resizer'),
  sidebarToggle: document.querySelector('#sidebar-toggle'),
  sidebarScrim: document.querySelector('#sidebar-scrim'),
  navConversations: document.querySelector('#nav-conversations'),
  navConnections: document.querySelector('#nav-connections'),
  navRoutines: document.querySelector('#nav-routines'),
  sidebarTools: document.querySelector('.sidebar-tools'),
  sidebarSectionLabel: document.querySelector('.section-label'),
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
  managementView: document.querySelector('#management-view'),
  managementLoading: document.querySelector('#management-loading'),
  managementContent: document.querySelector('#management-content'),
  empty: document.querySelector('#empty-state'),
  jumpLatest: document.querySelector('#jump-latest'),
  composer: document.querySelector('#composer'),
  composerContext: document.querySelector('#composer-context'),
  composerAttachments: document.querySelector('#composer-attachments'),
  prompt: document.querySelector('#prompt'),
  delivery: document.querySelector('#delivery'),
  browserUse: document.querySelector('#browser-use'),
  attachFiles: document.querySelector('#attach-files'),
  fileInput: document.querySelector('#file-input'),
  send: document.querySelector('#send'),
  openContext: document.querySelector('#open-context'),
  terminalCommands: document.querySelector('#terminal-commands'),
  terminalDialog: document.querySelector('#terminal-dialog'),
  terminalCommandList: document.querySelector('#terminal-command-list'),
  terminalTitle: document.querySelector('#terminal-dialog-title'),
  reactionDialog: document.querySelector('#reaction-dialog'),
  reactionChoices: document.querySelector('#reaction-choices'),
  runStrip: document.querySelector('#run-strip'),
  runStripPhase: document.querySelector('#run-strip-phase'),
  runStripTitle: document.querySelector('#run-strip-title'),
  runStripDetail: document.querySelector('#run-strip-detail'),
  runStripElapsed: document.querySelector('#run-strip-elapsed'),
  steerRun: document.querySelector('#steer-run'),
  stopRun: document.querySelector('#stop-run'),
  notice: document.querySelector('#notice'),
  viewer: document.querySelector('#artifact-viewer'),
  viewerTitle: document.querySelector('#viewer-title'),
  viewerBack: document.querySelector('#viewer-back'),
  renameDialog: document.querySelector('#rename-dialog'),
  renameForm: document.querySelector('#rename-form'),
  renameTitle: document.querySelector('#rename-title'),
  viewerBody: document.querySelector('#viewer-body'),
  viewerDetail: document.querySelector('#viewer-detail'),
  viewerOpen: document.querySelector('#viewer-open'),
  viewerDownload: document.querySelector('#viewer-download'),
  viewerTerminal: document.querySelector('#viewer-terminal'),
  viewerSource: document.querySelector('#viewer-source'),
  closeViewer: document.querySelector('#close-viewer'),
  contextResizer: document.querySelector('#context-resizer'),
  contextPane: document.querySelector('#context-pane'),
  contextPopout: document.querySelector('#context-popout'),
  contextTabBrowser: document.querySelector('#context-tab-browser'),
  contextTabSources: document.querySelector('#context-tab-sources'),
  contextTabActivity: document.querySelector('#context-tab-activity'),
  contextBrowser: document.querySelector('#context-browser'),
  contextSources: document.querySelector('#context-sources'),
  contextActivity: document.querySelector('#context-activity'),
  contextSourceCount: document.querySelector('#context-source-count'),
  computerOwnerDot: document.querySelector('#computer-owner-dot'),
  computerOwnerLabel: document.querySelector('#computer-owner-label'),
  computerLeaseLabel: document.querySelector('#computer-lease-label'),
  computerControl: document.querySelector('#computer-control'),
  closeComputer: document.querySelector('#close-computer'),
  computerNavigation: document.querySelector('#computer-navigation'),
  computerBack: document.querySelector('#computer-back'),
  computerUrl: document.querySelector('#computer-url'),
  computerStage: document.querySelector('#computer-stage'),
  computerScreen: document.querySelector('#computer-screen'),
  computerLoading: document.querySelector('#computer-loading'),
  computerActionState: document.querySelector('#computer-action-state'),
  computerZoomOut: document.querySelector('#computer-zoom-out'),
  computerZoomIn: document.querySelector('#computer-zoom-in'),
  computerZoomLabel: document.querySelector('#computer-zoom-label'),
  computerFit: document.querySelector('#computer-fit'),
  computerType: document.querySelector('#computer-type'),
  computerText: document.querySelector('#computer-text'),
  computerEnter: document.querySelector('#computer-enter'),
  computerScrollUp: document.querySelector('#computer-scroll-up'),
  computerScrollDown: document.querySelector('#computer-scroll-down'),
  computerRecordingBadge: document.querySelector('#computer-recording-badge'),
  computerRecordingTime: document.querySelector('#computer-recording-time'),
  teachSetup: document.querySelector('#teach-setup'),
  teachName: document.querySelector('#teach-name'),
  teachGoal: document.querySelector('#teach-goal'),
  teachStart: document.querySelector('#teach-start'),
  teachRecordingActions: document.querySelector('#teach-recording-actions'),
  teachStepCount: document.querySelector('#teach-step-count'),
  teachSave: document.querySelector('#teach-save'),
  teachDiscard: document.querySelector('#teach-discard'),
  connectDialog: document.querySelector('#connect-dialog'),
  connectForm: document.querySelector('#connect-form'),
  connectDialogTitle: document.querySelector('#connect-dialog-title'),
  connectDialogClose: document.querySelector('#connect-dialog-close'),
  connectCancel: document.querySelector('#connect-cancel'),
  connectPluginId: document.querySelector('#connect-plugin-id'),
  connectAuthScheme: document.querySelector('#connect-auth-scheme'),
  connectFields: document.querySelector('#connect-fields'),
  connectAlias: document.querySelector('#connect-alias'),
  connectAliasField: document.querySelector('#connect-alias-field'),
  connectAccess: document.querySelector('#connect-access'),
  connectAccessField: document.querySelector('#connect-access-field'),
  connectSubmit: document.querySelector('#connect-submit'),
  connectionDetailDialog: document.querySelector('#connection-detail-dialog'),
  connectionDetailForm: document.querySelector('#connection-detail-form'),
  connectionDetailTitle: document.querySelector('#connection-detail-title'),
  connectionDetailClose: document.querySelector('#connection-detail-close'),
  connectionDetailCancel: document.querySelector('#connection-detail-cancel'),
  connectionDetailSummary: document.querySelector('#connection-detail-summary'),
  connectionDisplayName: document.querySelector('#connection-display-name'),
  connectionHealth: document.querySelector('#connection-health'),
  connectionScopes: document.querySelector('#connection-scopes'),
  connectionOperations: document.querySelector('#connection-operations'),
  connectionConsumers: document.querySelector('#connection-consumers'),
  connectionTest: document.querySelector('#connection-test'),
  connectionReconnect: document.querySelector('#connection-reconnect'),
  connectionRename: document.querySelector('#connection-rename'),
  routineDialog: document.querySelector('#routine-dialog'),
  routineForm: document.querySelector('#routine-form'),
  routineDialogClose: document.querySelector('#routine-dialog-close'),
  routineCancel: document.querySelector('#routine-cancel'),
  routineName: document.querySelector('#routine-name'),
  routinePrompt: document.querySelector('#routine-prompt'),
  routineMinutes: document.querySelector('#routine-minutes'),
  routineEnabled: document.querySelector('#routine-enabled'),
  routineSubmit: document.querySelector('#routine-submit'),
};

const LIST_PAGE_SIZE = 25;
const EVENT_PAGE_SIZE = 100;
const AUTO_REFRESH_MS = 15_000;
const MAX_RETAINED_EVENTS = 200;
const DRAFT_PREFIX = 'rat-things.draft.';

const state = {
  mode: 'conversations',
  conversations: [],
  conversationRows: new Map(),
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
  draftTitle: null,
  activeRunId: null,
  computerUnavailableRunId: null,
  activeRun: null,
  activeRunObservedAt: null,
  events: [],
  pendingRequests: [],
  questionNodes: new Map(),
  eventAfter: 0,
  eventGap: false,
  runtimeReady: false,
  completedWork: null,
  completionByRun: new Map(),
  activityRunId: null,
  answeredRequests: [],
  viewerHistory: [],
  liveWorkByConversation: new Map(),
  artifacts: [],
  uploads: [],
  replyTarget: null,
  steering: false,
  busy: false,
  pollTimer: null,
  progressTimer: null,
  refreshTimer: null,
  selectionRevision: 0,
  computer: null,
  computerBusy: false,
  computerTimer: null,
  computerClock: null,
  contextOpen: false,
  contextTab: 'browser',
  computerZoom: 1,
  managementLoading: false,
  plugins: [],
  connections: [],
  connectionSets: [],
  sourceBindings: [],
  routines: [],
  oauthPollTimer: null,
  selectedConnection: null,
  reconnectTarget: null,
  connectionFilter: '',
};

elements.newThread.addEventListener('click', openNewThread);
elements.navConversations.addEventListener('click', () => void setWorkspaceMode('conversations'));
elements.navConnections.addEventListener('click', () => void setWorkspaceMode('connections'));
elements.navRoutines.addEventListener('click', () => void setWorkspaceMode('routines'));
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
elements.viewerSource.addEventListener('click', () => {
  const viewing = state.viewerFile;
  if (!viewing?.preview) return;
  viewing.source = !viewing.source;
  elements.viewerBody.replaceChildren(textPreviewNode(viewing));
});
elements.closeViewer.addEventListener('click', () => elements.viewer.close());
elements.viewerBack.addEventListener('click', () => {
  const previous = state.viewerHistory.pop();
  if (previous) void openArtifact(previous.artifact, elements.viewerBack, previous, true);
});
elements.renameForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!elements.renameForm.reportValidity()) return;
  const title = elements.renameTitle.value.trim();
  if (!title) return;
  const updated = await updateConversationOrganization(state.renaming, {title});
  if (updated.title === title) elements.renameDialog.close();
});
document.querySelector('#rename-cancel').addEventListener('click', () => elements.renameDialog.close());
elements.viewer.addEventListener('close', () => { state.viewerHistory = []; state.viewerFile = null; elements.viewerBody.replaceChildren(); });
elements.viewerTerminal.addEventListener('click', () => {
  if (!state.viewerFile) return;
  const { threadKey, artifact } = state.viewerFile;
  showTerminalCommands(fileCommands(threadKey, artifact), 'Use this file in your terminal');
});
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
elements.openContext.addEventListener('click', () => openContext());
elements.terminalCommands.addEventListener('click', openTerminalCommands);
elements.steerRun.addEventListener('click', focusSteeringComposer);
elements.stopRun.addEventListener('click', interruptRun);
elements.closeComputer.addEventListener('click', () => void closeComputer());
elements.contextPopout.addEventListener('click', toggleContextFullscreen);
elements.contextTabBrowser.addEventListener('click', () => openContext('browser'));
elements.contextTabSources.addEventListener('click', () => setContextTab('sources'));
elements.contextTabActivity.addEventListener('click', () => setContextTab('activity'));
elements.computerControl.addEventListener('click', toggleComputerControl);
elements.computerNavigation.addEventListener('submit', navigateComputer);
elements.computerBack.addEventListener('click', () => void computerAction({ type: 'back' }));
elements.computerType.addEventListener('submit', typeOnComputer);
elements.computerEnter.addEventListener('click', () => void computerAction({ type: 'press', key: 'Enter' }));
elements.computerScrollUp.addEventListener('click', () => void computerAction({ type: 'scroll', deltaY: -560 }));
elements.computerScrollDown.addEventListener('click', () => void computerAction({ type: 'scroll', deltaY: 560 }));
elements.computerScreen.addEventListener('click', clickComputerScreen);
elements.computerStage.addEventListener('wheel', wheelComputerScreen, { passive: false });
elements.computerStage.addEventListener('keydown', keyComputerScreen);
elements.computerZoomOut.addEventListener('click', () => setComputerZoom(state.computerZoom - .25));
elements.computerZoomIn.addEventListener('click', () => setComputerZoom(state.computerZoom + .25));
elements.computerFit.addEventListener('click', () => setComputerZoom(1));
elements.teachStart.addEventListener('click', startTeaching);
elements.teachName.addEventListener('input', renderComputer);
elements.teachSave.addEventListener('click', () => void stopTeaching(false));
elements.teachDiscard.addEventListener('click', () => void stopTeaching(true));
elements.connectForm.addEventListener('submit', submitManualConnection);
elements.connectDialogClose.addEventListener('click', () => elements.connectDialog.close());
elements.connectCancel.addEventListener('click', () => elements.connectDialog.close());
elements.connectionDetailForm.addEventListener('submit', renameSelectedConnection);
elements.connectionDetailClose.addEventListener('click', () => elements.connectionDetailDialog.close());
elements.connectionDetailCancel.addEventListener('click', () => elements.connectionDetailDialog.close());
elements.connectionTest.addEventListener('click', () => void testSelectedConnection());
elements.connectionReconnect.addEventListener('click', () => void reconnectSelectedConnection());
elements.connectionDetailDialog.addEventListener('close', () => { state.selectedConnection = null; });
elements.connectDialog.addEventListener('close', () => {
  state.reconnectTarget = null;
  elements.connectForm.reset();
  elements.connectFields.replaceChildren();
});
elements.routineForm.addEventListener('submit', submitRoutine);
elements.routineDialogClose.addEventListener('click', () => elements.routineDialog.close());
elements.routineCancel.addEventListener('click', () => elements.routineDialog.close());
elements.transcript.addEventListener('scroll', updateJumpLatest);
elements.jumpLatest.addEventListener('click', () => scrollTranscriptToBottom('smooth'));
elements.sidebarToggle.addEventListener('click', () => setSidebarOpen(!sidebarIsOpen()));
elements.sidebarScrim.addEventListener('click', () => setSidebarOpen(false));
document.addEventListener('keydown', handleSidebarKeydown);
window.addEventListener('resize', () => {
  setSidebarOpen(false);
  syncContextLayout();
});

setupPaneResizer(elements.sidebarResizer, 'sidebar');
setupPaneResizer(elements.contextResizer, 'context');
restorePaneWidths();
setSidebarOpen(false);
syncContextLayout();
void initialize();

async function initialize() {
  try {
    await refreshConversations(false);
    const requested = new URLSearchParams(window.location.search);
    const requestedThread = requested.get('thread');
    const requestedRun = requested.get('run');
    const requestedConversation = requested.get('conversation');
    if ([requestedRun, requestedThread, requestedConversation].filter(Boolean).length > 1) throw new Error('Choose one conversation, thread, or Run destination.');
    let explicitConversation;
    let explicitRun;
    if (requestedRun) {
      explicitRun = await api(`/v1/runs/${encodeURIComponent(requestedRun)}`);
      if (!explicitRun.conversationId) throw new Error('This Run has no conversation link. Update the control API or open its conversation explicitly.');
      explicitConversation = await api(`/v1/conversations/${encodeURIComponent(explicitRun.conversationId)}`);
    }
    if (requestedThread) explicitConversation = await findThread(requestedThread);
    if (requestedConversation) {
      try {
        explicitConversation = await api(`/v1/conversations/${encodeURIComponent(requestedConversation)}`);
      } catch (error) {
        renderWorkspace();
        notice(`Could not open the requested conversation. ${message(error)}`, true);
        return;
      }
    }
    const saved = localStorage.getItem('rat-things.selected-conversation');
    const selected = explicitConversation ?? (!requestedThread && !requestedRun && !requestedConversation
      ? state.conversations.find(item => item.conversationId === saved) ?? state.conversations[0] : undefined);
    const draft = JSON.parse(localStorage.getItem('rat-things.new-conversation') ?? 'null');
    const acceptedDraft = state.conversations.find(item => draft?.key && item.threadKey === draft.key);
    if (requestedThread && !selected) {
      prepareDraftThread(requestedThread, requestedThread);
    } else if (acceptedDraft && !requestedThread && !requestedRun && !requestedConversation) {
      await selectConversation(acceptedDraft);
    } else if (draft?.key && !requestedThread && !requestedRun && !requestedConversation) {
      state.draftThreadKey = draft.key;
      state.draftTitle = draft.title;
      restoreDraft();
      await restoreSubmission(draft.key);
      renderWorkspace({ scrollMode: 'bottom' });
    } else if (selected) await selectConversation(selected);
    else { restoreDraft(); renderWorkspace({ scrollMode: 'bottom' }); }
    if (explicitRun) {
      if (isTerminal(explicitRun.status)) {
        const work = completedRunWork(explicitRun);
        state.completionByRun.set(work.runId, work);
        state.completedWork = work;
        state.activityRunId = work.runId;
        renderWorkspace({scrollMode: 'bottom'});
        await openContext('activity');
        void reconcileCompletedActivity(work);
      } else {
        if (!state.activeRunId) { activateRun(explicitRun); void pollRun(); }
        await openContext('browser');
      }
    }
    window.setInterval(updateRelativeTimes, 15_000);
    const requestedView = requested.get('view');
    if (requestedView === 'connections' || requestedView === 'routines') {
      await setWorkspaceMode(requestedView);
    }
    state.refreshTimer = window.setInterval(() => {
      if (!document.hidden && !state.listLoading) void refreshConversations(false);
    }, AUTO_REFRESH_MS);
  } finally {
    elements.newThread.disabled = false;
    elements.refresh.disabled = false;
    document.documentElement.dataset.consoleReady = 'true';
  }
}

async function setWorkspaceMode(mode) {
  if (!['conversations', 'connections', 'routines'].includes(mode)) return;
  state.mode = mode;
  window.clearInterval(state.oauthPollTimer);
  state.oauthPollTimer = null;
  for (const [name, button] of Object.entries({
    conversations: elements.navConversations,
    connections: elements.navConnections,
    routines: elements.navRoutines,
  })) {
    if (name === mode) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  const conversations = mode === 'conversations';
  elements.newThread.hidden = !conversations;
  elements.sidebarTools.hidden = !conversations;
  elements.sidebarSectionLabel.hidden = !conversations;
  elements.list.hidden = !conversations;
  elements.hiddenToggle.hidden = !conversations;
  elements.transcript.hidden = !conversations;
  elements.composer.hidden = !conversations;
  elements.jumpLatest.hidden = !conversations || transcriptNearBottom();
  elements.managementView.hidden = conversations;
  elements.badge.hidden = !conversations;
  elements.openContext.hidden = !conversations || !(state.selected || state.activeRunId);
  elements.terminalCommands.hidden = !conversations || (!state.selected?.conversationId && !state.draftThreadKey);
  elements.runStrip.hidden = !conversations || !currentWork(
    state.activeRun?.status ?? state.detail?.status ?? state.selected?.status ?? 'idle',
  )?.active;
  if (state.contextOpen && !conversations) await closeComputer();
  setSidebarOpen(false);

  const url = new URL(window.location.href);
  if (conversations) url.searchParams.delete('view');
  else url.searchParams.set('view', mode);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);

  if (conversations) {
    renderWorkspace({ scrollMode: 'keep' });
    return;
  }
  elements.title.textContent = mode === 'connections' ? 'Connections' : 'Routines';
  elements.subtitle.textContent = mode === 'connections'
    ? 'Provider accounts and least-privilege access'
    : 'Durable work that runs while the console is closed';
  await loadManagementWorkspace(mode);
}

async function loadManagementWorkspace(mode = state.mode) {
  if (state.managementLoading || mode === 'conversations') return;
  state.managementLoading = true;
  elements.managementLoading.hidden = false;
  elements.managementContent.hidden = true;
  try {
    if (mode === 'connections') {
      const [catalog, installed, sets, bindings] = await Promise.all([
        api('/v1/integrations/plugins'),
        api('/v1/integrations/connections'),
        api('/v1/integrations/connection-sets'),
        api('/v1/integrations/source-bindings'),
      ]);
      if (state.mode !== mode) return;
      state.plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
      state.connections = Array.isArray(installed.connections) ? installed.connections : [];
      state.connectionSets = Array.isArray(sets.connectionSets) ? sets.connectionSets : [];
      state.sourceBindings = Array.isArray(bindings.sourceBindings) ? bindings.sourceBindings : [];
      renderConnectionsWorkspace();
    } else {
      const result = await api('/v1/routines?limit=100');
      if (state.mode !== mode) return;
      state.routines = Array.isArray(result.items) ? result.items : [];
      renderRoutinesWorkspace();
    }
    elements.managementContent.hidden = false;
  } catch (error) {
    elements.managementContent.replaceChildren(managementEmpty('Could not load this workspace', message(error)));
    elements.managementContent.hidden = false;
    notice(message(error), true);
  } finally {
    state.managementLoading = false;
    elements.managementLoading.hidden = true;
  }
}

function renderConnectionsWorkspace() {
  const content = document.createDocumentFragment();
  const active = state.connections.filter((item) => item.connection?.status === 'active');
  const healthy = state.connections.filter((item) => item.health?.status === 'healthy');
  content.append(managementHero(
    'Connected services',
    'Install provider accounts, inspect their health and consumers, and set the smaller Rat-side access ceiling used by agents.',
    'Refresh',
    () => void reloadManagementWorkspace(),
  ));
  content.append(managementSummary([
    ['Active', active.length],
    ['Healthy', healthy.length],
    ['Available', state.plugins.length],
  ]));
  content.append(connectionFilter());
  content.append(managementSectionHeading('Your connections', `${active.length} ready for agent use`));
  if (state.connections.length === 0) {
    content.append(managementEmpty('No connections yet', 'Choose an installed provider below. Credentials remain in AWS Secrets Manager.'));
  } else {
    const grid = document.createElement('div');
    grid.className = 'management-grid';
    for (const item of state.connections) grid.append(connectionCard(item));
    content.append(grid);
  }
  content.append(managementSectionHeading('Installed providers', 'Self-hosted in this AWS deployment'));
  const plugins = document.createElement('div');
  plugins.className = 'management-grid';
  for (const plugin of state.plugins) plugins.append(pluginCard(plugin));
  if (state.plugins.length === 0) plugins.append(managementEmpty('No providers installed', 'Provider manifests are compiled into the deployment, not downloaded at runtime.'));
  content.append(plugins);
  elements.managementContent.replaceChildren(content);
  applyConnectionFilter();
}

function connectionFilter() {
  const label = document.createElement('label');
  label.className = 'management-filter';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search services, accounts, or operations';
  input.setAttribute('aria-label', 'Search connections');
  input.value = state.connectionFilter;
  const count = document.createElement('span');
  count.textContent = `${state.connections.length} account${state.connections.length === 1 ? '' : 's'} · ${state.plugins.length} app${state.plugins.length === 1 ? '' : 's'}`;
  input.addEventListener('input', () => {
    state.connectionFilter = input.value;
    applyConnectionFilter();
  });
  label.append(input, count);
  return label;
}

function applyConnectionFilter() {
  const query = state.connectionFilter.trim().toLocaleLowerCase('en-US');
  for (const card of elements.managementContent.querySelectorAll('[data-filter-text]')) {
    card.hidden = Boolean(query) && !card.dataset.filterText.includes(query);
  }
}

function connectionCard(item) {
  const connection = item.connection ?? {};
  const plugin = state.plugins.find((candidate) => candidate.id === connection.pluginId);
  const card = managementCardShell(
    plugin?.title ?? connection.pluginId ?? 'Provider',
    connection.displayName ?? connection.label ?? connection.alias ?? 'Connection',
  );
  card.dataset.status = connection.status ?? 'unknown';
  card.dataset.filterText = connectionSearchText(item, plugin);
  const copy = card.querySelector('.management-card-copy');
  const details = document.createElement('span');
  details.textContent = [
    connection.alias,
    connection.authorization?.scheme?.toUpperCase(),
    connection.authorization?.scopeModel === 'granular'
      ? `${connection.authorization.scopes?.length ?? 0} provider scopes`
      : 'Provider authority not granular',
  ].filter(Boolean).join(' · ');
  const stateLine = document.createElement('span');
  stateLine.className = 'management-card-state';
  const eventsBinding = slackEventsBinding(connection);
  const workspaceEventsBinding = slackWorkspaceEventsBinding(connection);
  stateLine.textContent = [
    statusLabel(connection.status ?? 'unknown'),
    `Rat access ${item.grant?.preset ?? 'not granted'}`,
    connection.pluginId === 'slack'
      ? eventsBinding
        ? 'mentions on'
        : workspaceEventsBinding
          ? 'mentions use another connection'
          : 'mentions off'
      : null,
  ].filter(Boolean).join(' · ');
  const healthLine = document.createElement('span');
  healthLine.className = 'management-card-state connection-health-line';
  healthLine.dataset.health = item.health?.status ?? 'unknown';
  healthLine.textContent = connectionHealthLabel(item.health);
  copy.append(details, stateLine, healthLine);

  const actions = document.createElement('div');
  actions.className = 'management-card-actions';
  const inspect = document.createElement('button');
  inspect.type = 'button';
  inspect.textContent = 'Details';
  inspect.addEventListener('click', () => void openConnectionDetails(item));
  actions.append(inspect);
  if (connection.status !== 'revoked') {
    const test = document.createElement('button');
    test.type = 'button';
    test.textContent = 'Test';
    test.addEventListener('click', () => void testConnection(item, test));
    actions.append(test);
    if (connection.status === 'expired') {
      const reconnect = document.createElement('button');
      reconnect.type = 'button';
      reconnect.textContent = 'Reconnect';
      reconnect.dataset.primary = 'true';
      reconnect.addEventListener('click', () => void reconnectConnection(item, reconnect));
      actions.append(reconnect);
    }
  }
  if (connection.status === 'active') {
    const access = document.createElement('select');
    access.setAttribute('aria-label', `Rat access for ${connection.alias ?? connection.label}`);
    for (const [value, label] of [['read-only', 'Read only'], ['read-write', 'Read & write'], ['full', 'Full installed']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = item.grant?.preset === value;
      access.append(option);
    }
    access.addEventListener('change', () => void replaceConnectionGrant(connection, access));
    if (connection.pluginId === 'slack') {
      const events = document.createElement('button');
      events.type = 'button';
      events.textContent = eventsBinding
        ? 'Mentions enabled'
        : workspaceEventsBinding
          ? 'Another connection handles mentions'
          : 'Enable mentions';
      events.disabled = Boolean(eventsBinding || workspaceEventsBinding);
      events.addEventListener('click', () => void enableSlackMentions(item, events));
      actions.append(events);
    }
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'danger-action';
    revoke.textContent = 'Disconnect';
    revoke.addEventListener('click', () => void revokeConnection(connection, revoke));
    actions.append(access, revoke);
  }
  card.append(actions);
  return card;
}

function connectionSearchText(item, plugin) {
  const connection = item.connection ?? {};
  return [
    connection.displayName,
    connection.label,
    connection.alias,
    connection.pluginId,
    plugin?.title,
    plugin?.description,
    ...(plugin?.operations ?? []).flatMap((operation) => [operation.id, operation.title, operation.kind]),
  ].filter(Boolean).join(' ').toLocaleLowerCase('en-US');
}

function connectionHealthLabel(health) {
  if (!health || health.status === 'unknown') return 'Health not tested';
  if (health.status === 'healthy') return `Healthy${health.checkedAt ? ` · verified ${relativeTime(health.checkedAt)}` : ''}`;
  if (health.code === 'provider-unavailable') return 'Provider unavailable when last tested';
  if (health.code === 'credential-missing') return 'Needs reconnect · stored credential is missing';
  if (health.code === 'identity-mismatch') return 'Needs reconnect · provider identity changed';
  if (health.status === 'reauth-required') return 'Needs reconnect · stored authorization was rejected';
  return 'Connection is degraded';
}

async function openConnectionDetails(item) {
  const connection = item.connection ?? {};
  if (!connection.connectionId) return;
  const plugin = state.plugins.find((candidate) => candidate.id === connection.pluginId);
  state.selectedConnection = { detail: item, consumers: null, plugin };
  elements.connectionDetailTitle.textContent = connection.displayName ?? connection.label ?? connection.alias ?? 'Connected account';
  elements.connectionDetailSummary.textContent = `${plugin?.title ?? connection.pluginId} · ${connection.alias} · loading current details…`;
  elements.connectionDisplayName.value = connection.displayName ?? connection.label ?? connection.alias ?? '';
  elements.connectionHealth.replaceChildren(detailLoadingRow('Checking saved health…'));
  elements.connectionScopes.replaceChildren(detailLoadingRow('Loading provider authority…'));
  elements.connectionOperations.replaceChildren(detailLoadingRow('Loading installed operations…'));
  elements.connectionConsumers.replaceChildren(detailLoadingRow('Finding Things and routines…'));
  elements.connectionTest.disabled = connection.status === 'revoked';
  elements.connectionReconnect.disabled = connection.status === 'revoked';
  elements.connectionRename.disabled = true;
  elements.connectionDetailDialog.showModal();
  try {
    const path = `/v1/integrations/connections/${encodeURIComponent(connection.connectionId)}`;
    const [detail, consumers] = await Promise.all([
      api(path),
      api(`${path}/consumers`),
    ]);
    if (!state.selectedConnection || state.selectedConnection.detail.connection?.connectionId !== connection.connectionId) return;
    state.selectedConnection = { detail, consumers, plugin };
    renderConnectionDetails(detail, consumers, plugin);
  } catch (error) {
    elements.connectionConsumers.replaceChildren(detailLoadingRow(message(error)));
    notice(message(error), true);
  } finally {
    elements.connectionRename.disabled = false;
  }
}

function renderConnectionDetails(detail, consumers, plugin) {
  const connection = detail.connection ?? {};
  const health = detail.health ?? {};
  elements.connectionDetailTitle.textContent = connection.displayName ?? connection.label ?? connection.alias ?? 'Connected account';
  elements.connectionDetailSummary.textContent = [
    plugin?.title ?? connection.pluginId,
    `stable alias ${connection.alias}`,
    connection.label ? `provider identity ${connection.label}` : null,
    `Rat access ${detail.grant?.preset ?? 'not granted'}`,
  ].filter(Boolean).join(' · ');
  elements.connectionDisplayName.value = connection.displayName ?? connection.label ?? connection.alias ?? '';
  elements.connectionTest.disabled = connection.status === 'revoked';
  elements.connectionReconnect.disabled = connection.status === 'revoked';
  elements.connectionHealth.replaceChildren(
    healthStat('State', connectionHealthLabel(health)),
    healthStat('Lifecycle', statusLabel(connection.status ?? 'unknown')),
    healthStat('Last checked', health.checkedAt ? relativeTime(health.checkedAt) : 'Never'),
  );

  const scopes = connection.authorization?.scopes ?? [];
  elements.connectionScopes.replaceChildren();
  for (const scope of scopes) elements.connectionScopes.append(detailChip(scope));
  if (scopes.length === 0) {
    elements.connectionScopes.append(detailChip(
      connection.authorization?.scopeModel === 'coarse' ? 'Provider uses coarse authority' : 'No granular scopes reported',
    ));
  }

  elements.connectionOperations.replaceChildren();
  for (const operation of plugin?.operations ?? []) {
    elements.connectionOperations.append(detailRow(
      operation.title ?? operation.id,
      `${operation.access} · ${operation.risk}`,
    ));
  }
  if (!plugin?.operations?.length) {
    elements.connectionOperations.append(detailLoadingRow('No operations are installed for this provider.'));
  }

  elements.connectionConsumers.replaceChildren();
  for (const consumer of consumers?.consumers ?? []) {
    elements.connectionConsumers.append(detailRow(
      consumer.name,
      [consumer.kind, consumer.stage, consumer.status, consumer.via ? `via ${consumer.via}` : null]
        .filter(Boolean).join(' · '),
    ));
  }
  if (!consumers?.consumers?.length) {
    elements.connectionConsumers.append(detailLoadingRow('No Things, routines, sets, or source bindings currently select this account.'));
  }
  if (consumers?.complete === false) {
    elements.connectionConsumers.append(detailLoadingRow('Showing a bounded dependency scan. Narrow the deployment before disconnecting.'));
  }
}

function healthStat(labelText, valueText) {
  const stat = document.createElement('div');
  stat.className = 'connection-health-stat';
  const label = document.createElement('span');
  label.textContent = labelText;
  const value = document.createElement('strong');
  value.textContent = valueText;
  value.title = valueText;
  stat.append(label, value);
  return stat;
}

function detailChip(text) {
  const chip = document.createElement('span');
  chip.className = 'connection-chip';
  chip.textContent = text;
  return chip;
}

function detailRow(titleText, detailText) {
  const row = document.createElement('div');
  row.className = 'connection-detail-row';
  const title = document.createElement('strong');
  title.textContent = titleText;
  const detail = document.createElement('span');
  detail.textContent = detailText;
  row.append(title, detail);
  return row;
}

function detailLoadingRow(text) {
  const row = document.createElement('span');
  row.className = 'connection-detail-row';
  row.textContent = text;
  return row;
}

async function testConnection(item, button) {
  const connection = item.connection ?? {};
  if (!connection.connectionId) return;
  button.disabled = true;
  try {
    const result = await api(`/v1/integrations/connections/${encodeURIComponent(connection.connectionId)}/test`, {
      method: 'POST',
      body: {},
    });
    const current = state.connections.find((candidate) => candidate.connection?.connectionId === connection.connectionId);
    if (current) {
      current.connection = result.connection;
      current.health = result.health;
    }
    renderConnectionsWorkspace();
    notice(connectionHealthLabel(result.health));
    return result;
  } catch (error) {
    button.disabled = false;
    notice(message(error), true);
    return null;
  }
}

async function testSelectedConnection() {
  const selected = state.selectedConnection;
  if (!selected) return;
  elements.connectionTest.disabled = true;
  const result = await testConnection(selected.detail, elements.connectionTest);
  if (!result || !state.selectedConnection) return;
  const detail = { ...state.selectedConnection.detail, ...result };
  state.selectedConnection = { ...state.selectedConnection, detail };
  renderConnectionDetails(detail, state.selectedConnection.consumers, state.selectedConnection.plugin);
}

async function reconnectSelectedConnection() {
  const selected = state.selectedConnection;
  if (!selected) return;
  await reconnectConnection(selected.detail, elements.connectionReconnect);
}

async function reconnectConnection(item, button) {
  const connection = item.connection ?? {};
  const plugin = state.plugins.find((candidate) => candidate.id === connection.pluginId);
  const authentication = plugin?.authentication?.find(
    (candidate) => candidate.scheme === connection.authorization?.scheme,
  );
  if (!connection.connectionId || !plugin || !authentication) {
    notice('The installed authentication method for this connection is unavailable.', true);
    return;
  }
  if (authentication.oauth2) {
    button.disabled = true;
    try {
      const started = await api(`/v1/integrations/connections/${encodeURIComponent(connection.connectionId)}/oauth/reconnect`, {
        method: 'POST',
        body: { version: '1' },
      });
      window.open(started.authorizationUrl, '_blank', 'noopener,noreferrer');
      notice(`Finish reconnecting ${connection.displayName ?? connection.label} in the provider window. If no tab opened, allow pop-ups and try again. Existing access stays unchanged until the same provider account is verified.`);
      window.clearInterval(state.oauthPollTimer);
      state.oauthPollTimer = window.setInterval(() => void pollOAuthReconnect(
        connection,
        item.health,
      ), 2_000);
      window.setTimeout(() => {
        window.clearInterval(state.oauthPollTimer);
        state.oauthPollTimer = null;
        button.disabled = false;
      }, 10 * 60_000);
    } catch (error) {
      button.disabled = false;
      notice(message(error), true);
    }
    return;
  }
  if (elements.connectionDetailDialog.open) elements.connectionDetailDialog.close();
  openManualConnection(plugin, authentication, item);
}

async function pollOAuthReconnect(before, previousHealth) {
  if (state.mode !== 'connections' || state.managementLoading) return;
  try {
    const result = await api('/v1/integrations/connections');
    const connections = Array.isArray(result.connections) ? result.connections : [];
    const current = connections.find((item) => item.connection?.connectionId === before.connectionId);
    const changed = current && (
      current.connection?.updatedAt !== before.updatedAt ||
      current.health?.checkedAt !== previousHealth?.checkedAt
    );
    if (!changed || current.connection?.status !== 'active' || current.health?.status !== 'healthy') return;
    state.connections = connections;
    window.clearInterval(state.oauthPollTimer);
    state.oauthPollTimer = null;
    if (elements.connectionDetailDialog.open) elements.connectionDetailDialog.close();
    renderConnectionsWorkspace();
    notice(`${current.connection.displayName ?? current.connection.label} reconnected. Its stable alias, Rat access, and consumers did not change.`);
  } catch {
    // The console remains usable while the callback window or network is in flight.
  }
}

async function renameSelectedConnection(event) {
  event.preventDefault();
  const selected = state.selectedConnection;
  if (!selected || !elements.connectionDetailForm.reportValidity()) return;
  const connection = selected.detail.connection ?? {};
  elements.connectionRename.disabled = true;
  try {
    const updated = await api(`/v1/integrations/connections/${encodeURIComponent(connection.connectionId)}`, {
      method: 'PATCH',
      body: { version: '1', displayName: elements.connectionDisplayName.value.trim() },
    });
    const current = state.connections.find((candidate) => candidate.connection?.connectionId === connection.connectionId);
    if (current) current.connection = updated;
    const detail = { ...selected.detail, connection: updated };
    state.selectedConnection = { ...selected, detail };
    renderConnectionDetails(detail, selected.consumers, selected.plugin);
    renderConnectionsWorkspace();
    notice(`Display name saved. Stable alias ${updated.alias} did not change.`);
  } catch (error) {
    notice(message(error), true);
  } finally {
    elements.connectionRename.disabled = false;
  }
}

function slackEventsBinding(connection) {
  const binding = slackWorkspaceEventsBinding(connection);
  if (!binding) return null;
  return state.connectionSets.some((set) => (
    set.connectionSetId === binding.connectionSetId &&
    Array.isArray(set.connectionIds) &&
    set.connectionIds.includes(connection.connectionId)
  )) ? binding : null;
}

function slackWorkspaceEventsBinding(connection) {
  if (connection.pluginId !== 'slack' || !connection.externalTenantId) return null;
  return state.sourceBindings.find((binding) => (
    binding.sourceKind === 'slack' &&
    binding.selector?.teamId === connection.externalTenantId &&
    binding.connectionSetId &&
    state.connectionSets.some((set) => set.connectionSetId === binding.connectionSetId)
  )) ?? null;
}

async function enableSlackMentions(item, button) {
  const connection = item.connection ?? {};
  if (!connection.connectionId || !connection.externalTenantId) return;
  const confirmed = window.confirm(
    `Enable Slack mentions for ${connection.label}? Rat will accept signed @mentions from this workspace, ` +
    'search messages the connected user can see, and reply in the originating thread. Agent access stays read-only; ' +
    'the delivery service receives write access only for replies.',
  );
  if (!confirmed) return;
  button.disabled = true;
  try {
    if (!['read-write', 'full'].includes(item.grant?.preset)) {
      await api(`/v1/integrations/connections/${encodeURIComponent(connection.connectionId)}/grant`, {
        method: 'POST',
        body: { version: '1', preset: 'read-write' },
      });
    }
    const set = await api('/v1/integrations/connection-sets', {
      method: 'POST',
      body: {
        version: '1',
        name: `slack-events-${String(connection.externalTenantId).toLowerCase()}`,
        connections: [connection.connectionId],
        defaults: { slack: connection.connectionId },
      },
    });
    await api('/v1/integrations/source-bindings', {
      method: 'POST',
      body: {
        version: '1',
        sourceKind: 'slack',
        selector: { teamId: connection.externalTenantId },
        capabilityProfile: 'read-only',
        connectionSetId: set.connectionSetId,
      },
    });
    await reloadManagementWorkspace();
    notice(`Slack mentions are enabled for ${connection.label}.`);
  } catch (error) {
    button.disabled = false;
    notice(message(error), true);
  }
}

function pluginCard(plugin) {
  const card = managementCardShell(plugin.title, plugin.description);
  card.classList.add('plugin-card');
  card.dataset.filterText = [
    plugin.id,
    plugin.title,
    plugin.description,
    ...(plugin.operations ?? []).flatMap((operation) => [operation.id, operation.title, operation.kind]),
  ].filter(Boolean).join(' ').toLocaleLowerCase('en-US');
  const copy = card.querySelector('.management-card-copy');
  const operations = document.createElement('span');
  operations.textContent = `${plugin.operations?.length ?? 0} installed operation${plugin.operations?.length === 1 ? '' : 's'} · reviewed provider adapter`;
  copy.append(operations);
  const authActions = document.createElement('div');
  authActions.className = 'plugin-auth-actions';
  for (const authentication of plugin.authentication ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    if (authentication.oauth2) {
      const configured = plugin.oauthInstallation?.status === 'configured';
      button.textContent = configured ? `Connect with ${plugin.title}` : 'OAuth app setup required';
      button.dataset.primary = String(configured);
      button.disabled = !configured;
      button.addEventListener('click', () => void beginOAuth(plugin, button));
      authActions.append(button);
      if (!configured) {
        const note = document.createElement('span');
        note.className = 'oauth-note';
        note.textContent = `Register ${plugin.oauthInstallation?.callbackUrl ?? 'the deployment callback URL'} in the provider app, then set its secret ARN in Terraform.`;
        copy.append(note);
      }
      continue;
    }
    button.textContent = authentication.title;
    button.addEventListener('click', () => openManualConnection(plugin, authentication));
    authActions.append(button);
  }
  copy.append(authActions);
  return card;
}

async function beginOAuth(plugin, button) {
  button.disabled = true;
  const before = new Set(state.connections.map((item) => item.connection?.connectionId));
  try {
    const result = await api('/v1/integrations/oauth/authorizations', {
      method: 'POST',
      body: { version: '1', pluginId: plugin.id, grant: { version: '1', preset: 'read-only' } },
    });
    window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer');
    notice(`Finish connecting ${plugin.title} in the provider window. If no tab opened, allow pop-ups and try again. This page will update automatically.`);
    window.clearInterval(state.oauthPollTimer);
    state.oauthPollTimer = window.setInterval(() => void pollOAuthCompletion(plugin, before), 2_000);
    window.setTimeout(() => {
      window.clearInterval(state.oauthPollTimer);
      state.oauthPollTimer = null;
    }, 10 * 60_000);
  } catch (error) {
    notice(message(error), true);
    button.disabled = false;
  }
}

async function pollOAuthCompletion(plugin, before) {
  if (state.mode !== 'connections' || state.managementLoading) return;
  try {
    const result = await api('/v1/integrations/connections');
    const connections = Array.isArray(result.connections) ? result.connections : [];
    const added = connections.find((item) => item.connection?.pluginId === plugin.id && !before.has(item.connection?.connectionId));
    if (!added) return;
    state.connections = connections;
    window.clearInterval(state.oauthPollTimer);
    state.oauthPollTimer = null;
    renderConnectionsWorkspace();
    notice(`${plugin.title} connected as ${added.connection.label}.`);
  } catch {
    // The console remains usable while the callback window or network is in flight.
  }
}

function openManualConnection(plugin, authentication, reconnectItem = null) {
  state.reconnectTarget = reconnectItem;
  elements.connectPluginId.value = plugin.id;
  elements.connectAuthScheme.value = authentication.scheme;
  elements.connectDialogTitle.textContent = reconnectItem
    ? `Reconnect ${reconnectItem.connection?.displayName ?? reconnectItem.connection?.label ?? plugin.title}`
    : `Connect ${plugin.title}`;
  elements.connectAlias.value = '';
  elements.connectAccess.value = 'read-only';
  elements.connectAliasField.hidden = Boolean(reconnectItem);
  elements.connectAccessField.hidden = Boolean(reconnectItem);
  elements.connectSubmit.textContent = reconnectItem ? 'Verify & reconnect' : 'Verify & connect';
  elements.connectFields.replaceChildren();
  for (const field of (authentication.fields ?? []).filter((candidate) => !candidate.computed)) {
    const label = document.createElement('label');
    label.className = 'dialog-field';
    const title = document.createElement('span');
    title.textContent = field.label;
    const input = document.createElement('input');
    input.type = field.secret ? 'password' : 'text';
    input.autocomplete = field.secret ? 'off' : 'on';
    input.dataset.credentialKey = field.key;
    input.required = field.required !== false;
    input.maxLength = 32_768;
    label.append(title, input);
    elements.connectFields.append(label);
  }
  elements.connectDialog.showModal();
  window.setTimeout(() => elements.connectFields.querySelector('input')?.focus(), 0);
}

async function submitManualConnection(event) {
  event.preventDefault();
  if (!elements.connectForm.reportValidity()) return;
  const credential = {};
  for (const input of elements.connectFields.querySelectorAll('[data-credential-key]')) {
    if (input.value) credential[input.dataset.credentialKey] = input.value;
  }
  elements.connectSubmit.disabled = true;
  try {
    const reconnectTarget = state.reconnectTarget?.connection;
    const result = await api(reconnectTarget
      ? `/v1/integrations/connections/${encodeURIComponent(reconnectTarget.connectionId)}/credential`
      : '/v1/integrations/connections', {
      method: 'POST',
      body: reconnectTarget ? { version: '1', credential } : {
        version: '1',
        pluginId: elements.connectPluginId.value,
        authScheme: elements.connectAuthScheme.value,
        credential,
        grant: { version: '1', preset: elements.connectAccess.value },
        ...(elements.connectAlias.value.trim() ? { alias: elements.connectAlias.value.trim() } : {}),
      },
    });
    elements.connectDialog.close();
    await reloadManagementWorkspace();
    notice(reconnectTarget
      ? `${result.connection?.label ?? 'Provider account'} verified and reconnected without changing its access or consumers.`
      : `${result.connection?.label ?? 'Provider account'} verified and connected.`);
  } catch (error) {
    notice(message(error), true);
  } finally {
    elements.connectSubmit.disabled = false;
  }
}

async function replaceConnectionGrant(connection, select) {
  const previous = state.connections.find((item) => item.connection?.connectionId === connection.connectionId)?.grant?.preset;
  select.disabled = true;
  try {
    await api(`/v1/integrations/connections/${encodeURIComponent(connection.connectionId)}/grant`, {
      method: 'POST',
      body: { version: '1', preset: select.value },
    });
    await reloadManagementWorkspace();
    notice(`Rat access for ${connection.alias} is now ${select.value}.`);
  } catch (error) {
    select.value = previous ?? 'read-only';
    select.disabled = false;
    notice(message(error), true);
  }
}

async function revokeConnection(connection, button) {
  if (!window.confirm(`Disconnect ${connection.label}? Agents will no longer be able to use it.`)) return;
  button.disabled = true;
  try {
    await api(`/v1/integrations/connections/${encodeURIComponent(connection.connectionId)}/revoke`, {
      method: 'POST',
      body: {},
    });
    await reloadManagementWorkspace();
    notice(`${connection.label} disconnected and its stored credential scheduled for deletion.`);
  } catch (error) {
    button.disabled = false;
    notice(message(error), true);
  }
}

function renderRoutinesWorkspace() {
  const content = document.createDocumentFragment();
  const enabled = state.routines.filter((routine) => routine.status === 'enabled');
  content.append(managementHero(
    'Routines',
    'Create durable interval work, pause it without losing configuration, or run it immediately. AWS scheduling continues with this console closed.',
    'New routine',
    openRoutineDialog,
  ));
  content.append(managementSummary([
    ['Enabled', enabled.length],
    ['Paused', state.routines.filter((routine) => routine.status === 'paused').length],
    ['Next run', enabled.length ? relativeTime(enabled.map((routine) => routine.nextRunAt).sort()[0]) : '—'],
  ]));
  content.append(managementSectionHeading('Scheduled work', `${state.routines.length} routine${state.routines.length === 1 ? '' : 's'}`));
  if (state.routines.length === 0) {
    content.append(managementEmpty('No routines yet', 'Create a routine for recurring work that should continue after you close the console.'));
  } else {
    const grid = document.createElement('div');
    grid.className = 'management-grid';
    for (const routine of state.routines) grid.append(routineCard(routine));
    content.append(grid);
  }
  elements.managementContent.replaceChildren(content);
}

function routineCard(routine) {
  const card = managementCardShell('Routine', routine.name);
  card.dataset.status = routine.status;
  const copy = card.querySelector('.management-card-copy');
  const schedule = document.createElement('span');
  schedule.textContent = `Every ${formatInterval(routine.schedule?.everyMinutes)} · next ${relativeTime(routine.nextRunAt)}`;
  const stateLine = document.createElement('span');
  stateLine.className = 'management-card-state';
  stateLine.textContent = routine.lastRunAt
    ? `${statusLabel(routine.status)} · last ran ${relativeTime(routine.lastRunAt)}`
    : `${statusLabel(routine.status)} · has not run yet`;
  copy.append(schedule, stateLine);
  const actions = document.createElement('div');
  actions.className = 'management-card-actions';
  const run = document.createElement('button');
  run.type = 'button';
  run.textContent = 'Run now';
  run.addEventListener('click', () => void routineAction(routine, 'run', run));
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = routine.status === 'enabled' ? 'Pause' : 'Resume';
  toggle.addEventListener('click', () => void routineAction(routine, routine.status === 'enabled' ? 'pause' : 'resume', toggle));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger-action';
  remove.textContent = 'Delete';
  remove.addEventListener('click', () => void routineAction(routine, 'delete', remove));
  actions.append(run, toggle, remove);
  card.append(actions);
  return card;
}

function openRoutineDialog() {
  elements.routineForm.reset();
  elements.routineMinutes.value = '1440';
  elements.routineEnabled.checked = true;
  elements.routineDialog.showModal();
  window.setTimeout(() => elements.routineName.focus(), 0);
}

async function submitRoutine(event) {
  event.preventDefault();
  if (!elements.routineForm.reportValidity()) return;
  elements.routineSubmit.disabled = true;
  try {
    const routine = await api('/v1/routines', {
      method: 'POST',
      body: {
        version: '1',
        name: elements.routineName.value.trim(),
        schedule: { kind: 'interval', everyMinutes: Number(elements.routineMinutes.value) },
        request: { version: '1', prompt: elements.routinePrompt.value.trim() },
        enabled: elements.routineEnabled.checked,
      },
    });
    elements.routineDialog.close();
    await reloadManagementWorkspace();
    notice(`Routine “${routine.name}” created${routine.status === 'enabled' ? ' and enabled' : ' in a paused state'}.`);
  } catch (error) {
    notice(message(error), true);
  } finally {
    elements.routineSubmit.disabled = false;
  }
}

async function routineAction(routine, operation, button) {
  if (operation === 'delete' && !window.confirm(`Delete “${routine.name}”? This keeps a short audit tombstone but stops future runs.`)) return;
  button.disabled = true;
  try {
    const result = await api(`/v1/routines/${encodeURIComponent(routine.routineId)}/${operation}`, {
      method: 'POST',
      body: {},
    });
    if (operation === 'run') notice(`Run ${result.runId} queued from “${routine.name}”.`);
    else notice(`Routine “${routine.name}” ${operation === 'delete' ? 'deleted' : operation === 'pause' ? 'paused' : 'resumed'}.`);
    await reloadManagementWorkspace();
  } catch (error) {
    button.disabled = false;
    notice(message(error), true);
  }
}

async function reloadManagementWorkspace() {
  state.managementLoading = false;
  await loadManagementWorkspace(state.mode);
}

function managementHero(titleText, descriptionText, actionText, action) {
  const hero = document.createElement('header');
  hero.className = 'management-hero';
  const copy = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'AWS control plane';
  const title = document.createElement('h2');
  title.textContent = titleText;
  const description = document.createElement('p');
  description.textContent = descriptionText;
  copy.append(eyebrow, title, description);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary-button';
  button.textContent = actionText;
  button.addEventListener('click', action);
  hero.append(copy, button);
  return hero;
}

function managementSummary(items) {
  const summary = document.createElement('section');
  summary.className = 'management-summary';
  for (const [label, value] of items) {
    const stat = document.createElement('div');
    stat.className = 'management-stat';
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    const text = document.createElement('span');
    text.textContent = label;
    stat.append(strong, text);
    summary.append(stat);
  }
  return summary;
}

function managementSectionHeading(titleText, detailText) {
  const heading = document.createElement('div');
  heading.className = 'management-section-heading';
  const title = document.createElement('h3');
  title.textContent = titleText;
  const detail = document.createElement('span');
  detail.textContent = detailText;
  heading.append(title, detail);
  return heading;
}

function managementCardShell(iconText, titleText) {
  const card = document.createElement('article');
  card.className = 'management-card';
  const icon = document.createElement('span');
  icon.className = 'management-card-icon';
  icon.textContent = String(iconText ?? 'R').slice(0, 2);
  icon.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('div');
  copy.className = 'management-card-copy';
  const title = document.createElement('strong');
  title.textContent = titleText;
  copy.append(title);
  card.append(icon, copy);
  return card;
}

function managementEmpty(titleText, detailText) {
  const empty = document.createElement('div');
  empty.className = 'management-empty';
  const title = document.createElement('strong');
  title.textContent = titleText;
  const detail = document.createElement('span');
  detail.textContent = detailText;
  empty.append(title, detail);
  return empty;
}

function formatInterval(minutes) {
  if (!Number.isFinite(minutes)) return 'unknown interval';
  if (minutes % 10_080 === 0) return `${minutes / 10_080} week${minutes === 10_080 ? '' : 's'}`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} day${minutes === 1_440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
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
  adoptCompletions(refreshed);
  state.artifacts = artifacts;
  // A terminal Run can still appear active until its conversation projection catches up.
  if (refreshed.activeRunId && refreshed.activeRunId !== state.completedWork?.runId) {
    state.completedWork = null;
    state.activeRunId = refreshed.activeRunId;
    restoreLiveWork(selected.conversationId, refreshed.activeRunId);
  }
  renderWorkspace({ scrollMode: 'auto' });
  if (state.activeRunId) await pollRun();
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
  if (current) {
    state.selected = current;
    if (state.detail && current.title !== state.detail.title) {
      state.detail.title = current.title;
      if (state.mode === 'conversations') elements.title.textContent = current.title;
    }
  }
}

function renderConversationList() {
  const query = state.searchQuery;
  elements.viewLabel.textContent = query ? 'Search results' : state.visibility === 'hidden' ? 'Hidden' : 'Conversations';
  elements.hiddenToggle.lastElementChild.textContent = state.visibility === 'hidden'
    ? 'Back to conversations'
    : 'Show hidden conversations';
  elements.count.textContent = String(query ? state.searchResults.length : state.conversations.length);
  const searchSignature = query ? JSON.stringify([query, state.searchLoading, state.searchResults, state.selected?.conversationId]) : null;
  if (query && searchSignature === state.searchListSignature) return;
  state.searchListSignature = searchSignature;
  if (query) elements.list.replaceChildren();
  const focused = elements.list.contains(document.activeElement) ? document.activeElement : null;
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
    elements.list.replaceChildren(emptyConversationList(
      state.visibility === 'hidden' ? 'No hidden conversations.' : 'No durable conversations yet.',
    ));
  }
  const sections = state.visibility === 'hidden'
    ? [['Hidden', state.conversations]]
    : conversationSections(state.conversations);
  const desired = [];
  for (const [label, conversations] of sections) {
    if (conversations.length === 0) continue;
    const section = [...elements.list.children].find(node => node.dataset.section === label) ?? document.createElement('section');
    section.dataset.section = label;
    section.className = 'conversation-section';
    const heading = section.querySelector('h2') ?? document.createElement('h2');
    heading.textContent = label;
    if (!section.isConnected) elements.list.append(section);
    reconcileChildren(section, [heading, ...conversations.map(conversation => conversationNode(conversation))]);
    desired.push(section);
  }
  if (state.listNextToken) {
    const loadMore = document.createElement('button');
    loadMore.type = 'button';
    loadMore.className = 'load-more-conversations';
    loadMore.textContent = `Load more ${state.visibility === 'hidden' ? 'hidden ' : ''}conversations`;
    loadMore.addEventListener('click', () => void loadMoreConversations(loadMore));
    desired.push(loadMore);
  }
  if (state.conversations.length) reconcileChildren(elements.list, desired);
  const ids = new Set(state.conversations.map(item => item.conversationId));
  for (const id of state.conversationRows.keys()) if (!ids.has(id)) state.conversationRows.delete(id);
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({preventScroll: true});
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
  return [
    ['Pinned', pinned],
    ['Needs your input', remaining.filter(item => conversationAttention(item) === 'needs-input')],
    ['Failed', remaining.filter(item => conversationAttention(item) === 'failed')],
    ['Working', remaining.filter(item => conversationAttention(item) === 'working')],
    ['Recent', remaining.filter(item => conversationAttention(item) === 'ready')],
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
    adoptCompletions(older);
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

function reconcileChildren(parent, nodes) {
  for (const [index, node] of nodes.entries()) if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
  for (const child of [...parent.children]) if (!nodes.includes(child)) child.remove();
}

// Keep listeners, focus, and open details while updating a row's visible content.
function updateNode(target, fresh) {
  if (target.nodeType === Node.TEXT_NODE) { if (target.textContent !== fresh.textContent) target.textContent = fresh.textContent; return; }
  for (const attr of [...target.attributes]) if (attr.name !== 'open' && !fresh.hasAttribute(attr.name)) target.removeAttribute(attr.name);
  for (const attr of fresh.attributes) if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
  const children = [...fresh.childNodes];
  for (const [index, child] of children.entries()) {
    const current = target.childNodes[index];
    if (!current) target.append(child);
    else if (current.nodeType !== child.nodeType || current.nodeName !== child.nodeName) current.replaceWith(child);
    else updateNode(current, child);
  }
  while (target.childNodes.length > children.length) target.lastChild.remove();
}

function conversationNode(conversation, onSelect) {
  if (onSelect) return createConversationNode(conversation, onSelect);
  let cached = state.conversationRows.get(conversation.conversationId);
  if (!cached) {
    const model = {...conversation};
    cached = {model, node: createConversationNode(model)};
    state.conversationRows.set(conversation.conversationId, cached);
  } else {
    const updated = {...conversation};
    for (const key of Object.keys(cached.model)) delete cached.model[key];
    Object.assign(cached.model, updated);
    updateNode(cached.node, createConversationNode(cached.model));
  }
  return cached.node;
}

function createConversationNode(conversation, onSelect = () => void selectConversation(conversation)) {
  const row = document.createElement('div');
  row.className = 'conversation-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'conversation-item';
  button.setAttribute('aria-current', state.selected?.conversationId === conversation.conversationId ? 'page' : 'false');
  const attention = conversationAttention(conversation);
  button.dataset.state = attention;
  button.setAttribute('aria-label', `${labelFor(conversation)}, ${attentionLabel(attention)}${conversation.unread ? ', Unread' : ''}`);
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
  time.dataset.relative = '';
  time.textContent = relativeTime(conversation.updatedAt);
  meta.append(time);
  if (conversation.unread) {
    const unread = document.createElement('span');
    unread.className = 'conversation-unread';
    unread.textContent = 'Unread';
    meta.append(unread);
  }
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
      const key = Object.keys(update)[0];
      const value = key === 'read' ? conversation.unread : !conversation[key];
      void updateConversationOrganization(conversation, {[key]: value});
    });
    menu.append(button);
  }
  const rename = document.createElement('button');
  rename.type = 'button'; rename.textContent = 'Rename';
  rename.addEventListener('click', () => {
    details.open = false;
    state.renaming = conversation;
    elements.renameTitle.value = conversation.title ?? '';
    elements.renameDialog.showModal(); elements.renameTitle.focus(); elements.renameTitle.select();
  });
  menu.append(rename);
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
  if ('title' in update) return 'Conversation renamed.';
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
  if (state.contextOpen) await closeComputer();
  persistDraft();
  cacheLiveWork();
  const revision = ++state.selectionRevision;
  state.selected = conversation;
  state.draftThreadKey = null;
  state.draftTitle = null;
  localStorage.removeItem('rat-things.new-conversation');
  state.detail = null;
  state.detailLoading = true;
  resetLiveRunState();
  state.completedWork = null;
  state.completionByRun.clear();
  state.activityRunId = null;
  state.answeredRequests = [];
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
    adoptCompletions(detail);
    await restoreSubmission(detail.threadKey);
    state.artifacts = artifacts;
    state.detailLoading = false;
    state.activeRunId = detail.activeRunId ?? null;
    if (state.activeRunId) restoreLiveWork(conversation.conversationId, state.activeRunId);
    renderWorkspace({ scrollMode: 'bottom' });
    if (state.activeRunId) await pollRun();
    else void reconcileCompletedActivity();
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
  prepareDraftThread(`thread-${crypto.randomUUID()}`, elements.threadKey.value.trim());
  elements.dialog.close();
}

function prepareDraftThread(key, title) {
  if (state.contextOpen) void closeComputer();
  persistDraft();
  state.selectionRevision += 1;
  state.selected = null;
  state.detail = null;
  state.detailLoading = false;
  state.completionByRun.clear();
  state.activityRunId = null;
  state.answeredRequests = [];
  state.draftThreadKey = key;
  state.draftTitle = title;
  localStorage.setItem('rat-things.new-conversation', JSON.stringify({key: state.draftThreadKey, title: state.draftTitle}));
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
  state.steering = false;
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
  if (state.steering && state.activeRunId) {
    elements.composerContext.hidden = false;
    elements.composerContext.classList.add('composer-reply-context');
    const copy = document.createElement('span');
    copy.textContent = 'Steering the active Run · this direction is delivered immediately';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.setAttribute('aria-label', 'Cancel steering');
    cancel.textContent = '×';
    cancel.addEventListener('click', () => {
      state.steering = false;
      renderWorkspace({ scrollMode: 'keep' });
    });
    elements.composerContext.append(copy, cancel);
    return;
  }
  if (!state.replyTarget) {
    elements.composerContext.hidden = true;
    elements.composerContext.classList.remove('composer-reply-context');
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
  if (state.mode !== 'conversations') return;
  const scroll = options.scrollSnapshot ?? captureTranscriptScroll();
  const conversation = state.detail ?? state.selected;
  const threadKey = state.draftThreadKey ?? conversation?.threadKey;
  elements.title.textContent = state.draftTitle ?? conversation?.title ?? (conversation ? labelFor(conversation) : 'New conversation');
  renderConversationSubtitle();
  const status = state.activeRun?.status ?? conversation?.status ?? (state.activeRunId ? 'queued' : 'idle');
  elements.badge.dataset.state = status;
  elements.badge.textContent = state.activeRunId ? workPresentation(currentWork(status)).label : statusLabel(status);
  elements.openContext.hidden = !(conversation || workAvailable());
  elements.terminalCommands.hidden = !conversation?.conversationId && !state.draftThreadKey;

  const messages = state.detail?.transcript?.messages ?? [];
  const work = currentWork(status);
  renderRunStrip(work);
  const focusedAnswer = document.activeElement?.closest('.question-form') ? document.activeElement : null;
  elements.transcript.replaceChildren();
  if (state.detailLoading) {
    elements.transcript.append(transcriptLoadingNode());
  } else if (messages.length === 0 && !work) {
    elements.transcript.append(elements.empty);
  } else {
    renderTranscript(messages, work);
  }

  if (focusedAnswer?.isConnected) focusedAnswer.focus({ preventScroll: true });
  const writable = Boolean(threadKey) || !conversation;
  elements.prompt.disabled = !writable || state.busy;
  elements.prompt.placeholder = state.steering ? 'Give Rat additional direction…' : 'Message Rat Things…';
  elements.send.disabled = !writable || state.busy;
  elements.delivery.disabled = !writable || state.busy;
  const inheritedPolicy = state.detail?.executionPolicy;
  if (inheritedPolicy) elements.browserUse.checked = inheritedPolicy.capabilities?.computerUse === 'browser';
  elements.browserUse.disabled = !writable || state.busy || Boolean(inheritedPolicy);
  elements.browserUse.title = inheritedPolicy ? 'Inherited from this conversation. Start a new conversation to use different capabilities.' : '';
  elements.attachFiles.disabled = !writable || state.busy;
  renderComposerContext(writable, conversation);
  renderComposerAttachments();
  renderContextPane();

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

  const receipts = [...state.completionByRun.values()];
  if (work && !work.active && !receipts.some(item => item.runId === work.runId)) receipts.push(work);
  receipts.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  const appendReceipts = index => {
    for (const receipt of receipts) if (completionReceiptIndex(messages, receipt.completedAt) === index) elements.transcript.append(workNode(receipt));
  };
  appendReceipts(-1);
  for (const [index, item] of messages.entries()) {
    for (const interaction of item.interactions ?? []) elements.transcript.append(messageNode(interaction));
    elements.transcript.append(messageNode(item));
    appendReceipts(index);
  }
  for (const answer of state.answeredRequests) {
    elements.transcript.append(messageNode({role: 'assistant', content: answer.question, receivedAt: answer.at}),
      messageNode({role: 'user', content: `${answer.value} — Answer sent`, receivedAt: answer.at}));
  }
  if (work?.active) elements.transcript.append(workNode(work));
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
    adoptCompletions(older);
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
    time.dataset.relative = '';
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
  const react = document.createElement('button');
  react.type = 'button';
  react.textContent = 'React';
  react.setAttribute('aria-haspopup', 'dialog');
  react.addEventListener('click', () => {
    elements.reactionChoices.replaceChildren(...['👍', '❤️', '🎉', '👀'].map(emoji => reactionButton(item, emoji, true)));
    elements.reactionDialog.showModal();
  });
  actions.append(react);
  for (const reaction of item.reactions ?? []) {
    if (reaction.count || reaction.reacted) actions.append(reactionButton(item, reaction.emoji));
  }
  return actions;
}

function reactionButton(item, emoji, closeDialog = false) {
  const reaction = (item.reactions ?? []).find(candidate => candidate.emoji === emoji);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reaction-button';
  button.dataset.reacted = String(reaction?.reacted === true);
  button.setAttribute('aria-label', `${reaction?.reacted ? 'Remove' : 'Add'} ${emoji} reaction`);
  button.textContent = `${emoji}${reaction?.count ? ` ${reaction.count}` : ''}`;
  button.addEventListener('click', async () => {
    if (await toggleReaction(item, emoji, button) && closeDialog) {
      elements.reactionDialog.close();
      elements.transcript.querySelector(`[data-message-id="${CSS.escape(item.messageId)}"] .message-actions [aria-haspopup="dialog"]`)?.focus();
    }
  });
  return button;
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
    const visibleItem = state.detail?.conversationId === conversationId ? transcriptMessage(item.messageId) : null;
    const target = visibleItem ?? item;
    target.reactions = [
      ...(target.reactions ?? []).filter((reaction) => reaction.emoji !== emoji),
      ...(count ? [{ emoji, count, reacted }] : []),
    ];
    renderWorkspace({ scrollMode: 'keep' });
    return true;
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

function markdownFragment(value, context = { threadKey: state.detail?.threadKey ?? state.selected?.threadKey, artifacts: state.artifacts }, fromPath = '') {
  return renderMarkdown(value, {
    codeBlock: codeBlockNode,
    link(href) {
      const artifact = resolveArtifactLink(href, context.artifacts, fromPath);
      const link = document.createElement('a');
      if (artifact && context.threadKey) {
        link.href = artifactContentUrl(context.threadKey, artifact.id);
        link.setAttribute('aria-haspopup', 'dialog');
        link.addEventListener('click', (event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          void openArtifact(artifact, link, context);
        });
      } else if (safePublicUrl(href)) {
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else {
        const unavailable = document.createElement('span');
        unavailable.title = 'Link unavailable in this conversation';
        return unavailable;
      }
      return link;
    },
  });
}

function artifactContentUrl(threadKey, artifactId) {
  return `/api/v1/conversations/${encodeURIComponent(threadKey)}/artifacts/${encodeURIComponent(artifactId)}/content`;
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

function openTerminalCommands() {
  const conversation = state.detail ?? state.selected;
  if (!conversation?.conversationId) {
    if (state.draftThreadKey) {
      const thread = shellArgument(state.draftThreadKey);
      showTerminalCommands([
        ['Start this conversation', `rat-things chat --thread ${thread} "Your first message"`],
        ['Open this draft', `rat-things console --thread ${thread}`],
      ], 'Use this conversation in your terminal');
    }
    return;
  }
  const quote = shellArgument;
  const id = quote(conversation.conversationId);
  const commands = [
    ['Read this conversation', `rat-things conversation show ${id}`],
    ['Open this conversation', `rat-things console --conversation ${id}`],
  ];
  if (conversation.threadKey) {
    const thread = quote(conversation.threadKey);
    commands.unshift(['Continue this conversation', `rat-things chat --thread ${thread} "Your next message"`]);
    commands.push(['List files', `rat-things files --thread ${thread}`]);
  }
  if (state.activeRunId) commands.push(['Follow live activity', `rat-things watch ${quote(state.activeRunId)} --follow`]);
  if (state.completedWork?.runId) commands.push(['Saved Run events', `rat-things artifact ${quote(state.completedWork.runId)} events`]);
  if (state.activeRunId) commands.unshift(...state.pendingRequests.flatMap(request => answerCommands(state.activeRunId, request)));
  showTerminalCommands(commands, 'Use this conversation in your terminal');
}

function showTerminalCommands(commands, title) {
  elements.terminalTitle.textContent = title;
  elements.terminalCommandList.replaceChildren(...commands.map(([label, command]) => codeBlockNode(command, label)));
  elements.terminalDialog.showModal();
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

async function openArtifact(artifact, button, context = { threadKey: state.detail?.threadKey ?? state.selected?.threadKey, artifacts: state.artifacts }, restored = false) {
  const { threadKey } = context;
  if (!threadKey || !artifact.id) return;
  button.disabled = true;
  try {
    const url = artifactContentUrl(threadKey, artifact.id);
    if (state.viewerFile && elements.viewer.open && !restored) {
      state.viewerFile.scrollTop = elements.viewerBody.scrollTop;
      state.viewerFile.focusHref = button.getAttribute('href');
      state.viewerHistory.push(state.viewerFile);
      state.viewerHistory = state.viewerHistory.slice(-20);
    }
    state.viewerFile = { artifact, threadKey, artifacts: context.artifacts, source: restored ? context.source : false };
    const viewing = state.viewerFile;
    elements.viewerBack.hidden = state.viewerHistory.length === 0;
    elements.viewerSource.hidden = true;
    elements.viewerTitle.textContent = artifact.path ?? artifact.name ?? 'Artifact';
    elements.viewerDetail.textContent = [artifact.mediaType, formatBytes(artifact.bytes)].filter(Boolean).join(' · ');
    elements.viewerOpen.href = url;
    elements.viewerDownload.href = url;
    elements.viewerDownload.download = (artifact.path ?? artifact.name ?? 'download').split('/').at(-1);
    elements.viewerBody.replaceChildren(viewerLoadingNode());
    if (!elements.viewer.open) elements.viewer.showModal();
    await renderArtifactContent(artifact, url, viewing);
    if (state.viewerFile === viewing) {
      elements.viewerBody.scrollTop = restored ? context.scrollTop ?? 0 : 0;
      const focus = restored && [...elements.viewerBody.querySelectorAll('a')].find(link => link.getAttribute('href') === context.focusHref);
      (focus || elements.viewerTitle).focus({preventScroll: true});
    }
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

async function renderArtifactContent(artifact, url, viewing) {
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
    isTextArtifact(mediaType) || isMarkdownArtifact(artifact)
  ) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Artifact viewer returned ${response.status}`);
    const preview = await readTextPreview(response, 2_000_000);
    if (state.viewerFile !== viewing || !elements.viewer.open) return;
    viewing.preview = preview;
    node = textPreviewNode(viewing);
  } else {
    node = document.createElement('div');
    node.className = 'viewer-unknown';
    node.textContent = 'This file type does not have an inline preview. Download it or open it in a new tab.';
  }
  if (elements.viewer.open && state.viewerFile === viewing) elements.viewerBody.replaceChildren(node);
}

function textPreviewNode(viewing) {
  const markdown = isMarkdownArtifact(viewing.artifact);
  elements.viewerSource.hidden = !markdown;
  elements.viewerSource.textContent = viewing.source ? 'Show preview' : 'Show source';
  const node = document.createElement(markdown && !viewing.source ? 'div' : 'pre');
  node.className = markdown && !viewing.source ? 'message viewer-markdown' : 'viewer-text';
  const { text, truncated } = viewing.preview;
  if (markdown && !viewing.source) node.append(markdownFragment(text, viewing, viewing.artifact.path));
  else node.textContent = text;
  if (truncated) node.append(document.createTextNode('\n\n[Preview truncated. Download for the full file.]'));
  return node;
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
  const section = document.createElement('section');
  if (work.active || work.runId === state.completedWork?.runId) section.id = 'run-progress';
  section.dataset.runId = work.runId;
  section.className = 'work-card';
  section.dataset.state = work.status;
  if (work.active) {
    // Progress and controls live in the Run strip; only input belongs in the transcript.
    section.hidden = !work.pendingRequests?.length;
    for (const pending of work.pendingRequests ?? []) section.append(pendingRequestNode(pending));
    return section;
  }
  section.className = 'completion-receipt';
  const title = document.createElement('strong');
  title.textContent = work.status === 'failed' ? 'Work failed' : work.status === 'cancelled' ? 'Work stopped' : 'Work completed';
  const elapsed = document.createElement('time');
  elapsed.dateTime = work.completedAt;
  elapsed.title = new Date(work.completedAt).toLocaleString();
  elapsed.textContent = workDuration(work);
  const details = document.createElement('button');
  details.type = 'button';
  details.textContent = 'View Activity';
  details.addEventListener('click', () => { state.activityRunId = work.runId; void openContext('activity'); void reconcileCompletedActivity(work); });
  section.append(title, elapsed, details);
  return section;
}

function renderRunStrip(work) {
  elements.runStrip.hidden = state.mode !== 'conversations' || !work?.active;
  if (!work?.active) return;
  const progress = workPresentation(work);
  elements.runStrip.dataset.state = work.status;
  elements.runStripPhase.textContent = progress.label;
  elements.runStripTitle.textContent = work.pendingRequests?.[0]?.questions?.[0]?.question ?? progress.title;
  elements.runStripDetail.textContent = work.pendingRequests?.length
    ? 'Answer below to continue.'
    : progress.detail;
  elements.runStripElapsed.textContent = workDuration(work);
  elements.steerRun.hidden = !work.active;
  elements.steerRun.textContent = work.pendingRequests?.length ? 'Answer question' : 'Steer';
  elements.stopRun.hidden = !work.active;
}

function workPresentation(work) {
  return runPresentation({ ...work, latestProgress: state.detail?.latestProgress?.text ?? state.selected?.latestProgress?.text });
}

function workAvailable() {
  return Boolean(state.activeRunId || state.completedWork);
}

function pendingRequestNode(request) {
  const key = `${state.activeRunId}:${request.requestId}`;
  const signature = JSON.stringify(request.questions);
  const cached = state.questionNodes.get(key);
  if (cached?.signature === signature) return cached.node;
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
  state.questionNodes.set(key, { signature, node });
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
  const conversationId = state.detail?.conversationId ?? state.selected?.conversationId;
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
    const acknowledged = request.questions.map(question => ({
      requestId: request.requestId,
      question: question.question,
      value: question.isSecret ? 'Private answer' : answers[question.id].answers.join(', '),
      at: new Date().toISOString(),
    }));
    state.questionNodes.delete(`${runId}:${request.requestId}`);
    const target = state.activeRunId === runId ? state : state.liveWorkByConversation.get(conversationId);
    if (target) {
      target.answeredRequests = [...(target.answeredRequests ?? []), ...acknowledged];
      target.pendingRequests = target.pendingRequests.filter(pending => pending.requestId !== request.requestId);
    }
    if (state.activeRunId !== runId) return;
    renderWorkspace({ scrollMode: 'keep' });
    notice('Response delivered to the isolated agent.');
    void pollRun();
  } catch (error) {
    submit.disabled = false;
    submit.textContent = 'Send response';
    notice(message(error), true);
  }
}

function phaseNode(phase) {
  const row = document.createElement('div');
  row.className = 'phase-card';
  row.dataset.phase = phase.key;
  row.dataset.status = phase.status;
  const icon = document.createElement('span');
  icon.textContent = phase.icon;
  const copy = document.createElement('div');
  copy.className = 'phase-card-copy';
  const title = document.createElement('strong');
  title.textContent = phase.title;
  const detail = document.createElement('span');
  detail.textContent = [phase.detail, phase.count > 1 ? `${phase.count} related updates` : undefined]
    .filter(Boolean).join(' · ');
  copy.append(title, detail);
  const time = document.createElement('time');
  time.dateTime = phase.occurredAt;
  time.title = phase.occurredAt ? new Date(phase.occurredAt).toLocaleString() : '';
  time.textContent = phase.occurredAt
    ? new Date(phase.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  row.append(icon, copy, time);
  return row;
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
  let threadKey = state.draftThreadKey ?? state.detail?.threadKey ?? state.selected?.threadKey;
  if (!prompt || state.busy) return;
  if (!threadKey && !state.selected) {
    threadKey = state.draftThreadKey = `thread-${crypto.randomUUID()}`;
    localStorage.setItem('rat-things.new-conversation', JSON.stringify({key: threadKey}));
    persistDraft();
  }
  if (!threadKey) return;
  if (state.steering && state.activeRunId) {
    state.busy = true;
    renderWorkspace({ scrollMode: 'keep' });
    try {
      await api(`/v1/runs/${encodeURIComponent(state.activeRunId)}/steer`, {
        method: 'POST',
        body: { prompt },
      });
      elements.prompt.value = '';
      state.steering = false;
      clearDraft();
      resizeComposer();
      notice('Direction delivered to the active Run.');
    } catch (error) {
      notice(message(error), true);
    } finally {
      state.busy = false;
      renderWorkspace({ scrollMode: 'keep' });
    }
    return;
  }
  const files = [...state.uploads];
  const replyTarget = state.replyTarget;
  state.busy = true;
  renderWorkspace({ scrollMode: 'keep' });
  try {
    const attachments = await Promise.all(files.map(filePayload));
    const body = {
        version: '1',
        prompt,
        ...(elements.browserUse.checked && !state.detail?.executionPolicy ? {
          agent: {
            driver: 'codex',
            capabilities: {
              profile: 'small-business',
              networkAccess: true,
              computerUse: 'browser',
            },
          },
        } : {}),
        thread: {
          key: threadKey,
          ...(state.draftTitle ? { title: state.draftTitle } : {}),
          delivery: elements.delivery.value,
          ...(attachments.length ? { attachments } : {}),
          ...(replyTarget?.messageId ? { replyToMessageId: replyTarget.messageId } : {}),
        },
    };
    const prior = await submissionStorage('get', threadKey);
    const envelope = prior && submissionIntent(prior.body) === submissionIntent(body)
      ? prior : { key: crypto.randomUUID(), body };
    await submissionStorage('put', threadKey, envelope);
    const run = await api('/v1/runs', {
      method: 'POST', headers: { 'idempotency-key': envelope.key }, body: envelope.body,
    });
    await submissionStorage('delete', threadKey);
    activateRun(run);
    elements.prompt.value = '';
    clearDraft();
    clearComposerExtras();
    resizeComposer();
    appendOptimisticMessage(prompt, files, replyTarget);
    renderWorkspace({ scrollMode: 'bottom' });
    notice(`Run ${run.runId} accepted.`);
    await refreshConversations(false);
    const created = state.conversations.find(item => item.threadKey === threadKey);
    if (state.draftThreadKey === threadKey && created) {
      await selectConversation(created);
      // The durable conversation can appear before its coordinator projects
      // activeRunId. Keep tracking the accepted receipt during that interval.
      if (!state.activeRunId && state.selected?.conversationId === created.conversationId) {
        activateRun(run);
        await pollRun();
      }
    } else await pollRun();
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

function submissionIntent(body) {
  return JSON.stringify({
    prompt: body.prompt, thread: body.thread.key, delivery: body.thread.delivery,
    reply: body.thread.replyToMessageId,
    files: body.thread.attachments ?? [],
    browser: (body.agent ?? state.detail?.executionPolicy)?.capabilities?.computerUse === 'browser',
  });
}

// Store the exact request, including attachments, before sending. IndexedDB avoids
// localStorage's small synchronous quota for file-bearing submission envelopes.
async function submissionStorage(operation, key, value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('rat-things-submissions', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pending');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('pending', operation === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('pending');
      const request = operation === 'put' ? store.put(value, key) : store[operation](key);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Could not save submission for retry'));
    });
  } finally { db.close(); }
}

async function restoreSubmission(threadKey) {
  if (!threadKey) return;
  const pending = await submissionStorage('get', threadKey);
  if (!pending) return;
  if (!elements.prompt.value || elements.prompt.value === pending.body.prompt) {
    elements.prompt.value = pending.body.prompt;
    state.uploads = (pending.body.thread.attachments ?? []).map(file => new File(
      [Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))], file.name, { type: file.mediaType },
    ));
    if (pending.body.thread.replyToMessageId) state.replyTarget = {messageId: pending.body.thread.replyToMessageId};
    elements.delivery.value = pending.body.thread.delivery;
    elements.browserUse.checked = pending.body.agent?.capabilities?.computerUse === 'browser';
  }
  notice('Submission not confirmed. Send the unchanged message again to recover its existing Run.');
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
    if (runId !== state.activeRunId) return;
    if (snapshot) consumeRuntimeSnapshot(snapshot, after);
    if (isTerminal(run.status)) {
      await finishRun(run);
      return;
    }
    state.activeRun = run;
    state.activeRunObservedAt = runStartedAt(run);
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
  state.pendingRequests = (Array.isArray(snapshot.pendingRequests) ? snapshot.pendingRequests : [])
    .filter(request => !state.answeredRequests.some(answer => answer.requestId === request.requestId));
  state.runtimeReady = snapshot.ready === true;
  const pendingKeys = new Set(state.pendingRequests.map(request => `${state.activeRunId}:${request.requestId}`));
  for (const key of state.questionNodes.keys()) {
    if (key.startsWith(`${state.activeRunId}:`) && !pendingKeys.has(key)) state.questionNodes.delete(key);
  }
}

async function finishRun(run) {
  const revision = state.selectionRevision;
  const completedAt = run.updatedAt ?? new Date().toISOString();
  state.completedWork = {
    runId: run.runId,
    status: run.status,
    active: false,
    startedAt: runStartedAt(run),
    completedAt,
    durationMs: run.result?.durationMs,
    events: [...state.events],
    pendingRequests: [],
    eventGap: state.eventGap,
    ready: state.runtimeReady,
  };
  state.completedWork.evidence = 'loading';
  state.completionByRun.set(run.runId, state.completedWork);
  state.activityRunId = null;
  const conversationId = state.detail?.conversationId ?? state.selected?.conversationId;
  if (conversationId) state.liveWorkByConversation.delete(conversationId);
  clearActiveRun();
  void reconcileCompletedActivity(state.completedWork, true);
  await refreshConversations(false);
  if (revision !== state.selectionRevision) return;
  const threadKey = state.draftThreadKey ?? state.detail?.threadKey;
  const current = state.conversations.find((item) => item.threadKey && item.threadKey === threadKey);
  if (current) {
    state.selected = current;
    markConversationRead(current);
    const detail = await waitForConversationProjection(current, run);
    const artifacts = await loadConversationArtifacts(current);
    if (revision !== state.selectionRevision || state.activeRunId) return;
    state.detail = detail;
    if (conversationProjectionSettled(detail, run)) state.answeredRequests = [];
    adoptCompletions(detail);
    state.artifacts = artifacts;
    state.draftThreadKey = null;
    state.draftTitle = null;
    localStorage.removeItem('rat-things.new-conversation');
    localStorage.setItem('rat-things.selected-conversation', current.conversationId);
  }
  renderConversationList();
  renderWorkspace({ scrollMode: 'bottom' });
  notice(run.status === 'succeeded' ? 'Run completed.' : `Run ${run.status}.`, run.status === 'failed');
}

async function reconcileCompletedActivity(work = state.completedWork, start = false) {
  if (!work || work.evidence === 'saved' || (!start && work.evidence === 'loading')) return;
  work.evidence = 'loading';
  try {
    const saved = await api(`/v1/runs/${encodeURIComponent(work.runId)}/events?source=durable`);
    if (saved.source !== 'durable' || saved.runId !== work.runId || !Array.isArray(saved.events)) throw new Error('Saved Activity unavailable');
    // Durable sequences have a different origin. Replace, never merge, the live tail.
    work.events = saved.events.slice(-MAX_RETAINED_EVENTS);
    work.eventGap = saved.truncated === true || saved.events.length > MAX_RETAINED_EVENTS;
    work.evidence = 'saved';
  } catch {
    work.evidence = 'unavailable';
  }
  if (state.completionByRun.get(work.runId) === work || state.completedWork === work) renderContextActivity();
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
  if (!detail || detail.activeRunId === run.runId) return false;
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
  window.clearTimeout(state.computerTimer);
  state.computerTimer = null;
  if (state.computer) state.computer = { ...state.computer, control: 'agent', takeover: undefined };
  state.activeRunId = null;
  state.activeRun = null;
  state.activeRunObservedAt = null;
  state.events = [];
  state.pendingRequests = [];
  state.eventAfter = 0;
  state.eventGap = false;
  state.runtimeReady = false;
  if (state.contextOpen) renderComputer();
  window.clearInterval(state.progressTimer);
  state.progressTimer = null;
}

function resetLiveRunState() {
  window.clearTimeout(state.pollTimer);
  if (state.contextOpen) void closeComputer();
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
    answeredRequests: state.answeredRequests,
    eventAfter: state.eventAfter,
    eventGap: state.eventGap,
    runtimeReady: state.runtimeReady,
  });
}

function restoreLiveWork(conversationId, runId) {
  const cached = state.liveWorkByConversation.get(conversationId);
  if (!cached || cached.runId !== runId) {
    state.activeRunObservedAt = null;
    return;
  }
  state.activeRun = cached.run;
  state.activeRunObservedAt = cached.observedAt ?? Date.now();
  state.events = cached.events;
  state.pendingRequests = cached.pendingRequests;
  state.answeredRequests = cached.answeredRequests ?? [];
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
  if (!state.activeRunId || !state.activeRunObservedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - state.activeRunObservedAt) / 1_000));
  elements.runStripElapsed.dateTime = `PT${seconds}S`;
  elements.runStripElapsed.textContent = formatElapsed(seconds);
}

function runStartedAt(run) {
  const createdAt = Date.parse(run?.createdAt);
  return Number.isFinite(createdAt) ? Math.min(createdAt, Date.now()) : Date.now();
}

function statusLabel(status) {
  if (['queued', 'dispatching', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(status)) return runPresentation({status}).label;
  return ({
    idle: 'Ready', pending: 'Saving', awaiting_resume: 'Resuming',
    active: 'Active', expired: 'Expired', revoked: 'Revoked', enabled: 'Enabled', paused: 'Paused', deleted: 'Deleted',
  })[status] ?? String(status).replaceAll('_', ' ');
}

function focusSteeringComposer() {
  if (state.pendingRequests.length) {
    const form = elements.transcript.querySelector('.question-form');
    form?.scrollIntoView({block: 'center'}); form?.querySelector('input')?.focus(); return;
  }
  if (!state.activeRunId) return;
  state.steering = true;
  state.replyTarget = null;
  elements.delivery.value = 'interrupt';
  renderWorkspace({ scrollMode: 'keep' });
  elements.prompt.placeholder = 'Give Rat additional direction…';
  elements.prompt.focus();
}

function setContextTab(tab) {
  state.contextTab = tab;
  if (tab !== 'browser') window.clearTimeout(state.computerTimer);
  const tabs = {
    browser: [elements.contextTabBrowser, elements.contextBrowser],
    sources: [elements.contextTabSources, elements.contextSources],
    activity: [elements.contextTabActivity, elements.contextActivity],
  };
  for (const [name, [button, panel]] of Object.entries(tabs)) {
    const selected = name === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
  renderContextPane();
}

function renderContextPane() {
  if (!state.contextOpen) return;
  renderContextSources();
  renderContextActivity();
}

function renderContextSources() {
  const sources = conversationSources();
  elements.contextSourceCount.textContent = String(sources.length);
  elements.contextSources.replaceChildren();
  if (sources.length === 0) {
    elements.contextSources.append(contextEmptyNode(
      'Sources will appear here',
      'Web pages and durable files are collected without interrupting the conversation.',
    ));
    return;
  }
  const list = document.createElement('div');
  list.className = 'source-list';
  for (const source of sources) {
    if (source.artifact) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source-card';
      button.innerHTML = `<strong></strong><span></span>`;
      button.querySelector('strong').textContent = source.label;
      button.querySelector('span').textContent = source.detail;
      button.addEventListener('click', () => void openArtifact(source.artifact, button));
      list.append(button);
      continue;
    }
    const link = document.createElement('a');
    link.className = 'source-card';
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const title = document.createElement('strong');
    title.textContent = source.label;
    const detail = document.createElement('span');
    detail.textContent = source.url;
    link.append(title, detail);
    list.append(link);
  }
  elements.contextSources.append(list);
}

function conversationSources() {
  const result = [];
  const seen = new Set();
  const pageUrl = state.computer?.page?.url;
  if (safePublicUrl(pageUrl)) {
    seen.add(pageUrl);
    result.push({ url: pageUrl, label: state.computer?.page?.title || new URL(pageUrl).hostname });
  }
  for (const item of state.detail?.transcript?.messages ?? []) {
    for (const match of String(item.content ?? '').matchAll(/https:\/\/[^\s<>()\]]+/g)) {
      const url = match[0].replace(/[.,;:!?]+$/, '');
      if (!safePublicUrl(url) || seen.has(url)) continue;
      seen.add(url);
      result.push({ url, label: new URL(url).hostname });
    }
  }
  for (const artifact of state.artifacts) {
    if (!artifact.id) continue;
    const key = `artifact:${artifact.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      artifact,
      label: artifact.path ?? artifact.name ?? 'Conversation file',
      detail: [artifact.mediaType, formatBytes(artifact.bytes)].filter(Boolean).join(' · '),
    });
  }
  return result.slice(0, 40);
}

function safePublicUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function renderContextActivity() {
  const work = state.completionByRun.get(state.activityRunId) ?? currentWork(state.activeRun?.status ?? state.detail?.status ?? state.selected?.status ?? 'idle');
  const activities = coalesceActivities(work?.events ?? []);
  const phases = groupActivities(activities);
  elements.contextActivity.replaceChildren();
  const choices = [...state.completionByRun.values()].sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  if (choices.length) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Activity for Run');
    if (state.activeRunId) select.add(new Option('Current work', ''));
    for (const receipt of choices) select.add(new Option(`${new Date(receipt.completedAt).toLocaleString()} · ${receipt.status}`, receipt.runId));
    select.value = state.activityRunId ?? (state.activeRunId ? '' : state.completedWork?.runId ?? '');
    select.addEventListener('change', () => {
      state.activityRunId = select.value || null;
      const selected = state.completionByRun.get(select.value);
      if (selected) void reconcileCompletedActivity(selected);
      renderContextActivity();
    });
    elements.contextActivity.append(select);
  }

  if (work && !work.active) {
    const evidence = document.createElement('p');
    evidence.className = 'activity-evidence';
    evidence.textContent = work.evidence === 'saved' ? 'Activity reconciled with saved events.'
      : work.evidence === 'loading' ? 'Checking saved Activity…'
      : 'Saved Activity unavailable. Last live updates are shown; unfinished actions are unconfirmed.';
    if (work.evidence !== 'saved' && work.evidence !== 'loading') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry saved Activity';
      retry.addEventListener('click', () => { void reconcileCompletedActivity(work); renderContextActivity(); });
      evidence.append(' ', retry);
    }
    elements.contextActivity.append(evidence);
  }
  if (work?.eventGap) {
    const gap = document.createElement('p');
    gap.className = 'activity-gap';
    gap.textContent = work.evidence === 'saved' ? 'Showing a bounded or incomplete preview of saved Activity. The complete event file remains available from the terminal.' : 'Early live events rolled out of the bounded window. Durable terminal evidence remains available.';
    elements.contextActivity.append(gap);
  }
  if (phases.length === 0) {
    elements.contextActivity.append(contextEmptyNode(
      work?.active ? 'Rat is getting ready' : 'No recent activity',
      work?.active ? 'Human-readable phases will appear as the Run progresses.' : 'Live activity is retained in this browser. Use the saved Run events from the terminal for a durable record.',
    ));
    return;
  }
  const list = document.createElement('div');
  list.className = 'phase-list';
  for (const phase of phases) list.append(phaseNode(phase));
  elements.contextActivity.append(list);
  const technical = document.createElement('details');
  technical.className = 'technical-evidence';
  const summary = document.createElement('summary');
  summary.textContent = `Technical evidence · ${activities.length} event${activities.length === 1 ? '' : 's'}`;
  technical.append(summary);
  for (const activity of activities) technical.append(activityNode(activity));
  elements.contextActivity.append(technical);
}

function contextEmptyNode(titleText, detailText) {
  const empty = document.createElement('div');
  empty.className = 'context-empty';
  const title = document.createElement('strong');
  title.textContent = titleText;
  const detail = document.createElement('span');
  detail.textContent = detailText;
  empty.append(title, detail);
  return empty;
}

function syncContextLayout() {
  const open = state.contextOpen;
  const compact = compactLayout();
  elements.shell.dataset.contextOpen = String(open && !compact);
  elements.contextPane.hidden = !open;
  elements.contextResizer.hidden = !open || compact;
  elements.contextPane.inert = !open;
  elements.workspace.inert = sidebarIsOpen() || (compact && open);
  if (open && compact) elements.contextPane.removeAttribute('aria-hidden');
  else if (!open) elements.contextPane.setAttribute('aria-hidden', 'true');
  else elements.contextPane.removeAttribute('aria-hidden');
  if (open) setSidebarOpen(false);
}

function setupPaneResizer(resizer, kind) {
  const bounds = kind === 'sidebar' ? [248, 440] : [360, 760];
  const resize = (clientX) => {
    const raw = kind === 'sidebar' ? clientX : window.innerWidth - clientX;
    setPaneWidth(kind, Math.max(bounds[0], Math.min(bounds[1], raw)));
  };
  resizer.addEventListener('pointerdown', (event) => {
    if (compactLayout()) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.dataset.dragging = 'true';
    resize(event.clientX);
  });
  resizer.addEventListener('pointermove', (event) => {
    if (resizer.dataset.dragging === 'true') resize(event.clientX);
  });
  const finish = (event) => {
    if (resizer.dataset.dragging !== 'true') return;
    resizer.dataset.dragging = 'false';
    if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
  };
  resizer.addEventListener('pointerup', finish);
  resizer.addEventListener('pointercancel', finish);
  resizer.addEventListener('dblclick', () => setPaneWidth(kind, kind === 'sidebar' ? 328 : 520));
  resizer.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Number(resizer.getAttribute('aria-valuenow'));
    if (event.key === 'Home') return setPaneWidth(kind, bounds[0]);
    if (event.key === 'End') return setPaneWidth(kind, bounds[1]);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    setPaneWidth(kind, current + direction * (kind === 'context' ? -16 : 16));
  });
}

function setPaneWidth(kind, width) {
  const bounds = kind === 'sidebar' ? [248, 440] : [360, 760];
  const bounded = Math.round(Math.max(bounds[0], Math.min(bounds[1], width)));
  elements.shell.style.setProperty(kind === 'sidebar' ? '--sidebar-width' : '--context-width', `${bounded}px`);
  const resizer = kind === 'sidebar' ? elements.sidebarResizer : elements.contextResizer;
  resizer.setAttribute('aria-valuenow', String(bounded));
  try { localStorage.setItem(`rat-things.${kind}-width`, String(bounded)); } catch { /* best effort */ }
}

function restorePaneWidths() {
  for (const [kind, fallback] of [['sidebar', 328], ['context', 520]]) {
    const value = Number(localStorage.getItem(`rat-things.${kind}-width`));
    setPaneWidth(kind, Number.isFinite(value) && value > 0 ? value : fallback);
  }
  setComputerZoom(1);
}

async function openContext(tab = 'activity') {
  if (!(state.selected || workAvailable()) || state.computerBusy) return;
  state.contextOpen = true;
  setContextTab(tab);
  syncContextLayout();
  renderComputer();
  if (tab === 'browser' && state.activeRunId) await refreshComputer();
  if (tab === 'activity') void reconcileCompletedActivity(state.completionByRun.get(state.activityRunId) ?? state.completedWork);
}

async function closeComputer() {
  window.clearTimeout(state.computerTimer);
  window.clearInterval(state.computerClock);
  state.computerTimer = null;
  state.computerClock = null;
  const shouldReturn = state.computer?.control === 'human' && state.computer?.teach?.state !== 'recording';
  const runId = state.activeRunId;
  state.contextOpen = false;
  syncContextLayout();
  state.computer = null;
  if (shouldReturn && runId) {
    try {
      await api(`/v1/runs/${encodeURIComponent(runId)}/computer/takeover`, {
        method: 'POST',
        body: { control: 'agent' },
      });
    } catch (error) {
      notice(`Could not return browser control; the lease will expire automatically. ${message(error)}`, true);
    }
  }
}

async function refreshComputer() {
  window.clearTimeout(state.computerTimer);
  if (!state.contextOpen || state.contextTab !== 'browser' || !state.activeRunId || state.computerBusy) return;
  if (state.computerUnavailableRunId === state.activeRunId) return;
  const runId = state.activeRunId;
  try {
    const snapshot = await api(`/v1/runs/${encodeURIComponent(runId)}/computer`);
    if (runId !== state.activeRunId || !state.contextOpen) return;
    state.computer = snapshot;
    renderComputer();
  } catch (error) {
    if (runId !== state.activeRunId) {
      renderComputer();
      return;
    }
    const detail = message(error);
    if (/does not have browser computer use enabled/i.test(detail)) {
      state.computerUnavailableRunId = runId;
      renderComputer();
      return;
    }
    const starting = /not active in this MicroVM|control command timed out|control endpoint returned HTTP 502/i
      .test(detail);
    elements.computerLoading.hidden = false;
    elements.computerLoading.textContent = starting
      ? 'Starting the isolated screen. First-use storage can take tens of seconds.'
      : detail;
    elements.computerOwnerLabel.textContent = starting ? 'Preparing browser' : 'Live view reconnecting';
    elements.computerLeaseLabel.textContent = starting
      ? 'The first durable start can take tens of seconds'
      : 'Rat will retry automatically';
  } finally {
    if (state.contextOpen && state.contextTab === 'browser' && state.activeRunId && state.computerUnavailableRunId !== state.activeRunId) {
      state.computerTimer = window.setTimeout(
        () => void refreshComputer(),
        state.computer?.control === 'human' ? 650 : 1_200,
      );
    }
  }
}

function renderComputer() {
  const computer = state.computer;
  const unavailable = Boolean(state.activeRunId && state.computerUnavailableRunId === state.activeRunId);
  const human = computer?.control === 'human';
  const recording = computer?.teach?.state === 'recording';
  elements.computerControl.textContent = human ? 'Return control' : 'Take control';
  elements.computerControl.className = human || !computer || !state.activeRunId ? 'secondary-button' : 'primary-button';
  elements.computerControl.disabled = state.computerBusy || recording || !computer || !state.activeRunId;
  elements.computerOwnerDot.dataset.owner = human ? 'human' : 'agent';
  elements.computerOwnerLabel.textContent = computer
    ? !state.activeRunId ? 'Final browser frame' : human ? 'You have control' : 'Rat has control'
    : unavailable ? 'Browser unavailable' : !state.activeRunId ? 'No retained browser frame' : 'Connecting to browser';
  updateComputerTemporalLabels();
  if (unavailable) {
    elements.computerLeaseLabel.textContent = 'Browser access was not enabled for this Run';
    elements.computerLoading.textContent = 'This Run has no browser. You can still follow Activity and Sources. Start a new conversation with Isolated browser enabled to use a browser.';
  }
  if (!state.activeRunId && !computer?.imageDataUrl) elements.computerLoading.textContent = 'No browser frame is retained here. Activity and saved files remain available.';
  elements.computerLoading.hidden = Boolean(computer?.imageDataUrl);
  elements.computerScreen.hidden = !computer?.imageDataUrl;
  if (computer?.imageDataUrl && elements.computerScreen.src !== computer.imageDataUrl) {
    elements.computerScreen.src = computer.imageDataUrl;
  }
  if (computer?.page?.url && document.activeElement !== elements.computerUrl) {
    elements.computerUrl.value = computer.page.url;
  }
  const interactive = human && Boolean(state.activeRunId) && !state.computerBusy;
  for (const control of [
    elements.computerUrl,
    elements.computerBack,
    elements.computerNavigation.querySelector('button[type="submit"]'),
    elements.computerText,
    elements.computerType.querySelector('button[type="submit"]'),
    elements.computerEnter,
    elements.computerScrollUp,
    elements.computerScrollDown,
  ]) control.disabled = !interactive;
  elements.computerScreen.dataset.interactive = String(interactive);
  elements.computerActionState.hidden = !state.computerBusy;
  elements.computerRecordingBadge.hidden = !recording;
  elements.teachSetup.hidden = recording;
  elements.teachRecordingActions.hidden = !recording;
  elements.teachStart.disabled = !interactive || !elements.teachName.value.trim();
  elements.teachName.disabled = !interactive;
  elements.teachGoal.disabled = !interactive;
  elements.teachStepCount.textContent = `${computer?.teach?.demonstratedSteps ?? 0} action${computer?.teach?.demonstratedSteps === 1 ? '' : 's'} demonstrated`;
  window.clearInterval(state.computerClock);
  state.computerClock = null;
  updateComputerRecordingClock();
  state.computerClock = window.setInterval(() => {
    updateComputerTemporalLabels();
    updateComputerRecordingClock();
  }, 1_000);
}

function updateComputerTemporalLabels() {
  const computer = state.computer;
  if (state.activeRunId && state.computerUnavailableRunId === state.activeRunId) {
    elements.computerLeaseLabel.textContent = 'Browser access was not enabled for this Run';
    return;
  }
  if (!computer) {
    elements.computerLeaseLabel.textContent = 'Live isolated browser';
    return;
  }
  if (!state.activeRunId) {
    const outcome = state.completedWork?.status === 'cancelled' ? 'Work stopped'
      : state.completedWork?.status === 'failed' ? 'Run failed' : 'Run completed';
    elements.computerLeaseLabel.textContent = `${outcome} · last captured view`;
    return;
  }
  if (computer.control !== 'human') {
    elements.computerLeaseLabel.textContent = computer.page?.title || computer.page?.url || 'Live isolated browser';
    return;
  }
  const expiresAt = Date.parse(computer.takeover?.expiresAt);
  const seconds = Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000)) : undefined;
  elements.computerLeaseLabel.textContent = seconds === undefined
    ? 'Exclusive browser lease'
    : `Exclusive lease · ${formatElapsed(seconds)} remaining`;
}

function updateComputerRecordingClock() {
  const startedAt = Date.parse(state.computer?.teach?.startedAt);
  const seconds = Number.isFinite(startedAt) ? Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)) : 0;
  elements.computerRecordingTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function toggleComputerControl() {
  if (!state.activeRunId || !state.computer || state.computerBusy) return;
  await computerMutation(
    `/v1/runs/${encodeURIComponent(state.activeRunId)}/computer/takeover`,
    { control: state.computer.control === 'human' ? 'agent' : 'human' },
    (receipt) => { state.computer = { ...state.computer, ...receipt }; },
  );
}

async function navigateComputer(event) {
  event.preventDefault();
  if (!elements.computerUrl.value.trim()) return;
  await computerAction({ type: 'navigate', url: elements.computerUrl.value.trim() });
}

async function typeOnComputer(event) {
  event.preventDefault();
  const text = elements.computerText.value;
  if (!text) return;
  await computerAction({ type: 'type', text, clear: false, submit: false });
  elements.computerText.value = '';
}

async function clickComputerScreen(event) {
  if (state.computer?.control !== 'human' || state.computerBusy) return;
  const rectangle = elements.computerScreen.getBoundingClientRect();
  if (!rectangle.width || !rectangle.height) return;
  const viewportWidth = state.computer.viewport?.width ?? 1280;
  const viewportHeight = state.computer.viewport?.height ?? 720;
  const scale = Math.min(rectangle.width / viewportWidth, rectangle.height / viewportHeight);
  const renderedWidth = viewportWidth * scale;
  const renderedHeight = viewportHeight * scale;
  const offsetX = (rectangle.width - renderedWidth) / 2;
  const offsetY = (rectangle.height - renderedHeight) / 2;
  const renderedX = event.clientX - rectangle.left - offsetX;
  const renderedY = event.clientY - rectangle.top - offsetY;
  if (renderedX < 0 || renderedY < 0 || renderedX > renderedWidth || renderedY > renderedHeight) return;
  const x = Math.max(0, Math.min(viewportWidth, renderedX / scale));
  const y = Math.max(0, Math.min(viewportHeight, renderedY / scale));
  await computerAction({ type: 'click', x, y });
}

async function computerAction(action) {
  if (!state.activeRunId || state.computer?.control !== 'human') return;
  await computerMutation(
    `/v1/runs/${encodeURIComponent(state.activeRunId)}/computer/action`,
    { action },
    (snapshot) => { state.computer = snapshot; },
  );
}

function wheelComputerScreen(event) {
  if (state.computer?.control !== 'human' || state.computerBusy) return;
  event.preventDefault();
  const deltaY = Math.max(-900, Math.min(900, Math.round(event.deltaY)));
  if (Math.abs(deltaY) < 4) return;
  void computerAction({ type: 'scroll', deltaY });
}

function keyComputerScreen(event) {
  if (state.computer?.control !== 'human' || state.computerBusy) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Tab' || event.key === 'Escape') return;
  event.preventDefault();
  if (event.key.length === 1) {
    void computerAction({ type: 'type', text: event.key, clear: false, submit: false });
  } else if (['Enter', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    void computerAction({ type: 'press', key: event.key });
  }
}

function setComputerZoom(value) {
  state.computerZoom = Math.max(.5, Math.min(2, Math.round(value * 4) / 4));
  elements.computerStage.style.setProperty('--computer-zoom', String(state.computerZoom));
  elements.computerZoomLabel.value = `${Math.round(state.computerZoom * 100)}%`;
}

async function toggleContextFullscreen() {
  try {
    if (document.fullscreenElement === elements.contextPane) await document.exitFullscreen();
    else await elements.contextPane.requestFullscreen();
  } catch (error) {
    notice(`Full screen is unavailable: ${message(error)}`, true);
  }
}

async function startTeaching() {
  if (!state.activeRunId || state.computer?.control !== 'human') return;
  const name = elements.teachName.value.trim();
  if (!name) {
    elements.teachName.focus();
    return;
  }
  await computerMutation(
    `/v1/runs/${encodeURIComponent(state.activeRunId)}/computer/teach`,
    { action: 'start', name, ...(elements.teachGoal.value.trim() ? { goal: elements.teachGoal.value.trim() } : {}) },
    (snapshot) => { state.computer = snapshot; },
  );
}

async function stopTeaching(discard) {
  if (!state.activeRunId || state.computer?.teach?.state !== 'recording') return;
  await computerMutation(
    `/v1/runs/${encodeURIComponent(state.activeRunId)}/computer/teach`,
    { action: 'stop', discard },
    (result) => {
      if (state.computer) state.computer = { ...state.computer, teach: { state: 'idle' } };
      if (result.thing?.thingId) {
        notice(`Draft Thing “${result.thing.draft?.name ?? elements.teachName.value}” created for review (${result.thing.thingId}).`);
      } else if (discard) notice('Demonstration discarded. No Thing was created.');
    },
  );
}

async function computerMutation(path, body, consume) {
  if (state.computerBusy) return;
  state.computerBusy = true;
  renderComputer();
  try {
    const result = await api(path, { method: 'POST', body });
    consume(result);
  } catch (error) {
    notice(message(error), true);
  } finally {
    state.computerBusy = false;
    renderComputer();
  }
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
  return `${DRAFT_PREFIX}${identity ?? 'new'}`;
}

function completedRunWork(run) {
  return {runId: run.runId, status: run.status, active: false, startedAt: runStartedAt(run), completedAt: run.updatedAt,
    durationMs: run.result?.durationMs, events: [], pendingRequests: [], evidence: 'unavailable'};
}

function adoptCompletions(detail) {
  for (const receipt of detail?.transcript?.completions ?? []) {
    const existing = state.completionByRun.get(receipt.runId);
    if (!existing) state.completionByRun.set(receipt.runId, {...receipt, startedAt: Date.parse(receipt.startedAt), active: false, events: [], pendingRequests: [], evidence: 'unavailable'});
  }
  const latest = [...state.completionByRun.values()].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt)).at(-1);
  if (latest && latest !== state.completedWork) {
    state.completedWork = latest;
    if (state.contextOpen && !state.activeRunId && !state.activityRunId) void reconcileCompletedActivity(latest);
  }
}

async function findThread(key) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new Error('Invalid thread name.');
  const cached = state.conversations.find(item => item.threadKey === key);
  if (cached) return cached;
  const seen = new Set();
  let token;
  for (let page = 0; page < 100; page++) {
    const result = await api(`/v1/conversations?visibility=all&limit=100${token ? `&nextToken=${encodeURIComponent(token)}` : ''}`);
    const found = (result.items ?? []).find(item => item.threadKey === key);
    if (found) return found;
    if (!result.nextToken) return null;
    if (seen.has(result.nextToken)) break;
    seen.add(result.nextToken); token = result.nextToken;
  }
  throw new Error('Could not finish finding that thread. Open it using its public conversation ID.');
}

function renderConversationSubtitle() {
  const conversation = state.detail ?? state.selected;
  const updatedAt = conversation?.updatedAt;
  elements.subtitle.textContent = conversation
    ? `${sourceLabel(conversation.sourceKind)}${updatedAt ? ` · updated ${relativeTime(updatedAt)}` : ''}`
    : 'Durable, isolated execution';
}

function updateRelativeTimes() {
  for (const time of document.querySelectorAll('time[data-relative]')) time.textContent = relativeTime(time.dateTime);
  if (state.mode === 'conversations') renderConversationSubtitle();
}

function conversationAttention(conversation) {
  const selected = state.selected?.conversationId === conversation.conversationId;
  const pending = selected ? state.pendingRequests : state.liveWorkByConversation.get(conversation.conversationId)?.pendingRequests;
  const status = selected && state.activeRunId ? state.activeRun?.status ?? 'running' : conversation.status;
  return conversationWorkState({...conversation, status}, pending);
}

function attentionLabel(value) {
  return ({ 'needs-input': 'Needs your input', failed: 'Failed', working: 'Working', ready: 'Ready' })[value];
}

function conversationPreview(conversation) {
  return messagePreview(conversation.latestProgress?.text && ['pending', 'running', 'awaiting_resume'].includes(conversation.status)
    ? conversation.latestProgress.text
    : conversation.lastMessagePreview ?? statusText(conversation));
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
  elements.workspace.inert = next || (compact && state.contextOpen);
  elements.contextPane.inert = !state.contextOpen || next;
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
  if (state.contextOpen && event.key === 'Escape' && document.fullscreenElement !== elements.contextPane) {
    if (state.computer?.teach?.state !== 'recording') {
      event.preventDefault();
      void closeComputer();
    }
    return;
  }
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
  return window.matchMedia('(max-width: 960px)').matches;
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
