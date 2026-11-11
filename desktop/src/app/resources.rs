use super::*;

impl ConsoleApp {
    pub(super) fn details(&mut self, ui: &mut Ui, resource: &Resource) {
        ui.horizontal_wrapped(|ui| {
            match self.collection {
                Collection::Agents | Collection::Templates => {
                    if self.can_manage() && ui.button(format!("Edit {}", self.collection.singular())).clicked() {
                        self.open_editor(format!("Edit {}", self.collection.singular()), resource.edit_body(self.collection), self.collection.resource_path(&resource.id), self.collection, Some(resource.id.clone()), false);
                    }
                    if self.can_contribute() && ui.add(theme::primary_button("Start session")).clicked() {
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
                    if ui.add(theme::primary_button("Add credential")).clicked() {
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
                ui.add_space(16.0);
                if self.collection == Collection::Vaults {
                    ui.label(RichText::new("Credentials").strong().size(14.0));
                    ui.label(
                        RichText::new(
                            "Secret values cannot be read back.",
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
                        theme::section(ui, credential.title(), "", |ui| {
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
                    ui.horizontal_wrapped(|ui| {
                        ui.label(RichText::new("Model").small().color(theme::MUTED));
                        ui.label(if resource.model().is_empty() { "No model configured" } else { resource.model() });
                    });
                    ui.add_space(16.0);
                    theme::section(ui, "Instructions", "", |ui| {
                        let instructions = resource.text("instructions");
                        ui.add(egui::Label::new(if instructions.is_empty() { "No instructions." } else { instructions }).wrap());
                    });
                    ui.add_space(6.0);
                    ui.label(RichText::new("Tools").font(theme::semibold(14.0)));
                    ui.add_space(6.0);
                    ui.vertical(|ui| {
                        let tools = resource.fields.get("tools").and_then(Value::as_array);
                        if let Some(tools) = tools.filter(|tools| !tools.is_empty()) {
                            for tool in tools {
                                let kind = string(tool, "type").replace('_', " ");
                                let name = string(tool, "name");
                                ui.horizontal_wrapped(|ui| {
                                    ui.label(if name.is_empty() { &kind } else { &name });
                                    if !name.is_empty() { ui.label(RichText::new(kind).small().color(theme::MUTED)); }
                                });
                            }
                        } else { ui.label(RichText::new("No tools configured").color(theme::MUTED)); }
                    });
                }
                if self.collection == Collection::Templates {
                    theme::section(ui, "Network access", "", |ui| {
                        let network = resource.fields.get("network").unwrap_or(&Value::Null);
                        let access = string(network, "access");
                        ui.label(if access.is_empty() { "disabled" } else { &access });
                        if let Some(domains) = network["allowed_domains"].as_array().filter(|domains| !domains.is_empty()) {
                            ui.add_space(6.0);
                            theme::field_label(ui, "Allowed domains");
                            for domain in domains.iter().filter_map(Value::as_str) { ui.label(domain); }
                        }
                    });
                    theme::section(ui, "Packages", "", |ui| {
                        let mut has_packages = false;
                        for (kind, label) in [("npm", "npm"), ("python", "Python"), ("system", "System")] {
                            let packages = resource.fields.get("packages").and_then(|packages| packages.get(kind)).and_then(Value::as_array).map(|packages| packages.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                            if !packages.is_empty() {
                                has_packages = true;
                                theme::field_label(ui, label);
                                ui.add(egui::Label::new(packages).wrap());
                                ui.add_space(6.0);
                            }
                        }
                        if !has_packages { ui.label(RichText::new("No additional packages").color(theme::MUTED)); }
                    });
                }
                ui.add_space(24.0);
                egui::CollapsingHeader::new("Resource JSON")
                    .id_salt((&resource.id, "resource-json"))
                    .default_open(false)
                    .show(ui, |ui| json_view(ui, &resource.value()));
            });
    }
}
