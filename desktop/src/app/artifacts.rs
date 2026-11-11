use super::*;

#[derive(Default)]
pub(super) struct ArtifactWorkspace {
    pub open: bool,
    selected: Option<String>,
    pub(super) generation: u64,
    pending: Option<u64>,
    texture: Option<egui::TextureHandle>,
    text: Option<String>,
    frame: Option<Value>,
    capture: Option<String>,
    thread: Option<String>,
    anchor: Option<Value>,
    drag_start: Option<egui::Pos2>,
    annotating: bool,
    feedback: bool,
    discussion_only: bool,
    drafts: HashMap<String, String>,
    url: String,
    browser_text: String,
    next_frame: Option<Instant>,
    error: Option<String>,
    preview_failed: bool,
    show_resolved: bool,
    submission_keys: HashMap<String, String>,
}
impl ArtifactWorkspace {
    pub(super) fn clear_selection(&mut self) {
        let drafts = std::mem::take(&mut self.drafts);
        *self = Self {
            drafts,
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
        draft_key: String,
        text: String,
        submission: String,
    },
}

impl ConsoleApp {
    pub(super) fn receive_artifact(
        &mut self,
        operation: ArtifactOperation,
        result: Result<Data, String>,
        ctx: &egui::Context,
    ) {
        self.artifact_workspace.pending = None;
        self.artifact_workspace.next_frame = Some(Instant::now() + Duration::from_millis(500));
        if result.is_ok() {
            let submission = match &operation {
                ArtifactOperation::Frame { submission, .. } => submission.as_ref(),
                ArtifactOperation::Feedback { submission, .. } => Some(submission),
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
                if matches!(operation, ArtifactOperation::Capture) {
                    self.artifact_workspace.capture = value["id"].as_str().map(ToOwned::to_owned);
                }
                let frame = value.get("frame").unwrap_or(&value).clone();
                self.artifact_workspace.texture =
                    Some(ctx.load_texture("shared-browser", image, egui::TextureOptions::LINEAR));
                if self.artifact_workspace.url.is_empty() {
                    self.artifact_workspace.url = string(&frame, "url");
                }
                self.artifact_workspace.frame = Some(frame);
            }
            Ok(Data::Mutation(_)) => {
                if let ArtifactOperation::Feedback {
                    draft_key, text, ..
                } = operation
                {
                    if self.artifact_workspace.drafts.get(&draft_key) == Some(&text) {
                        self.artifact_workspace.drafts.remove(&draft_key);
                    }
                    self.next_refresh = Instant::now();
                    self.artifact_workspace.anchor = None;
                }
            }
            Err(error) => {
                self.artifact_workspace.preview_failed =
                    matches!(operation, ArtifactOperation::Preview);
                self.artifact_workspace.error = Some(error);
                self.artifact_workspace.next_frame = Some(Instant::now() + Duration::from_secs(3));
            }
            _ => {}
        }
    }

    fn artifact_request(&mut self, task: Task, operation: ArtifactOperation, ctx: &egui::Context) {
        if self.artifact_workspace.pending.is_some() {
            return;
        }
        self.artifact_workspace.error = None;
        self.artifact_workspace.preview_failed = false;
        let pending = Pending::Artifact {
            session_generation: self.selection_generation,
            generation: self.artifact_workspace.generation,
            operation,
        };
        self.artifact_workspace.pending = self.submit(task, pending, ctx);
    }

    fn select_artifact(&mut self, id: String, session: &str, ctx: &egui::Context) {
        if self.artifact_workspace.selected.as_ref() == Some(&id) {
            return;
        }
        let state = &mut self.artifact_workspace;
        state.selected = Some(id.clone());
        state.generation += 1;
        state.pending = None;
        state.texture = None;
        state.text = None;
        state.frame = None;
        state.capture = None;
        state.anchor = None;
        state.thread = None;
        state.annotating = false;
        state.feedback = id != "browser";
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
        let submission = body.as_ref().map(ToString::to_string);
        let key = body.as_ref().map(|body| {
            self.artifact_workspace
                .submission_keys
                .entry(body.to_string())
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

    fn select_artifact_thread(
        &mut self,
        session: &str,
        thread: &Value,
        browser: bool,
        ctx: &egui::Context,
    ) {
        let state = &mut self.artifact_workspace;
        state.feedback = true;
        state.thread = thread["id"].as_str().map(ToOwned::to_owned);
        state.annotating = true;
        state.anchor = None;
        if browser {
            // Selecting a capture is navigation: an in-flight live frame belongs to the old view.
            state.generation += 1;
            state.pending = None;
            state.texture = None;
            state.text = None;
            state.frame = None;
            state.capture = thread["target"]["id"].as_str().map(ToOwned::to_owned);
            if thread["target"]["image_available"] == true {
                self.artifact_request(
                    Task::ArtifactPreview {
                        path: annotation_image_path(session, &string(thread, "id")),
                    },
                    ArtifactOperation::Preview,
                    ctx,
                );
            }
        }
    }

    pub(super) fn artifact_workspace(&mut self, ui: &mut Ui, snapshot: &SessionSnapshot) {
        let session = snapshot.session.id.clone();
        let mut contributors = Vec::new();
        for item in &snapshot.items {
            if let (Some(label), Some(color)) = (
                snapshot.actor_labels.get(&item.id),
                snapshot.actor_colors.get(&item.id),
            ) {
                let contributor = (label, color);
                if !contributors.contains(&contributor) {
                    contributors.push(contributor);
                }
            }
        }
        if !contributors.is_empty() {
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new("Contributors").small().color(theme::MUTED));
                for (label, color) in contributors.iter().take(4) {
                    ui.label(
                        RichText::new(*label)
                            .small()
                            .color(theme::participant_color(color)),
                    );
                }
                if contributors.len() > 4 {
                    ui.label(
                        RichText::new(format!("+{}", contributors.len() - 4))
                            .small()
                            .color(theme::MUTED),
                    )
                    .on_hover_text(
                        contributors
                            .iter()
                            .skip(4)
                            .map(|(label, _)| label.as_str())
                            .collect::<Vec<_>>()
                            .join("\n"),
                    );
                }
            });
        }
        ui.add_space(10.0);
        ui.horizontal_wrapped(|ui| {
            if snapshot.browser_available
                && ui
                    .selectable_label(
                        self.artifact_workspace.selected.as_deref() == Some("browser"),
                        "Live browser",
                    )
                    .clicked()
            {
                self.select_artifact("browser".into(), &session, ui.ctx());
            }
            for artifact in &snapshot.artifacts {
                if ui
                    .selectable_label(
                        self.artifact_workspace.selected.as_ref() == Some(&artifact.id),
                        format!(
                            "{} · {}",
                            crate::api::safe_filename(artifact.text("path")),
                            &artifact.id[artifact.id.len().saturating_sub(6)..]
                        ),
                    )
                    .clicked()
                {
                    self.select_artifact(artifact.id.clone(), &session, ui.ctx());
                }
            }
        });
        if self.artifact_workspace.selected.is_none() && snapshot.browser_available {
            self.select_artifact("browser".into(), &session, ui.ctx());
        }
        if self.artifact_workspace.selected.is_none() {
            ui.add_space(30.0);
            ui.label(
                RichText::new(if snapshot.artifacts.is_empty() {
                    "No saved artifacts yet."
                } else {
                    "Choose an artifact to review."
                })
                .color(theme::MUTED),
            );
            return;
        }
        let browser = self.artifact_workspace.selected.as_deref() == Some("browser");
        let selected = self.artifact_workspace.selected.clone().unwrap();
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
            })
            .cloned()
            .collect();
        let wide = ui.available_width() > 900.0;
        if !wide {
            ui.horizontal(|ui| {
                ui.selectable_value(&mut self.artifact_workspace.discussion_only, false, "Work");
                ui.selectable_value(
                    &mut self.artifact_workspace.discussion_only,
                    true,
                    "Discussion",
                );
            });
            ui.add_space(8.0);
        }
        let area = ui.available_rect_before_wrap();
        if wide {
            let gap = 24.0;
            let discussion_width = (area.width() * 0.38).clamp(340.0, 440.0);
            let edge = area.right() - discussion_width;
            let work = egui::Rect::from_min_max(area.min, egui::pos2(edge - gap, area.bottom()));
            let discussion = egui::Rect::from_min_max(egui::pos2(edge, area.top()), area.max);
            ui.scope_builder(egui::UiBuilder::new().max_rect(work), |ui| {
                self.artifact_controls(ui, &session, browser);
                self.artifact_preview(ui, &session, &threads, browser);
            });
            ui.painter().vline(
                edge - gap / 2.0,
                area.y_range(),
                egui::Stroke::new(1.0, theme::BORDER),
            );
            ui.scope_builder(egui::UiBuilder::new().max_rect(discussion), |ui| {
                self.workspace_discussion(ui, snapshot, &threads, browser, false);
            });
        } else if self.artifact_workspace.discussion_only {
            self.workspace_discussion(ui, snapshot, &threads, browser, true);
        } else {
            egui::ScrollArea::vertical()
                .id_salt("artifact-work")
                .show(ui, |ui| {
                    self.artifact_controls(ui, &session, browser);
                    self.artifact_preview(ui, &session, &threads, browser);
                });
        }
        // Give explicit interactions the request slot before starting a refresh.
        // Otherwise a due poll can swallow a click in this same render pass.
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

    fn artifact_controls(&mut self, ui: &mut Ui, session: &str, browser: bool) {
        if browser {
            ui.horizontal(|ui| {
                ui.add_enabled_ui(
                    self.can_contribute()
                        && !self.artifact_workspace.annotating
                        && self.artifact_workspace.pending.is_none()
                        && self.artifact_workspace.frame.is_some(),
                    |ui| {
                        if ui.small_button("←").on_hover_text("Back").clicked() {
                            self.browser_request(session, Some(json!({"action":"back"})), ui.ctx());
                        }
                        if ui.small_button("↻").on_hover_text("Reload").clicked() {
                            self.browser_request(
                                session,
                                Some(json!({"action":"reload"})),
                                ui.ctx(),
                            );
                        }
                        ui.text_edit_singleline(&mut self.artifact_workspace.url);
                        if ui.button("Go").clicked() {
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
            if let Some(frame) = &self.artifact_workspace.frame {
                ui.label(
                    RichText::new(string(frame, "url"))
                        .small()
                        .color(theme::MUTED),
                );
            }
            ui.ctx().request_repaint_after(Duration::from_millis(500));
        }
        ui.horizontal_wrapped(|ui| {
            if self.can_contribute() || self.artifact_workspace.annotating {
                let label = if self.artifact_workspace.annotating {
                    if browser {
                        "Return to live view"
                    } else {
                        "Done annotating"
                    }
                } else {
                    "Add comment"
                };
                if ui
                    .add_enabled(
                        self.artifact_workspace.pending.is_none()
                            && (!browser
                                || self.artifact_workspace.annotating
                                || self.artifact_workspace.frame.is_some()),
                        egui::Button::new(label),
                    )
                    .clicked()
                {
                    if self.artifact_workspace.annotating {
                        self.artifact_workspace.annotating = false;
                        self.artifact_workspace.thread = None;
                        self.artifact_workspace.capture = None;
                    } else {
                        self.artifact_workspace.annotating = true;
                        self.artifact_workspace.feedback = true;
                        self.artifact_workspace.discussion_only = true;
                        self.artifact_workspace.thread = None;
                        self.artifact_workspace.anchor = Some(json!({"type":"item"}));
                        if browser && let Some(frame) = &self.artifact_workspace.frame {
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
                                ui.ctx(),
                            );
                        }
                    }
                }
            }
            if browser && self.artifact_workspace.annotating {
                ui.label(
                    RichText::new("Saved capture · live page may differ")
                        .small()
                        .color(theme::MUTED),
                );
            }
            if self.artifact_workspace.annotating && self.artifact_workspace.texture.is_some() {
                ui.label(
                    RichText::new("Click to pin; drag to mark a region.")
                        .small()
                        .color(theme::MUTED),
                );
            }
        });
        self.artifact_status(ui, session, browser);
        ui.add_space(12.0);
    }

    fn artifact_status(&mut self, ui: &mut Ui, session: &str, browser: bool) {
        if let Some(error) = &self.artifact_workspace.error {
            ui.colored_label(theme::ERROR, error);
            if self.artifact_workspace.pending.is_none()
                && self.artifact_workspace.preview_failed
                && ui.button("Retry preview").clicked()
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
                let Some(path) = path else { return };
                self.artifact_request(
                    Task::ArtifactPreview { path },
                    ArtifactOperation::Preview,
                    ui.ctx(),
                );
            }
        }
        if self
            .artifact_workspace
            .pending
            .is_some_and(|id| self.loading_is_slow(Some(id)))
        {
            ui.spinner();
        }
    }

    fn workspace_discussion(
        &mut self,
        ui: &mut Ui,
        snapshot: &SessionSnapshot,
        threads: &[Value],
        browser: bool,
        compact: bool,
    ) {
        ui.horizontal(|ui| {
            ui.selectable_value(&mut self.artifact_workspace.feedback, false, "Conversation");
            ui.selectable_value(&mut self.artifact_workspace.feedback, true, "Feedback");
        });
        ui.separator();
        if compact {
            self.artifact_status(ui, &snapshot.session.id, browser);
        }
        if self.artifact_workspace.feedback {
            if compact && browser && self.artifact_workspace.annotating {
                ui.label(
                    RichText::new("Saved capture · live page may differ")
                        .small()
                        .color(theme::MUTED),
                );
            }
            self.artifact_comments(ui, &snapshot.session.id, threads, browser);
        } else {
            self.session_conversation(ui, snapshot);
        }
    }

    fn artifact_preview(&mut self, ui: &mut Ui, session: &str, threads: &[Value], browser: bool) {
        if let Some(texture) = self.artifact_workspace.texture.clone() {
            let size = texture.size_vec2();
            let height = if ui.ctx().content_rect().width() < 1100.0 {
                ui.ctx().content_rect().height() * 0.3
            } else {
                560.0
            };
            let scale = (ui.available_width() / size.x)
                .min(height / size.y)
                .min(1.0);
            let response = ui.add(
                egui::Image::new((texture.id(), size * scale)).sense(egui::Sense::click_and_drag()),
            );
            let normalized = |point: egui::Pos2| {
                egui::pos2(
                    ((point.x - response.rect.left()) / response.rect.width()).clamp(0.0, 1.0),
                    ((point.y - response.rect.top()) / response.rect.height()).clamp(0.0, 1.0),
                )
            };
            if self.artifact_workspace.annotating && self.can_contribute() {
                if response.drag_started() {
                    self.artifact_workspace.drag_start = ui
                        .input(|input| input.pointer.press_origin())
                        .map(normalized);
                }
                if response.drag_stopped()
                    && let (Some(start), Some(end)) = (
                        self.artifact_workspace.drag_start.take(),
                        response.interact_pointer_pos().map(normalized),
                    )
                {
                    let width = (start.x - end.x).abs();
                    let height = (start.y - end.y).abs();
                    if width > 0.002 && height > 0.002 {
                        self.artifact_workspace.anchor = Some(
                            json!({"type":"region","x":start.x.min(end.x),"y":start.y.min(end.y),"width":width,"height":height}),
                        );
                    }
                } else if response.clicked()
                    && let Some(point) = response.interact_pointer_pos().map(normalized)
                {
                    self.artifact_workspace.anchor =
                        Some(json!({"type":"point","x":point.x,"y":point.y}));
                }
            } else if browser
                && self.can_contribute()
                && response.clicked()
                && let Some(point) = response.interact_pointer_pos().map(normalized)
            {
                self.browser_request(
                    session,
                    Some(json!({"action":"click","x":point.x,"y":point.y})),
                    ui.ctx(),
                );
            }
            for (index, thread) in threads.iter().enumerate() {
                if browser
                    && self.artifact_workspace.capture.as_deref() != thread["target"]["id"].as_str()
                {
                    continue;
                }
                let anchor = &thread["target"]["anchor"];
                if let (Some(x), Some(y)) = (anchor["x"].as_f64(), anchor["y"].as_f64()) {
                    let point = response.rect.min
                        + egui::vec2(
                            x as f32 * response.rect.width(),
                            y as f32 * response.rect.height(),
                        );
                    let rect = egui::Rect::from_center_size(point, egui::vec2(24.0, 24.0));
                    let color = theme::participant_color(
                        thread["comments"][0]["participant"]["color"]
                            .as_str()
                            .unwrap_or_default(),
                    );
                    ui.painter().circle_filled(point, 12.0, color);
                    ui.painter().text(
                        point,
                        egui::Align2::CENTER_CENTER,
                        (index + 1).to_string(),
                        egui::FontId::proportional(12.0),
                        theme::BACKGROUND,
                    );
                    if ui
                        .interact(
                            rect,
                            ui.scope_id().with(("annotation-pin", string(thread, "id"))),
                            egui::Sense::click(),
                        )
                        .clicked()
                    {
                        self.select_artifact_thread(session, thread, browser, ui.ctx());
                    }
                }
            }
            if self.artifact_workspace.annotating
                && let Some(anchor) = &self.artifact_workspace.anchor
                && let (Some(x), Some(y)) = (anchor["x"].as_f64(), anchor["y"].as_f64())
            {
                let point = response.rect.min
                    + egui::vec2(
                        x as f32 * response.rect.width(),
                        y as f32 * response.rect.height(),
                    );
                ui.painter()
                    .circle_stroke(point, 7.0, egui::Stroke::new(2.0, theme::ACCENT));
                if let (Some(width), Some(height)) =
                    (anchor["width"].as_f64(), anchor["height"].as_f64())
                {
                    ui.painter().rect_stroke(
                        egui::Rect::from_min_size(
                            point,
                            egui::vec2(
                                width as f32 * response.rect.width(),
                                height as f32 * response.rect.height(),
                            ),
                        ),
                        2,
                        egui::Stroke::new(2.0, theme::ACCENT),
                        egui::StrokeKind::Inside,
                    );
                }
            }
        } else if let Some(text) = &self.artifact_workspace.text {
            egui::ScrollArea::vertical()
                .max_height(500.0)
                .show(ui, |ui| {
                    ui.add(egui::Label::new(text).selectable(true).wrap());
                });
        }
        if browser && !self.artifact_workspace.annotating && self.can_contribute() {
            ui.horizontal_wrapped(|ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut self.artifact_workspace.browser_text)
                        .hint_text("Type into the focused field"),
                );
                if ui
                    .add_enabled(
                        self.artifact_workspace.pending.is_none(),
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
                for key in ["Enter", "Tab", "Backspace"] {
                    if ui
                        .add_enabled(
                            self.artifact_workspace.pending.is_none(),
                            egui::Button::new(key).small(),
                        )
                        .clicked()
                    {
                        self.browser_request(
                            session,
                            Some(json!({"action":"key","key":key})),
                            ui.ctx(),
                        );
                    }
                }
                for (label, delta) in [("Scroll up", -500), ("Scroll down", 500)] {
                    if ui
                        .add_enabled(
                            self.artifact_workspace.pending.is_none(),
                            egui::Button::new(label).small(),
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
            });
        }
    }

    fn artifact_comments(&mut self, ui: &mut Ui, session: &str, threads: &[Value], browser: bool) {
        egui::Panel::bottom("artifact-composer")
            .show_separator_line(false)
            .resizable(false)
            .min_size(0.0)
            .frame(egui::Frame::NONE)
            .show(ui, |ui| {
                ui.add_space(12.0);
                self.artifact_feedback_composer(ui, session, browser);
            });
        ui.checkbox(&mut self.artifact_workspace.show_resolved, "Show resolved");
        egui::ScrollArea::vertical().id_salt(("artifact-feedback", session)).auto_shrink([false, false]).show(ui, |ui| {
            if threads.is_empty() {
                ui.add_space(16.0);
                ui.label(RichText::new(if self.artifact_workspace.annotating { "Feedback is shared with the team and agent." } else { "No feedback yet. Choose Add comment to start." }).color(theme::MUTED));
            }
            for (index, thread) in threads.iter().enumerate() {
                let id = string(thread, "id");
                egui::Frame::new().fill(theme::SURFACE).inner_margin(10).corner_radius(6).show(ui, |ui| {
                    if ui.selectable_label(self.artifact_workspace.thread.as_deref() == Some(&id), format!("{} · {}", index + 1, if thread["resolved"] == true { "Resolved" } else { "Open" })).clicked() {
                        self.select_artifact_thread(session, thread, browser, ui.ctx());
                    }
                    if browser { ui.label(RichText::new(string(&thread["target"], "url")).small().color(theme::MUTED)); }
                    for comment in thread["comments"].as_array().into_iter().flatten() {
                        let actor = &comment["actor"];
                        let name = actor["label"].as_str().or(actor["subject"].as_str()).or(actor["id"].as_str()).unwrap_or("Participant");
                        let color = theme::participant_color(comment["participant"]["color"].as_str().unwrap_or_default());
                        ui.label(RichText::new(name).small().color(color));
                        if comment["provenance"]["kind"] != "authenticated" { ui.label(RichText::new("Imported or unverified attribution").small().color(theme::MUTED)); }
                        ui.label(string(comment, "text"));
                    }
                    if self.can_contribute() && ui.add_enabled(self.artifact_workspace.pending.is_none(), egui::Button::new(if thread["resolved"] == true { "Reopen" } else { "Resolve" }).small()).clicked() {
                        let action = if thread["resolved"] == true { "reopen" } else { "resolve" };
                        self.send_artifact_feedback(session, json!({"thread_id":id,"action":action,"text":if action == "resolve" { "Resolved this feedback." } else { "Reopened this feedback." }}), String::new(), String::new(), ui.ctx());
                    }
                });
                ui.add_space(8.0);
            }
        });
    }

    fn artifact_feedback_composer(&mut self, ui: &mut Ui, session: &str, browser: bool) {
        if self.can_contribute()
            && (self.artifact_workspace.annotating || self.artifact_workspace.thread.is_some())
        {
            self.typing_label(ui);
            ui.label(
                RichText::new(if self.artifact_workspace.thread.is_some() {
                    "Reply to this feedback"
                } else if browser {
                    "Feedback on this capture"
                } else {
                    "Feedback on this file version"
                })
                .small()
                .color(theme::MUTED),
            );
            let draft_key = format!(
                "{}:{}:{}",
                session,
                self.artifact_workspace
                    .selected
                    .as_deref()
                    .unwrap_or_default(),
                self.artifact_workspace.thread.as_deref().unwrap_or("new")
            );
            let text = self
                .artifact_workspace
                .drafts
                .entry(draft_key.clone())
                .or_default();
            let response = egui::ScrollArea::vertical()
                .id_salt(("feedback-draft", &draft_key))
                .max_height(120.0)
                .show(ui, |ui| {
                    ui.add(
                        egui::TextEdit::multiline(text)
                            .desired_rows(3)
                            .desired_width(f32::INFINITY)
                            .hint_text("Add feedback…"),
                    )
                })
                .inner;
            response.widget_info(|| {
                egui::WidgetInfo::labeled(egui::Role::TextInput, true, "Artifact feedback")
            });
            let text = text.clone();
            if response.changed() && response.has_focus() && !text.is_empty() {
                self.collaboration.last_edit = Some((session.to_owned(), Instant::now()));
            }
            if !response.has_focus() || text.is_empty() {
                self.collaboration.last_edit = None;
            }

            let target_ready = !browser || self.artifact_workspace.capture.is_some();
            if ui
                .add_enabled(
                    target_ready
                        && !text.trim().is_empty()
                        && self.artifact_workspace.pending.is_none(),
                    theme::primary_button("Share feedback"),
                )
                .clicked()
            {
                let mut body = json!({"text":text,"action":"comment"});
                if let Some(thread) = &self.artifact_workspace.thread {
                    body["thread_id"] = thread.clone().into();
                } else {
                    body["target"] = json!({"kind":if browser { "browser" } else { "artifact" },"id":if browser { self.artifact_workspace.capture.as_deref() } else { self.artifact_workspace.selected.as_deref() },"anchor":self.artifact_workspace.anchor.clone().unwrap_or(json!({"type":"item"}))});
                }
                self.send_artifact_feedback(session, body, draft_key, text, ui.ctx());
            }
        }
    }
    fn send_artifact_feedback(
        &mut self,
        session: &str,
        body: Value,
        draft_key: String,
        text: String,
        ctx: &egui::Context,
    ) {
        let key = self
            .artifact_workspace
            .submission_keys
            .entry(body.to_string())
            .or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        self.artifact_request(
            Task::Mutation {
                path: format!(
                    "/api/v1/rat/sessions/{}/workspace/feedback",
                    path_segment(session)
                ),
                method: Method::POST,
                body: Some(Zeroizing::new(body.to_string())),
                idempotency_key: Some(key),
                secret: false,
            },
            ArtifactOperation::Feedback {
                draft_key,
                text,
                submission: body.to_string(),
            },
            ctx,
        );
    }
}

fn annotation_image_path(session: &str, thread: &str) -> String {
    format!(
        "/api/v1/rat/sessions/{}/workspace/threads/{}/image",
        path_segment(session),
        path_segment(thread),
    )
}
