use super::*;

#[derive(Clone)]
pub(super) struct ReplyDraft {
    pub id: String,
    pub label: String,
    pub text: String,
    pub color: Color32,
}

pub(super) struct RemoteTypist {
    pub label: String,
    pub color: Color32,
    pub expires: Instant,
}

pub(super) struct CollaborationUi {
    pub replies: HashMap<String, ReplyDraft>,
    pub remote: Vec<RemoteTypist>,
    pub scroll_target: Option<String>,
    pub focus_composer: bool,
    pub last_edit: Option<(String, Instant)>,
    client: String,
    sequence: u64,
    sent: Option<String>,
    sent_at: Option<Instant>,
    pub pending: Option<u64>,
}
impl Default for CollaborationUi {
    fn default() -> Self {
        Self {
            replies: HashMap::new(),
            remote: Vec::new(),
            scroll_target: None,
            focus_composer: false,
            last_edit: None,
            client: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
            sent: None,
            sent_at: None,
            pending: None,
        }
    }
}

impl ConsoleApp {
    pub(super) fn receive_typing(&mut self, event: &Value) {
        let now = Instant::now();
        let server_time = event["server_time"].as_f64().unwrap_or_default();
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
        self.collaboration.remote = event["typing"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let actor = &entry["participant"]["actor"];
                if identity.is_some_and(|identity| {
                    identity["issuer"].is_string()
                        && identity["issuer"] == actor["issuer"]
                        && identity["subject"] == actor["subject"]
                }) {
                    return None;
                }
                let remaining = (entry["expires_at"].as_f64()? - server_time).clamp(0.0, 6.0);
                if remaining == 0.0 {
                    return None;
                }
                Some(RemoteTypist {
                    label: actor["label"]
                        .as_str()
                        .or(actor["subject"].as_str())
                        .or(actor["id"].as_str())
                        .unwrap_or("Someone")
                        .to_owned(),
                    color: theme::participant_color(
                        entry["participant"]["color"].as_str().unwrap_or_default(),
                    ),
                    expires: now + Duration::from_secs_f64(remaining),
                })
            })
            .collect();
    }

    pub(super) fn poll_typing(&mut self, ctx: &egui::Context) {
        let now = Instant::now();
        self.collaboration
            .remote
            .retain(|person| person.expires > now);
        if self.collaboration.last_edit.is_some()
            || !self.collaboration.remote.is_empty()
            || self.collaboration.sent.is_some()
        {
            ctx.request_repaint_after(Duration::from_millis(250));
        }
        if self.collaboration.pending.is_some() {
            return;
        }
        let desired = self
            .collaboration
            .last_edit
            .as_ref()
            .filter(|(id, at)| {
                self.is_team()
                    && self.can_contribute()
                    && !self.workspace_open
                    && self.selected_id.as_ref() == Some(id)
                    && now.duration_since(*at) < Duration::from_secs(3)
            })
            .map(|(id, _)| id.clone());
        let previous = self.collaboration.sent.clone();
        let heartbeat_due = desired.is_some()
            && self
                .collaboration
                .sent_at
                .is_none_or(|at| now.duration_since(at) >= Duration::from_secs(2));
        if desired == previous && !heartbeat_due {
            return;
        }
        // Stop the previous Session before starting another; delayed requests carry monotonic sequences.
        let stopping = previous.is_some() && desired != previous;
        let target = if stopping { previous } else { desired.clone() };
        let Some(id) = target else {
            return;
        };
        if !self.is_team() {
            self.collaboration.sent = None;
            return;
        }
        self.collaboration.sequence += 1;
        let body = json!({"client_id":self.collaboration.client,"sequence":self.collaboration.sequence,"typing":!stopping});
        if let Ok(request) = self.worker.submit(
            Task::Typing {
                id: id.clone(),
                body,
            },
            ctx,
        ) {
            self.pending
                .insert(request, PendingRequest::new(Pending::Typing));
            self.collaboration.pending = Some(request);
            self.collaboration.sent = if stopping { None } else { Some(id) };
            self.collaboration.sent_at = Some(now);
        }
    }

    pub(super) fn typing_label(&self, ui: &mut Ui) {
        let people = &self.collaboration.remote;
        ui.allocate_ui_with_layout(
            egui::vec2(ui.available_width(), 18.0),
            egui::Layout::left_to_right(egui::Align::Center),
            |ui| match people.as_slice() {
                [] => {}
                [person] => {
                    ui.label(
                        RichText::new(format!("{} is typing…", person.label))
                            .small()
                            .color(person.color),
                    );
                }
                [first, second] => {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(RichText::new(&first.label).small().color(first.color));
                        ui.label(RichText::new("and").small().color(theme::MUTED));
                        ui.label(RichText::new(&second.label).small().color(second.color));
                        ui.label(RichText::new("are typing…").small().color(theme::MUTED));
                    });
                }
                _ => {
                    ui.label(
                        RichText::new("Several people are typing…")
                            .small()
                            .color(theme::MUTED),
                    )
                    .on_hover_text(
                        people
                            .iter()
                            .map(|person| person.label.as_str())
                            .collect::<Vec<_>>()
                            .join(", "),
                    );
                }
            },
        );
    }

    pub(super) fn reply_composer(&mut self, ui: &mut Ui, session: &str) {
        if let Some(reply) = self.collaboration.replies.get(session).cloned() {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(format!("Replying to {}", reply.label))
                        .small()
                        .color(reply.color),
                );
                let cancel = ui.small_button("×").on_hover_text("Cancel reply");
                cancel.widget_info(|| {
                    egui::WidgetInfo::labeled(egui::Role::Button, true, "Cancel reply")
                });
                if cancel.clicked() {
                    self.collaboration.replies.remove(session);
                }
            });
            ui.label(RichText::new(&reply.text).small().color(theme::MUTED));
            ui.separator();
        }
    }
}

pub(super) fn message_text(item: &Resource) -> String {
    item.fields
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui_kittest::{Harness, kittest::Queryable};

    fn app() -> ConsoleApp {
        let mut app = ConsoleApp::new("http://127.0.0.1:1".into(), "fixture".into()).unwrap();
        app.initialized = true;
        app.workspace = Some(
            json!({"kind":"team","role":"collaborator","name":"Product team","permissions":["read","contribute","create_session"],"connection_id":"team"}),
        );
        app.team.connections = vec![
            json!({"id":"team","identity":{"issuer":"https://identity.test","subject":"self"}}),
        ];
        app.team.authority_valid_until = Some(Instant::now() + Duration::from_secs(60));
        app.team.authority_due = Some(Instant::now() + Duration::from_secs(60));
        app.team.loaded = true;
        app.team.saved_shares_loaded = true;
        app.next_refresh = Instant::now() + Duration::from_secs(60);
        let snapshot = SessionSnapshot::from_activity(json!({
            "cursor":"act_session_1", "role":"collaborator", "permissions":["read","contribute"],
            "session":{"id":"sess_shared","object":"agent.session","status":"idle","metadata":{"name":"It works on my machine"}},
            "runtime":{"runtime":"codex"},"turns":[],
            "items":[
                {"id":"msg_design","type":"message","role":"user","content":[{"type":"input_text","text":"Make the environment mismatch visible before we blame the person."}]},
                {"id":"msg_agent","type":"message","role":"assistant","content":[{"type":"output_text","text":"Let’s focus the product direction on reproducible handoffs. What should the first experience show?"}]},
                {"id":"msg_engineer","type":"message","role":"user","content":[{"type":"input_text","text":"Show which dependencies differ. Avoid promising identical machines."}]},
                {"id":"msg_qa","type":"message","role":"user","content":[{"type":"input_text","text":"And test a clean setup. Cached dependencies can hide the actual failure."}]}
            ],
            "inputs":[
                {"actor":{"id":"maya","label":"Maya · designer"},"participant":{"color":"#d9adf5"},"message_ids":["msg_design"]},
                {"actor":{"id":"theo","label":"Theo · engineer"},"participant":{"color":"#8fc9ff"},"message_ids":["msg_engineer"],"reply":{"message_id":"msg_design","role":"user","actor":{"id":"maya","label":"Maya · designer"},"text":"Make the environment mismatch visible before we blame the person."}},
                {"actor":{"id":"jules","label":"Jules · QA"},"participant":{"color":"#f3c77b"},"message_ids":["msg_qa"],"reply":{"message_id":"msg_engineer","role":"user","actor":{"id":"theo","label":"Theo · engineer"},"text":"Show which dependencies differ. Avoid promising identical machines."}}
            ]
        })).unwrap();
        app.selected_id = Some(snapshot.session.id.clone());
        app.resources = vec![snapshot.session.clone()];
        app.selected = Some(snapshot.session.clone());
        app.snapshot = Some(snapshot);
        app
    }
    fn typing(people: &[(&str, &str)]) -> Value {
        json!({"server_time":100,"typing": people.iter().map(|(id, label)| json!({"participant":{"key":id,"actor":{"id":id,"issuer":"https://identity.test","subject":id,"label":label},"color":"#8fc9ff"},"expires_at":106})).collect::<Vec<_>>()})
    }
    #[test]
    fn typing_excludes_self_and_expires_during_disconnect() {
        let mut app = app();
        app.receive_typing(&typing(&[("self", "You"), ("maya", "Maya")]));
        assert_eq!(app.collaboration.remote.len(), 1);
        assert_eq!(app.collaboration.remote[0].label, "Maya");
        app.collaboration.remote[0].expires = Instant::now();
        app.poll_typing(&egui::Context::default());
        assert!(app.collaboration.remote.is_empty());
        app.receive_typing(&typing(&[("maya", "Maya")]));
        app.clear_team_access(&egui::Context::default());
        assert!(app.collaboration.remote.is_empty());
    }
    #[test]
    fn selecting_reply_preserves_the_draft_and_cancel_keeps_it() {
        let mut state = app();
        state
            .messages
            .insert("sess_shared".into(), "QA has one more concern".into());
        let mut ui = Harness::new_ui_state(
            |ui, app: &mut ConsoleApp| {
                theme::apply(ui.ctx());
                app.show(ui);
            },
            state,
        );
        ui.set_size(egui::vec2(1280.0, 850.0));
        ui.run_steps(3);
        ui.query_all_by_label("Reply").next().unwrap().click();
        ui.run_steps(2);
        assert!(ui.state().collaboration.replies.contains_key("sess_shared"));
        assert_eq!(
            ui.state().messages["sess_shared"],
            "QA has one more concern"
        );
        ui.run_steps(5);
        ui.get_by_label("Cancel reply").click();
        ui.run_steps(5);
        assert!(!ui.state().collaboration.replies.contains_key("sess_shared"));
        assert_eq!(
            ui.state().messages["sess_shared"],
            "QA has one more concern"
        );
    }
    #[test]
    fn multiplayer_layout_and_typing_labels() {
        let mut state = app();
        state.receive_typing(&typing(&[
            ("maya", "Maya"),
            ("theo", "Theo"),
            ("jules", "Jules"),
        ]));
        state.collaboration.replies.insert(
            "sess_shared".into(),
            ReplyDraft {
                id: "msg_qa".into(),
                label: "Jules · QA".into(),
                text: "And test a clean setup. Cached dependencies can hide the actual failure."
                    .into(),
                color: theme::PARTICIPANT_COLORS[2],
            },
        );
        let mut ui = Harness::new_ui_state(
            |ui, app: &mut ConsoleApp| {
                theme::apply(ui.ctx());
                app.show(ui);
            },
            state,
        );
        ui.set_size(egui::vec2(1280.0, 850.0));
        ui.run_steps(3);
        assert!(ui.query_by_label("Several people are typing…").is_some());
        assert!(ui.query_by_label("Replying to Jules · QA").is_some());
        if let Ok(directory) = std::env::var("RAT_COLLABORATION_SCREENSHOTS") {
            std::fs::create_dir_all(&directory).unwrap();
            ui.render()
                .unwrap()
                .save(std::path::Path::new(&directory).join("multiplayer-wide.png"))
                .unwrap();
            ui.set_size(egui::vec2(720.0, 850.0));
            ui.run_steps(3);
            assert!(ui.query_by_label("Cancel reply").is_some());
            ui.render()
                .unwrap()
                .save(std::path::Path::new(&directory).join("multiplayer-narrow.png"))
                .unwrap();
        }
        ui.state_mut().receive_typing(&typing(&[("maya", "Maya")]));
        ui.run_steps(2);
        assert!(ui.query_by_label("Maya is typing…").is_some());
    }
}
