use crate::{
    api::{Data, Task, Worker, artifact_path},
    environment_picker::EnvironmentPicker,
    markdown::safe_markdown,
    model::{
        Collection, ModelCatalog, Resource, SessionSnapshot, name_session_request, path_segment,
        pretty, prompt_title, string,
    },
    theme,
};
use egui::{Color32, RichText, TextEdit, Ui};
use egui_commonmark::{CommonMarkCache, CommonMarkViewer};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};

pub(crate) const LOADING_FEEDBACK_DELAY: Duration = Duration::from_millis(300);

const SNAPSHOT_INTERVAL: Duration = Duration::from_millis(750);
const IDLE_SNAPSHOT_INTERVAL: Duration = Duration::from_secs(15);

struct Editor {
    id: u64,
    title: String,
    draft: Zeroizing<String>,
    path: String,
    collection: Collection,
    select_id: Option<String>,
    secret: bool,
    advanced: bool,
    models_requested: bool,
    templates_requested: bool,
    saved_model: Option<String>,
    form_inputs: HashMap<String, String>,
    error: Option<String>,
}

impl Editor {
    fn widget_id(&self) -> egui::Id {
        egui::Id::new(("configuration-json", self.id))
    }
    fn clear(&mut self, ctx: &egui::Context) {
        self.draft.zeroize();
        self.form_inputs.values_mut().for_each(Zeroize::zeroize);
        ctx.data_mut(|data| {
            data.remove::<egui::text_edit::TextEditState>(self.widget_id());
            for label in [
                "Name",
                "Model",
                "Task",
                "Instructions",
                "Server URL",
                "Secret value",
            ] {
                data.remove::<egui::text_edit::TextEditState>(egui::Id::new((
                    "form-field",
                    self.id,
                    label,
                )));
            }
        });
    }
}

#[derive(Default)]
struct ToolDraft {
    text: String,
    failed: bool,
}

enum Effect {
    Editor {
        editor_id: u64,
        collection: Collection,
        select_id: Option<String>,
    },
    Event {
        session_id: String,
        sent_message: Option<String>,
        tool_call: Option<String>,
    },
    Delete {
        collection: Collection,
        id: String,
    },
    SessionArchive {
        id: String,
        archived: bool,
    },
    SessionMetadata {
        id: String,
    },
    CredentialDelete {
        vault_id: String,
    },
}

enum Pending {
    Models,
    Templates,
    List { generation: u64, append: bool },
    Detail { generation: u64 },
    Snapshot { generation: u64 },
    Credentials { generation: u64 },
    Mutation(Effect),
    Download,
}

struct PendingRequest {
    operation: Pending,
    started: Instant,
}

impl PendingRequest {
    fn new(operation: Pending) -> Self {
        Self {
            operation,
            started: Instant::now(),
        }
    }

    fn needs_feedback(&self) -> bool {
        self.started.elapsed() >= LOADING_FEEDBACK_DELAY
    }
}

pub struct ConsoleApp {
    worker: Worker,
    models: ModelPicker,
    environments: EnvironmentPicker,
    collection: Collection,
    resources: Vec<Resource>,
    session_index: HashSet<String>,
    archived_sessions: bool,
    search: String,
    focus_search: bool,
    rename: Option<(String, String)>,
    archive_undo: Option<(String, bool)>,
    after: Option<String>,
    selected_id: Option<String>,
    selected: Option<Resource>,
    snapshot: Option<SessionSnapshot>,
    credentials: Vec<Resource>,
    list_generation: u64,
    selection_generation: u64,
    pending: HashMap<u64, PendingRequest>,
    detail_loaded: bool,
    credentials_loaded: bool,
    list_pending: Option<u64>,
    detail_pending: Option<u64>,
    snapshot_pending: Option<u64>,
    mutation_pending: Option<u64>,
    next_refresh: Instant,
    editor: Option<Editor>,
    session_editor: Option<Editor>,
    next_editor_id: u64,
    delete_confirmation: Option<(Collection, String, String)>,
    messages: HashMap<String, String>,
    session_titles: HashMap<String, String>,
    tool_drafts: HashMap<(String, String), ToolDraft>,
    markdown_cache: CommonMarkCache,
    rendered_markdown: HashMap<String, (String, String)>,
    error: Option<String>,
    notice: Option<String>,
    initialized: bool,
}

impl ConsoleApp {
    pub fn new(endpoint: String, token: String) -> Result<Self, String> {
        Ok(Self {
            worker: Worker::new(endpoint, token)?,
            models: ModelPicker::default(),
            environments: EnvironmentPicker::default(),
            collection: Collection::Sessions,
            resources: Vec::new(),
            session_index: HashSet::new(),
            archived_sessions: false,
            search: String::new(),
            focus_search: false,
            rename: None,
            archive_undo: None,
            after: None,
            selected_id: None,
            selected: None,
            snapshot: None,
            credentials: Vec::new(),
            list_generation: 0,
            selection_generation: 0,
            pending: HashMap::new(),
            detail_loaded: false,
            credentials_loaded: false,
            list_pending: None,
            detail_pending: None,
            snapshot_pending: None,
            mutation_pending: None,
            next_refresh: Instant::now(),
            editor: None,
            session_editor: None,
            next_editor_id: 0,
            delete_confirmation: None,
            messages: HashMap::new(),
            session_titles: HashMap::new(),
            tool_drafts: HashMap::new(),
            markdown_cache: CommonMarkCache::default(),
            rendered_markdown: HashMap::new(),
            error: None,
            notice: None,
            initialized: false,
        })
    }

    pub fn show(&mut self, ui: &mut Ui) {
        let ctx = ui.ctx().clone();
        if !self.initialized {
            theme::apply(&ctx);
            self.initialized = true;
            self.refresh_list(false, &ctx);
            // Egui installs the new font families at the start of the next pass.
            ctx.request_repaint();
            return;
        }
        self.receive(&ctx);
        if self.collection == Collection::Sessions
            && self.selected_id.is_some()
            && self.snapshot_pending.is_none()
            && Instant::now() >= self.next_refresh
        {
            self.refresh_snapshot(&ctx);
        }
        if !self.pending.is_empty() {
            ctx.request_repaint_after(Duration::from_millis(150));
        } else if self.collection == Collection::Sessions && self.selected_id.is_some() {
            ctx.request_repaint_after(self.next_refresh.saturating_duration_since(Instant::now()));
        }
        if self.editor.as_ref().is_none_or(|editor| {
            editor.collection == Collection::Sessions && editor.select_id.is_none()
        }) && self.rename.is_none()
        {
            if ctx.input_mut(|input| input.consume_key(egui::Modifiers::COMMAND, egui::Key::K)) {
                self.focus_search = true;
            }
            if ctx.input_mut(|input| input.consume_key(egui::Modifiers::COMMAND, egui::Key::N)) {
                self.new_resource(Collection::Sessions, None);
            }
        }
        egui::Panel::left("resources")
            .resizable(true)
            .default_size(232.0)
            .size_range(208.0..=320.0)
            .frame(egui::Frame::new().fill(theme::PANEL).inner_margin(14))
            .show(ui, |ui| {
                egui::Panel::bottom("workspace-navigation")
                    .show_separator_line(false)
                    .frame(egui::Frame::NONE)
                    .resizable(false)
                    .show(ui, |ui| self.navigation(ui));
                ui.label(RichText::new("Rat Things").font(theme::semibold(14.0)));
                ui.add_space(14.0);
                self.resource_list(ui);
            });
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(theme::BACKGROUND).inner_margin(24))
            .show(ui, |ui| {
                let area = ui.available_rect_before_wrap();
                let width = if self.collection == Collection::Sessions {
                    780.0
                } else {
                    920.0
                };
                let gutter = ((area.width() - width) / 2.0).max(0.0);
                let column = egui::Rect::from_min_max(
                    area.min + egui::vec2(gutter, 0.0),
                    area.max - egui::vec2(gutter, 0.0),
                );
                ui.scope_builder(egui::UiBuilder::new().max_rect(column), |ui| {
                    self.content(ui)
                });
            });
        self.editor_window(ui, false);
        self.rename_window(&ctx);
        self.delete_window(&ctx);
        if self.error.is_some() || self.notice.is_some() {
            egui::Area::new(egui::Id::new("notifications"))
                .order(egui::Order::Foreground)
                .anchor(egui::Align2::RIGHT_TOP, egui::vec2(-24.0, 62.0))
                .show(&ctx, |ui| {
                    ui.set_max_width(380.0);
                    theme::card().show(ui, |ui| self.notifications(ui));
                });
        }
    }

    pub fn save_artifact_to(
        &mut self,
        ctx: &egui::Context,
        session_id: &str,
        artifact_id: &str,
        destination: PathBuf,
    ) -> Result<(), String> {
        let id = self.worker.submit(
            Task::DownloadTo {
                path: artifact_path(session_id, artifact_id),
                destination,
            },
            ctx,
        )?;
        self.pending
            .insert(id, PendingRequest::new(Pending::Download));
        Ok(())
    }

    fn submit(&mut self, task: Task, pending: Pending, ctx: &egui::Context) -> Option<u64> {
        match self.worker.submit(task, ctx) {
            Ok(id) => {
                self.pending.insert(id, PendingRequest::new(pending));
                Some(id)
            }
            Err(error) => {
                self.error = Some(error);
                None
            }
        }
    }

    fn navigate(&mut self, collection: Collection, ctx: &egui::Context) {
        if self.collection == collection {
            return;
        }
        self.suspend_session_editor();
        self.collection = collection;
        self.search.clear();
        self.resources.clear();
        self.after = None;
        self.clear_selection(ctx);
        self.error = None;
        self.refresh_list(false, ctx);
    }

    fn clear_selection(&mut self, ctx: &egui::Context) {
        egui::Popup::close_all(ctx);
        self.selection_generation += 1;
        self.selected = None;
        self.selected_id = None;
        self.snapshot = None;
        self.credentials.clear();
        self.detail_loaded = false;
        self.credentials_loaded = false;
        self.detail_pending = None;
        self.snapshot_pending = None;
        self.rendered_markdown.clear();
        self.markdown_cache = CommonMarkCache::default();
    }

    fn refresh_list(&mut self, append: bool, ctx: &egui::Context) {
        self.list_generation += 1;
        self.list_pending = self.submit(
            Task::List {
                collection: self.collection,
                after: if append { self.after.clone() } else { None },
            },
            Pending::List {
                generation: self.list_generation,
                append,
            },
            ctx,
        );
    }

    fn select(&mut self, id: String, ctx: &egui::Context) {
        self.suspend_session_editor();
        if self.selected_id.as_ref() == Some(&id) {
            return;
        }
        self.clear_selection(ctx);
        self.error = None;
        self.selected_id = Some(id.clone());
        self.selected = self
            .resources
            .iter()
            .find(|resource| resource.id == id)
            .cloned();
        self.refresh_selection(ctx);
    }

    // Refresh replaces data only after success; navigation alone resets view state.
    fn refresh_selection(&mut self, ctx: &egui::Context) {
        let Some(id) = self.selected_id.clone() else {
            return;
        };
        if self.collection == Collection::Sessions {
            self.refresh_snapshot(ctx);
        } else if self.detail_pending.is_none() {
            self.detail_pending = self.submit(
                Task::Detail {
                    collection: self.collection,
                    id,
                },
                Pending::Detail {
                    generation: self.selection_generation,
                },
                ctx,
            );
        }
    }

    fn loading_is_slow(&self, id: Option<u64>) -> bool {
        id.and_then(|id| self.pending.get(&id))
            .is_some_and(PendingRequest::needs_feedback)
    }

    fn refresh_snapshot(&mut self, ctx: &egui::Context) {
        if self.snapshot_pending.is_some() {
            return;
        }
        let Some(id) = self.selected_id.clone() else {
            return;
        };
        self.next_refresh = Instant::now() + SNAPSHOT_INTERVAL;
        self.snapshot_pending = self.submit(
            Task::Snapshot { id },
            Pending::Snapshot {
                generation: self.selection_generation,
            },
            ctx,
        );
    }

    fn refresh_credentials(&mut self, ctx: &egui::Context) {
        let Some(vault_id) = self.selected_id.clone() else {
            return;
        };
        self.submit(
            Task::Credentials { vault_id },
            Pending::Credentials {
                generation: self.selection_generation,
            },
            ctx,
        );
    }

    fn refresh_models(&mut self, ctx: &egui::Context) {
        if self.models.loading {
            return;
        }
        self.models.error = None;
        self.models.refresh_requested = false;
        match self.worker.submit(Task::Models, ctx) {
            Ok(id) => {
                self.pending
                    .insert(id, PendingRequest::new(Pending::Models));
                self.models.started = Some(Instant::now());
                self.models.loading = true;
            }
            Err(error) => self.models.error = Some(error),
        }
    }

    fn refresh_templates(&mut self, ctx: &egui::Context) {
        if self.environments.started.is_some() {
            return;
        }
        self.environments.error = None;
        self.environments.refresh_requested = false;
        match self.worker.submit(Task::Templates, ctx) {
            Ok(id) => {
                self.pending
                    .insert(id, PendingRequest::new(Pending::Templates));
                self.environments.started = Some(Instant::now());
            }
            Err(error) => self.environments.error = Some(error),
        }
    }

    fn receive(&mut self, ctx: &egui::Context) {
        while let Ok(completion) = self.worker.completions.try_recv() {
            let Some(pending) = self.pending.remove(&completion.id) else {
                continue;
            };
            let pending = pending.operation;
            let current = match &pending {
                Pending::List { generation, .. } => *generation == self.list_generation,
                Pending::Detail { generation }
                | Pending::Snapshot { generation }
                | Pending::Credentials { generation } => *generation == self.selection_generation,
                _ => true,
            };
            if self.list_pending == Some(completion.id) {
                self.list_pending = None;
            }
            if self.detail_pending == Some(completion.id) {
                self.detail_pending = None;
            }
            if self.snapshot_pending == Some(completion.id) {
                self.snapshot_pending = None;
                self.next_refresh = Instant::now() + SNAPSHOT_INTERVAL;
            }
            if self.mutation_pending == Some(completion.id) {
                self.mutation_pending = None;
            }
            if !current {
                continue;
            }
            if matches!(pending, Pending::Templates) {
                self.environments.started = None;
                match completion.result {
                    Ok(Data::Templates(templates)) => self.environments.templates = Some(templates),
                    Err(error) => self.environments.error = Some(error),
                    _ => {
                        self.environments.error =
                            Some("The environment template response is invalid.".into())
                    }
                }
                continue;
            }
            if matches!(pending, Pending::Models) {
                self.models.loading = false;
                self.models.started = None;
                match completion.result {
                    Ok(Data::Models(catalog)) => self.models.catalog = Some(catalog),
                    Err(error) => self.models.error = Some(error),
                    _ => self.models.error = Some("The model catalog response is invalid.".into()),
                }
                continue;
            }
            match completion.result {
                Err(error) => {
                    if let Pending::Mutation(Effect::Editor { editor_id, .. }) = pending {
                        if let Some(editor) = &mut self.editor
                            && editor.id == editor_id
                        {
                            editor.error = Some(error);
                        }
                    } else {
                        self.error = Some(error);
                        self.next_refresh = Instant::now() + Duration::from_secs(3);
                    }
                }
                Ok(data) => match (pending, data) {
                    (Pending::List { append, .. }, Data::Page(page)) => {
                        self.after = if page.has_more {
                            page.data.last().map(|row| row.id.clone())
                        } else {
                            None
                        };
                        if self.collection == Collection::Sessions {
                            if !append {
                                self.session_index.clear();
                            }
                            self.session_index
                                .extend(page.data.iter().map(|row| row.id.clone()));
                            let mut ordered = page.data;
                            if append {
                                for row in ordered {
                                    if let Some(old) =
                                        self.resources.iter_mut().find(|old| old.id == row.id)
                                    {
                                        *old = row;
                                    } else {
                                        self.resources.push(row);
                                    }
                                }
                            } else {
                                ordered.extend(
                                    self.resources
                                        .iter()
                                        .filter(|row| !self.session_index.contains(&row.id))
                                        .cloned(),
                                );
                                self.resources = ordered;
                            }
                            if self.after.is_none() {
                                self.resources
                                    .retain(|row| self.session_index.contains(&row.id));
                            }
                        } else if append {
                            for row in page.data {
                                if !self.resources.iter().any(|old| old.id == row.id) {
                                    self.resources.push(row);
                                }
                            }
                        } else {
                            self.resources = page.data;
                        }
                        self.load_past_hidden_sessions(ctx);
                    }
                    (Pending::Detail { .. }, Data::Resource(resource)) => {
                        self.detail_loaded = true;
                        self.selected = Some(resource);
                        if self.collection == Collection::Vaults {
                            self.refresh_credentials(ctx);
                        }
                    }
                    (Pending::Snapshot { .. }, Data::Snapshot(snapshot)) => {
                        if snapshot.session.is_unnamed_session()
                            && let Some(title) =
                                snapshot
                                    .items
                                    .iter()
                                    .filter(|item| item.text("role") == "user")
                                    .find_map(|item| {
                                        item.fields.get("content")?.as_array()?.iter().find_map(
                                            |part| prompt_title(part.get("text")?.as_str()?),
                                        )
                                    })
                        {
                            self.session_titles
                                .insert(snapshot.session.id.clone(), title);
                        }
                        self.selected = Some(snapshot.session.clone());
                        if let Some(row) = self
                            .resources
                            .iter_mut()
                            .find(|row| row.id == snapshot.session.id)
                        {
                            *row = snapshot.session.clone();
                        }
                        self.next_refresh = Instant::now()
                            + if snapshot.turn_active() {
                                SNAPSHOT_INTERVAL
                            } else {
                                IDLE_SNAPSHOT_INTERVAL
                            };
                        self.snapshot = Some(snapshot);
                    }
                    (Pending::Credentials { .. }, Data::Credentials(credentials)) => {
                        self.credentials_loaded = true;
                        self.credentials = credentials
                    }
                    (Pending::Mutation(effect), Data::Mutation(value)) => {
                        self.mutation_done(effect, value, ctx)
                    }
                    (Pending::Download, Data::Download(path)) => {
                        self.notice =
                            path.map(|path| format!("Saved artifact to {}", path.display()));
                    }
                    _ => self.error = Some("The console received an unexpected response".into()),
                },
            }
        }
    }

    fn mutation_done(&mut self, effect: Effect, result: Value, ctx: &egui::Context) {
        self.error = None;
        match effect {
            Effect::Editor {
                editor_id,
                collection,
                select_id,
            } => {
                if self
                    .editor
                    .as_ref()
                    .is_some_and(|editor| editor.id == editor_id)
                {
                    self.close_editor(ctx);
                }
                let id = select_id.or_else(|| {
                    result
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                });
                if collection == Collection::Sessions {
                    self.archived_sessions = false;
                }
                if self.collection != collection {
                    self.navigate(collection, ctx);
                } else {
                    self.refresh_list(false, ctx);
                }
                if let Some(id) = id {
                    if self.selected_id.as_ref() == Some(&id) {
                        self.refresh_selection(ctx);
                    } else {
                        self.select(id, ctx);
                    }
                }
                self.notice = None;
            }
            Effect::Event {
                session_id,
                sent_message,
                tool_call,
            } => {
                if let Some(message) = sent_message
                    && self.messages.get(&session_id) == Some(&message)
                {
                    self.messages.remove(&session_id);
                }
                if let Some(call_id) = tool_call {
                    self.tool_drafts.remove(&(session_id.clone(), call_id));
                }
                if self.selected_id.as_ref() == Some(&session_id) {
                    self.next_refresh = Instant::now();
                    self.refresh_snapshot(ctx);
                }
                self.notice = None;
            }
            Effect::Delete { collection, id } => {
                if self.collection == collection {
                    if self.selected_id.as_ref() == Some(&id) {
                        self.clear_selection(ctx);
                    }
                    self.refresh_list(false, ctx);
                }
                self.notice = Some(format!("Deleted {}", collection.singular()));
            }
            Effect::SessionArchive { id, archived } => {
                self.archive_undo = Some((id.clone(), !archived));
                if self.collection == Collection::Sessions {
                    if let Ok(resource) = serde_json::from_value::<Resource>(result)
                        && let Some(row) = self.resources.iter_mut().find(|row| row.id == id)
                    {
                        *row = resource;
                    }
                    if self.selected_id.as_ref() == Some(&id) && self.archived_sessions != archived
                    {
                        self.clear_selection(ctx);
                    }
                    self.refresh_list(false, ctx);
                }
                self.notice = Some(
                    if archived {
                        "Session archived"
                    } else {
                        "Session unarchived"
                    }
                    .into(),
                );
            }
            Effect::SessionMetadata { id } => {
                if self
                    .rename
                    .as_ref()
                    .is_some_and(|(renaming, _)| renaming == &id)
                {
                    self.rename = None;
                }
                if self.collection == Collection::Sessions {
                    if let Ok(resource) = serde_json::from_value::<Resource>(result) {
                        if let Some(row) = self.resources.iter_mut().find(|row| row.id == id) {
                            *row = resource.clone();
                        }
                        if self.selected_id.as_ref() == Some(&id) {
                            self.selection_generation += 1;
                            self.snapshot_pending = None;
                            self.selected = Some(resource.clone());
                            if let Some(snapshot) = &mut self.snapshot {
                                snapshot.session = resource;
                            }
                        }
                    }
                    self.refresh_list(false, ctx);
                }
            }
            Effect::CredentialDelete { vault_id } => {
                if self.collection == Collection::Vaults
                    && self.selected_id.as_ref() == Some(&vault_id)
                {
                    self.refresh_credentials(ctx);
                }
                self.notice = Some("Deleted credential".into());
            }
        }
    }

    fn navigation(&mut self, ui: &mut Ui) {
        ui.add_space(12.0);
        ui.label(RichText::new("Workspace").small().color(theme::MUTED));
        for collection in Collection::ALL {
            let selected = self.collection == collection;
            let response = ui.add_sized(
                [ui.available_width(), 28.0],
                egui::Button::new(RichText::new(collection.title()).color(if selected {
                    theme::TEXT
                } else {
                    theme::MUTED
                }))
                .right_text("")
                .selected(selected)
                .frame_when_inactive(selected)
                .stroke(egui::Stroke::NONE),
            );
            response.widget_info(|| {
                egui::WidgetInfo::selected(
                    egui::WidgetType::Button,
                    true,
                    selected,
                    collection.title(),
                )
            });
            if response.clicked() {
                self.navigate(collection, ui.ctx());
            }
        }
    }

    fn resource_title(&self, resource: &Resource) -> String {
        if resource.is_unnamed_session() {
            self.session_titles
                .get(&resource.id)
                .cloned()
                .unwrap_or_else(|| resource.title().into())
        } else {
            resource.title().into()
        }
    }

    fn session_visible(&self, resource: &Resource) -> bool {
        self.collection != Collection::Sessions
            || resource.is_archived_session() == self.archived_sessions
    }

    fn load_past_hidden_sessions(&mut self, ctx: &egui::Context) {
        // Index every page so older pinned sessions and search results are available.
        // Existing rows remain usable while subsequent pages arrive.
        if self.collection == Collection::Sessions
            && self.after.is_some()
            && self.list_pending.is_none()
        {
            self.refresh_list(true, ctx);
        }
    }

    fn resource_list(&mut self, ui: &mut Ui) {
        let new_label = format!("New {}", self.collection.singular());
        let create = ui.add_sized(
            [ui.available_width(), 32.0],
            egui::Button::new((
                RichText::new("+").size(18.0),
                RichText::new(&new_label).size(13.0),
            ))
            .right_text("")
            .frame_when_inactive(false)
            .stroke(egui::Stroke::NONE),
        );
        create
            .widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, &new_label));
        if create.clicked() {
            self.new_resource(self.collection, None);
        }
        ui.add_space(8.0);
        let search = ui.add(
            TextEdit::singleline(&mut self.search)
                .id_salt("resource-search")
                .hint_text("Search…  ⌘K")
                .margin(egui::Margin::symmetric(10, 8))
                .min_size(egui::vec2(0.0, 32.0))
                .desired_width(f32::INFINITY),
        );
        search.widget_info(|| {
            egui::WidgetInfo::labeled(egui::WidgetType::TextEdit, true, "Search sessions")
        });
        if self.focus_search {
            search.request_focus();
            self.focus_search = false;
        }
        if search.has_focus()
            && ui.input_mut(|input| input.consume_key(egui::Modifiers::NONE, egui::Key::Escape))
        {
            self.search.clear();
            search.surrender_focus();
        }
        if search.changed() {
            self.load_past_hidden_sessions(ui.ctx());
        }
        if (search.has_focus() || search.lost_focus())
            && ui.input_mut(|input| input.consume_key(egui::Modifiers::NONE, egui::Key::Enter))
        {
            let query = self.search.to_lowercase();
            if let Some(row) = self.resources.iter().find(|row| {
                self.session_visible(row)
                    && self.resource_title(row).to_lowercase().contains(&query)
            }) {
                let id = row.id.clone();
                search.surrender_focus();
                self.select(id, ui.ctx());
            }
        }
        ui.add_space(10.0);
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(
                    if self.archived_sessions && self.collection == Collection::Sessions {
                        "Archived sessions"
                    } else if self.collection == Collection::Sessions {
                        "Recent"
                    } else {
                        self.collection.title()
                    },
                )
                .small()
                .color(theme::MUTED),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let menu = ui.menu_button("···", |ui| {
                    if ui
                        .add_enabled(self.list_pending.is_none(), egui::Button::new("Refresh"))
                        .clicked()
                    {
                        self.error = None;
                        self.refresh_list(false, ui.ctx());
                        self.refresh_selection(ui.ctx());
                        ui.close();
                    }
                });
                menu.response.widget_info(|| {
                    egui::WidgetInfo::labeled(egui::WidgetType::Button, true, "List options")
                });
            });
        });
        ui.add_space(4.0);
        let mut clicked = None;
        let mut archive = None;
        let mut pin = None;
        egui::ScrollArea::vertical()
            .id_salt("resource-list")
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                if !self.resources.iter().any(|row| self.session_visible(row))
                    && self.list_pending.is_none()
                {
                    ui.add_space(18.0);
                    ui.label(
                        RichText::new(
                            if self.collection == Collection::Sessions && self.archived_sessions {
                                "No archived sessions".into()
                            } else {
                                format!("No {} yet", self.collection.title().to_lowercase())
                            },
                        )
                        .color(theme::MUTED),
                    );
                }
                let query = self.search.to_lowercase();
                let mut rows: Vec<_> = self
                    .resources
                    .iter()
                    .filter(|row| {
                        self.session_visible(row)
                            && self.resource_title(row).to_lowercase().contains(&query)
                    })
                    .cloned()
                    .collect();
                rows.sort_by_key(|row| !row.is_pinned_session());
                let mut last_group = None;
                let has_pins = rows.iter().any(Resource::is_pinned_session);
                if rows.is_empty() && !query.is_empty() {
                    ui.label(
                        RichText::new("No matching sessions")
                            .small()
                            .color(theme::MUTED),
                    );
                }
                for resource in &rows {
                    if self.collection == Collection::Sessions && has_pins {
                        let pinned = resource.is_pinned_session();
                        if last_group != Some(pinned) {
                            ui.add_space(6.0);
                            ui.label(
                                RichText::new(if pinned { "Pinned" } else { "Other sessions" })
                                    .small()
                                    .color(theme::MUTED),
                            );
                            last_group = Some(pinned);
                        }
                    }
                    let title = self.resource_title(resource);
                    let selected = self.selected_id.as_ref() == Some(&resource.id);
                    let status = resource.text("status").replace('_', " ");
                    let subtitle = [status.as_str(), resource.model()]
                        .into_iter()
                        .filter(|value| !value.is_empty())
                        .collect::<Vec<_>>()
                        .join(" · ");
                    let response = ui
                        .push_id(&resource.id, |ui| {
                            ui.add_sized(
                                [ui.available_width(), 30.0],
                                egui::Button::new(
                                    RichText::new(title.replace(['\n', '\r'], " ")).size(13.0),
                                )
                                .right_text("")
                                .selected(selected)
                                .frame_when_inactive(selected)
                                .stroke(egui::Stroke::NONE)
                                .corner_radius(6)
                                .truncate(),
                            )
                        })
                        .inner
                        .on_hover_text(if subtitle.is_empty() {
                            title.clone()
                        } else {
                            format!("{title}\n{subtitle}")
                        });
                    response.widget_info(|| {
                        egui::WidgetInfo::selected(egui::WidgetType::Button, true, selected, &title)
                    });
                    if self.collection == Collection::Sessions {
                        response.context_menu(|ui| {
                            if ui
                                .add_enabled(
                                    self.mutation_pending.is_none(),
                                    egui::Button::new(if resource.is_pinned_session() {
                                        "Unpin session"
                                    } else {
                                        "Pin session"
                                    }),
                                )
                                .clicked()
                            {
                                pin = Some((resource.id.clone(), !resource.is_pinned_session()));
                                ui.close();
                            }
                            if ui.button("Rename session").clicked() {
                                self.rename = Some((resource.id.clone(), title.clone()));
                                ui.close();
                            }
                            let archived = resource.is_archived_session();
                            if ui
                                .add_enabled(
                                    self.mutation_pending.is_none(),
                                    egui::Button::new(if archived {
                                        "Unarchive session"
                                    } else {
                                        "Archive session"
                                    }),
                                )
                                .clicked()
                            {
                                archive = Some((resource.id.clone(), !archived));
                                ui.close();
                            }
                        });
                    }
                    if response.clicked() {
                        clicked = Some(resource.id.clone());
                    }
                }
                if self.loading_is_slow(self.list_pending) {
                    ui.horizontal(|ui| {
                        ui.spinner();
                        ui.label(if self.resources.is_empty() {
                            "Loading resources…"
                        } else {
                            "Updating…"
                        });
                    });
                }
                if self.after.is_some()
                    && ui
                        .add_enabled(self.list_pending.is_none(), egui::Button::new("Load more"))
                        .clicked()
                {
                    self.refresh_list(true, ui.ctx());
                }
                if self.collection == Collection::Sessions {
                    ui.add_space(12.0);
                    let label = if self.archived_sessions {
                        "Back to sessions"
                    } else {
                        "Archived sessions"
                    };
                    if ui
                        .add(
                            egui::Button::new(RichText::new(label).small().color(theme::MUTED))
                                .frame(false),
                        )
                        .clicked()
                    {
                        self.archived_sessions = !self.archived_sessions;
                        self.clear_selection(ui.ctx());
                        self.load_past_hidden_sessions(ui.ctx());
                    }
                }
            });
        if let Some(id) = clicked {
            self.select(id, ui.ctx());
        }
        if let Some((id, archived)) = archive {
            self.archive_session(id, archived, ui.ctx());
        }
        if let Some((id, pinned)) = pin {
            self.update_session_metadata(
                id,
                "rat_things_pinned",
                pinned.then(|| "true".into()),
                ui.ctx(),
            );
        }
    }

    fn archive_session(&mut self, id: String, archived: bool, ctx: &egui::Context) {
        self.error = None;
        self.notice = None;
        self.archive_undo = None;
        self.mutation_pending = self.submit(
            Task::SetSessionArchived {
                id: id.clone(),
                archived,
            },
            Pending::Mutation(Effect::SessionArchive { id, archived }),
            ctx,
        );
    }

    fn update_session_metadata(
        &mut self,
        id: String,
        key: &str,
        value: Option<String>,
        ctx: &egui::Context,
    ) {
        self.error = None;
        self.mutation_pending = self.submit(
            Task::UpdateSessionMetadata {
                id: id.clone(),
                key: key.into(),
                value,
            },
            Pending::Mutation(Effect::SessionMetadata { id }),
            ctx,
        );
    }

    fn rename_window(&mut self, ctx: &egui::Context) {
        let Some((id, mut name)) = self.rename.clone() else {
            return;
        };
        let mut save = false;
        let mut close = false;
        egui::Modal::new(egui::Id::new("rename-session")).show(ctx, |ui| {
            ui.heading("Rename session");
            if let Some(error) = &self.error {
                ui.colored_label(theme::ERROR, error);
            }
            let response = ui.add(TextEdit::singleline(&mut name).desired_width(320.0));
            response.widget_info(|| {
                egui::WidgetInfo::labeled(egui::WidgetType::TextEdit, true, "Session name")
            });
            ui.horizontal(|ui| {
                close = ui.button("Cancel rename").clicked();
                save = ui
                    .add_enabled(
                        self.mutation_pending.is_none() && !name.trim().is_empty(),
                        theme::primary_button("Save name"),
                    )
                    .clicked();
            });
        });
        self.rename = if close {
            None
        } else {
            Some((id.clone(), name.clone()))
        };
        if save {
            self.update_session_metadata(id, "name", Some(name.trim().into()), ctx);
        }
    }

    fn content(&mut self, ui: &mut Ui) {
        if self.editor.as_ref().is_some_and(|editor| {
            editor.collection == Collection::Sessions && editor.select_id.is_none()
        }) {
            self.editor_window(ui, true);
            return;
        }
        let Some(resource) = self.selected.clone() else {
            if self.selected_id.is_some() {
                if self.loading_is_slow(self.snapshot_pending.or(self.detail_pending)) {
                    ui.horizontal(|ui| {
                        ui.spinner();
                        ui.label("Loading resource…");
                    });
                }
            } else {
                self.welcome(ui);
            }
            return;
        };
        ui.horizontal(|ui| {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.menu_button("Actions", |ui| {
                    if self.collection == Collection::Sessions {
                        if ui.button("Rename session").clicked() {
                            self.rename =
                                Some((resource.id.clone(), self.resource_title(&resource)));
                            ui.close();
                        }
                        if ui
                            .add_enabled(
                                self.mutation_pending.is_none(),
                                egui::Button::new(if resource.is_pinned_session() {
                                    "Unpin session"
                                } else {
                                    "Pin session"
                                }),
                            )
                            .clicked()
                        {
                            self.update_session_metadata(
                                resource.id.clone(),
                                "rat_things_pinned",
                                (!resource.is_pinned_session()).then(|| "true".into()),
                                ui.ctx(),
                            );
                            ui.close();
                        }
                        let archived = resource.is_archived_session();
                        if ui
                            .add_enabled(
                                self.mutation_pending.is_none(),
                                egui::Button::new(if archived {
                                    "Unarchive session"
                                } else {
                                    "Archive session"
                                }),
                            )
                            .clicked()
                        {
                            self.archive_session(resource.id.clone(), !archived, ui.ctx());
                            ui.close();
                        }
                    }
                    if ui.button("Copy resource ID").clicked() {
                        ui.ctx().copy_text(resource.id.clone());
                        ui.close();
                    }
                    let label = format!("Delete {}", self.collection.singular());
                    if ui
                        .add_enabled(self.mutation_pending.is_none(), egui::Button::new(label))
                        .clicked()
                    {
                        self.delete_confirmation = Some((
                            self.collection,
                            resource.id.clone(),
                            self.resource_title(&resource),
                        ));
                        ui.close();
                    }
                });
                self.files_menu(ui);
                ui.menu_button("Details", |ui| {
                    ui.set_max_width(340.0);
                    theme::status(ui, resource.text("status"));
                    if !resource.model().is_empty() {
                        ui.label(RichText::new("Model").small().color(theme::MUTED));
                        ui.label(resource.model());
                    }
                    if let Some(snapshot) = &self.snapshot {
                        self.environment(ui, snapshot);
                    }
                });
                ui.allocate_ui_with_layout(
                    egui::vec2(ui.available_width(), 30.0),
                    egui::Layout::left_to_right(egui::Align::Center),
                    |ui| {
                        let title = ui
                            .add(
                                egui::Label::new(
                                    RichText::new(self.resource_title(&resource))
                                        .font(theme::semibold(16.0)),
                                )
                                .truncate()
                                .sense(egui::Sense::click()),
                            )
                            .on_hover_text(self.resource_title(&resource));
                        if self.collection == Collection::Sessions && title.double_clicked() {
                            self.rename =
                                Some((resource.id.clone(), self.resource_title(&resource)));
                        }
                    },
                );
            });
        });
        ui.add_space(18.0);
        if self.collection == Collection::Sessions {
            if let Some(snapshot) = self.snapshot.take() {
                self.session(ui, &snapshot);
                self.snapshot = Some(snapshot);
            } else if self.loading_is_slow(self.snapshot_pending) {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label("Loading saved items…");
                });
            }
        } else if !self.detail_loaded {
            if self.loading_is_slow(self.detail_pending) {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label("Loading resource details…");
                });
            }
        } else {
            self.details(ui, &resource);
        }
    }

    fn notifications(&mut self, ui: &mut Ui) {
        if let Some(error) = self.error.clone() {
            egui::Frame::new()
                .fill(theme::ERROR.gamma_multiply(0.1))
                .corner_radius(7)
                .inner_margin(10)
                .show(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.colored_label(theme::ERROR, error);
                        if ui.small_button("Dismiss error").clicked() {
                            self.error = None;
                        }
                    });
                });
        }
        if let Some(notice) = self.notice.clone() {
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new(notice).small().color(theme::ACCENT));
                if let Some((id, archived)) = self.archive_undo.clone()
                    && ui
                        .add_enabled(
                            self.mutation_pending.is_none(),
                            egui::Button::new("Undo").small(),
                        )
                        .clicked()
                {
                    self.archive_session(id, archived, ui.ctx());
                }
                if ui.small_button("Dismiss notice").clicked() {
                    self.notice = None;
                    self.archive_undo = None;
                }
            });
        }
    }

    fn welcome(&mut self, ui: &mut Ui) {
        let (heading, subtitle, action) = match self.collection {
            Collection::Sessions => (
                "What are we working on?",
                "Start a conversation with an agent. Your work and results stay together here.",
                "Create a session",
            ),
            Collection::Agents => (
                "A team, ready when you are",
                "Save a model and instructions for work you do often.",
                "Create an agent",
            ),
            Collection::Templates => (
                "A place for your agents to work",
                "Prepare reusable environments with the packages and access your work needs.",
                "Create a template",
            ),
            Collection::Vaults => (
                "Keep connections in one place",
                "Store credentials for the tools your agents use. Secret values remain private.",
                "Create a vault",
            ),
        };
        ui.add_space((ui.available_height() * 0.25).max(30.0));
        ui.vertical_centered(|ui| {
            ui.label(RichText::new(heading).font(theme::semibold(22.0)));
            ui.add_space(10.0);
            ui.add(egui::Label::new(RichText::new(subtitle).color(theme::MUTED)).wrap());
            ui.add_space(22.0);
            if ui.add(theme::primary_button(action)).clicked() {
                self.new_resource(self.collection, None);
            }
        });
    }

    fn session(&mut self, ui: &mut Ui, snapshot: &SessionSnapshot) {
        let gutter = ((ui.available_width() - 780.0) / 2.0).max(0.0);
        let area = ui.available_rect_before_wrap();
        let column = egui::Rect::from_min_max(
            area.min + egui::vec2(gutter, 0.0),
            area.max - egui::vec2(gutter, 0.0),
        );
        ui.scope_builder(egui::UiBuilder::new().max_rect(column), |ui| {
        let session_id = snapshot.session.id.clone();
        let active = snapshot.turn_active();
        egui::Panel::bottom("composer").show_separator_line(false).resizable(false).min_size(0.0).frame(egui::Frame::NONE).show(ui, |ui| {
            ui.add_space(12.0);
            egui::Frame::new().fill(theme::SURFACE).stroke(egui::Stroke::new(1.0, theme::BORDER)).corner_radius(8).inner_margin(12).show(ui, |ui| {
                let message = self.messages.entry(session_id.clone()).or_default();
                let response = egui::ScrollArea::vertical().id_salt(("composer-scroll", &session_id)).max_height(160.0).show(ui, |ui| {
                    ui.add(TextEdit::multiline(message).id_salt(("message", &session_id)).frame(egui::Frame::NONE).desired_rows(1).desired_width(f32::INFINITY).hint_text(if active { "Add a direction for the agent…" } else { "Ask a follow-up, or start the next step…" }))
                }).inner;
                response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::TextEdit, true, "Message"));
                let shortcut = response.has_focus() && ui.input(|input| input.modifiers.command && input.key_pressed(egui::Key::Enter));
                let message = message.clone();
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new("⌘ / Ctrl + Enter").small().color(theme::MUTED));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let label = if active { "Steer" } else { "Send" };
                        let enabled = self.mutation_pending.is_none() && !message.trim().is_empty();
                        if ui.add_enabled(enabled, theme::primary_button(label)).clicked() || (enabled && shortcut) {
                            self.send_events(&session_id, vec![json!({"type": "agent.session.input.message", "input": [{"role": "user", "content": [{"type": "input_text", "text": message}]}]})], Some(message), None, ui.ctx());
                        }
                    });
                });
            });
            ui.horizontal(|ui| {
                if let Some(turn) = snapshot.turn() { ui.label(RichText::new(format!("Turn {}", turn.text("status").replace('_', " "))).small().color(theme::MUTED)); }
                else { ui.label(RichText::new("Ready for input").small().color(theme::MUTED)); }
                if active && ui.add_enabled(self.mutation_pending.is_none(), egui::Button::new("Cancel turn").small()).clicked() {
                    self.send_events(&session_id, vec![json!({"type": "agent.session.input.cancel"})], None, None, ui.ctx());
                }
            });
        });
        egui::ScrollArea::vertical()
            .id_salt(("session-history", &session_id))
            .stick_to_bottom(true)
            .auto_shrink([false, false])
            .show(ui, |ui| {

                if snapshot.actions().iter().any(|action| action.get("type").and_then(Value::as_str) == Some("environment_connection")) {
                    self.environment(ui, snapshot);
                }
                let error = snapshot.session.text("error");
                if !error.is_empty() {
                    ui.colored_label(theme::ERROR, error);
                }
                if snapshot.items.is_empty() {
                    ui.add_space(22.0);
                    ui.label(RichText::new("No saved items yet.").color(theme::MUTED));
                }
                for item in &snapshot.items {
                    self.transcript_item(ui, item);
                }
                for action in snapshot.actions() {
                    if action.get("type").and_then(Value::as_str) == Some("function_call") {
                        self.tool_result(ui, &session_id, &action);
                    }
                }
                ui.add_space(12.0);
            });
            });
    }

    fn files_menu(&mut self, ui: &mut Ui) {
        let Some(snapshot) = self.snapshot.as_ref().filter(|snapshot| {
            self.collection == Collection::Sessions
                && self.selected_id.as_deref() == Some(snapshot.session.id.as_str())
                && !snapshot.artifacts.is_empty()
        }) else {
            return;
        };
        let session_id = snapshot.session.id.clone();
        let artifacts = snapshot.artifacts.clone();
        let turn_ids: Vec<_> = snapshot
            .turns
            .iter()
            .rev()
            .map(|turn| turn.id.clone())
            .collect();
        ui.push_id(("session-files", &session_id), |ui| {
            let escape = ui.input(|input| input.key_pressed(egui::Key::Escape));
            let (trigger, popup) =
                egui::containers::menu::MenuButton::new(format!("Files ({})", artifacts.len()))
                    .config(
                        egui::containers::menu::MenuConfig::new()
                            .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside),
                    )
                    .ui(ui, |ui| {
                        ui.set_width((ui.ctx().content_rect().width() - 64.0).clamp(220.0, 360.0));
                        ui.label(RichText::new("Files").font(theme::semibold(13.0)));
                        ui.label(
                            RichText::new("Created in this session")
                                .small()
                                .color(theme::MUTED),
                        );
                        ui.separator();
                        egui::ScrollArea::vertical()
                            .id_salt(("session-file-list", &session_id))
                            .max_height((ui.ctx().content_rect().height() * 0.5).min(360.0))
                            .show(ui, |ui| {
                                for artifact in &artifacts {
                                    ui.push_id(&artifact.id, |ui| {
                                        ui.horizontal(|ui| {
                                            let name_width =
                                                (ui.available_width() - 72.0).max(120.0);
                                            ui.vertical(|ui| {
                                                ui.set_width(name_width);
                                                ui.add(
                                                    egui::Label::new(artifact.text("path"))
                                                        .truncate(),
                                                )
                                                .on_hover_text(artifact.text("path"));
                                                let bytes = artifact
                                                    .fields
                                                    .get("size_bytes")
                                                    .and_then(Value::as_u64)
                                                    .unwrap_or_default();
                                                ui.label(
                                                    RichText::new(
                                                        turn_ids
                                                            .iter()
                                                            .position(|id| {
                                                                id == artifact.text("turn_id")
                                                            })
                                                            .map_or_else(
                                                                || format!("{bytes} bytes"),
                                                                |index| {
                                                                    format!(
                                                                        "Turn {} · {bytes} bytes",
                                                                        index + 1
                                                                    )
                                                                },
                                                            ),
                                                    )
                                                    .small()
                                                    .color(theme::MUTED),
                                                );
                                            });
                                            let response = ui.button("Save");
                                            response.widget_info(|| {
                                                egui::WidgetInfo::labeled(
                                                    egui::WidgetType::Button,
                                                    true,
                                                    format!(
                                                        "Save {}",
                                                        crate::api::safe_filename(
                                                            artifact.text("path")
                                                        )
                                                    ),
                                                )
                                            });
                                            if response.clicked() {
                                                self.submit(
                                                    Task::Download {
                                                        path: artifact_path(
                                                            &session_id,
                                                            &artifact.id,
                                                        ),
                                                        filename: artifact.text("path").into(),
                                                    },
                                                    Pending::Download,
                                                    ui.ctx(),
                                                );
                                                ui.close();
                                            }
                                        });
                                    });
                                }
                            });
                    });
            if escape && popup.is_some() {
                trigger.request_focus();
            }
        });
    }

    fn environment(&self, ui: &mut Ui, snapshot: &SessionSnapshot) {
        let Some(environment) = snapshot.session.fields.get("environment") else {
            return;
        };
        let kind = string(environment, "type");
        if kind == "none" || kind.is_empty() {
            return;
        }
        let id = string(environment, "id");
        egui::Frame::NONE.show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new("Environment").strong());
                let label = match kind.as_str() {
                    "openai_hosted" => "Rat Things managed",
                    "self_hosted" => "Connected worker",
                    _ => "Execution environment",
                };
                let response = ui
                    .label(label)
                    .on_hover_text(format!("Environment ID: {id}"));
                response.context_menu(|ui| {
                    if ui.button("Copy environment ID").clicked() {
                        ui.ctx().copy_text(id.clone());
                        ui.close();
                    }
                });
            });
            if snapshot.actions().iter().any(|action| {
                action.get("type").and_then(Value::as_str) == Some("environment_connection")
            }) {
                ui.label("Connect the executor to continue this session.");
                let command = format!("rat-things environments connect {id}");
                ui.horizontal_wrapped(|ui| {
                    ui.code(&command);
                    if ui.small_button("Copy connect command").clicked() {
                        ui.ctx().copy_text(command);
                    }
                });
            }
        });
    }

    fn transcript_item(&mut self, ui: &mut Ui, item: &Resource) {
        if item.text("type") != "message" {
            let kind = match item.text("type") {
                "function_call_output" => "Tool result".into(),
                "function_call" => "Tool call".into(),
                "command_execution" => "Command".into(),
                "reasoning" => "Reasoning".into(),
                "mcp_call" => "Connected tool".into(),
                other => other.replace('_', " "),
            };
            let title = if !item.text("name").is_empty() {
                item.text("name").to_owned()
            } else if !item.text("command").is_empty() {
                item.text("command").to_owned()
            } else {
                kind
            };
            ui.add_space(4.0);
            egui::CollapsingHeader::new(RichText::new(title).small().color(theme::MUTED))
                .id_salt(&item.id)
                .show(ui, |ui| json_view(ui, &item.value()));
            ui.add_space(4.0);
            return;
        }
        let is_user = item.text("role") == "user";
        let title = if item.text("type") == "message" {
            if is_user {
                "You"
            } else if item.text("phase") == "commentary" {
                "Agent · working"
            } else {
                "Agent"
            }
        } else {
            item.text("type")
        };
        let bounds_id = ui.make_persistent_id(("message-bounds", &item.id));
        let hovered = ui
            .ctx()
            .data(|data| data.get_temp::<egui::Rect>(bounds_id))
            .is_some_and(|rect| ui.rect_contains_pointer(rect));
        let frame = ui
            .push_id(("message-row", &item.id), |ui| {
                egui::Frame::new()
                    .fill(Color32::TRANSPARENT)
                    .corner_radius(8)
                    .inner_margin(egui::Margin::symmetric(2, 10))
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.horizontal(|ui| {
                            ui.label(
                                RichText::new(title.replace('_', " "))
                                    .size(11.0)
                                    .strong()
                                    .color(theme::MUTED),
                            );
                            if item.text("type") == "message" {
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        let copy = ui.add(
                                            egui::Button::new(
                                                RichText::new("Copy message")
                                                    .small()
                                                    .color(Color32::TRANSPARENT),
                                            )
                                            .frame(false),
                                        );
                                        if hovered || copy.has_focus() || copy.hovered() {
                                            ui.painter().text(
                                                copy.rect.center(),
                                                egui::Align2::CENTER_CENTER,
                                                "Copy message",
                                                egui::FontId::proportional(11.0),
                                                theme::MUTED,
                                            );
                                        }
                                        if copy.clicked() {
                                            let text = item
                                                .fields
                                                .get("content")
                                                .and_then(Value::as_array)
                                                .map(|parts| {
                                                    parts
                                                        .iter()
                                                        .filter_map(|part| {
                                                            part.get("text").and_then(Value::as_str)
                                                        })
                                                        .collect::<Vec<_>>()
                                                        .join("\n\n")
                                                })
                                                .unwrap_or_default();
                                            ui.ctx().copy_text(text);
                                        }
                                    },
                                );
                            }
                        });
                        if item.text("type") == "message" {
                            if let Some(parts) =
                                item.fields.get("content").and_then(Value::as_array)
                            {
                                for (index, part) in parts.iter().enumerate() {
                                    match part
                                        .get("type")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                    {
                                        "output_text" => {
                                            let source = string(part, "text");
                                            let key = format!("{}-{index}", item.id);
                                            let cached =
                                                self.rendered_markdown.entry(key).or_default();
                                            if cached.0 != source {
                                                *cached = (source.clone(), safe_markdown(&source));
                                            }
                                            ui.scope(|ui| {
                                                ui.style_mut().interaction.selectable_labels =
                                                    false;
                                                CommonMarkViewer::new()
                                                    .explicit_image_uri_scheme(true)
                                                    .show(ui, &mut self.markdown_cache, &cached.1);
                                            });
                                        }
                                        "input_text" => {
                                            ui.label(string(part, "text"));
                                        }
                                        "input_image" => {
                                            ui.label(
                                                RichText::new("Image input")
                                                    .italics()
                                                    .color(theme::MUTED),
                                            );
                                        }
                                        other => {
                                            ui.label(other.replace('_', " "));
                                        }
                                    }
                                }
                            }
                        } else {
                            let summary = if !item.text("name").is_empty() {
                                item.text("name")
                            } else if !item.text("command").is_empty() {
                                item.text("command")
                            } else {
                                item.text("type")
                            };
                            egui::CollapsingHeader::new(summary)
                                .id_salt(&item.id)
                                .show(ui, |ui| {
                                    json_view(ui, &item.value());
                                });
                        }
                    })
            })
            .inner;
        ui.ctx()
            .data_mut(|data| data.insert_temp(bounds_id, frame.response.rect));
        ui.add_space(12.0);
    }

    fn tool_result(&mut self, ui: &mut Ui, session_id: &str, action: &Value) {
        let call_id = string(action, "call_id");
        let name = string(action, "name");
        let mut send = None;
        theme::card().show(ui, |ui| {
            ui.label(RichText::new(format!("Function result needed: {name}")).strong());
            egui::CollapsingHeader::new(format!("Arguments for {name}")).id_salt((&call_id, "arguments")).show(ui, |ui| { json_view(ui, &action["arguments"]); });
            let draft = self.tool_drafts.entry((session_id.into(), call_id.clone())).or_default();
            let label_text = format!("Result for {name}");
            let label = ui.label(&label_text);
            let response = ui.add(TextEdit::multiline(&mut draft.text).id_salt((&call_id, "tool-output")).desired_rows(2).desired_width(f32::INFINITY)).labelled_by(label.id);
            response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::TextEdit, true, &label_text));
            ui.checkbox(&mut draft.failed, "Report as failed");
            if ui.add_enabled(self.mutation_pending.is_none(), egui::Button::new("Send tool result")).clicked() {
                let mut event = json!({"type": "agent.session.input.tool_result", "turn_id": action["turn_id"], "call_id": call_id, "success": !draft.failed});
                event[if draft.failed { "error" } else { "output" }] = draft.text.clone().into();
                send = Some(event);
            }
        });
        if let Some(event) = send {
            self.send_events(session_id, vec![event], None, Some(call_id), ui.ctx());
        }
    }

    fn send_events(
        &mut self,
        session_id: &str,
        events: Vec<Value>,
        sent_message: Option<String>,
        tool_call: Option<String>,
        ctx: &egui::Context,
    ) {
        self.error = None;
        self.mutation_pending = self.submit(
            Task::Mutation {
                path: format!("{}/events", Collection::Sessions.resource_path(session_id)),
                method: Method::POST,
                body: Some(Zeroizing::new(json!({"events": events}).to_string())),
                idempotency_key: Some(uuid::Uuid::new_v4().to_string()),
                secret: false,
            },
            Pending::Mutation(Effect::Event {
                session_id: session_id.into(),
                sent_message,
                tool_call,
            }),
            ctx,
        );
    }

    fn details(&mut self, ui: &mut Ui, resource: &Resource) {
        ui.horizontal_wrapped(|ui| {
            match self.collection {
                Collection::Agents | Collection::Templates => {
                    if ui.button(format!("Edit {}", self.collection.singular())).clicked() {
                        self.open_editor(format!("Edit {}", self.collection.singular()), resource.edit_body(self.collection), self.collection.resource_path(&resource.id), self.collection, Some(resource.id.clone()), false);
                    }
                    if ui.button("Start session").clicked() {
                        if self.collection == Collection::Agents { self.new_resource(Collection::Sessions, Some(&resource.id)); }
                        else {
                            self.new_resource(Collection::Sessions, None);
                            if let Some(editor) = &mut self.editor {
                                let mut value: Value = serde_json::from_str(&editor.draft).expect("new session draft");
                                value["environment"] = json!({"type":"openai_hosted", "environment_template_id":resource.id});
                                editor.draft = Zeroizing::new(pretty(&value));
                            }
                        }
                    }
                }
                Collection::Vaults => {
                    if ui.button("Add credential").clicked() {
                        self.open_editor("Add credential".into(), json!({"name": "MCP credential", "auth": {"type": "static_bearer", "mcp_server_url": "https://example.com/mcp", "token": ""}}), format!("{}/credentials", self.collection.resource_path(&resource.id)), self.collection, Some(resource.id.clone()), true);
                    }
                }
                Collection::Sessions => {}
            }
        });
        egui::ScrollArea::vertical()
            .id_salt(("details", &resource.id))
            .auto_shrink([false, false])
            .show(ui, |ui| {
                if self.collection == Collection::Vaults {
                    ui.add_space(8.0);
                    ui.label(RichText::new("Credentials").strong().size(14.0));
                    ui.label(
                        RichText::new(
                            "Secret values are write-only. Only credential metadata is shown.",
                        )
                        .small()
                        .color(theme::MUTED),
                    );
                    let request = self.pending.values().find(|pending| matches!(&pending.operation, Pending::Credentials { generation } if *generation == self.selection_generation));
                    if !self.credentials_loaded && request.is_some_and(PendingRequest::needs_feedback) {
                        ui.horizontal(|ui| { ui.spinner(); ui.label("Loading credentials…"); });
                    } else if self.credentials_loaded && self.credentials.is_empty() {
                        ui.label("No active credentials.");
                    }
                    for credential in self.credentials.clone() {
                        theme::card().show(ui, |ui| {
                            ui.label(RichText::new(credential.title()).strong());
                            let auth = credential
                                .fields
                                .get("auth")
                                .cloned()
                                .unwrap_or(Value::Null);
                            ui.label(
                                RichText::new(string(&auth, "type").replace('_', " "))
                                    .small()
                                    .color(theme::MUTED),
                            );
                            egui::CollapsingHeader::new(format!(
                                "Credential details: {}",
                                credential.title()
                            ))
                            .id_salt(&credential.id)
                            .show(ui, |ui| json_view(ui, &credential.value()));
                            ui.horizontal(|ui| {
                                if ui.button("Rotate credential").clicked() {
                                    let auth = if string(&auth, "type") == "static_bearer" {
                                        json!({"type": "static_bearer", "token": ""})
                                    } else {
                                        json!({"type": "mcp_oauth", "access_token": ""})
                                    };
                                    self.open_editor(
                                        "Rotate credential".into(),
                                        json!({"auth": auth}),
                                        format!(
                                            "{}/credentials/{}",
                                            Collection::Vaults.resource_path(&resource.id),
                                            path_segment(&credential.id)
                                        ),
                                        Collection::Vaults,
                                        Some(resource.id.clone()),
                                        true,
                                    );
                                }
                                if ui
                                    .add_enabled(
                                        self.mutation_pending.is_none(),
                                        egui::Button::new("Delete credential"),
                                    )
                                    .clicked()
                                {
                                    self.mutation_pending = self.submit(
                                        Task::Mutation {
                                            path: format!(
                                                "{}/credentials/{}",
                                                Collection::Vaults.resource_path(&resource.id),
                                                path_segment(&credential.id)
                                            ),
                                            method: Method::DELETE,
                                            body: None,
                                            idempotency_key: None,
                                            secret: true,
                                        },
                                        Pending::Mutation(Effect::CredentialDelete {
                                            vault_id: resource.id.clone(),
                                        }),
                                        ui.ctx(),
                                    );
                                }
                            });
                        });
                    }
                }
                if self.collection == Collection::Agents {
                    ui.add_space(20.0);
                    ui.label(RichText::new("Instructions").strong());
                    let instructions = resource.text("instructions");
                    ui.label(if instructions.is_empty() { "No instructions yet. Edit this agent to give it a role." } else { instructions });
                    ui.add_space(16.0);
                    let tools = resource.fields.get("tools").and_then(Value::as_array);
                    ui.label(RichText::new("Tools").strong());
                    if let Some(tools) = tools.filter(|tools| !tools.is_empty()) {
                        for tool in tools { ui.label(string(tool, "type").replace('_', " ")); }
                    } else { ui.label(RichText::new("No additional tools configured").color(theme::MUTED)); }
                }
                if self.collection == Collection::Templates {
                    ui.add_space(20.0);
                    ui.label(RichText::new("Network access").strong());
                    ui.label(resource.fields.get("network").map(|network| string(network, "access")).filter(|access| !access.is_empty()).unwrap_or_else(|| "disabled".into()));
                    ui.add_space(16.0);
                    ui.label(RichText::new("Packages").strong());
                    for kind in ["npm", "python", "system"] {
                        let packages = resource.fields.get("packages").and_then(|packages| packages.get(kind)).and_then(Value::as_array).map(|packages| packages.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                        if !packages.is_empty() { ui.label(format!("{kind}: {packages}")); }
                    }
                }
                ui.add_space(24.0);
                egui::CollapsingHeader::new("Resource JSON")
                    .id_salt((&resource.id, "resource-json"))
                    .default_open(false)
                    .show(ui, |ui| json_view(ui, &resource.value()));
            });
    }

    fn suspend_session_editor(&mut self) {
        if self.editor.as_ref().is_some_and(|editor| {
            editor.collection == Collection::Sessions && editor.select_id.is_none()
        }) {
            self.session_editor = self.editor.take();
        }
    }

    fn new_resource(&mut self, collection: Collection, agent_id: Option<&str>) {
        if collection == Collection::Sessions && agent_id.is_none() {
            if self
                .editor
                .as_ref()
                .is_some_and(|editor| editor.collection == Collection::Sessions)
            {
                return;
            }
            if self.session_editor.is_some() {
                self.editor = self.session_editor.take();
                return;
            }
        }
        self.open_editor(
            format!("New {}", collection.singular()),
            {
                let mut initial = collection.initial(agent_id);
                if collection == Collection::Sessions {
                    initial["input"] = "".into();
                    if agent_id.is_none() {
                        initial["agent"]["model"] = "".into();
                    }
                }
                if collection == Collection::Agents {
                    initial["name"] = "".into();
                    initial["model"] = "".into();
                    initial["instructions"] = "".into();
                }
                if collection == Collection::Vaults || collection == Collection::Templates {
                    initial["name"] = "".into();
                }
                initial
            },
            collection.path().into(),
            collection,
            None,
            false,
        );
    }

    fn open_editor(
        &mut self,
        title: String,
        initial: Value,
        path: String,
        collection: Collection,
        select_id: Option<String>,
        secret: bool,
    ) {
        self.next_editor_id += 1;
        self.editor = Some(Editor {
            id: self.next_editor_id,
            title,
            draft: Zeroizing::new(pretty(&initial)),
            path,
            collection,
            select_id,
            secret,
            advanced: false,
            models_requested: false,
            templates_requested: false,
            saved_model: initial
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned),
            form_inputs: HashMap::new(),
            error: None,
        });
    }

    fn close_editor(&mut self, ctx: &egui::Context) {
        if let Some(mut editor) = self.editor.take() {
            editor.clear(ctx);
        }
    }

    fn editor_window(&mut self, parent: &mut Ui, inline: bool) {
        let ctx = &parent.ctx().clone();
        if self.editor.as_ref().is_some_and(|editor| {
            editor.collection == Collection::Sessions && editor.select_id.is_none()
        }) != inline
        {
            return;
        }
        let Some(mut editor) = self.editor.take() else {
            return;
        };
        if !editor.models_requested
            && !editor.secret
            && matches!(editor.collection, Collection::Sessions | Collection::Agents)
        {
            self.refresh_models(ctx);
            editor.models_requested = true;
        }
        if !editor.templates_requested
            && editor.collection == Collection::Sessions
            && editor.select_id.is_none()
        {
            self.refresh_templates(ctx);
            editor.templates_requested = true;
        }
        let mut close = false;
        let mut submit = false;
        let busy = self.mutation_pending.is_some();
        let mut contents = |ui: &mut Ui| {
            if !inline {
                ui.set_width((ctx.content_rect().width() - 100.0).clamp(320.0, 650.0));
            } else {
                ui.add_space(20.0);
            }
            ui.heading(&editor.title);
            ui.label(RichText::new(if editor.secret { "Credentials stay private. Secret values cannot be read back." } else { match editor.collection {
                Collection::Sessions => "Give your agent a task. You can keep the conversation going as it works.",
                Collection::Agents => "Define a reusable agent for your team's work.",
                Collection::Templates => "Prepare the software and network access an agent needs.",
                Collection::Vaults => "A private home for the credentials your agents use.",
            }}).color(theme::MUTED));
            ui.add_space(12.0);
            egui::ScrollArea::vertical().id_salt("editor-scroll").max_height((ctx.content_rect().height() - 260.0).max(120.0)).show(ui, |ui| {
                ui.add_enabled_ui(!busy, |ui| {
                    if !editor.advanced {
                        match serde_json::from_str::<Value>(&editor.draft) {
                            Ok(mut value) if value.is_object() => {
                                if editor_form(ui, &mut editor, &mut value, &mut self.models, &mut self.environments) {
                                    editor.draft = Zeroizing::new(pretty(&value));
                                    editor.error = None;
                                }
                                zeroize_json(&mut value);
                            }
                            _ => { ui.colored_label(theme::ERROR, "Fix the configuration in Advanced JSON to return to the form."); }
                        }
                    }
                    ui.add_space(10.0);
                    ui.horizontal(|ui| {
                        let response = ui.add(egui::Button::new("    Advanced JSON").frame(false));
                        let center = egui::pos2(response.rect.left() + 10.0, response.rect.center().y);
                        let offsets = if editor.advanced { [(-4.0, -2.0), (4.0, -2.0), (0.0, 3.0)] } else { [(-2.0, -4.0), (-2.0, 4.0), (3.0, 0.0)] };
                        ui.painter().add(egui::Shape::convex_polygon(offsets.into_iter().map(|(x, y)| center + egui::vec2(x, y)).collect(), theme::MUTED, egui::Stroke::NONE));
                        response.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::Button, !busy, editor.advanced, "Advanced JSON"));
                        if response.clicked() { editor.advanced = !editor.advanced; editor.form_inputs.clear(); }
                        ui.label(RichText::new("Edit all fields").small().color(theme::MUTED));
                    });
                    if editor.advanced {
                        ui.label(RichText::new("All request fields. Changes are kept when you switch back to the form.").small().color(theme::MUTED));
                        let label = ui.label("Configuration JSON");
                        let widget_id = editor.widget_id();
                        let response = ui.add(TextEdit::multiline(&mut *editor.draft).id(widget_id).font(egui::TextStyle::Monospace).desired_rows(12).desired_width(f32::INFINITY).code_editor()).labelled_by(label.id);
                        response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::TextEdit, !busy, "Configuration JSON"));
                        if editor.secret && let Some(mut state) = egui::text_edit::TextEditState::load(ctx, response.id) { state.clear_undoer(); state.store(ctx, response.id); }
                    }
                });
            });
            ui.add_space(12.0);
            if let Some(error) = &editor.error {
                ui.colored_label(theme::ERROR, error);
            }
            ui.horizontal(|ui| {
                close = ui.add_enabled(!busy, egui::Button::new("Cancel")).clicked();
                if busy {
                    ui.spinner();
                    ui.label("Saving…");
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let label = if editor.title.starts_with("Edit ")
                        || editor.title == "Rotate credential"
                    {
                        "Save"
                    } else {
                        "Create"
                    };
                    submit = ui
                        .add_enabled(!busy, theme::primary_button(label))
                        .clicked();
                });
            });
        };
        if inline {
            contents(parent);
        } else {
            egui::Modal::new(egui::Id::new("resource-editor"))
                .frame(theme::card().inner_margin(24).corner_radius(8))
                .show(ctx, contents);
        }
        if self.environments.refresh_requested {
            self.refresh_templates(ctx);
        }
        if self.models.refresh_requested {
            self.refresh_models(ctx);
        }
        if ctx.input(|input| input.key_pressed(egui::Key::Escape)) && !busy {
            close = true;
        }
        if close {
            editor.clear(ctx);
            return;
        }
        if submit {
            match serde_json::from_str::<Value>(&editor.draft) {
                Err(error) => {
                    editor.error = Some(format!(
                        "Invalid JSON at line {}, column {}",
                        error.line(),
                        error.column()
                    ))
                }
                Ok(mut value) => {
                    editor.error = if !value.is_object() {
                        Some("Configuration must be a JSON object".into())
                    } else if value
                        .get("stream")
                        .is_some_and(|value| value != &Value::Bool(false))
                    {
                        Some("Omit stream from this request. The console refreshes saved session items automatically.".into())
                    } else if !editor.advanced {
                        form_error(editor.collection, editor.secret, &value).or_else(|| {
                            self.models
                                .validation_error(editor.collection, editor.secret, &value)
                        })
                    } else {
                        None
                    };
                    if editor.error.is_none() {
                        if editor.collection == Collection::Sessions && editor.select_id.is_none() {
                            name_session_request(&mut value);
                        }
                        let body = Zeroizing::new(value.to_string());
                        self.mutation_pending = self.submit(
                            Task::Mutation {
                                path: editor.path.clone(),
                                method: Method::POST,
                                body: Some(body),
                                idempotency_key: None,
                                secret: editor.secret,
                            },
                            Pending::Mutation(Effect::Editor {
                                editor_id: editor.id,
                                collection: editor.collection,
                                select_id: editor.select_id.clone(),
                            }),
                            ctx,
                        );
                        if self.mutation_pending.is_none() {
                            editor.error = self.error.take();
                        }
                    }
                    zeroize_json(&mut value);
                }
            }
        }
        self.editor = Some(editor);
    }

    fn delete_window(&mut self, ctx: &egui::Context) {
        let Some((collection, id, title)) = self.delete_confirmation.clone() else {
            return;
        };
        let mut close = false;
        egui::Modal::new(egui::Id::new("delete-resource")).show(ctx, |ui| {
            ui.set_width(380.0);
            ui.heading(format!("Delete {}?", collection.singular()));
            ui.label(&title);
            ui.label("This removes the resource from your workspace.");
            ui.horizontal(|ui| {
                if ui.button("Keep resource").clicked() {
                    close = true;
                }
                if ui
                    .add_enabled(
                        self.mutation_pending.is_none(),
                        egui::Button::new("Confirm delete").fill(Color32::from_rgb(94, 44, 47)),
                    )
                    .clicked()
                {
                    self.mutation_pending = self.submit(
                        Task::Mutation {
                            path: collection.resource_path(&id),
                            method: Method::DELETE,
                            body: None,
                            idempotency_key: None,
                            secret: false,
                        },
                        Pending::Mutation(Effect::Delete {
                            collection,
                            id: id.clone(),
                        }),
                        ctx,
                    );
                    close = true;
                }
            });
        });
        if close || ctx.input(|input| input.key_pressed(egui::Key::Escape)) {
            self.delete_confirmation = None;
        }
    }
}

impl eframe::App for ConsoleApp {
    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        self.show(ui);
    }
}

fn form_field(
    ui: &mut Ui,
    id: u64,
    value: &mut Value,
    path: &[&str],
    label: &str,
    multiline: bool,
    secret: bool,
) -> bool {
    let mut field = value
        .pointer(&format!("/{}", path.join("/")))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let label_response = ui.label(RichText::new(label).strong());
    let widget_id = egui::Id::new(("form-field", id, label));
    let edit = if multiline {
        TextEdit::multiline(&mut field).desired_rows(3)
    } else {
        TextEdit::singleline(&mut field)
    };
    let response = ui
        .add(
            edit.id(widget_id)
                .desired_width(f32::INFINITY)
                .password(secret)
                .hint_text(match label {
                    "Name" => "Give it a name",
                    "Model" => "Model ID",
                    "Task" => "What should the agent do?",
                    "Instructions" => "Describe its role and how it should work",
                    "Server URL" => "https://your-server.example/mcp",
                    "Secret value" => "Paste a token",
                    _ => "",
                })
                .margin(egui::vec2(10.0, 7.0)),
        )
        .labelled_by(label_response.id);
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::TextEdit, true, label));
    if secret && let Some(mut state) = egui::text_edit::TextEditState::load(ui.ctx(), response.id) {
        state.clear_undoer();
        state.store(ui.ctx(), response.id);
    }
    let changed = response.changed();
    if changed {
        set_field(value, path, Value::String(field.clone()));
    }
    field.zeroize();
    ui.add_space(4.0);
    changed
}

fn set_field(value: &mut Value, path: &[&str], field: Value) {
    if let Some((key, rest)) = path.split_first() {
        if !value.is_object() {
            *value = json!({});
        }
        if rest.is_empty() {
            value[*key] = field;
        } else {
            set_field(&mut value[*key], rest, field);
        }
    }
}

#[derive(Default)]
struct ModelPicker {
    catalog: Option<ModelCatalog>,
    error: Option<String>,
    loading: bool,
    started: Option<Instant>,
    refresh_requested: bool,
}

impl ModelPicker {
    fn field(
        &mut self,
        ui: &mut Ui,
        id: u64,
        value: &mut Value,
        path: &[&str],
        allow_default: bool,
    ) -> bool {
        let mut selected = value
            .pointer(&format!("/{}", path.join("/")))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let original = selected.clone();
        let choices = self
            .catalog
            .as_ref()
            .map(|catalog| catalog.data.as_slice())
            .unwrap_or_default();
        if allow_default
            && selected.is_empty()
            && let Some(default) = self
                .catalog
                .as_ref()
                .and_then(|catalog| catalog.default_model.as_ref())
                .filter(|default| choices.iter().any(|model| &model.id == *default))
        {
            selected.clone_from(default);
        }
        let label = ui
            .horizontal(|ui| {
                let label = ui.label(RichText::new("Model").strong());
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let label = if self.error.is_some() {
                        "Retry models"
                    } else {
                        "Refresh models"
                    };
                    if ui
                        .add_enabled(!self.loading, egui::Button::new(label).small())
                        .clicked()
                    {
                        self.refresh_requested = true;
                    }
                });
                label
            })
            .inner;
        let selected_text = choices
            .iter()
            .find(|model| model.id == selected)
            .map(|model| model.label())
            .unwrap_or(if selected.is_empty() {
                "Select a model"
            } else {
                &selected
            })
            .to_owned();
        let enabled = !choices.is_empty();
        let response = ui
            .add_enabled_ui(enabled, |ui| {
                egui::ComboBox::from_id_salt(("model-picker", id))
                    .selected_text(selected_text)
                    .truncate()
                    .width(ui.available_width())
                    .show_ui(ui, |ui| {
                        ui.style_mut().wrap_mode = Some(egui::TextWrapMode::Truncate);
                        for model in choices {
                            ui.selectable_value(&mut selected, model.id.clone(), model.label())
                                .on_hover_text(&model.id);
                        }
                    })
                    .response
            })
            .inner
            .labelled_by(label.id);
        response.widget_info(|| {
            egui::WidgetInfo::labeled(egui::WidgetType::ComboBox, enabled, "Model")
        });
        if self.loading
            && self
                .started
                .is_some_and(|started| started.elapsed() >= LOADING_FEEDBACK_DELAY)
        {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label(
                    RichText::new("Loading available models…")
                        .small()
                        .color(theme::MUTED),
                );
            });
        } else if let Some(error) = &self.error {
            ui.colored_label(theme::ERROR, "Could not load available models.")
                .on_hover_text(error);
        } else if self.catalog.is_some() && choices.is_empty() {
            ui.label(
                RichText::new("No models are available for this deployment.").color(theme::MUTED),
            );
        } else if !selected.is_empty() && !choices.iter().any(|model| model.id == selected) {
            ui.colored_label(theme::ERROR, "This saved model is not available in this deployment. Choose another model to continue.");
        }
        if original != selected {
            set_field(value, path, selected.into());
            true
        } else {
            false
        }
    }

    fn validation_error(
        &self,
        collection: Collection,
        secret: bool,
        value: &Value,
    ) -> Option<String> {
        let path = match collection {
            Collection::Agents if !secret => "/model",
            Collection::Sessions if !secret && value.get("agent_id").is_none() => "/agent/model",
            _ => return None,
        };
        if self.loading && self.catalog.is_none() {
            return Some("Wait for the available models to load.".into());
        }
        let Some(catalog) = &self.catalog else {
            return Some("Load the available models before continuing.".into());
        };
        let selected = value
            .pointer(path)
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !catalog.data.iter().any(|model| model.id == selected) {
            return Some("Choose a model available in this deployment.".into());
        }
        None
    }
}

fn editor_form(
    ui: &mut Ui,
    editor: &mut Editor,
    value: &mut Value,
    models: &mut ModelPicker,
    environments: &mut EnvironmentPicker,
) -> bool {
    let id = editor.id;
    let collection = editor.collection;
    let secret = editor.secret;
    let creating = editor.select_id.is_none();
    let form_inputs = &mut editor.form_inputs;
    let mut changed = false;
    if secret {
        if value.get("name").is_some() {
            changed |= form_field(ui, id, value, &["name"], "Name", false, false);
            changed |= form_field(
                ui,
                id,
                value,
                &["auth", "mcp_server_url"],
                "Server URL",
                false,
                false,
            );
        }
        let key = if value.pointer("/auth/type").and_then(Value::as_str) == Some("mcp_oauth") {
            "access_token"
        } else {
            "token"
        };
        changed |= form_field(ui, id, value, &["auth", key], "Secret value", false, true);
        return changed;
    }
    match collection {
        Collection::Sessions => {
            if creating {
                changed |= form_field(ui, id, value, &["input"], "Task", true, false);
            }
            if creating && value.get("agent_id").is_none() {
                ui.columns(2, |columns| {
                    changed |= models.field(&mut columns[0], id, value, &["agent", "model"], true);
                    changed |= environments.field(&mut columns[1], id, value);
                });
            } else {
                if value.get("agent_id").is_some() {
                    ui.label(
                        RichText::new("Using the selected agent's saved configuration")
                            .color(theme::MUTED),
                    );
                } else {
                    changed |= models.field(ui, id, value, &["agent", "model"], creating);
                }
                if creating {
                    changed |= environments.field(ui, id, value);
                }
            }
            egui::CollapsingHeader::new("Session options")
                .id_salt(("session-options", id))
                .show(ui, |ui| {
                    changed |=
                        form_field(ui, id, value, &["metadata", "name"], "Name", false, false);
                });
        }
        Collection::Agents => {
            if !creating
                && value.get("model").is_none()
                && let Some(model) = &editor.saved_model
            {
                value["model"] = model.clone().into();
                changed = true;
            }
            changed |= form_field(ui, id, value, &["name"], "Name", false, false);
            changed |= models.field(ui, id, value, &["model"], creating);
            changed |= form_field(
                ui,
                id,
                value,
                &["instructions"],
                "Instructions",
                true,
                false,
            );
        }
        Collection::Vaults => {
            changed |= form_field(ui, id, value, &["name"], "Name", false, false);
        }
        Collection::Templates => {
            changed |= form_field(ui, id, value, &["name"], "Name", false, false);
            let mut network = value
                .pointer("/network/access")
                .and_then(Value::as_str)
                .unwrap_or("disabled")
                .to_owned();
            ui.label(RichText::new("Network access").strong());
            egui::ComboBox::from_id_salt((id, "network-access"))
                .selected_text(&network)
                .show_ui(ui, |ui| {
                    for mode in ["disabled", "restricted", "enabled"] {
                        if ui
                            .selectable_value(&mut network, mode.into(), mode)
                            .changed()
                        {
                            set_field(value, &["network", "access"], mode.into());
                            changed = true;
                        }
                    }
                });
            if network == "restricted" {
                changed |= list_field(
                    ui,
                    id,
                    value,
                    &["network", "allowed_domains"],
                    "Allowed domains",
                    form_inputs,
                );
            }
            ui.add_space(8.0);
            changed |= list_field(
                ui,
                id,
                value,
                &["packages", "npm"],
                "npm packages",
                form_inputs,
            );
            changed |= list_field(
                ui,
                id,
                value,
                &["packages", "python"],
                "Python packages",
                form_inputs,
            );
            changed |= list_field(
                ui,
                id,
                value,
                &["packages", "system"],
                "System packages",
                form_inputs,
            );
        }
    }
    changed
}

fn list_field(
    ui: &mut Ui,
    id: u64,
    value: &mut Value,
    path: &[&str],
    label: &str,
    form_inputs: &mut HashMap<String, String>,
) -> bool {
    let text = form_inputs.entry(label.into()).or_insert_with(|| {
        value
            .pointer(&format!("/{}", path.join("/")))
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default()
    });
    let label_response = ui.label(RichText::new(label).strong());
    let response = ui
        .add(
            TextEdit::singleline(text)
                .id_salt(("form-field", id, label))
                .desired_width(f32::INFINITY)
                .hint_text("Separate with commas")
                .margin(egui::vec2(10.0, 7.0)),
        )
        .labelled_by(label_response.id);
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::TextEdit, true, label));
    if response.changed() {
        set_field(
            value,
            path,
            Value::Array(
                text.split(',')
                    .map(str::trim)
                    .filter(|part| !part.is_empty())
                    .map(|part| Value::String(part.into()))
                    .collect(),
            ),
        );
        true
    } else {
        false
    }
}

fn form_error(collection: Collection, secret: bool, value: &Value) -> Option<String> {
    let required: &[(&str, &str)] = if secret {
        if value.pointer("/auth/type").and_then(Value::as_str) == Some("mcp_oauth") {
            &[("/auth/access_token", "Secret value")]
        } else {
            &[("/auth/token", "Secret value")]
        }
    } else {
        match collection {
            Collection::Sessions if value.get("agent_id").is_some() => &[("/input", "Task")],
            Collection::Sessions => &[("/input", "Task"), ("/agent/model", "Model")],
            Collection::Agents => &[("/name", "Name"), ("/model", "Model")],
            Collection::Templates | Collection::Vaults => &[("/name", "Name")],
        }
    };
    required
        .iter()
        .find(|(path, _)| {
            value
                .pointer(path)
                .and_then(Value::as_str)
                .is_none_or(|text| text.trim().is_empty())
        })
        .map(|(_, label)| format!("Enter a {} to continue.", label.to_lowercase()))
}

fn json_view(ui: &mut Ui, value: &Value) {
    ui.add(egui::Label::new(RichText::new(pretty(value)).monospace().size(12.0)).wrap());
}

fn zeroize_json(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(items) => items.iter_mut().for_each(zeroize_json),
        Value::Object(fields) => fields.values_mut().for_each(zeroize_json),
        _ => {}
    }
}
