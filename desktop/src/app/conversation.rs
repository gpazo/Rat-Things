use super::*;

impl ConsoleApp {
    pub(super) fn session_conversation(&mut self, ui: &mut Ui, snapshot: &SessionSnapshot) {
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
            self.conversation_progress(ui, snapshot);
            ui.add_space(8.0);
            self.typing_label(ui);
            if self.can_contribute() { egui::Frame::new().fill(theme::SURFACE).stroke(egui::Stroke::new(1.0, theme::BORDER)).corner_radius(8).inner_margin(12).show(ui, |ui| {
                self.reply_composer(ui, &session_id);
                let message = self.messages.entry(session_id.clone()).or_default();
                let response = egui::ScrollArea::vertical().id_salt(("composer-scroll", &session_id)).max_height(160.0).show(ui, |ui| {
                    ui.add(TextEdit::multiline(message).id_salt(("message", &session_id)).frame(egui::Frame::NONE).desired_rows(1).desired_width(f32::INFINITY).hint_text(if active { "Add a direction…" } else { "Message the agent…" }))
                }).inner;
                if self.collaboration.focus_composer { response.request_focus(); self.collaboration.focus_composer = false; }
                response.widget_info(|| egui::WidgetInfo::labeled(egui::Role::TextInput, true, "Message"));
                let shortcut = response.has_focus() && ui.input(|input| input.modifiers.command && input.key_pressed(egui::Key::Enter));
                let message = message.clone();
                if response.changed() && response.has_focus() && !message.is_empty() { self.collaboration.last_edit = Some((session_id.clone(), Instant::now())); }
                if !response.has_focus() || message.is_empty() { self.collaboration.last_edit = None; }
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
            } else { ui.label(if self.share_fenced() { "Sharing… Continue in the team space when ready." } else { "View-only access" }); }

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
                    let mut attributed = item.clone();
                    if let Some(label) = snapshot.actor_labels.get(&item.id) { attributed.fields.insert("participant_label".into(), label.clone().into()); }
                    if let Some(color) = snapshot.actor_colors.get(&item.id) { attributed.fields.insert("participant_color".into(), color.clone().into()); }
                    if let Some(reply) = snapshot.replies.get(&item.id) {
                        attributed.fields.insert("reply".into(), reply.clone());
                        if let Some(color) = reply["message_id"].as_str().and_then(|id| snapshot.actor_colors.get(id)) { attributed.fields.insert("reply_color".into(), color.clone().into()); }
                    }
                    self.transcript_item(ui, &attributed);
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

    fn conversation_progress(&mut self, ui: &mut Ui, snapshot: &SessionSnapshot) {
        let active = snapshot.turn_active();
        let label = progress_label(snapshot.turn().map(|turn| turn.text("status")));
        let failed = snapshot
            .turn()
            .is_some_and(|turn| turn.text("status") == "failed");
        ui.horizontal_wrapped(|ui| {
            if active {
                ui.add(egui::Spinner::new().size(12.0).color(theme::ACCENT));
            }
            ui.label(RichText::new(label).small().color(if failed {
                theme::ERROR
            } else if active {
                theme::ACCENT
            } else {
                theme::MUTED
            }));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if snapshot
                    .items
                    .iter()
                    .any(|item| item.text("type") != "message")
                {
                    ui.menu_button("Activity", |ui| {
                        ui.set_max_width(420.0);
                        ui.label(RichText::new("Recent activity").font(theme::semibold(13.0)));
                        ui.label(
                            RichText::new("Latest 20 updates")
                                .small()
                                .color(theme::MUTED),
                        );
                        egui::ScrollArea::vertical()
                            .max_height(320.0)
                            .show(ui, |ui| {
                                for item in snapshot
                                    .items
                                    .iter()
                                    .rev()
                                    .filter(|item| item.text("type") != "message")
                                    .take(20)
                                {
                                    self.transcript_item(ui, item);
                                }
                            });
                    });
                }
                if self.can_control()
                    && active
                    && ui
                        .add_enabled(
                            self.mutation_pending.is_none(),
                            egui::Button::new("Cancel turn").small(),
                        )
                        .clicked()
                {
                    self.send_events(
                        &snapshot.session.id,
                        vec![json!({"type":"agent.session.input.cancel"})],
                        None,
                        None,
                        ui.ctx(),
                    );
                }
            });
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
            egui::CollapsingHeader::new(
                RichText::new(transcript_item_summary(&title))
                    .small()
                    .color(theme::MUTED),
            )
            .id_salt(&item.id)
            .show(ui, |ui| json_view(ui, &item.value()));
            ui.add_space(4.0);
            return;
        }
        let is_user = item.text("role") == "user";
        let title = if item.text("type") == "message" {
            if is_user {
                if !item.text("participant_label").is_empty() {
                    item.text("participant_label")
                } else if self.is_team() {
                    "Participant"
                } else {
                    "You"
                }
            } else if item.text("phase") == "commentary" {
                "Agent · working"
            } else {
                "Agent"
            }
        } else {
            item.text("type")
        };
        let identity_color = if !is_user {
            theme::TEXT
        } else if !item.text("participant_color").is_empty() {
            theme::participant_color(item.text("participant_color"))
        } else if !self.is_team() {
            theme::PARTICIPANT_COLORS[0]
        } else {
            theme::MUTED
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
                        ui.horizontal_top(|ui| {
                            author_badge(ui, title, identity_color, !is_user);
                            ui.vertical(|ui| {
                                ui.set_width((ui.available_width() - 2.0).max(40.0));
                                ui.horizontal(|ui| {
                                    ui.label(
                                        RichText::new(title)
                                            .font(theme::semibold(13.0))
                                            .color(identity_color),
                                    );
                                    if item.text("type") == "message" {
                                        ui.with_layout(
                                            egui::Layout::right_to_left(egui::Align::Center),
                                            |ui| {
                                                if self.can_contribute()
                                                    && quiet_message_action(ui, "Reply", hovered)
                                                        .clicked()
                                                    && let Some(session) = &self.selected_id
                                                {
                                                    self.collaboration.focus_composer = true;
                                                    self.collaboration.replies.insert(
                                                        session.clone(),
                                                        ReplyDraft {
                                                            id: item.id.clone(),
                                                            label: title.to_owned(),
                                                            text: message_text(item)
                                                                .chars()
                                                                .take(200)
                                                                .collect(),
                                                            color: identity_color,
                                                        },
                                                    );
                                                }
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
                                                                    part.get("text")
                                                                        .and_then(Value::as_str)
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
                                if let Some(reply) = item.fields.get("reply") {
                                    let label = reply["actor"]["label"]
                                        .as_str()
                                        .or(reply["actor"]["subject"].as_str())
                                        .or(reply["actor"]["id"].as_str())
                                        .unwrap_or(if reply["role"] == "assistant" {
                                            "Agent"
                                        } else {
                                            "Participant"
                                        });
                                    let imported = if reply["provenance"]["kind"] == "imported" {
                                        " (imported)"
                                    } else {
                                        ""
                                    };
                                    let preview: String = reply["text"]
                                        .as_str()
                                        .unwrap_or("Message")
                                        .chars()
                                        .take(200)
                                        .collect();
                                    if ui
                                        .add(
                                            egui::Button::new(
                                                RichText::new(format!(
                                                    "↪ {label}{imported}\n{preview}"
                                                ))
                                                .small()
                                                .color(theme::participant_color(
                                                    item.text("reply_color"),
                                                )),
                                            )
                                            .wrap()
                                            .fill(theme::CARD)
                                            .stroke(egui::Stroke::NONE),
                                        )
                                        .on_hover_text("Go to original message")
                                        .clicked()
                                    {
                                        self.collaboration.scroll_target =
                                            reply["message_id"].as_str().map(ToOwned::to_owned);
                                    }
                                }
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
                                                    let cached = self
                                                        .rendered_markdown
                                                        .entry(key)
                                                        .or_default();
                                                    if cached.0 != source {
                                                        *cached = (
                                                            source.clone(),
                                                            Markdown::new(&source),
                                                        );
                                                    }
                                                    ui.scope(|ui| {
                                                        ui.style_mut()
                                                            .interaction
                                                            .selectable_labels = false;
                                                        cached.1.show(ui, &mut self.markdown_cache);
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
                                    egui::CollapsingHeader::new(summary).id_salt(&item.id).show(
                                        ui,
                                        |ui| {
                                            json_view(ui, &item.value());
                                        },
                                    );
                                }
                            });
                        });
                    })
            })
            .inner;
        if self.collaboration.scroll_target.as_deref() == Some(&item.id) {
            frame.response.scroll_to_me(Some(egui::Align::Center));
            self.collaboration.scroll_target = None;
        }
        ui.ctx()
            .data_mut(|data| data.insert_temp(bounds_id, frame.response.rect));
        ui.add_space(8.0);
    }
}

fn progress_label(status: Option<&str>) -> &str {
    match status {
        Some("queued") => "Agent is queued",
        Some("in_progress") => "Agent is working",
        Some("waiting") => "Agent is waiting",
        Some("completed") => "Ready for the next step",
        Some("failed") => "Turn failed",
        Some("cancelled") => "Turn cancelled",
        Some(other) if !other.is_empty() => other,
        _ => "Ready for input",
    }
}

fn author_badge(ui: &mut Ui, label: &str, color: Color32, agent: bool) {
    let (rect, response) = ui.allocate_exact_size(egui::vec2(24.0, 24.0), egui::Sense::hover());
    if agent {
        let glyph = crate::brand::glyph(ui.ctx());
        ui.painter().image(
            glyph.id(),
            rect,
            egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0)),
            Color32::WHITE,
        );
    } else {
        ui.painter().circle_filled(rect.center(), 12.0, color);
        let initial = label
            .chars()
            .find(|c| !c.is_whitespace())
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_else(|| "?".into());
        ui.painter().text(
            rect.center(),
            egui::Align2::CENTER_CENTER,
            initial,
            theme::semibold(12.0),
            theme::BACKGROUND,
        );
    }
    response.on_hover_text(label);
}

fn quiet_message_action(ui: &mut Ui, label: &str, row_hovered: bool) -> egui::Response {
    let response = ui.add(
        egui::Button::new(RichText::new(label).small().color(Color32::TRANSPARENT)).frame(false),
    );
    if row_hovered || response.hovered() || response.has_focus() {
        ui.painter().text(
            response.rect.center(),
            egui::Align2::CENTER_CENTER,
            label,
            egui::FontId::proportional(11.0),
            theme::MUTED,
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_never_presents_waiting_or_failed_work_as_complete() {
        assert_eq!(progress_label(Some("waiting")), "Agent is waiting");
        assert_eq!(progress_label(Some("failed")), "Turn failed");
        assert_eq!(progress_label(Some("cancelled")), "Turn cancelled");
        assert_eq!(progress_label(Some("completed")), "Ready for the next step");
        assert_eq!(progress_label(None), "Ready for input");
        assert_eq!(progress_label(Some("new_server_state")), "new_server_state");
    }
}
