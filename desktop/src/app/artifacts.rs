use super::*;

pub(super) const PLAN_TAB_ID: &str = "__rat_things_plan";
const IMAGE_ZOOM_LEVELS: [f32; 4] = [1.0, 1.25, 1.5, 2.0];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum NarrowSessionPane {
    #[default]
    Conversation,
    Workspace,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum FeedbackFilter {
    #[default]
    Everyone,
    Mine,
}

#[derive(Default)]
struct PlanHistoryRead {
    loaded: bool,
    head_revision: u64,
    revisions: Vec<crate::model::SessionPlan>,
    next_after: Option<u64>,
    pending: Option<u64>,
    error: Option<String>,
}

#[derive(Default)]
pub(super) struct ArtifactWorkspace {
    pub(super) narrow_pane: NarrowSessionPane,
    pub(super) workspace_expanded: bool,
    pub(super) conversation_width: Option<f32>,
    pub(super) selected: Option<String>,
    pub(super) generation: u64,
    pub(super) pending: Option<u64>,
    settled_action: Option<(u64, Option<String>)>,
    feedback_confirmation: Option<FeedbackConfirmation>,
    texture: Option<egui::TextureHandle>,
    text: Option<String>,
    frame: Option<Value>,
    captured_frame: Option<Value>,
    capture: Option<String>,
    captured_source: Option<CapturedSource>,
    thread: Option<String>,
    anchor: Option<CapturedAnchor>,
    drag_start: Option<egui::Pos2>,
    annotating: bool,
    selecting_text: bool,
    reading_capture: Option<String>,
    reading_url: Option<String>,
    url: String,
    browser_text: String,
    next_frame: Option<Instant>,
    error: Option<String>,
    preview_failed: bool,
    show_resolved: bool,
    feedback_filter: FeedbackFilter,
    pub(super) selected_plan_item: Option<String>,
    show_plan_history: bool,
    selected_plan_revision: Option<u64>,
    plan_history: PlanHistoryRead,
    submission_keys: HashMap<String, String>,
    zoom_level: u8,
    actual_size: bool,
}
impl ArtifactWorkspace {
    pub(super) fn plan_selected(&self) -> bool {
        self.selected.as_deref() == Some(PLAN_TAB_ID)
    }

    pub(super) fn clear_selection(&mut self) {
        let generation = self.generation.wrapping_add(1);
        let submission_keys = std::mem::take(&mut self.submission_keys);
        *self = Self {
            generation,
            submission_keys,
            ..Self::default()
        };
    }
}
pub(super) enum ArtifactOperation {
    Preview,
    Frame {
        submission: Option<String>,
        typed: Option<String>,
    },
    Capture,
    Feedback {
        session: String,
        text: String,
        context: Box<CapturedContext>,
        reply_id: Option<String>,
        submission: String,
    },
    ThreadAction {
        submission: String,
        confirmation: FeedbackConfirmation,
    },
}

#[derive(Clone)]
pub(super) struct FeedbackConfirmation {
    session: String,
    source: Value,
    resolved: bool,
}

impl FeedbackConfirmation {
    fn visible(&self, session: &str, browser: bool, selected: Option<&str>) -> bool {
        self.session == session
            && if browser {
                self.source["kind"] == "browser"
            } else {
                self.source["kind"] == "artifact" && self.source["id"].as_str() == selected
            }
    }
}

fn fence_artifact_view(state: &mut ArtifactWorkspace) {
    state.generation = state.generation.wrapping_add(1);
    state.pending = None;
}

/// Project saved versions into file tabs without changing the selected version.
fn artifact_tabs<'a>(artifacts: &'a [Resource], selected: Option<&str>) -> Vec<&'a Resource> {
    let mut tabs: Vec<&Resource> = Vec::new();
    for artifact in artifacts {
        let path = artifact.text("path");
        let slot = tabs
            .iter()
            .position(|current| !path.is_empty() && current.text("path") == path);
        if let Some(index) = slot {
            let current = tabs[index];
            let created = |item: &Resource| {
                item.fields
                    .get("created_at")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            };
            if selected == Some(artifact.id.as_str())
                || (selected != Some(current.id.as_str()) && created(artifact) >= created(current))
            {
                tabs[index] = artifact;
            }
        } else {
            tabs.push(artifact);
        }
    }
    tabs
}

impl ConsoleApp {
    /// The latest settled user-directed operation, keyed independently of its resource.
    pub fn workspace_action_result(&self) -> Option<(u64, Option<String>)> {
        self.artifact_workspace.settled_action.clone()
    }

    /// A user-directed workspace operation is pending, excluding routine frame polling.
    pub fn workspace_action_pending(&self) -> bool {
        self.artifact_workspace.pending.is_some_and(|id| {
            self.pending
                .get(&id)
                .is_some_and(|request| match &request.operation {
                    Pending::Artifact {
                        operation:
                            ArtifactOperation::Frame {
                                submission: None, ..
                            },
                        ..
                    } => self.artifact_workspace.frame.is_none(),
                    Pending::Artifact { .. } => true,
                    _ => false,
                })
        })
    }

    fn cancel_anchor_selection(&mut self) {
        let capture_pending = self.artifact_workspace.pending.is_some_and(|request_id| {
            self.pending.get(&request_id).is_some_and(|request| {
                matches!(
                    &request.operation,
                    Pending::Artifact {
                        operation: ArtifactOperation::Capture,
                        ..
                    }
                )
            })
        });
        if capture_pending {
            self.artifact_workspace.generation = self.artifact_workspace.generation.wrapping_add(1);
            self.artifact_workspace.pending = None;
        }
        self.artifact_workspace.annotating = false;
        self.artifact_workspace.selecting_text = false;
        self.artifact_workspace.captured_source = None;
        self.artifact_workspace.capture = None;
        self.artifact_workspace.anchor = None;
    }

    pub(super) fn receive_artifact(
        &mut self,
        request: u64,
        operation: ArtifactOperation,
        result: Result<Data, String>,
        ctx: &egui::Context,
    ) {
        if self.artifact_workspace.pending != Some(request) {
            return;
        }
        if let ArtifactOperation::Feedback { session, .. } = &operation {
            self.collaboration
                .settle_contribution(session, request, &result);
        }
        let reports_outcome = !matches!(
            &operation,
            ArtifactOperation::Frame {
                submission: None,
                ..
            }
        ) || self.artifact_workspace.frame.is_none();
        if let Some(request) = self.artifact_workspace.pending.take()
            && reports_outcome
        {
            self.artifact_workspace.settled_action =
                Some((request, result.as_ref().err().cloned()));
        }
        self.artifact_workspace.next_frame = Some(Instant::now() + Duration::from_millis(500));
        if result.is_ok() {
            let submission = match &operation {
                ArtifactOperation::Frame { submission, .. } => submission.as_ref(),
                ArtifactOperation::Feedback { submission, .. } => Some(submission),
                ArtifactOperation::ThreadAction { submission, .. } => Some(submission),
                _ => None,
            };
            if let Some(submission) = submission {
                self.artifact_workspace.submission_keys.remove(submission);
            }
            if let ArtifactOperation::Frame {
                typed: Some(text), ..
            } = &operation
                && &self.artifact_workspace.browser_text == text
            {
                self.artifact_workspace.browser_text.clear();
            }
        }
        match result {
            Ok(Data::ArtifactPreview { image, text }) => {
                self.artifact_workspace.texture = image.map(|image| {
                    ctx.load_texture("artifact-preview", image, egui::TextureOptions::LINEAR)
                });
                self.artifact_workspace.text = text;
            }
            Ok(Data::Browser { value, image }) => {
                let frame = value.get("frame").unwrap_or(&value).clone();
                let texture =
                    ctx.load_texture("shared-browser", image, egui::TextureOptions::LINEAR);
                if matches!(&operation, ArtifactOperation::Capture) {
                    let id = value["id"].as_str().map(ToOwned::to_owned);
                    self.artifact_workspace.capture = id.clone();
                    self.artifact_workspace.captured_frame = Some(frame.clone());
                    self.artifact_workspace.captured_source = id.map(|id| CapturedSource {
                        kind: CapturedSourceKind::Browser,
                        id,
                        title: string(&frame, "title"),
                        url: Some(string(&frame, "url")),
                        version: Some(format!(
                            "{}:{}",
                            string(&frame, "epoch"),
                            frame["revision"].as_u64().unwrap_or_default()
                        )),
                        frame: Some(frame.clone()),
                        preview: Some(texture.clone()),
                    });
                    self.artifact_workspace.reading_capture = None;
                    self.artifact_workspace.reading_url = None;
                    self.artifact_workspace.annotating = true;
                }
                if self.artifact_workspace.reading_capture.is_none() {
                    self.artifact_workspace.texture = Some(texture);
                }
                self.artifact_workspace.url = string(&frame, "url");
                self.artifact_workspace.frame = Some(frame);
            }
            Ok(Data::Mutation(_)) => {
                if let ArtifactOperation::Feedback {
                    session,
                    text,
                    context,
                    reply_id,
                    ..
                } = operation
                {
                    self.collaboration.feedback_errors.remove(&session);
                    if self.messages.get(&session) == Some(&text) {
                        self.messages.remove(&session);
                    }
                    if self
                        .collaboration
                        .contexts
                        .get(&session)
                        .is_some_and(|current| current.id == context.id)
                    {
                        self.collaboration.contexts.remove(&session);
                    }
                    if self
                        .collaboration
                        .replies
                        .get(&session)
                        .map(|reply| reply.id.as_str())
                        == reply_id.as_deref()
                    {
                        self.collaboration.replies.remove(&session);
                    }
                    if self.selected_id.as_ref() == Some(&session) {
                        self.next_refresh = Instant::now();
                    }
                    self.artifact_workspace.anchor = None;
                } else if let ArtifactOperation::ThreadAction { confirmation, .. } = operation {
                    self.artifact_workspace.feedback_confirmation = Some(confirmation);
                    self.next_refresh = Instant::now();
                }
            }
            Err(error) => {
                self.artifact_workspace.preview_failed =
                    matches!(operation, ArtifactOperation::Preview);
                if let ArtifactOperation::Feedback { session, .. } = operation {
                    self.collaboration.feedback_errors.insert(session, error);
                } else {
                    self.artifact_workspace.error = Some(error);
                }
                self.artifact_workspace.next_frame = Some(Instant::now() + Duration::from_secs(3));
            }
            _ => {}
        }
    }

    fn artifact_request(&mut self, task: Task, operation: ArtifactOperation, ctx: &egui::Context) {
        if matches!(
            &operation,
            ArtifactOperation::Feedback { .. } | ArtifactOperation::ThreadAction { .. }
        ) && self.artifact_workspace.pending.is_some()
            && self.artifact_mutation_ready()
        {
            // A routine frame read must not consume a feedback contribution.
            fence_artifact_view(&mut self.artifact_workspace);
        }
        if self.artifact_workspace.pending.is_some() {
            return;
        }
        self.artifact_workspace.error = None;
        self.artifact_workspace.preview_failed = false;
        let contribution = match &operation {
            ArtifactOperation::Feedback { session, .. } => Some(session.clone()),
            _ => None,
        };
        if let Some(session) = &contribution {
            self.collaboration.submissions.remove(session);
        }
        let pending = Pending::Artifact {
            session_generation: self.selection_generation,
            generation: self.artifact_workspace.generation,
            operation,
        };
        self.artifact_workspace.pending = self.submit(task, pending, ctx);
        if let Some(session) = contribution
            && let Some(request) = self.artifact_workspace.pending
        {
            self.collaboration.submissions.insert(
                session,
                ContributionReceipt {
                    request,
                    kind: ContributionKind::Feedback,
                    outcome: SaveOutcome::Saving,
                },
            );
        }
    }

    fn select_artifact(&mut self, id: String, session: &str, ctx: &egui::Context) {
        if self.artifact_workspace.selected.as_ref() == Some(&id) {
            return;
        }
        let state = &mut self.artifact_workspace;
        state.selected = Some(id.clone());
        fence_artifact_view(state);
        state.zoom_level = 0;
        state.actual_size = false;
        state.texture = None;
        state.text = None;
        state.frame = None;
        state.captured_frame = None;
        state.capture = None;
        state.captured_source = None;
        state.anchor = None;
        state.thread = None;
        state.annotating = false;
        state.selecting_text = false;
        state.reading_capture = None;
        state.reading_url = None;
        state.error = None;
        state.next_frame = None;
        if id != "browser" {
            self.artifact_request(
                Task::ArtifactPreview {
                    path: artifact_path(session, &id),
                },
                ArtifactOperation::Preview,
                ctx,
            );
        }
    }

    pub(super) fn receive_plan_history(&mut self, request_id: u64, result: Result<Data, String>) {
        if self.artifact_workspace.plan_history.pending != Some(request_id) {
            return;
        }
        let history = &mut self.artifact_workspace.plan_history;
        history.pending = None;
        match result {
            Ok(Data::PlanRevisions(value)) => {
                let revisions = serde_json::from_value::<Vec<crate::model::SessionPlan>>(
                    value["revisions"].clone(),
                );
                match revisions {
                    Ok(revisions) => {
                        history.head_revision = value["head_revision"]
                            .as_u64()
                            .unwrap_or(history.head_revision);
                        history.next_after = value["next_after"].as_u64();
                        history.revisions.extend(revisions);
                        history.revisions.sort_by_key(|revision| revision.revision);
                        history.revisions.dedup_by_key(|revision| revision.revision);
                        history.loaded = true;
                        history.error = None;
                    }
                    Err(_) => history.error = Some("The Plan history response is invalid.".into()),
                }
            }
            Err(error) => history.error = Some(error),
            _ => history.error = Some("Could not read the Plan history.".into()),
        }
    }

    fn plan_history_request(&mut self, session: &str, after: u64, ctx: &egui::Context) {
        if self.artifact_workspace.plan_history.pending.is_some() {
            return;
        }
        let path = format!(
            "/api/v1/rat/sessions/{}/plan/revisions?after={after}&limit=20",
            path_segment(session)
        );
        match self.worker.submit(Task::PlanRevisions { path }, ctx) {
            Ok(id) => {
                self.pending.insert(
                    id,
                    PendingRequest::new(Pending::PlanHistory {
                        session_generation: self.selection_generation,
                    }),
                );
                self.artifact_workspace.plan_history.pending = Some(id);
                self.artifact_workspace.plan_history.error = None;
            }
            Err(error) => self.artifact_workspace.plan_history.error = Some(error),
        }
    }

    pub(super) fn artifact_mutation_ready(&self) -> bool {
        self.artifact_workspace.pending.is_none() || self.browser_controls_ready()
    }

    fn browser_controls_ready(&self) -> bool {
        self.artifact_workspace.frame.is_some()
            && self.artifact_workspace.pending.is_none_or(|id| {
                matches!(
                    self.pending.get(&id).map(|request| &request.operation),
                    Some(Pending::Artifact {
                        operation: ArtifactOperation::Frame {
                            submission: None,
                            ..
                        },
                        ..
                    })
                )
            })
    }

    fn browser_request(&mut self, session: &str, operation: Option<Value>, ctx: &egui::Context) {
        if let Some(pending) = self.artifact_workspace.pending {
            let refreshing = matches!(
                self.pending.get(&pending).map(|request| &request.operation),
                Some(Pending::Artifact {
                    operation: ArtifactOperation::Frame {
                        submission: None,
                        ..
                    },
                    ..
                })
            );
            if operation.is_none() || !refreshing {
                return;
            }
            // A read must not consume an explicit interaction. Ignore its late
            // response and send the action against the frame the user saw.
            // The server still fences that original epoch/revision.
            self.artifact_workspace.generation += 1;
            self.artifact_workspace.pending = None;
        }
        let typed = operation
            .as_ref()
            .filter(|op| op["action"] == "type")
            .and_then(|op| op["text"].as_str())
            .map(ToOwned::to_owned);
        let body = operation.map(|operation| {
            let frame = self
                .artifact_workspace
                .frame
                .as_ref()
                .unwrap_or(&Value::Null);
            json!({"operation":operation,"epoch":frame["epoch"],"revision":frame["revision"]})
        });
        let submission = body
            .as_ref()
            .map(|body| workspace_submission_key(session, &body.to_string()));
        let key = body.as_ref().map(|body| {
            self.artifact_workspace
                .submission_keys
                .entry(workspace_submission_key(session, &body.to_string()))
                .or_insert_with(|| uuid::Uuid::new_v4().to_string())
                .clone()
        });
        self.artifact_request(
            Task::Browser {
                path: format!(
                    "/api/v1/rat/sessions/{}/workspace/browser",
                    path_segment(session)
                ),
                body,
                key,
            },
            ArtifactOperation::Frame { submission, typed },
            ctx,
        );
    }

    pub(super) fn artifact_workspace(
        &mut self,
        ui: &mut Ui,
        snapshot: &SessionSnapshot,
        expandable: bool,
    ) {
        let session = snapshot.session.id.clone();
        if self.artifact_workspace.selected.is_none() {
            let initial = if snapshot.browser_available {
                Some("browser".to_owned())
            } else {
                snapshot
                    .artifacts
                    .first()
                    .map(|artifact| artifact.id.clone())
            }
            .or_else(|| snapshot.plan.as_ref().map(|_| PLAN_TAB_ID.to_owned()));
            if let Some(initial) = initial {
                if initial == "browser" {
                    self.artifact_workspace.selected = Some(initial);
                    self.artifact_workspace.next_frame = Some(Instant::now());
                } else if initial == PLAN_TAB_ID {
                    self.artifact_workspace.selected = Some(initial);
                } else {
                    self.select_artifact(initial, &session, ui.ctx());
                }
            }
        }

        ui.horizontal_wrapped(|ui| {
            if snapshot.browser_available
                && ui
                    .selectable_label(
                        self.artifact_workspace.selected.as_deref() == Some("browser"),
                        "Browser",
                    )
                    .clicked()
            {
                self.select_artifact("browser".into(), &session, ui.ctx());
                self.artifact_workspace.reading_capture = None;
            }
            for artifact in artifact_tabs(
                &snapshot.artifacts,
                self.artifact_workspace.selected.as_deref(),
            ) {
                let label = crate::api::safe_filename(artifact.text("path"));
                if ui
                    .selectable_label(
                        self.artifact_workspace.selected.as_ref() == Some(&artifact.id),
                        label,
                    )
                    .on_hover_text(artifact.text("path"))
                    .clicked()
                {
                    self.select_artifact(artifact.id.clone(), &session, ui.ctx());
                }
            }
            if snapshot.plan.is_some()
                && ui
                    .selectable_label(
                        self.artifact_workspace.selected.as_deref() == Some(PLAN_TAB_ID),
                        "Plan",
                    )
                    .clicked()
            {
                self.artifact_workspace.selected = Some(PLAN_TAB_ID.into());
                self.artifact_workspace.selected_plan_item = None;
            }
            if expandable && icons::button(ui, Icon::Expand, "Expand workspace").clicked() {
                self.artifact_workspace.workspace_expanded = true;
                self.artifact_workspace.narrow_pane = NarrowSessionPane::Workspace;
            }
        });
        ui.separator();

        if self.artifact_workspace.selected.as_deref() == Some(PLAN_TAB_ID) {
            self.plan_workspace(ui, snapshot);
            return;
        }
        let Some(selected) = self.artifact_workspace.selected.clone() else {
            self.workspace_empty(ui, snapshot);
            return;
        };
        let browser = selected == "browser";
        let threads: Vec<_> = snapshot
            .workspace_threads
            .iter()
            .filter(|thread| {
                let target = &thread["target"];
                (if browser {
                    target["kind"] == "browser"
                } else {
                    target["id"].as_str() == Some(&selected)
                }) && (self.artifact_workspace.show_resolved || thread["resolved"] != true)
                    && (self.artifact_workspace.feedback_filter == FeedbackFilter::Everyone
                        || self.is_current_participant(
                            thread["comments"]
                                .as_array()
                                .map(Vec::as_slice)
                                .unwrap_or(&[]),
                        ))
            })
            .cloned()
            .collect();

        if browser && self.artifact_workspace.reading_capture.is_some() {
            ui.horizontal(|ui| {
                let moved = capture_has_moved(
                    self.artifact_workspace.captured_frame.as_ref(),
                    self.artifact_workspace.frame.as_ref(),
                    self.artifact_workspace.reading_url.as_deref(),
                    &self.artifact_workspace.url,
                );
                ui.label(
                    RichText::new(if moved {
                        "Capture · live browser moved"
                    } else {
                        "Saved capture"
                    })
                    .small()
                    .color(theme::MUTED),
                );
                if let Some(frame) = &self.artifact_workspace.captured_frame {
                    ui.label(
                        RichText::new(browser_size_label(frame))
                            .small()
                            .color(theme::MUTED),
                    );
                }
                if icons::object_button(ui, Icon::Back, "Live", "Return to live").clicked() {
                    self.artifact_workspace.reading_capture = None;
                    self.artifact_workspace.reading_url = None;
                    self.artifact_workspace.capture = None;
                    self.artifact_workspace.captured_source = None;
                    self.artifact_workspace.thread = None;
                    self.artifact_workspace.frame = None;
                    self.artifact_workspace.texture = None;
                    self.artifact_workspace.annotating = false;
                    self.artifact_workspace.anchor = None;
                    self.artifact_workspace.next_frame = Some(Instant::now());
                }
            });
        }
        self.artifact_controls(ui, &session, browser);
        let preview_viewport_width = ui.available_width();
        egui::ScrollArea::vertical()
            .id_salt(("shared-workspace", &session))
            .auto_shrink([false, false])
            .show(ui, |ui| {
                self.artifact_preview(ui, &session, &threads, browser, preview_viewport_width);
                if browser {
                    self.artifact_feedback_list(ui, &session, &threads, true);
                } else {
                    self.artifact_feedback_list(ui, &session, &threads, false);
                }
            });

        if browser
            && !self.artifact_workspace.annotating
            && self.artifact_workspace.pending.is_none()
            && self
                .artifact_workspace
                .next_frame
                .is_none_or(|due| Instant::now() >= due)
        {
            self.browser_request(&session, None, ui.ctx());
        }
    }

    fn workspace_empty(&self, ui: &mut Ui, snapshot: &SessionSnapshot) {
        ui.add_space(24.0);
        ui.label(
            RichText::new(
                if snapshot.artifacts.is_empty() && !snapshot.browser_available {
                    "No shared workspace yet."
                } else {
                    "Choose a workspace item."
                },
            )
            .color(theme::MUTED),
        );
    }

    fn is_current_participant(&self, comments: &[Value]) -> bool {
        let identity = self
            .workspace
            .as_ref()
            .and_then(|workspace| {
                self.team
                    .connections
                    .iter()
                    .find(|connection| connection["id"] == workspace["connection_id"])
            })
            .map(|connection| &connection["identity"]);
        identity.is_some_and(|identity| {
            comments.iter().any(|comment| {
                let actor = &comment["actor"];
                identity["issuer"].is_string()
                    && identity["issuer"] == actor["issuer"]
                    && identity["subject"] == actor["subject"]
            })
        })
    }

    pub(super) fn plan_summary(&mut self, ui: &mut Ui, snapshot: &SessionSnapshot) {
        let Some(plan) = snapshot.plan.as_ref() else {
            return;
        };
        let addressed = plan
            .items
            .iter()
            .filter(|item| item.state == crate::model::SessionPlanState::Addressed)
            .count();
        let label = if plan.items.is_empty() {
            "Plan · No items yet".to_owned()
        } else {
            format!("Plan · {addressed} of {} addressed", plan.items.len())
        };
        let button = egui::Button::new(RichText::new(label).small().color(theme::TEXT))
            .min_size(egui::vec2(0.0, 28.0));
        if ui
            .add(button)
            .on_hover_text("Open the agent’s current Plan")
            .clicked()
        {
            self.artifact_workspace.selected = Some(PLAN_TAB_ID.into());
            self.artifact_workspace.selected_plan_item = None;
            self.artifact_workspace.narrow_pane = NarrowSessionPane::Workspace;
        }
    }

    fn plan_workspace(&mut self, ui: &mut Ui, snapshot: &SessionSnapshot) {
        let Some(plan) = snapshot.plan.as_ref() else {
            ui.label(RichText::new("No Plan has been published yet.").color(theme::MUTED));
            return;
        };
        let history_view = self.artifact_workspace.show_plan_history;
        let selected_revision = self.artifact_workspace.selected_plan_revision;
        let revision = selected_revision
            .and_then(|revision| {
                self.artifact_workspace
                    .plan_history
                    .revisions
                    .iter()
                    .find(|entry| entry.revision == revision)
            })
            .unwrap_or(plan)
            .clone();
        let addressed = revision
            .items
            .iter()
            .filter(|item| item.state == crate::model::SessionPlanState::Addressed)
            .count();
        ui.horizontal(|ui| {
            ui.label(RichText::new("Plan").font(theme::semibold(16.0)));
            ui.label(
                RichText::new(format!(
                    "Revision {} · {addressed} of {} addressed",
                    revision.revision,
                    revision.items.len()
                ))
                .small()
                .color(theme::MUTED),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if history_view {
                    if icons::object_button(ui, Icon::Back, "Plan", "Current Plan").clicked() {
                        self.artifact_workspace.show_plan_history = false;
                        self.artifact_workspace.selected_plan_revision = None;
                        self.artifact_workspace.selected_plan_item = None;
                    }
                } else if icons::button(ui, Icon::History, "History").clicked() {
                    self.artifact_workspace.show_plan_history = true;
                    if !self.artifact_workspace.plan_history.loaded
                        && self.artifact_workspace.plan_history.pending.is_none()
                    {
                        self.plan_history_request(&snapshot.session.id, 0, ui.ctx());
                    }
                }
            });
        });
        ui.label(
            RichText::new("Updated by the agent")
                .small()
                .color(theme::MUTED),
        );
        ui.add_space(8.0);
        if history_view {
            self.plan_history_view(ui, snapshot);
            return;
        }
        if revision.items.is_empty() {
            ui.add_space(12.0);
            ui.label(RichText::new("No Plan items yet.").color(theme::MUTED));
            return;
        }
        egui::ScrollArea::vertical()
            .id_salt(("plan-items", revision.revision))
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for item in &revision.items {
                    self.plan_item_row(ui, snapshot, item);
                    ui.add_space(6.0);
                }
            });
    }

    fn plan_item_row(
        &mut self,
        ui: &mut Ui,
        snapshot: &SessionSnapshot,
        item: &crate::model::SessionPlanItem,
    ) {
        let selected =
            self.artifact_workspace.selected_plan_item.as_deref() == Some(item.id.as_str());
        egui::Frame::new()
            .fill(if selected {
                theme::SURFACE
            } else {
                theme::BACKGROUND
            })
            .corner_radius(7)
            .show(ui, |ui| {
                let icon = if selected {
                    Icon::ChevronDown
                } else {
                    Icon::ChevronRight
                };
                let mut title = icons::text(icon, &item.text);
                if !selected {
                    let format = egui::TextFormat {
                        font_id: theme::medium(11.0),
                        color: plan_state_color(item.state),
                        ..Default::default()
                    };
                    title.append("\n", 0.0, format.clone());
                    title.append(item.state.label(), 24.0, format);
                }
                let row = ui.add_sized(
                    egui::vec2(ui.available_width(), if selected { 36.0 } else { 48.0 }),
                    egui::Button::new(title).wrap().frame(false).right_text(""),
                );
                row.widget_info(|| {
                    egui::WidgetInfo::selected(egui::Role::Button, true, selected, &item.text)
                });
                if row.clicked() {
                    self.artifact_workspace.selected_plan_item = if selected {
                        None
                    } else {
                        Some(item.id.clone())
                    };
                }
                if self.artifact_workspace.selected_plan_item.as_deref() == Some(item.id.as_str()) {
                    egui::Frame::new()
                        .inner_margin(egui::Margin {
                            left: 36,
                            right: 12,
                            top: 2,
                            bottom: 12,
                        })
                        .show(ui, |ui| {
                            self.plan_item_detail(ui, snapshot, item);
                        });
                }
            });
    }

    fn plan_item_detail(
        &mut self,
        ui: &mut Ui,
        snapshot: &SessionSnapshot,
        item: &crate::model::SessionPlanItem,
    ) {
        ui.vertical(|ui| {
            let state = match item.state {
                crate::model::SessionPlanState::Addressed => "Agent addressed",
                crate::model::SessionPlanState::Deferred => "Agent deferred",
                _ => item.state.label(),
            };
            ui.label(RichText::new(state).small().color(theme::MUTED));
            if let Some(reason) = &item.reason
                && !reason.trim().is_empty()
            {
                ui.label(reason);
            }
            if !item.source_refs.is_empty() {
                ui.add_space(6.0);
                ui.label(RichText::new("Sources").small().color(theme::MUTED));
                for source in &item.source_refs {
                    let label = snapshot
                        .actor_labels
                        .get(&source.message_id)
                        .map(String::as_str)
                        .unwrap_or("Conversation message");
                    let excerpt = snapshot
                        .items
                        .iter()
                        .find(|message| message.id == source.message_id)
                        .map(message_text)
                        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
                        .filter(|text| !text.is_empty())
                        .map(|text| text.chars().take(56).collect::<String>());
                    let source_label = excerpt
                        .map(|excerpt| format!("{label} · “{excerpt}”"))
                        .unwrap_or_else(|| label.to_owned());
                    let color = snapshot
                        .actor_colors
                        .get(&source.message_id)
                        .map(|color| theme::participant_color(color))
                        .unwrap_or(theme::MUTED);
                    let accessible = format!("{source_label} · open message");
                    let mut text = egui::text::LayoutJob::default();
                    text.append(
                        label,
                        0.0,
                        egui::TextFormat {
                            font_id: theme::medium(12.0),
                            color,
                            ..Default::default()
                        },
                    );
                    if let Some(excerpt) = source_label.strip_prefix(&format!("{label} · ")) {
                        text.append(
                            &format!("\n{excerpt}"),
                            0.0,
                            egui::TextFormat {
                                font_id: egui::FontId::proportional(13.0),
                                color: theme::TEXT,
                                ..Default::default()
                            },
                        );
                    }
                    let source_button = ui.add_sized(
                        egui::vec2(ui.available_width(), 0.0),
                        egui::Button::new(text).wrap().right_text(
                            RichText::new(Icon::Forward.glyph())
                                .font(icons::font(18.0))
                                .color(theme::MUTED),
                        ),
                    );

                    source_button.widget_info(|| {
                        egui::WidgetInfo::labeled(
                            egui::Role::Button,
                            source_button.enabled(),
                            &accessible,
                        )
                    });
                    if source_button.on_hover_text("Show message").clicked() {
                        self.collaboration.scroll_target = Some(source.message_id.clone());
                        self.artifact_workspace.narrow_pane = NarrowSessionPane::Conversation;
                        self.artifact_workspace.workspace_expanded = false;
                    }
                }
            }
            if !item.result_links.is_empty() {
                ui.add_space(6.0);
                ui.label(RichText::new("Result").small().color(theme::MUTED));
                for link in &item.result_links {
                    match link {
                        crate::model::PlanResultLink::Artifact { artifact_id, .. } => {
                            let title = snapshot
                                .artifacts
                                .iter()
                                .find(|artifact| artifact.id == *artifact_id)
                                .map(|artifact| crate::api::safe_filename(artifact.text("path")))
                                .unwrap_or_else(|| "Saved artifact".into());
                            if icons::object_button(
                                ui,
                                Icon::File,
                                &title,
                                &format!("Open {title}"),
                            )
                            .clicked()
                            {
                                self.artifact_workspace.selected_plan_item = None;
                                self.artifact_workspace.narrow_pane = NarrowSessionPane::Workspace;
                                self.select_artifact(
                                    artifact_id.clone(),
                                    &snapshot.session.id,
                                    ui.ctx(),
                                );
                            }
                        }
                        crate::model::PlanResultLink::Activity { item_id, .. } => {
                            if icons::button(ui, Icon::Comment, "Open activity").clicked() {
                                self.collaboration.scroll_target = Some(item_id.clone());
                                self.artifact_workspace.narrow_pane =
                                    NarrowSessionPane::Conversation;
                                self.artifact_workspace.workspace_expanded = false;
                            }
                        }
                    }
                }
            }
            ui.add_space(8.0);
            if self.can_contribute()
                && icons::object_button(ui, Icon::Reply, "Reply", "Follow up in conversation")
                    .clicked()
            {
                let session = snapshot.session.id.clone();
                let draft = self.messages.entry(session.clone()).or_default();
                if draft.is_empty() {
                    *draft = format!("Following up on Plan item “{}”", item.text);
                }
                self.collaboration.focus_composer = true;
                self.artifact_workspace.narrow_pane = NarrowSessionPane::Conversation;
                self.artifact_workspace.workspace_expanded = false;
            }
        });
    }

    fn plan_history_view(&mut self, ui: &mut Ui, snapshot: &SessionSnapshot) {
        let history = &self.artifact_workspace.plan_history;
        let head_revision = history.head_revision;
        let loaded = history.loaded;
        let pending = history.pending;
        let error = history.error.clone();
        let revisions = history.revisions.clone();
        let next_after = history.next_after;
        ui.label(
            RichText::new(format!("Revision history · head {head_revision}"))
                .small()
                .color(theme::MUTED),
        );
        let mut retry = false;
        if let Some(error) = error.as_deref() {
            ui.colored_label(theme::ERROR, error);
            retry =
                pending.is_none() && icons::button(ui, Icon::Refresh, "Retry history").clicked();
        }
        if !loaded && pending.is_none() && error.is_none() {
            ui.label(
                RichText::new("Loading Plan history…")
                    .small()
                    .color(theme::MUTED),
            );
        }
        let mut load_after = None;
        egui::ScrollArea::vertical()
            .id_salt("plan-history")
            .show(ui, |ui| {
                for entry in &revisions {
                    if ui
                        .selectable_label(
                            self.artifact_workspace.selected_plan_revision == Some(entry.revision),
                            format!("Revision {}", entry.revision),
                        )
                        .clicked()
                    {
                        self.artifact_workspace.selected_plan_revision = Some(entry.revision);
                        self.artifact_workspace.selected_plan_item = None;
                    }
                }
                if let Some(after) = next_after
                    && ui
                        .add_enabled(pending.is_none(), egui::Button::new("Load older revisions"))
                        .clicked()
                {
                    load_after = Some(after);
                }
            });
        if retry {
            self.artifact_workspace.plan_history.loaded = false;
            if let Some(session) = self.selected_id.clone() {
                self.plan_history_request(&session, 0, ui.ctx());
            }
        } else if let Some(after) = load_after
            && let Some(session) = self.selected_id.clone()
        {
            self.plan_history_request(&session, after, ui.ctx());
        }
        if revisions.is_empty() && loaded {
            ui.label(
                RichText::new("No earlier Plan revisions.")
                    .small()
                    .color(theme::MUTED),
            );
        }
        if let Some(revision) = self
            .artifact_workspace
            .selected_plan_revision
            .and_then(|selected| revisions.iter().find(|entry| entry.revision == selected))
            .cloned()
        {
            ui.separator();
            ui.label(
                RichText::new(format!("Revision {} items", revision.revision))
                    .font(theme::semibold(14.0)),
            );
            if revision.items.is_empty() {
                ui.label(
                    RichText::new("No Plan items in this revision.")
                        .small()
                        .color(theme::MUTED),
                );
            }
            for item in &revision.items {
                self.plan_item_row(ui, snapshot, item);
            }
        }
    }

    fn artifact_controls(&mut self, ui: &mut Ui, session: &str, browser: bool) {
        let reading_capture = self.artifact_workspace.reading_capture.is_some();
        let contributor = self.can_contribute();
        if self.artifact_workspace.annotating
            && ui.input_mut(|input| input.consume_key(egui::Modifiers::NONE, egui::Key::Escape))
        {
            self.cancel_anchor_selection();
        }
        if browser && !reading_capture {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                ui.add_enabled_ui(
                    contributor
                        && !self.artifact_workspace.annotating
                        && self.browser_controls_ready()
                        && self.artifact_workspace.frame.is_some(),
                    |ui| {
                        if icons::toolbar_button(ui, true, None, Icon::Back, "Back").clicked() {
                            self.browser_request(session, Some(json!({"action":"back"})), ui.ctx());
                        }
                        if icons::toolbar_button(ui, true, None, Icon::Refresh, "Reload").clicked()
                        {
                            self.browser_request(
                                session,
                                Some(json!({"action":"reload"})),
                                ui.ctx(),
                            );
                        }
                        let address = ui.add_sized(
                            egui::vec2((ui.available_width() - 38.0).max(40.0), 30.0),
                            egui::TextEdit::singleline(&mut self.artifact_workspace.url),
                        );
                        address.widget_info(|| {
                            egui::WidgetInfo::labeled(
                                egui::Role::TextInput,
                                address.enabled(),
                                "Address",
                            )
                        });
                        let navigate = address.lost_focus()
                            && ui.input(|input| input.key_pressed(egui::Key::Enter));
                        if icons::toolbar_button(ui, true, None, Icon::Forward, "Go").clicked()
                            || navigate
                        {
                            self.browser_request(
                                session,
                                Some(
                                    json!({"action":"navigate","url":self.artifact_workspace.url}),
                                ),
                                ui.ctx(),
                            );
                        }
                    },
                );
            });
        }
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            if contributor && !reading_capture {
                let selecting = self.artifact_workspace.annotating;
                let text_mode = self.artifact_workspace.selecting_text;
                let ready = !browser || self.artifact_workspace.frame.is_some();
                if icons::toolbar_button(
                    ui,
                    ready,
                    Some(selecting && !text_mode),
                    Icon::Annotate,
                    "Annotate",
                )
                .clicked()
                {
                    if selecting {
                        self.cancel_anchor_selection();
                    } else {
                        self.start_anchor_selection(session, browser, false, ui.ctx());
                    }
                }
                let can_select_text = if browser {
                    self.artifact_workspace
                        .captured_frame
                        .as_ref()
                        .or(self.artifact_workspace.frame.as_ref())
                        .is_some_and(|frame| !string(frame, "text").is_empty())
                } else {
                    self.artifact_workspace
                        .text
                        .as_ref()
                        .is_some_and(|text| !text.is_empty())
                };
                if can_select_text
                    && icons::toolbar_button(
                        ui,
                        !selecting || text_mode,
                        Some(selecting && text_mode),
                        Icon::SelectText,
                        "Select text",
                    )
                    .clicked()
                {
                    if selecting {
                        self.cancel_anchor_selection();
                    } else {
                        self.start_anchor_selection(session, browser, true, ui.ctx());
                    }
                }
                if !browser
                    && !selecting
                    && self.artifact_workspace.texture.is_none()
                    && self.artifact_workspace.text.is_none()
                    && icons::toolbar_button(ui, true, None, Icon::Attach, "Attach whole file")
                        .clicked()
                {
                    self.artifact_workspace.captured_source = Some(self.artifact_source(session));
                    self.set_captured_context(session, CapturedAnchor::Item);
                }
                if selecting {
                    if icons::toolbar_button(ui, true, None, Icon::Close, "Cancel selection")
                        .clicked()
                    {
                        self.cancel_anchor_selection();
                    }
                } else if browser {
                    icons::menu(ui, Icon::Keyboard, "Browser controls", |ui| {
                        self.browser_input_controls(ui, session);
                    });
                    for (icon, label, delta) in [
                        (Icon::Up, "Scroll up", -500),
                        (Icon::Down, "Scroll down", 500),
                    ] {
                        if icons::toolbar_button(
                            ui,
                            self.browser_controls_ready(),
                            None,
                            icon,
                            label,
                        )
                        .clicked()
                        {
                            self.browser_request(
                                session,
                                Some(json!({"action":"scroll","x":0.5,"y":0.5,"delta_y":delta})),
                                ui.ctx(),
                            );
                        }
                    }
                }
            }
            if browser && !reading_capture && !self.artifact_workspace.annotating {
                let dimensions =
                    self.artifact_workspace.frame.as_ref().and_then(|frame| {
                        Some((frame["width"].as_u64()?, frame["height"].as_u64()?))
                    });
                ui.separator();
                for (icon, label, width, height) in [
                    (Icon::Desktop, "Desktop viewport", 1280, 800),
                    (Icon::Phone, "Phone viewport", 390, 844),
                ] {
                    if icons::toolbar_button(
                        ui,
                        contributor && self.browser_controls_ready() && dimensions.is_some(),
                        Some(dimensions == Some((width, height))),
                        icon,
                        label,
                    )
                    .on_hover_text(format!(
                        "{label} · {width} × {height} · Shared with everyone"
                    ))
                    .clicked()
                        && dimensions != Some((width, height))
                    {
                        self.browser_request(
                            session,
                            Some(json!({"action":"resize","width":width,"height":height})),
                            ui.ctx(),
                        );
                    }
                }
            }
            if self.artifact_workspace.texture.is_some() {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    self.artifact_zoom_controls(ui);
                });
            }
        });
        if browser
            && !reading_capture
            && let Some(frame) = &self.artifact_workspace.frame
        {
            ui.horizontal_wrapped(|ui| {
                ui.label(
                    RichText::new(browser_view_label(frame))
                        .small()
                        .color(theme::MUTED),
                );
                if let Some(action) = browser_action_label(frame) {
                    ui.label(RichText::new(action).small().color(theme::MUTED));
                }
            });
        }
        if self.artifact_workspace.annotating {
            let guidance = if browser && self.artifact_workspace.captured_source.is_none() {
                "Capturing page…"
            } else if self.artifact_workspace.selecting_text {
                "Select text to quote."
            } else {
                "Click an element or drag a region."
            };
            ui.label(RichText::new(guidance).small().color(theme::MUTED));
        }
        if browser {
            ui.ctx().request_repaint_after(Duration::from_millis(500));
        }
        self.artifact_status(ui, session, browser);
        ui.add_space(6.0);
    }

    fn artifact_zoom_controls(&mut self, ui: &mut Ui) {
        let zoom = usize::from(self.artifact_workspace.zoom_level).min(IMAGE_ZOOM_LEVELS.len() - 1);
        if icons::toolbar_button(
            ui,
            zoom > 0 || self.artifact_workspace.actual_size,
            None,
            Icon::Fit,
            "Reset zoom",
        )
        .clicked()
        {
            self.artifact_workspace.zoom_level = 0;
            self.artifact_workspace.actual_size = false;
        }
        let actual = ui
            .selectable_label(self.artifact_workspace.actual_size, "1:1")
            .on_hover_text("Actual size · one page pixel per screen point");
        actual.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, "Actual size"));
        if actual.clicked() {
            self.artifact_workspace.actual_size = !self.artifact_workspace.actual_size;
            self.artifact_workspace.zoom_level = 0;
        }
        if icons::toolbar_button(
            ui,
            zoom + 1 < IMAGE_ZOOM_LEVELS.len(),
            None,
            Icon::ZoomIn,
            "Zoom in",
        )
        .clicked()
        {
            self.artifact_workspace.zoom_level = (zoom + 1) as u8;
        }
        ui.add_sized(
            egui::vec2(38.0, 30.0),
            egui::Label::new(
                RichText::new(if self.artifact_workspace.actual_size {
                    ["100%", "125%", "150%", "200%"][zoom]
                } else {
                    ["Fit", "1.25×", "1.5×", "2×"][zoom]
                })
                .small()
                .color(theme::MUTED),
            ),
        );
        if icons::toolbar_button(ui, zoom > 0, None, Icon::ZoomOut, "Zoom out").clicked() {
            self.artifact_workspace.zoom_level = (zoom - 1) as u8;
        }
    }

    fn browser_input_controls(&mut self, ui: &mut Ui, session: &str) {
        ui.set_width(280.0);
        ui.label(RichText::new("Browser controls").font(theme::semibold(13.0)));
        ui.label(
            RichText::new("Select a field on the page, then type.")
                .small()
                .color(theme::MUTED),
        );
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            let input = ui.add_sized(
                egui::vec2(216.0, 30.0),
                egui::TextEdit::singleline(&mut self.artifact_workspace.browser_text)
                    .hint_text("Text to enter…"),
            );
            input.widget_info(|| {
                egui::WidgetInfo::labeled(egui::Role::TextInput, true, "Browser text")
            });
            if ui
                .add_enabled(
                    self.browser_controls_ready()
                        && !self.artifact_workspace.browser_text.is_empty(),
                    egui::Button::new("Type"),
                )
                .clicked()
            {
                let text = self.artifact_workspace.browser_text.clone();
                self.browser_request(
                    session,
                    Some(json!({"action":"type","text":text})),
                    ui.ctx(),
                );
            }
        });
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            for key in ["Enter", "Tab", "Backspace"] {
                if ui
                    .add_enabled(self.browser_controls_ready(), egui::Button::new(key))
                    .clicked()
                {
                    self.browser_request(
                        session,
                        Some(json!({"action":"key","key":key})),
                        ui.ctx(),
                    );
                }
            }
        });
    }

    fn start_anchor_selection(
        &mut self,
        session: &str,
        browser: bool,
        selecting_text: bool,
        ctx: &egui::Context,
    ) {
        if browser {
            if self.artifact_workspace.reading_capture.is_some() {
                return;
            }
            if let Some(request_id) = self.artifact_workspace.pending {
                let read_refresh = self.pending.get(&request_id).is_some_and(|request| {
                    matches!(
                        &request.operation,
                        Pending::Artifact {
                            operation: ArtifactOperation::Frame {
                                submission: None,
                                ..
                            },
                            ..
                        }
                    )
                });
                if read_refresh || !self.pending.contains_key(&request_id) {
                    fence_artifact_view(&mut self.artifact_workspace);
                } else {
                    self.artifact_workspace.error = Some(
                        "Wait for the current browser action to finish before capturing this page."
                            .into(),
                    );
                    return;
                }
            }
        }
        self.artifact_workspace.annotating = true;
        self.artifact_workspace.selecting_text = selecting_text;
        self.artifact_workspace.anchor = None;
        self.artifact_workspace.thread = None;
        if browser {
            self.artifact_workspace.captured_source = None;
            self.artifact_workspace.captured_frame = None;
            self.artifact_workspace.capture = None;
            self.artifact_workspace.reading_capture = None;
            self.artifact_workspace.reading_url = None;
            let Some(frame) = self.artifact_workspace.frame.clone() else {
                self.artifact_workspace.annotating = false;
                self.artifact_workspace.error =
                    Some("Wait for the live browser frame before annotating.".into());
                return;
            };
            self.artifact_request(
                Task::Browser {
                    path: format!(
                        "/api/v1/rat/sessions/{}/workspace/browser/capture",
                        path_segment(session)
                    ),
                    body: Some(json!({"frame_id":frame["frame_id"]})),
                    key: None,
                },
                ArtifactOperation::Capture,
                ctx,
            );
        } else {
            self.artifact_workspace.captured_source = Some(self.artifact_source(session));
            if self.artifact_workspace.texture.is_none() && self.artifact_workspace.text.is_none() {
                self.set_captured_context(session, CapturedAnchor::Item);
            }
        }
    }

    fn artifact_source(&self, session: &str) -> CapturedSource {
        let id = self.artifact_workspace.selected.clone().unwrap_or_default();
        let title = self
            .snapshot
            .as_ref()
            .filter(|snapshot| snapshot.session.id == session)
            .and_then(|snapshot| snapshot.artifacts.iter().find(|artifact| artifact.id == id))
            .map(|artifact| artifact.text("path").to_owned())
            .unwrap_or_else(|| id.clone());
        CapturedSource {
            kind: CapturedSourceKind::Artifact,
            id,
            title,
            url: None,
            version: None,
            frame: None,
            preview: self.artifact_workspace.texture.clone(),
        }
    }

    fn set_captured_context(&mut self, session: &str, anchor: CapturedAnchor) {
        let Some(source) = self.artifact_workspace.captured_source.clone() else {
            self.artifact_workspace.error =
                Some("Capture the source before adding context.".into());
            self.artifact_workspace.annotating = false;
            return;
        };
        let context = CapturedContext::new(source, anchor.clone());
        self.collaboration
            .contexts
            .insert(session.to_owned(), context);
        self.artifact_workspace.anchor = Some(anchor);
        self.artifact_workspace.annotating = false;
        self.artifact_workspace.selecting_text = false;
        self.collaboration.focus_composer = true;
        self.artifact_workspace.narrow_pane = NarrowSessionPane::Conversation;
        self.artifact_workspace.workspace_expanded = false;
        self.artifact_workspace.error = None;
    }

    pub(super) fn send_context_message(
        &mut self,
        session: &str,
        text: String,
        ctx: &egui::Context,
    ) {
        if !self.can_contribute() || text.trim().is_empty() {
            return;
        }
        let Some(context) = self.collaboration.contexts.get(session).cloned() else {
            return;
        };
        self.collaboration.feedback_errors.remove(session);
        let reply_id = self
            .collaboration
            .replies
            .get(session)
            .map(|reply| reply.id.clone());
        let mut body = json!({
            "action":"comment",
            "text":text,
            "target":context.feedback_target(),
        });
        if let Some(reply_id) = &reply_id {
            body["reply_to"] = reply_id.clone().into();
        }
        self.collaboration.last_edit = None;
        let body = body.to_string();
        let submission = workspace_submission_key(session, &body);
        let key = self
            .artifact_workspace
            .submission_keys
            .entry(submission.clone())
            .or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        self.artifact_request(
            Task::Mutation {
                path: format!(
                    "/api/v1/rat/sessions/{}/workspace/feedback",
                    path_segment(session)
                ),
                method: Method::POST,
                body: Some(Zeroizing::new(body)),
                idempotency_key: Some(key),
                secret: false,
            },
            ArtifactOperation::Feedback {
                session: session.into(),
                text,
                context: Box::new(context),
                reply_id,
                submission,
            },
            ctx,
        );
    }

    pub(super) fn open_workspace_source(
        &mut self,
        session: &str,
        source: &Value,
        ctx: &egui::Context,
    ) {
        let thread_id = string(source, "thread_id");
        let thread = json!({"id":thread_id,"target":source["target"]});
        self.open_annotation(session, &thread, ctx);
        self.artifact_workspace.narrow_pane = NarrowSessionPane::Workspace;
    }

    pub(super) fn open_captured_context(
        &mut self,
        session: &str,
        context: &CapturedContext,
        ctx: &egui::Context,
    ) {
        let browser = context.source.kind == CapturedSourceKind::Browser;
        let state = &mut self.artifact_workspace;
        fence_artifact_view(state);
        state.texture = None;
        state.text = None;
        state.error = None;
        state.preview_failed = false;
        state.next_frame = None;
        state.selected = Some(if browser {
            "browser".into()
        } else {
            context.source.id.clone()
        });
        state.thread = None;
        state.capture = browser.then(|| context.source.id.clone());
        state.reading_capture = browser.then(|| context.source.id.clone());
        state.reading_url = context.source.url.clone();
        state.captured_source = Some(context.source.clone());
        state.captured_frame = context.source.frame.clone();
        state.anchor = Some(context.anchor.clone());
        state.annotating = false;
        state.selecting_text = false;
        state.texture = context.source.preview.clone();
        if browser {
            state.text = context
                .source
                .frame
                .as_ref()
                .and_then(|frame| frame["text"].as_str().map(ToOwned::to_owned));
        }
        state.narrow_pane = NarrowSessionPane::Workspace;
        if state.texture.is_none() && !browser {
            self.artifact_request(
                Task::ArtifactPreview {
                    path: artifact_path(session, &context.source.id),
                },
                ArtifactOperation::Preview,
                ctx,
            );
        }
    }

    fn open_annotation(&mut self, session: &str, thread: &Value, ctx: &egui::Context) {
        let target = &thread["target"];
        let browser = target["kind"] == "browser";
        let target_id = string(target, "id");
        let thread_id = string(thread, "id");
        let state = &mut self.artifact_workspace;
        state.selected = Some(if browser {
            "browser".into()
        } else {
            target_id.clone()
        });
        state.thread = Some(thread_id.clone());
        state.anchor = Some(captured_anchor_from_value(&target["anchor"]));
        state.captured_source = Some(CapturedSource {
            kind: if browser {
                CapturedSourceKind::Browser
            } else {
                CapturedSourceKind::Artifact
            },
            id: target_id.clone(),
            title: string(target, "title"),
            url: target["url"].as_str().map(ToOwned::to_owned),
            version: target["version"].as_str().map(ToOwned::to_owned),
            frame: None,
            preview: None,
        });
        state.annotating = false;
        state.selecting_text = false;
        state.frame = None;
        state.captured_frame = None;
        state.text = None;
        state.texture = None;
        state.capture = browser.then(|| target_id.clone());
        state.reading_capture = browser.then(|| target_id.clone());
        state.reading_url = browser.then(|| string(target, "url"));
        state.generation += 1;
        state.pending = None;
        state.error = None;
        if browser || target["image_available"] == true {
            self.artifact_request(
                Task::ArtifactPreview {
                    path: annotation_image_path(session, &thread_id),
                },
                ArtifactOperation::Preview,
                ctx,
            );
        } else {
            state.selected = Some(target_id.clone());
            self.artifact_request(
                Task::ArtifactPreview {
                    path: artifact_path(session, &target_id),
                },
                ArtifactOperation::Preview,
                ctx,
            );
        }
    }

    fn artifact_status(&mut self, ui: &mut Ui, session: &str, browser: bool) {
        if let Some(error) = &self.artifact_workspace.error {
            ui.colored_label(theme::ERROR, error);
            if self.artifact_workspace.pending.is_none()
                && self.artifact_workspace.preview_failed
                && icons::button(ui, Icon::Refresh, "Retry preview").clicked()
            {
                let path = if browser {
                    self.artifact_workspace
                        .thread
                        .as_deref()
                        .map(|id| annotation_image_path(session, id))
                } else {
                    self.artifact_workspace
                        .selected
                        .as_deref()
                        .map(|id| artifact_path(session, id))
                };
                if let Some(path) = path {
                    self.artifact_request(
                        Task::ArtifactPreview { path },
                        ArtifactOperation::Preview,
                        ui.ctx(),
                    );
                }
            }
        }
        if self
            .artifact_workspace
            .pending
            .is_some_and(|id| self.loading_is_slow(Some(id)))
        {
            ui.horizontal(|ui| {
                ui.spinner();
                let label = if self.artifact_workspace.texture.is_none()
                    && self.artifact_workspace.text.is_none()
                {
                    "Loading preview…"
                } else if browser && self.workspace_action_pending() {
                    "Updating browser…"
                } else {
                    "Refreshing preview…"
                };
                ui.label(RichText::new(label).small().color(theme::MUTED));
            });
        }
    }

    fn artifact_preview(
        &mut self,
        ui: &mut Ui,
        session: &str,
        threads: &[Value],
        browser: bool,
        viewport_width: f32,
    ) {
        if let Some(texture) = self.artifact_workspace.texture.clone() {
            let size = texture.size_vec2();
            let viewport_width = viewport_width
                .min(ui.available_width())
                .min(ui.clip_rect().width());
            let max_height = (ui.available_height() - 96.0).clamp(180.0, 720.0);
            let zoom = IMAGE_ZOOM_LEVELS
                .get(usize::from(self.artifact_workspace.zoom_level))
                .copied()
                .unwrap_or(1.0);
            let scale = preview_scale(
                size,
                viewport_width,
                max_height,
                self.artifact_workspace.actual_size,
            ) * zoom;
            let image_size = size * scale;
            let image_output = egui::ScrollArea::horizontal()
                .id_salt((
                    "artifact-image-zoom",
                    session,
                    self.artifact_workspace.selected.as_deref(),
                ))
                .auto_shrink([true, true])
                .show(ui, |ui| {
                    ui.set_width(image_size.x);
                    ui.add(
                        egui::Image::new((texture.id(), image_size))
                            .sense(egui::Sense::click_and_drag()),
                    )
                });
            let response = image_output.inner;
            let image_viewport = image_output.inner_rect;
            let overlay_painter = ui.painter().with_clip_rect(image_viewport);
            let normalized = |point: egui::Pos2| {
                egui::pos2(
                    ((point.x - response.rect.left()) / response.rect.width()).clamp(0.0, 1.0),
                    ((point.y - response.rect.top()) / response.rect.height()).clamp(0.0, 1.0),
                )
            };
            if self.artifact_workspace.annotating
                && self.artifact_workspace.captured_source.is_some()
                && !self.artifact_workspace.selecting_text
            {
                if response.drag_started()
                    && response
                        .interact_pointer_pos()
                        .is_some_and(|position| image_viewport.contains(position))
                {
                    self.artifact_workspace.drag_start = ui
                        .input(|input| input.pointer.press_origin())
                        .filter(|position| image_viewport.contains(*position))
                        .map(normalized);
                }
                if response.drag_stopped()
                    && let (Some(start), Some(end)) = (
                        self.artifact_workspace.drag_start.take(),
                        response
                            .interact_pointer_pos()
                            .filter(|position| image_viewport.contains(*position))
                            .map(normalized),
                    )
                {
                    let width = (start.x - end.x).abs();
                    let height = (start.y - end.y).abs();
                    if width > 0.002 && height > 0.002 {
                        self.set_captured_context(
                            session,
                            CapturedAnchor::Region {
                                x: start.x.min(end.x),
                                y: start.y.min(end.y),
                                width,
                                height,
                            },
                        );
                    }
                } else if response.clicked()
                    && let Some(point) = response
                        .interact_pointer_pos()
                        .filter(|position| image_viewport.contains(*position))
                        .map(normalized)
                {
                    let anchor = if browser {
                        element_at(
                            self.artifact_workspace
                                .captured_frame
                                .as_ref()
                                .or(self.artifact_workspace.frame.as_ref()),
                            point,
                        )
                        .map(|element| {
                            let bounds = element.bounds();
                            CapturedAnchor::BrowserElement {
                                id: element.id,
                                bounds: Some(bounds),
                            }
                        })
                        .unwrap_or(CapturedAnchor::Point {
                            x: point.x,
                            y: point.y,
                        })
                    } else {
                        CapturedAnchor::Point {
                            x: point.x,
                            y: point.y,
                        }
                    };
                    self.set_captured_context(session, anchor);
                }
            } else if browser
                && self.artifact_workspace.reading_capture.is_none()
                && !self.artifact_workspace.annotating
                && self.can_contribute()
                && response.clicked()
                && let Some(point) = response
                    .interact_pointer_pos()
                    .filter(|position| image_viewport.contains(*position))
                    .map(normalized)
            {
                self.browser_request(
                    session,
                    Some(json!({"action":"click","x":point.x,"y":point.y})),
                    ui.ctx(),
                );
            }
            let visible_capture = visible_browser_capture(
                self.artifact_workspace.reading_capture.as_deref(),
                self.artifact_workspace.annotating,
                self.artifact_workspace.capture.as_deref(),
            );
            let current_capture_threads = threads
                .iter()
                .enumerate()
                .filter(|(_, thread)| {
                    !browser
                        || visible_capture
                            .is_some_and(|capture| thread["target"]["id"].as_str() == Some(capture))
                })
                .collect::<Vec<_>>();
            for cluster in pin_clusters(&current_capture_threads, response.rect) {
                overlay_painter.circle_filled(cluster.position, 12.0, cluster.color);
                overlay_painter.text(
                    cluster.position,
                    egui::Align2::CENTER_CENTER,
                    cluster.indices.len().to_string(),
                    egui::FontId::proportional(11.0),
                    theme::BACKGROUND,
                );
                let cluster_hit =
                    egui::Rect::from_center_size(cluster.position, egui::vec2(24.0, 24.0))
                        .intersect(image_viewport);
                if cluster_hit.is_positive()
                    && ui
                        .interact(
                            cluster_hit,
                            ui.scope_id()
                                .with(("annotation-cluster", cluster.indices[0])),
                            egui::Sense::click(),
                        )
                        .clicked()
                {
                    let (_, thread) = current_capture_threads[cluster.indices[0]];
                    self.open_annotation(session, thread, ui.ctx());
                }
            }
            let saved_anchor_visible = self.artifact_workspace.reading_capture.is_some()
                || self
                    .artifact_workspace
                    .captured_source
                    .as_ref()
                    .is_some_and(|source| {
                        source.kind == CapturedSourceKind::Artifact
                            && self.artifact_workspace.selected.as_deref()
                                == Some(source.id.as_str())
                    });
            if (self.artifact_workspace.annotating || saved_anchor_visible)
                && let Some(anchor) = &self.artifact_workspace.anchor
            {
                paint_anchor(&overlay_painter, response.rect, anchor);
            }
            if browser
                && self.artifact_workspace.annotating
                && self.artifact_workspace.selecting_text
                && let Some(text) = self
                    .artifact_workspace
                    .captured_frame
                    .as_ref()
                    .and_then(|frame| frame["text"].as_str())
            {
                self.select_text_anchor(ui, session, text.to_owned());
            }
        } else if let Some(text) = self.artifact_workspace.text.clone() {
            if self.artifact_workspace.selecting_text {
                self.select_text_anchor(ui, session, text);
            } else {
                egui::ScrollArea::vertical()
                    .max_height(280.0)
                    .show(ui, |ui| {
                        ui.add(egui::Label::new(&text).selectable(true).wrap());
                    });
            }
        } else if self.artifact_workspace.preview_failed {
            ui.label(
                RichText::new("Preview unavailable.")
                    .small()
                    .color(theme::MUTED),
            );
        }
    }

    fn select_text_anchor(&mut self, ui: &mut Ui, session: &str, source: String) {
        let mut displayed = ReadOnlyText(source.clone());
        let output = egui::TextEdit::multiline(&mut displayed)
            .desired_rows(7)
            .desired_width(f32::INFINITY)
            .id_salt((
                "captured-text",
                session,
                self.artifact_workspace.selected.as_deref(),
            ))
            .show(ui);
        output.response.widget_info(|| {
            egui::WidgetInfo::labeled(egui::Role::TextInput, false, "Captured source text")
        });
        let anchor = output.cursor_range.and_then(|range| {
            let range = range.as_sorted_char_range();
            selected_text_anchor(&source, range.start.0..range.end.0)
        });
        ui.horizontal(|ui| {
            if let Some(anchor) = anchor
                && icons::button(ui, Icon::Attach, "Attach selected text").clicked()
            {
                self.set_captured_context(session, anchor);
            }
        });
    }

    fn artifact_feedback_list(
        &mut self,
        ui: &mut Ui,
        session: &str,
        threads: &[Value],
        browser: bool,
    ) {
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new("Feedback").font(theme::semibold(13.0)));
            ui.selectable_value(
                &mut self.artifact_workspace.feedback_filter,
                FeedbackFilter::Everyone,
                "Everyone",
            );
            ui.selectable_value(
                &mut self.artifact_workspace.feedback_filter,
                FeedbackFilter::Mine,
                "Mine",
            );
            ui.checkbox(&mut self.artifact_workspace.show_resolved, "Resolved");
        });
        let pending_confirmation = self
            .artifact_workspace
            .pending
            .and_then(|id| self.pending.get(&id))
            .and_then(|request| match &request.operation {
                Pending::Artifact {
                    operation: ArtifactOperation::ThreadAction { confirmation, .. },
                    ..
                } => Some(confirmation.clone()),
                _ => None,
            });
        let saving = pending_confirmation.is_some();
        if let Some(confirmation) = pending_confirmation
            .as_ref()
            .or(self.artifact_workspace.feedback_confirmation.as_ref())
            .filter(|confirmation| {
                confirmation.visible(
                    session,
                    browser,
                    self.artifact_workspace.selected.as_deref(),
                )
            })
            .cloned()
        {
            ui.horizontal(|ui| {
                confirmation_label(
                    ui,
                    match (saving, confirmation.resolved) {
                        (true, true) => "Resolving…",
                        (true, false) => "Reopening…",
                        (false, true) => "Feedback resolved",
                        (false, false) => "Feedback reopened",
                    },
                    theme::TEXT,
                );
                if !saving && confirmation.resolved && !self.artifact_workspace.show_resolved {
                    let show = ui
                        .small_button("Show resolved")
                        .on_hover_text("Show resolved feedback");
                    show.widget_info(|| {
                        egui::WidgetInfo::labeled(
                            egui::Role::Button,
                            true,
                            "Show resolved feedback",
                        )
                    });
                    if show.clicked() {
                        self.artifact_workspace.show_resolved = true;
                        self.artifact_workspace.feedback_filter = FeedbackFilter::Everyone;
                    }
                }
                if !saving
                    && icons::button(ui, Icon::Close, "Dismiss feedback confirmation").clicked()
                {
                    self.artifact_workspace.feedback_confirmation = None;
                }
            });
        }
        if threads.is_empty() {
            ui.label(
                RichText::new(
                    if self.artifact_workspace.feedback_filter == FeedbackFilter::Mine {
                        "No feedback from you on this source."
                    } else if self.artifact_workspace.show_resolved {
                        "No feedback on this source."
                    } else {
                        "No open feedback."
                    },
                )
                .small()
                .color(theme::MUTED),
            );
        }
        for (index, thread) in threads.iter().enumerate() {
            let id = string(thread, "id");
            egui::Frame::new()
                .fill(theme::SURFACE)
                .stroke(egui::Stroke::new(1.0, theme::BORDER))
                .corner_radius(6)
                .inner_margin(8)
                .show(ui, |ui| {
                    let comments = thread["comments"].as_array().cloned().unwrap_or_default();
                    let author = comments
                        .first()
                        .map(|comment| {
                            let actor = &comment["actor"];
                            actor["label"]
                                .as_str()
                                .or(actor["subject"].as_str())
                                .or(actor["id"].as_str())
                                .unwrap_or("Participant")
                        })
                        .unwrap_or("Participant");
                    let color = comments
                        .first()
                        .and_then(|comment| comment["participant"]["color"].as_str())
                        .map(theme::participant_color)
                        .unwrap_or(theme::MUTED);
                    ui.horizontal(|ui| {
                        ui.colored_label(color, format!("● {author}"));
                        ui.label(
                            RichText::new(if thread["resolved"] == true {
                                "Resolved"
                            } else {
                                "Open"
                            })
                            .small()
                            .color(theme::MUTED),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if icons::button(ui, Icon::Image, "Open source").clicked() {
                                self.open_annotation(session, thread, ui.ctx());
                            }
                            if self.can_contribute()
                                && ui
                                    .add_enabled(
                                        self.artifact_mutation_ready(),
                                        egui::Button::new(if thread["resolved"] == true {
                                            "Reopen"
                                        } else {
                                            "Resolve"
                                        })
                                        .small(),
                                    )
                                    .clicked()
                            {
                                let action = if thread["resolved"] == true {
                                    "reopen"
                                } else {
                                    "resolve"
                                };
                                self.send_thread_action(
                                    session,
                                    &id,
                                    &thread["target"],
                                    action,
                                    ui.ctx(),
                                );
                            }
                        });
                    });
                    if browser {
                        ui.label(
                            RichText::new(string(&thread["target"], "url"))
                                .small()
                                .color(theme::MUTED),
                        );
                    }
                    for comment in comments.iter().take(3) {
                        ui.label(string(comment, "text"));
                    }
                    if comments.len() > 3 {
                        ui.label(
                            RichText::new(format!("+{} more", comments.len() - 3))
                                .small()
                                .color(theme::MUTED),
                        );
                    }
                });
            ui.add_space(6.0);
            let _ = index;
        }
    }

    fn send_thread_action(
        &mut self,
        session: &str,
        thread: &str,
        source: &Value,
        action: &str,
        ctx: &egui::Context,
    ) {
        self.artifact_workspace.feedback_confirmation = None;
        let confirmation = FeedbackConfirmation {
            session: session.into(),
            source: source.clone(),
            resolved: action == "resolve",
        };
        let text = if action == "resolve" {
            "Resolved this feedback."
        } else {
            "Reopened this feedback."
        };
        let body = json!({"thread_id":thread,"action":action,"text":text});
        let body = body.to_string();
        let submission = workspace_submission_key(session, &body);
        let key = self
            .artifact_workspace
            .submission_keys
            .entry(submission.clone())
            .or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        self.artifact_request(
            Task::Mutation {
                path: format!(
                    "/api/v1/rat/sessions/{}/workspace/feedback",
                    path_segment(session)
                ),
                method: Method::POST,
                body: Some(Zeroizing::new(body)),
                idempotency_key: Some(key),
                secret: false,
            },
            ArtifactOperation::ThreadAction {
                submission,
                confirmation,
            },
            ctx,
        );
    }
}

struct ReadOnlyText(String);

impl egui::TextBuffer for ReadOnlyText {
    fn is_mutable(&self) -> bool {
        false
    }

    fn as_str(&self) -> &str {
        &self.0
    }

    fn insert_text(&mut self, _text: &str, _char_index: egui::text::CharIndex) -> usize {
        0
    }

    fn delete_char_range(&mut self, _char_range: std::ops::Range<egui::text::CharIndex>) {}

    fn type_id(&self) -> std::any::TypeId {
        std::any::TypeId::of::<Self>()
    }
}

fn annotation_image_path(session: &str, thread: &str) -> String {
    format!(
        "/api/v1/rat/sessions/{}/workspace/threads/{}/image",
        path_segment(session),
        path_segment(thread),
    )
}

fn plan_state_color(state: crate::model::SessionPlanState) -> Color32 {
    use crate::model::SessionPlanState as State;
    match state {
        State::Working => theme::ACCENT,
        State::Addressed => theme::SUCCESS,
        State::Deferred => theme::WARNING,
        State::NeedsDiscussion => theme::ERROR,
        State::Next | State::Reopened => theme::MUTED,
    }
}

fn captured_anchor_from_value(value: &Value) -> CapturedAnchor {
    let number = |key: &str| value[key].as_f64().unwrap_or_default() as f32;
    match value["type"].as_str().unwrap_or_default() {
        "point" => CapturedAnchor::Point {
            x: number("x"),
            y: number("y"),
        },
        "region" => CapturedAnchor::Region {
            x: number("x"),
            y: number("y"),
            width: number("width"),
            height: number("height"),
        },
        "text" => CapturedAnchor::Text {
            start: value["start"].as_u64().unwrap_or_default() as usize,
            end: value["end"].as_u64().unwrap_or_default() as usize,
            quote: string(value, "quote"),
        },
        "element" => CapturedAnchor::BrowserElement {
            id: string(value, "id"),
            bounds: FrameElement::from_value(value).map(|element| element.bounds()),
        },
        _ => CapturedAnchor::Item,
    }
}

#[derive(Clone)]
struct FrameElement {
    id: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

impl FrameElement {
    fn from_value(value: &Value) -> Option<Self> {
        let id = value["id"].as_str()?.to_owned();
        let x = value["x"].as_f64()? as f32;
        let y = value["y"].as_f64()? as f32;
        let width = value["width"].as_f64()? as f32;
        let height = value["height"].as_f64()? as f32;
        (width > 0.0 && height > 0.0).then_some(Self {
            id,
            x,
            y,
            width,
            height,
        })
    }

    fn bounds(&self) -> egui::Rect {
        egui::Rect::from_min_size(
            egui::pos2(self.x, self.y),
            egui::vec2(self.width, self.height),
        )
    }
}

fn frame_elements(frame: Option<&Value>) -> Vec<FrameElement> {
    frame
        .and_then(|frame| frame["elements"].as_array())
        .into_iter()
        .flatten()
        .filter_map(FrameElement::from_value)
        .collect()
}

fn element_at(frame: Option<&Value>, point: egui::Pos2) -> Option<FrameElement> {
    frame_elements(frame)
        .into_iter()
        .filter(|element| element.bounds().contains(point))
        .min_by(|a, b| {
            (a.width * a.height)
                .total_cmp(&(b.width * b.height))
                .then_with(|| a.id.cmp(&b.id))
        })
}

struct PinCluster {
    position: egui::Pos2,
    color: Color32,
    indices: Vec<usize>,
}

fn pin_position(anchor: &Value, rect: egui::Rect) -> Option<egui::Pos2> {
    let anchor = &anchor["anchor"];
    let point = match anchor["type"].as_str()? {
        "point" => egui::pos2(anchor["x"].as_f64()? as f32, anchor["y"].as_f64()? as f32),
        "region" | "element" => egui::pos2(
            anchor["x"].as_f64()? as f32 + anchor["width"].as_f64()? as f32 / 2.0,
            anchor["y"].as_f64()? as f32 + anchor["height"].as_f64()? as f32 / 2.0,
        ),
        _ => return None,
    };
    Some(egui::pos2(
        rect.left() + point.x * rect.width(),
        rect.top() + point.y * rect.height(),
    ))
}

fn pin_clusters(threads: &[(usize, &Value)], rect: egui::Rect) -> Vec<PinCluster> {
    let mut clusters: Vec<PinCluster> = Vec::new();
    for (thread_index, (_, thread)) in threads.iter().enumerate() {
        let Some(position) = pin_position(&thread["target"], rect) else {
            continue;
        };
        let color = thread["comments"]
            .as_array()
            .and_then(|comments| comments.first())
            .and_then(|comment| comment["participant"]["color"].as_str())
            .map(theme::participant_color)
            .unwrap_or(theme::MUTED);
        if let Some(cluster) = clusters
            .iter_mut()
            .find(|cluster| cluster.position.distance(position) < 22.0)
        {
            let count = cluster.indices.len() as f32;
            cluster.position += (position - cluster.position) / (count + 1.0);
            cluster.indices.push(thread_index);
        } else {
            clusters.push(PinCluster {
                position,
                color,
                indices: vec![thread_index],
            });
        }
    }
    clusters
}

fn paint_anchor(painter: &egui::Painter, image_rect: egui::Rect, anchor: &CapturedAnchor) {
    match anchor {
        CapturedAnchor::Point { x, y } => {
            let point = egui::pos2(
                image_rect.left() + x * image_rect.width(),
                image_rect.top() + y * image_rect.height(),
            );
            painter.circle_stroke(point, 9.0, egui::Stroke::new(2.0, theme::ACCENT));
            painter.circle_filled(point, 3.0, theme::ACCENT);
        }
        CapturedAnchor::Region {
            x,
            y,
            width,
            height,
        } => {
            let rect = egui::Rect::from_min_size(
                egui::pos2(
                    image_rect.left() + x * image_rect.width(),
                    image_rect.top() + y * image_rect.height(),
                ),
                egui::vec2(width * image_rect.width(), height * image_rect.height()),
            );
            painter.rect_stroke(
                rect,
                2,
                egui::Stroke::new(2.0, theme::ACCENT),
                egui::StrokeKind::Inside,
            );
        }
        CapturedAnchor::BrowserElement {
            bounds: Some(bounds),
            ..
        } => {
            let rect = egui::Rect::from_min_size(
                egui::pos2(
                    image_rect.left() + bounds.left() * image_rect.width(),
                    image_rect.top() + bounds.top() * image_rect.height(),
                ),
                egui::vec2(
                    bounds.width() * image_rect.width(),
                    bounds.height() * image_rect.height(),
                ),
            );
            painter.rect_stroke(
                rect,
                2,
                egui::Stroke::new(2.0, theme::ACCENT),
                egui::StrokeKind::Inside,
            );
        }
        CapturedAnchor::Item
        | CapturedAnchor::Text { .. }
        | CapturedAnchor::BrowserElement { bounds: None, .. } => {}
    }
}

fn selected_text_anchor(
    source: &str,
    selected_chars: std::ops::Range<usize>,
) -> Option<CapturedAnchor> {
    if selected_chars.start >= selected_chars.end {
        return None;
    }
    let chars = source.chars().collect::<Vec<_>>();
    if selected_chars.end > chars.len() {
        return None;
    }
    let utf16_offset = |char_offset: usize| {
        chars[..char_offset]
            .iter()
            .map(|character| character.len_utf16())
            .sum::<usize>()
    };
    let quote = chars[selected_chars.clone()].iter().collect::<String>();
    if quote.trim().is_empty() || quote.encode_utf16().count() > 2000 {
        return None;
    }
    Some(CapturedAnchor::Text {
        start: utf16_offset(selected_chars.start),
        end: utf16_offset(selected_chars.end),
        quote,
    })
}

fn preview_scale(size: egui::Vec2, width: f32, height: f32, actual: bool) -> f32 {
    if actual {
        1.0
    } else {
        (width / size.x).min(height / size.y).min(1.0)
    }
}

fn browser_view_label(frame: &Value) -> String {
    format!("Shared · {}", browser_size_label(frame))
}

fn browser_size_label(frame: &Value) -> String {
    let width = frame["width"].as_u64().unwrap_or_default();
    let height = frame["height"].as_u64().unwrap_or_default();
    let mode = match (width, height) {
        (390, 844) => "Phone",
        (1280, 800) => "Desktop",
        _ => "Browser",
    };
    format!("{mode} · {width} × {height}")
}

fn browser_action_label(frame: &Value) -> Option<String> {
    let last = &frame["last_action"];
    if last["epoch"] != frame["epoch"] || last["revision"] != frame["revision"] {
        return None;
    }
    let name = last["actor"]["label"].as_str()?;
    let verb = match last["action"].as_str()? {
        "resize" => "resized",
        "navigate" | "back" | "forward" => "navigated",
        "click" => "clicked",
        "scroll" => "scrolled",
        "reload" => "reloaded",
        "type" | "key" => "typed",
        _ => return None,
    };
    Some(format!(
        "{} {verb}",
        name.chars().take(40).collect::<String>()
    ))
}

fn visible_browser_capture<'a>(
    reading_capture: Option<&'a str>,
    annotating: bool,
    captured: Option<&'a str>,
) -> Option<&'a str> {
    // Retaining a draft's capture does not mean the live image still depicts it.
    reading_capture.or_else(|| annotating.then_some(captured).flatten())
}

fn capture_has_moved(
    capture: Option<&Value>,
    live: Option<&Value>,
    captured_url: Option<&str>,
    live_url: &str,
) -> bool {
    if captured_url != Some(live_url) {
        return true;
    }
    match (capture, live) {
        (Some(capture), Some(live)) => {
            capture["epoch"] != live["epoch"] || capture["revision"] != live["revision"]
        }
        (Some(_), None) => true,
        _ => false,
    }
}

fn workspace_submission_key(session: &str, body: &str) -> String {
    format!("{session}\0{body}")
}

#[cfg(test)]
mod captured_context_tests {
    use super::*;

    #[test]
    fn actual_size_ignores_fit_bounds_and_attribution_requires_the_current_revision() {
        let size = egui::vec2(390.0, 844.0);
        assert_eq!(preview_scale(size, 600.0, 422.0, false), 0.5);
        assert_eq!(preview_scale(size, 300.0, 422.0, true), 1.0);
        let mut frame = json!({"width":390,"height":844,"epoch":"e","revision":2,
            "last_action":{"epoch":"e","revision":2,"actor":{"label":"Maya"},"action":"resize"}});
        assert_eq!(browser_view_label(&frame), "Shared · Phone · 390 × 844");
        assert_eq!(
            browser_action_label(&frame).as_deref(),
            Some("Maya resized")
        );
        frame["revision"] = json!(3);
        assert_eq!(browser_action_label(&frame), None);
    }

    #[test]
    fn browser_pins_only_overlay_the_capture_being_viewed() {
        assert_eq!(visible_browser_capture(None, false, Some("phone")), None);
        assert_eq!(
            visible_browser_capture(None, true, Some("phone")),
            Some("phone")
        );
        assert_eq!(
            visible_browser_capture(Some("saved"), false, Some("phone")),
            Some("saved")
        );
        assert_eq!(visible_browser_capture(None, true, None), None);
    }

    #[test]
    fn file_tabs_group_versions_and_preserve_the_selected_source() {
        let artifact = |id: &str, path: &str, time: u64| {
            serde_json::from_value::<Resource>(json!({
                "id":id,"object":"agent.session.artifact","path":path,"created_at":time
            }))
            .unwrap()
        };
        let files = vec![
            artifact("new", "/a/direction.md", 20),
            artifact("old", "/a/direction.md", 10),
            artifact("other", "/b/direction.md", 5),
        ];
        assert_eq!(
            artifact_tabs(&files, None)
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["new", "other"]
        );
        assert_eq!(
            artifact_tabs(&files, Some("old"))
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["old", "other"]
        );
        assert_eq!(files.len(), 3, "All versions remain available in Files");
    }

    #[test]
    fn published_element_pins_and_outlines_use_the_saved_bounds_without_a_live_frame() {
        let anchor = json!({
            "type":"element", "id":"element_1", "x":0.25, "y":0.25,
            "width":0.5, "height":0.5, "quote":"Original page"
        });
        let target = json!({"anchor":anchor});
        let image = egui::Rect::from_min_size(egui::pos2(10.0, 20.0), egui::vec2(400.0, 200.0));
        assert_eq!(pin_position(&target, image), Some(egui::pos2(210.0, 120.0)));
        assert_eq!(
            captured_anchor_from_value(&anchor),
            CapturedAnchor::BrowserElement {
                id: "element_1".into(),
                bounds: Some(egui::Rect::from_min_size(
                    egui::pos2(0.25, 0.25),
                    egui::vec2(0.5, 0.5)
                )),
            }
        );
    }

    #[test]
    fn element_feedback_sends_identity_without_trusting_client_geometry() {
        let context = CapturedContext::new(
            CapturedSource {
                kind: CapturedSourceKind::Browser,
                id: "capture_1".into(),
                title: "Original page".into(),
                url: None,
                version: None,
                frame: None,
                preview: None,
            },
            CapturedAnchor::BrowserElement {
                id: "element_1".into(),
                bounds: Some(egui::Rect::EVERYTHING),
            },
        );
        assert_eq!(
            context.feedback_target()["anchor"],
            json!({"type":"element","id":"element_1"})
        );
    }

    #[test]
    fn clearing_workspace_keeps_session_idempotency_keys_and_advances_generation() {
        let mut workspace = ArtifactWorkspace {
            generation: 7,
            ..ArtifactWorkspace::default()
        };
        workspace
            .submission_keys
            .insert("session\0body".into(), "key".into());

        workspace.clear_selection();

        assert_eq!(workspace.generation, 8);
        assert_eq!(
            workspace
                .submission_keys
                .get("session\0body")
                .map(String::as_str),
            Some("key")
        );
    }

    #[test]
    fn opening_a_saved_source_fences_pending_requests_and_keeps_idempotency_keys() {
        let mut state = ArtifactWorkspace {
            generation: 7,
            pending: Some(42),
            submission_keys: HashMap::from([("session\0body".into(), "key".into())]),
            ..ArtifactWorkspace::default()
        };

        fence_artifact_view(&mut state);

        assert_eq!(state.generation, 8);
        assert_eq!(state.pending, None);
        assert_eq!(
            state
                .submission_keys
                .get("session\0body")
                .map(String::as_str),
            Some("key")
        );
    }

    #[test]
    fn selected_text_anchor_converts_unicode_character_ranges_to_utf16() {
        let source = "🐕 before 😀selected🚀 after";
        let chars = source.chars().collect::<Vec<_>>();
        let start = chars
            .iter()
            .position(|character| *character == '😀')
            .unwrap();
        let end = start + "😀selected🚀".chars().count();
        let prefix = chars[..start].iter().collect::<String>();
        let quote = chars[start..end].iter().collect::<String>();
        let expected_start = prefix.encode_utf16().count();
        let expected_end = expected_start + quote.encode_utf16().count();

        let Some(CapturedAnchor::Text {
            start: actual_start,
            end: actual_end,
            quote: actual_quote,
        }) = selected_text_anchor(source, start..end)
        else {
            panic!("expected a text anchor");
        };

        assert_eq!((actual_start, actual_end), (expected_start, expected_end));
        assert_eq!(actual_quote, quote);
    }

    #[test]
    fn selected_text_anchor_rejects_empty_or_unbounded_ranges() {
        let source = "A saved source";
        assert!(selected_text_anchor(source, 2..2).is_none());
        assert!(selected_text_anchor(source, 0..99).is_none());
    }

    #[test]
    fn selected_text_anchor_accepts_a_single_character() {
        assert!(selected_text_anchor("A saved source", 0..1).is_some());
    }

    #[test]
    fn selected_text_anchor_enforces_the_utf16_unit_limit() {
        let exact_limit = "😀".repeat(1000);
        let over_limit = "😀".repeat(1001);
        assert!(matches!(
            selected_text_anchor(&exact_limit, 0..1000),
            Some(CapturedAnchor::Text { end: 2000, .. })
        ));
        assert!(selected_text_anchor(&over_limit, 0..1001).is_none());
    }

    #[test]
    fn browser_element_hit_chooses_the_smallest_containing_rectangle() {
        let frame = json!({"elements":[
            {"id":"outer","x":0.1,"y":0.1,"width":0.8,"height":0.8},
            {"id":"inner","x":0.3,"y":0.3,"width":0.2,"height":0.2}
        ]});
        assert_eq!(
            element_at(Some(&frame), egui::pos2(0.4, 0.4)).unwrap().id,
            "inner"
        );
        assert_eq!(
            element_at(Some(&frame), egui::pos2(0.15, 0.15)).unwrap().id,
            "outer"
        );
        assert!(element_at(Some(&frame), egui::pos2(0.95, 0.95)).is_none());
    }

    #[test]
    fn capture_status_tracks_frame_revision_even_at_same_url() {
        let capture = json!({"url":"https://example.test","epoch":"e1","revision":3});
        let live = json!({"url":"https://example.test","epoch":"e1","revision":4});
        assert!(capture_has_moved(
            Some(&capture),
            Some(&live),
            Some("https://example.test"),
            "https://example.test",
        ));
    }
}
