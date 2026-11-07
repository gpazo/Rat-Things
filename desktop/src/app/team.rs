use super::*;

#[cfg(test)]
mod authority_tests;

pub(super) const AUTHORITY_MAX_AGE: Duration = Duration::from_secs(10);
const AUTHORITY_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Role {
    Viewer,
    Collaborator,
    Controller,
    Manager,
    NoAccess,
}
impl Role {
    pub(super) fn parse(value: &str) -> Self {
        match value {
            "viewer" => Self::Viewer,
            "collaborator" => Self::Collaborator,
            "controller" => Self::Controller,
            "manager" => Self::Manager,
            _ => Self::NoAccess,
        }
    }
    fn contributes(self) -> bool {
        matches!(self, Self::Collaborator | Self::Controller | Self::Manager)
    }
    fn controls(self) -> bool {
        matches!(self, Self::Controller | Self::Manager)
    }
}

pub(super) enum TeamOperation {
    Connections,
    Discovery,
    Login,
    LoginStatus,
    CancelLogin,
    Spaces(String),
    Logout,
    Bindings,
    Grant,
    Share,
    Shares,
    AbortShare,
}
#[derive(Default)]
pub(super) struct TeamState {
    pub authority_pending: Option<u64>,
    pub authority_due: Option<Instant>,
    pub authority_valid_until: Option<Instant>,
    pub authority_revision: u64,
    pub endpoint: String,
    pub open: bool,
    pub connections: Vec<Value>,
    pub loaded: bool,
    pub pending: Option<u64>,
    pub error: Option<String>,
    pub connection: String,
    pub spaces: Vec<Value>,
    pub space: String,
    pub providers: Vec<Value>,
    pub provider: String,
    pub login: Option<Value>,
    pub next_poll: Option<Instant>,
    pub share_open: bool,
    pub share_source: Option<String>,
    pub share_request: Option<Value>,
    pub share: Option<Value>,
    pub bindings: Option<Vec<Value>>,
    pub issuer: String,
    pub subject: String,
    pub grant_role: String,
    pub saved_shares_loaded: bool,
    pub saved_shares: Vec<Value>,
}
impl ConsoleApp {
    pub(super) fn is_team(&self) -> bool {
        self.workspace
            .as_ref()
            .is_some_and(|v| string(v, "kind") == "team")
    }
    fn role(&self) -> Role {
        if self.is_team() {
            Role::parse(&string(self.workspace.as_ref().unwrap(), "role"))
        } else {
            Role::Manager
        }
    }
    fn permitted(&self, action: &str) -> bool {
        !self.is_team()
            || self
                .workspace
                .as_ref()
                .and_then(|workspace| workspace["permissions"].as_array())
                .is_some_and(|permissions| {
                    permissions
                        .iter()
                        .any(|permission| permission.as_str() == Some(action))
                })
    }
    pub(super) fn can_contribute(&self) -> bool {
        self.role().contributes() && self.permitted("contribute") && !self.share_fenced()
    }
    pub(super) fn can_control(&self) -> bool {
        self.role().controls() && self.permitted("cancel") && !self.share_fenced()
    }
    pub(super) fn can_manage(&self) -> bool {
        self.role() == Role::Manager && self.permitted("configure") && !self.share_fenced()
    }
    pub(super) fn share_fenced(&self) -> bool {
        self.is_local()
            && self.selected_id.is_some()
            && self
                .team
                .share_request
                .as_ref()
                .is_some_and(|v| v["session_id"].as_str() == self.selected_id.as_deref())
    }
    fn team_request(
        &mut self,
        operation: TeamOperation,
        method: Method,
        path: String,
        body: Option<Value>,
        ctx: &egui::Context,
    ) {
        if self.team.pending.is_some() {
            return;
        }
        self.team.error = None;
        self.team.pending = self.submit(
            Task::Team { path, method, body },
            Pending::Team(operation),
            ctx,
        );
    }
    fn poll_team_authority(&mut self, ctx: &egui::Context) {
        if !self.is_team() || self.workspace_pending.is_some() {
            return;
        }
        let now = Instant::now();
        if self.role() != Role::NoAccess
            && self
                .team
                .authority_valid_until
                .is_some_and(|until| now >= until)
        {
            self.clear_team_access(ctx);
            self.error = Some("Team access could not be verified. Reconnect to continue.".into());
        }
        ctx.request_repaint_after(Duration::from_millis(500));
        if self.team.authority_pending.is_some()
            || self.team.authority_due.is_some_and(|due| now < due)
        {
            return;
        }
        let space_id = self
            .workspace
            .as_ref()
            .map(|workspace| string(workspace, "space_id"))
            .unwrap_or_default();
        if space_id.is_empty() {
            self.clear_team_access(ctx);
            return;
        }
        self.team.authority_due = Some(now + AUTHORITY_INTERVAL);
        self.team.authority_pending = self.submit(
            Task::TeamAuthority { space_id },
            Pending::TeamAuthority {
                generation: self.local_generation,
                revision: self.team.authority_revision,
            },
            ctx,
        );
    }
    pub(super) fn receive_team_authority(
        &mut self,
        result: Result<Data, String>,
        ctx: &egui::Context,
    ) {
        self.team.authority_due = Some(Instant::now() + AUTHORITY_INTERVAL);
        match result {
            Ok(Data::Authority { role, permissions }) => {
                let recovering = self.role() == Role::NoAccess;
                self.update_team_authority(&role, Some(&permissions), ctx);
                if self.role() != Role::NoAccess {
                    self.team.authority_valid_until = Some(Instant::now() + AUTHORITY_MAX_AGE);
                    if recovering {
                        self.error = None;
                        self.refresh_list(false, ctx);
                    }
                }
            }
            Err(error) if error.starts_with("[access_revoked]") => {
                self.clear_team_access(ctx);
                self.error =
                    Some("Team access is no longer available. Reconnect or choose a space.".into());
            }
            Err(error) => {
                if self
                    .team
                    .authority_valid_until
                    .is_none_or(|until| Instant::now() >= until)
                {
                    self.clear_team_access(ctx);
                }
                self.error = Some(error);
            }
            _ => {
                self.clear_team_access(ctx);
                self.error = Some("The team authority response is invalid.".into());
            }
        }
    }
    pub(super) fn poll_team(&mut self, ctx: &egui::Context) {
        self.poll_team_authority(ctx);
        if self.team.pending.is_some() {
            return;
        }
        if self.is_local()
            && self.workspace_pending.is_none()
            && let Some(index) = self.team.saved_shares.iter().position(|share| {
                share["source_session_id"].as_str() == self.selected_id.as_deref()
                    && share["status"] == "complete"
            })
        {
            let share = self.team.saved_shares.remove(index);
            self.team.share_request = Some(share_request(&share));
            self.receive_team(TeamOperation::Share, Ok(Data::Local(share)), ctx);
            return;
        }
        if ((self.workspace_open && self.team.open) || self.team.share_open) && !self.team.loaded {
            self.team_request(
                TeamOperation::Connections,
                Method::GET,
                "/api/v1/team/connections".into(),
                None,
                ctx,
            );
            return;
        }
        if self.is_local() && !self.team.saved_shares_loaded {
            self.team.saved_shares_loaded = true;
            self.team_request(
                TeamOperation::Shares,
                Method::GET,
                "/api/v1/workspace/shares".into(),
                None,
                ctx,
            );
            return;
        }
        if self
            .team
            .next_poll
            .is_some_and(|time| time > Instant::now())
        {
            ctx.request_repaint_after(Duration::from_millis(500));
            return;
        }
        if let Some(login) = &self.team.login
            && string(login, "status") == "waiting"
        {
            self.team_request(
                TeamOperation::LoginStatus,
                Method::GET,
                format!("/api/v1/team/login/{}", path_segment(&string(login, "id"))),
                None,
                ctx,
            );
        } else if let Some(share) = &self.team.share
            && !matches!(
                string(share, "status").as_str(),
                "complete" | "failed" | "aborted"
            )
            && self.is_local()
        {
            self.team_request(
                TeamOperation::Share,
                Method::GET,
                format!(
                    "/api/v1/workspace/shares/{}",
                    path_segment(&string(share, "id"))
                ),
                None,
                ctx,
            );
        }
    }
    pub(super) fn receive_team(
        &mut self,
        operation: TeamOperation,
        result: Result<Data, String>,
        ctx: &egui::Context,
    ) {
        self.team.pending = None;
        if matches!(operation, TeamOperation::Connections) {
            self.team.loaded = true;
        }
        self.team.next_poll = Some(Instant::now() + Duration::from_secs(2));
        let value = match result {
            Ok(Data::Local(value)) => value,
            Ok(Data::LocalRejected { status, message })
                if self.is_team()
                    && matches!(status.as_u16(), 401 | 403)
                    && matches!(operation, TeamOperation::Bindings | TeamOperation::Grant) =>
            {
                self.clear_team_access(ctx);
                self.team.error = Some(message);
                return;
            }
            Ok(Data::LocalRejected { message, .. }) | Err(message) => {
                self.team.error = Some(message);
                return;
            }
            _ => {
                self.team.error = Some("The team response is invalid.".into());
                return;
            }
        };
        match operation {
            TeamOperation::Connections => {
                self.team.connections = value["data"].as_array().cloned().unwrap_or_default();
                self.team.loaded = true;
            }
            TeamOperation::Discovery => {
                self.team.providers = value["login_providers"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                self.team.provider = self
                    .team
                    .providers
                    .first()
                    .map(|p| string(p, "id"))
                    .unwrap_or_default();
            }
            TeamOperation::Login | TeamOperation::LoginStatus => {
                if string(&value, "status") == "complete" {
                    self.team.loaded = false;
                    self.team.login = None;
                    self.notice = Some("Team sign-in complete. Choose a space.".into());
                } else {
                    if matches!(operation, TeamOperation::Login)
                        && let Some(url) = value["url"]
                            .as_str()
                            .filter(|url| url.starts_with("https://"))
                    {
                        ctx.open_url(egui::OpenUrl::new_tab(url));
                    }
                    self.team.login = Some(value);
                }
            }
            TeamOperation::CancelLogin => self.team.login = None,
            TeamOperation::Spaces(id) => {
                self.team.connection = id;
                self.team.spaces = value["data"].as_array().cloned().unwrap_or_default();
                self.team.space = self
                    .team
                    .spaces
                    .first()
                    .map(|s| string(s, "id"))
                    .unwrap_or_default();
            }
            TeamOperation::Logout => {
                self.team.login = None;
                self.team.loaded = false;
                self.team.spaces.clear();
                self.team.connection.clear();
                self.team.space.clear();
                self.clear_team_access(ctx);
                self.workspace_pending = self.submit(
                    Task::Workspace { connection: None },
                    Pending::Workspace { switching: true },
                    ctx,
                );
            }
            TeamOperation::Bindings => {
                self.team.bindings = Some(value["data"].as_array().cloned().unwrap_or_default())
            }
            TeamOperation::Grant => {
                self.team.bindings = None;
                self.team.subject.clear();
                self.notice = Some("Space role saved for the verified identity.".into());
            }
            TeamOperation::AbortShare => {
                if value["status"] == "aborted" {
                    self.team.share = None;
                    self.team.share_request = None;
                    self.team.share_open = false;
                    self.notice =
                        Some("Share stopped. This Session can continue on this computer.".into());
                }
            }
            TeamOperation::Shares => {
                let values = value["data"].as_array().or_else(|| value.as_array());
                self.team.saved_shares = values.cloned().unwrap_or_default();
                if let Some(share) = values.and_then(|values| {
                    values.iter().find(|share| {
                        !matches!(string(share, "status").as_str(), "complete" | "aborted")
                    })
                }) {
                    self.team.share = Some(share.clone());
                    self.team.share_request = Some(
                        json!({"id":share["id"],"session_id":share["source_session_id"],"endpoint":share["destination"]["baseURL"],"space_id":share["destination"]["space_id"],"connection_id":share["destination"]["connection_id"]}),
                    );
                }
            }
            TeamOperation::Share => {
                let complete = string(&value, "status") == "complete";
                self.team.share = Some(value.clone());
                if complete && self.selected_id.as_deref() != value["source_session_id"].as_str() {
                    self.team
                        .saved_shares
                        .retain(|share| share["id"] != value["id"]);
                    self.team.saved_shares.push(value);
                    self.notice =
                        Some("Session shared. Open it to continue in the team space.".into());
                } else if complete {
                    let destination = &value["destination"];
                    let target = string(&value, "destination_session_id");
                    self.connect_workspace(json!({"kind":"team","connection_id":destination["connection_id"],"space_id":destination["space_id"]}), ctx);
                    self.cloud_session_to_open = Some(target);
                    self.team.share_open = false;
                }
            }
        }
    }
    pub(super) fn update_team_authority(
        &mut self,
        role: &str,
        permissions: Option<&[String]>,
        ctx: &egui::Context,
    ) {
        if !self.is_team() {
            return;
        }
        if Role::parse(role) == Role::NoAccess
            || permissions.is_some_and(|permissions| {
                !permissions.iter().any(|permission| permission == "read")
            })
        {
            self.clear_team_access(ctx);
            return;
        }
        let was_manager = self.can_manage();
        let changed = self.workspace.as_ref().is_some_and(|workspace| {
            workspace["role"].as_str() != Some(role)
                || permissions
                    .is_some_and(|permissions| workspace["permissions"] != json!(permissions))
        });
        if changed {
            self.team.authority_revision += 1;
            self.selection_generation += 1;
            self.snapshot_pending = None;
            self.detail_pending = None;
        }
        self.team.authority_valid_until = Some(Instant::now() + AUTHORITY_MAX_AGE);
        if let Some(workspace) = &mut self.workspace {
            workspace["role"] = role.into();
            if let Some(permissions) = permissions {
                workspace["permissions"] = json!(permissions);
            }
        }
        if was_manager && !self.can_manage() {
            self.close_editor(ctx);
            if let Some(mut editor) = self.session_editor.take() {
                editor.clear(ctx);
            }
            self.rename = None;
            self.delete_confirmation = None;
            self.team.bindings = None;
            self.pending
                .retain(|_, request| !matches!(request.operation, Pending::Mutation(_)));
            self.mutation_pending = None;
        }
        if !self.can_manage() || !self.permitted("credentials") {
            self.credentials.clear();
            self.credentials_loaded = false;
            self.pending
                .retain(|_, request| !matches!(request.operation, Pending::Credentials { .. }));
            if self.collection == Collection::Vaults {
                self.navigate(Collection::Sessions, ctx);
            }
        }
        if !self.can_manage() || !self.permitted("manage_space") {
            self.team.bindings = None;
            self.team.subject.clear();
            self.team.issuer.clear();
            self.team.grant_role.clear();
            self.pending.retain(|_, request| {
                !matches!(
                    request.operation,
                    Pending::Team(TeamOperation::Bindings | TeamOperation::Grant)
                )
            });
            if self
                .team
                .pending
                .is_some_and(|id| !self.pending.contains_key(&id))
            {
                self.team.pending = None;
            }
        }
        if changed && self.collection != Collection::Sessions && !self.detail_loaded {
            self.refresh_selection(ctx);
        }
    }
    pub(super) fn clear_team_access(&mut self, ctx: &egui::Context) {
        self.team.authority_revision += 1;
        self.team.authority_valid_until = None;
        self.list_generation += 1;
        self.selection_generation += 1;
        self.resources.clear();
        self.after = None;
        self.detail_loaded = false;
        self.credentials_loaded = false;
        self.archive_undo = None;
        self.session_index.clear();
        self.selected = None;
        self.snapshot = None;
        self.selected_id = None;
        self.credentials.clear();
        self.messages.clear();
        self.tool_drafts.clear();
        self.session_titles.clear();
        self.models = ModelPicker::default();
        self.environments = EnvironmentPicker::default();
        self.rendered_markdown.clear();
        self.markdown_cache = CommonMarkCache::default();
        if let Some(mut editor) = self.editor.take() {
            editor.clear(ctx);
        }
        if let Some(mut editor) = self.session_editor.take() {
            editor.clear(ctx);
        }
        self.team.bindings = None;
        self.rename = None;
        self.delete_confirmation = None;
        self.team.spaces.clear();
        self.team.subject.clear();
        self.team.issuer.clear();
        self.team.grant_role.clear();
        self.submission_keys.clear();
        self.pending.retain(|_, request| matches!(request.operation, Pending::TeamAuthority { .. } | Pending::Workspace { .. })
            || matches!(request.operation, Pending::Team(ref operation) if !matches!(operation, TeamOperation::Bindings | TeamOperation::Grant)));
        if self
            .team
            .pending
            .is_some_and(|id| !self.pending.contains_key(&id))
        {
            self.team.pending = None;
        }
        self.list_pending = None;
        self.detail_pending = None;
        self.snapshot_pending = None;
        self.mutation_pending = None;
        if let Some(workspace) = &mut self.workspace {
            workspace["role"] = "no_access".into();
            workspace["permissions"] = json!([]);
        }
    }
    pub(super) fn team_controls(&mut self, ui: &mut Ui, ctx: &egui::Context, can_switch: bool) {
        theme::card().show(ui, |ui| {
            ui.label(RichText::new("Your team").font(theme::semibold(15.0)));
            ui.label("Sign in with your own account. A space role determines what you can see and do.");
            let label = ui.label("Team API URL");
            ui.add(TextEdit::singleline(&mut self.team.endpoint).hint_text("https://team.example/v1").desired_width(f32::INFINITY)).labelled_by(label.id);
            if ui.add_enabled(self.team.pending.is_none() && !self.team.endpoint.trim().is_empty(), egui::Button::new("Find team sign-in")).clicked() {
                self.team.providers.clear();
                self.team_request(TeamOperation::Discovery, Method::POST, "/api/v1/team/discovery".into(), Some(json!({"endpoint":self.team.endpoint.trim()})), ctx);
            }
            if !self.team.providers.is_empty() {
                egui::ComboBox::new("team-provider", "Sign-in provider").selected_text(&self.team.provider).show_ui(ui, |ui| { for provider in &self.team.providers { let id = string(provider, "id"); ui.selectable_value(&mut self.team.provider, id.clone(), id); } });
                if ui.add_enabled(self.team.pending.is_none() && self.team.login.is_none(), theme::primary_button("Sign in to team")).clicked() {
                    self.team_request(TeamOperation::Login, Method::POST, "/api/v1/team/login".into(), Some(json!({"endpoint":self.team.endpoint.trim(),"provider_id":self.team.provider})), ctx);
                }
            }
            if let Some(login) = self.team.login.clone() {
                ui.label(if string(&login, "status") == "waiting" { "Finish sign-in in your browser." } else { "Sign-in did not complete. Cancel and try again." });
                if let Some(url) = login["url"].as_str() { ui.hyperlink_to("Open team sign-in", url); }
                if ui.add_enabled(self.team.pending.is_none(), egui::Button::new("Cancel team sign-in")).clicked() { self.team_request(TeamOperation::CancelLogin, Method::DELETE, format!("/api/v1/team/login/{}",path_segment(&string(&login,"id"))), None, ctx); }
            }
            self.team_spaces(ui, ctx, false, can_switch);
            if self.is_team() && self.can_manage() && self.permitted("manage_space") {
                ui.separator(); ui.label("Space members");
                let space = string(self.workspace.as_ref().unwrap(), "space_id");
                if self.team.bindings.is_none() && self.team.pending.is_none() { self.team.bindings = Some(Vec::new()); self.team_request(TeamOperation::Bindings, Method::GET, format!("/api/v1/rat/spaces/{}/bindings",path_segment(&space)), None, ctx); }
                for binding in self.team.bindings.clone().unwrap_or_default() { ui.label(format!("{} · {}", string(&binding,"subject"), string(&binding,"role"))); }
                let label=ui.label("Identity issuer"); ui.text_edit_singleline(&mut self.team.issuer).labelled_by(label.id);
                let label=ui.label("Verified subject"); ui.text_edit_singleline(&mut self.team.subject).labelled_by(label.id);
                egui::ComboBox::new("team-grant-role", "Space role").selected_text(if self.team.grant_role.is_empty() { "Choose role" } else { &self.team.grant_role }).show_ui(ui, |ui| { for role in ["viewer","collaborator","controller","manager"] { ui.selectable_value(&mut self.team.grant_role,role.into(),role); } });
                if ui.add_enabled(self.team.pending.is_none() && !self.team.issuer.is_empty() && !self.team.subject.is_empty() && !self.team.grant_role.is_empty(),egui::Button::new("Grant space role")).clicked() { self.team_request(TeamOperation::Grant,Method::POST,format!("/api/v1/rat/spaces/{}/bindings",path_segment(&space)),Some(json!({"issuer":self.team.issuer,"subject":self.team.subject,"role":self.team.grant_role})),ctx); }
                ui.label(RichText::new("Use the exact issuer and subject from the person's verified team identity.").small().color(theme::MUTED));
            }
            if ui.add_enabled(self.team.pending.is_none(), egui::Button::new("Refresh team accounts")).clicked() { self.team.loaded = false; self.team.bindings = None; }
            self.team_feedback(ui);
        });
    }
    fn team_spaces(&mut self, ui: &mut Ui, ctx: &egui::Context, share: bool, can_switch: bool) {
        for connection in self.team.connections.clone() {
            let id = string(&connection, "id");
            let identity = &connection["identity"];
            let name = identity["label"]
                .as_str()
                .or(identity["subject"].as_str())
                .unwrap_or("Team account");
            ui.horizontal_wrapped(|ui| {
                if ui.add_enabled(self.team.pending.is_none(),egui::Button::new(format!("{name} · spaces"))).clicked() { self.team_request(TeamOperation::Spaces(id.clone()),Method::GET,format!("/api/v1/team/connections/{}/spaces",path_segment(&id)),None,ctx); }
                if !share && ui.button("Copy verified identity").clicked() { ctx.copy_text(json!({"issuer":identity["issuer"],"subject":identity["subject"]}).to_string()); }
                if !share && ui.add_enabled(self.team.pending.is_none(),egui::Button::new("Reconnect")).clicked() { self.team_request(TeamOperation::Login,Method::POST,"/api/v1/team/login".into(),Some(json!({"endpoint":connection["endpoint"],"provider_id":connection["provider"]["id"],"connection_id":id})),ctx); }
                if !share && ui.add_enabled(self.team.pending.is_none(),egui::Button::new("Sign out")).clicked() { self.team_request(TeamOperation::Logout,Method::POST,format!("/api/v1/team/connections/{}/logout",path_segment(&id)),Some(json!({})),ctx); }
            });
            ui.label(
                RichText::new(string(&connection, "endpoint"))
                    .small()
                    .color(theme::MUTED),
            );
        }
        if !self.team.spaces.is_empty() {
            egui::ComboBox::new(("team-space", share), "Team space")
                .selected_text(
                    self.team
                        .spaces
                        .iter()
                        .find(|s| string(s, "id") == self.team.space)
                        .map(|s| format!("{} · {}", string(s, "name"), string(s, "role")))
                        .unwrap_or_else(|| "Choose space".into()),
                )
                .show_ui(ui, |ui| {
                    for space in &self.team.spaces {
                        ui.selectable_value(
                            &mut self.team.space,
                            string(space, "id"),
                            format!("{} · {}", string(space, "name"), string(space, "role")),
                        );
                    }
                });
            if !share
                && ui
                    .add_enabled(
                        can_switch && self.team.pending.is_none(),
                        theme::primary_button("Open team space"),
                    )
                    .clicked()
            {
                self.connect_workspace(json!({"kind":"team","connection_id":self.team.connection,"space_id":self.team.space}),ctx);
            }
        }
    }
    fn team_feedback(&self, ui: &mut Ui) {
        if let Some(error) = &self.team.error {
            ui.label(error);
        }
        if self.loading_is_slow(self.team.pending) {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label("Connecting…");
            });
        }
    }
    pub(super) fn share_window(&mut self, ctx: &egui::Context) {
        if !self.team.share_open {
            return;
        }
        egui::Modal::new(egui::Id::unique("share-session")).show(ctx,|ui| {
            ui.set_width(440.0); ui.heading("Share this Session");
            ui.label("The same agent, history and workspace will continue in your team space. Work can continue after you close this app.");
            if self.team.share_request.is_none() {
                self.team_spaces(ui,ctx,true,false);
                if self.team.connections.is_empty() { ui.label("Connect your team in Workspace to choose a space."); }
                let eligible=self.team.spaces.iter().any(|s| string(s,"id")==self.team.space && Role::parse(&string(s,"role")).contributes());
                if ui.add_enabled(eligible && self.team.pending.is_none(),theme::primary_button("Share Session")).clicked() {
                    let connection=self.team.connections.iter().find(|c| string(c,"id")==self.team.connection).unwrap();
                    let input=json!({"id":uuid::Uuid::new_v4().to_string(),"session_id":self.team.share_source,"endpoint":connection["endpoint"],"connection_id":self.team.connection,"space_id":self.team.space});
                    self.team.share_request=Some(input.clone());
                    self.team_request(TeamOperation::Share,Method::POST,"/api/v1/workspace/shares".into(),Some(input),ctx);
                }
            } else {
                let status=self.team.share.as_ref().map(|s| string(s,"status")).unwrap_or_else(|| "submitting".into());
                ui.label(match status.as_str() { "quiescing"=>"Waiting for the current Turn to finish…", "staging"=>"Saving the Session and workspace…", "released"=>"Activating the hosted Session…", "complete"=>"Shared. Opening the team Session…", "failed"=>"Share needs attention. Your Session remains protected from duplicate execution.", _=>"Confirming the Share request…" });
                if let Some(error)=self.team.share.as_ref().and_then(|s| s["error"].as_str()) { ui.label(error); }
                if status == "failed" && self.team.share.as_ref().is_some_and(|share| share["can_abort"] == true) && self.team.pending.is_none() && ui.button("Keep local").clicked()
                    && let Some(share) = &self.team.share { self.team_request(TeamOperation::AbortShare, Method::DELETE, format!("/api/v1/workspace/shares/{}", path_segment(&string(share,"id"))), None, ctx); }
                if self.team.pending.is_none() && (self.team.error.is_some() || matches!(status.as_str(),"failed"|"complete")) && ui.button("Retry Share").clicked() {
                    let path=self.team.share.as_ref().map(|s|format!("/api/v1/workspace/shares/{}",path_segment(&string(s,"id")))).unwrap_or_else(||"/api/v1/workspace/shares".into());
                    self.team_request(TeamOperation::Share,Method::POST,path,self.team.share_request.clone(),ctx);
                }
            }
            self.team_feedback(ui);
            if ui.button("Close").clicked() { self.team.share_open=false; }
        });
    }
}

fn share_request(share: &Value) -> Value {
    json!({"id":share["id"],"session_id":share["source_session_id"],"endpoint":share["destination"]["baseURL"],"space_id":share["destination"]["space_id"],"connection_id":share["destination"]["connection_id"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui_kittest::{Harness, kittest::Queryable};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
    };

    fn activity(id: &str, role: &str, text: &str) -> Value {
        json!({"session":{"id":id,"object":"agent.session","metadata":{"name":"Shared goal"}},
            "items":[{"id":"msg_1","type":"message","role":"user","content":[{"type":"input_text","text":text}]}],
            "turns":[],"inputs":[{"actor":{"id":"other-person","label":"Morgan"},"message_ids":["msg_1"]}],
            "cursor":format!("act_{id}_1"),"role":role,"permissions":if role == "viewer" {json!(["read"])} else {json!(["read","contribute","create_session"])}})
    }
    #[test]
    fn imported_actor_claims_are_labelled_as_imported() {
        let mut value = activity("sess_shared", "viewer", "Past contribution");
        value["inputs"][0]["provenance"] = json!({"kind":"imported","operation_id":"share"});
        let snapshot = SessionSnapshot::from_activity(value).unwrap();
        assert_eq!(snapshot.actor_labels["msg_1"], "Morgan (imported)");
    }
    fn app(endpoint: String) -> ConsoleApp {
        let mut app = ConsoleApp::new(endpoint, "fixture".into()).unwrap();
        app.initialized = true;
        app.workspace = Some(
            json!({"kind":"team","role":"collaborator","name":"Team space","permissions":["read","contribute","create_session"]}),
        );
        let snapshot = SessionSnapshot::from_activity(activity(
            "sess_shared",
            "collaborator",
            "Saved shared message",
        ))
        .unwrap();
        app.resources = vec![snapshot.session.clone()];
        app.selected = Some(snapshot.session.clone());
        app.selected_id = Some("sess_shared".into());
        app.snapshot = Some(snapshot);
        app.messages
            .insert("sess_shared".into(), "Keep my draft".into());
        app.team.authority_due = Some(Instant::now() + Duration::from_secs(60));
        app.team.loaded = true;
        app.team.saved_shares_loaded = true;
        app
    }
    fn held_response(
        status: u16,
        body: Value,
    ) -> (
        String,
        mpsc::Receiver<()>,
        mpsc::Sender<()>,
        std::thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (arrived, received) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0];
            while !headers.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            assert!(
                String::from_utf8_lossy(&headers)
                    .contains("/api/v1/rat/sessions/sess_shared/activity")
            );
            arrived.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            let body = body.to_string();
            write!(stream,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        });
        (endpoint, received, release, server)
    }
    fn harness(app: ConsoleApp) -> Harness<'static, ConsoleApp> {
        let mut harness = Harness::new_ui_state(
            |ui, app: &mut ConsoleApp| {
                theme::apply(ui.ctx());
                app.show(ui);
            },
            app,
        );
        harness.set_size(egui::vec2(1280.0, 850.0));
        harness.run_steps(2);
        harness
    }
    fn receive(harness: &mut Harness<'_, ConsoleApp>) {
        for _ in 0..100 {
            harness.step();
            if harness.state().snapshot_pending.is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn roles_fail_closed() {
        assert!(!Role::parse("viewer").contributes());
        assert!(Role::parse("collaborator").contributes());
        assert!(!Role::parse("collaborator").controls());
        assert!(Role::parse("controller").controls());
        assert_eq!(Role::parse("owner"), Role::NoAccess);
        assert!(!Role::parse("").contributes());
    }
    #[test]
    fn held_activity_retains_history_and_draft_then_applies_viewer_controls() {
        let (endpoint, received, release, server) =
            held_response(200, activity("sess_shared", "viewer", "New shared message"));
        let mut ui = harness(app(endpoint));
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            ui.get_by_label("Message").value().as_deref(),
            Some("Keep my draft")
        );
        assert!(ui.query_by_label("Morgan").is_some());
        assert!(ui.query_by_label("You").is_none());
        assert!(ui.query_by_label("Loading session…").is_none());
        std::thread::sleep(LOADING_FEEDBACK_DELAY + Duration::from_millis(30));
        ui.step();
        assert_eq!(
            ui.get_by_label("Message").value().as_deref(),
            Some("Keep my draft")
        );
        release.send(()).unwrap();
        server.join().unwrap();
        receive(&mut ui);
        assert_eq!(ui.state().role(), Role::Viewer);
        assert!(ui.query_by_label("Message").is_none());
        assert!(ui.query_by_label("Send").is_none());
        assert!(ui.query_by_label("Cancel turn").is_none());
        assert_eq!(
            ui.state().snapshot.as_ref().unwrap().items[0].fields["content"][0]["text"],
            "New shared message"
        );
    }
    #[test]
    fn failed_activity_refresh_keeps_the_last_history_and_draft() {
        let (endpoint, received, release, server) =
            held_response(503, json!({"error":{"message":"Temporarily unavailable"}}));
        let mut ui = harness(app(endpoint));
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        release.send(()).unwrap();
        server.join().unwrap();
        receive(&mut ui);
        assert_eq!(ui.state().selected_id.as_deref(), Some("sess_shared"));
        assert_eq!(
            ui.get_by_label("Message").value().as_deref(),
            Some("Keep my draft")
        );
        assert_eq!(
            ui.state().snapshot.as_ref().unwrap().items[0].fields["content"][0]["text"],
            "Saved shared message"
        );
        assert!(ui.state().error.is_some());
    }

    #[test]
    fn revoked_activity_clears_content_and_render_caches() {
        let (endpoint, received, release, server) =
            held_response(403, json!({"error":{"message":"Membership revoked"}}));
        let mut ui = harness(app(endpoint));
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        release.send(()).unwrap();
        server.join().unwrap();
        receive(&mut ui);
        assert!(ui.state().snapshot.is_none());
        assert!(ui.state().resources.is_empty());
        assert!(ui.state().messages.is_empty());
        assert!(ui.state().rendered_markdown.is_empty());
        assert!(ui.state().selected_id.is_none());
        assert_eq!(ui.state().role(), Role::NoAccess);
    }
    #[test]
    fn held_activity_cannot_replace_a_new_selection() {
        let (endpoint, received, release, server) =
            held_response(200, activity("sess_shared", "viewer", "Late old response"));
        let mut ui = harness(app(endpoint));
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        let next =
            SessionSnapshot::from_activity(activity("sess_other", "collaborator", "New selection"))
                .unwrap();
        let state = ui.state_mut();
        state.selection_generation += 1;
        state.selected = Some(next.session.clone());
        state.selected_id = Some(next.session.id.clone());
        state.snapshot = Some(next);
        state.next_refresh = Instant::now() + Duration::from_secs(60);
        release.send(()).unwrap();
        server.join().unwrap();
        receive(&mut ui);
        assert_eq!(ui.state().selected_id.as_deref(), Some("sess_other"));
        assert_eq!(ui.state().role(), Role::Collaborator);
    }
    #[test]
    fn share_ambiguity_preserves_id_and_handoff_opens_the_same_session() {
        let mut app = app("http://127.0.0.1:1".into());
        let ctx = egui::Context::default();
        app.workspace = Some(json!({"kind":"local"}));
        let request = json!({"id":uuid::Uuid::new_v4().to_string(),"session_id":"sess_shared","endpoint":"https://team.example/v1","connection_id":"connection","space_id":"space"});
        app.team.share_request = Some(request.clone());
        app.team.share_open = true;
        app.receive_team(TeamOperation::Share, Err("Response lost".into()), &ctx);
        assert_eq!(app.team.share_request, Some(request.clone()));
        assert!(app.share_fenced());
        assert!(!app.can_contribute());
        assert_eq!(
            app.messages.get("sess_shared").map(String::as_str),
            Some("Keep my draft")
        );
        app.receive_team(TeamOperation::Share,Ok(Data::Local(json!({"id":request["id"],"status":"complete","source_session_id":"sess_shared","destination_session_id":"sess_shared","destination":{"connection_id":"connection","space_id":"space"}}))),&ctx);
        assert_eq!(app.cloud_session_to_open.as_deref(), Some("sess_shared"));
        assert!(!app.team.share_open);
        assert_eq!(
            app.messages.get("sess_shared").map(String::as_str),
            Some("Keep my draft")
        );
    }
    #[test]
    fn completing_share_preserves_navigation_to_another_session() {
        let mut app = app("http://127.0.0.1:1".into());
        let ctx = egui::Context::default();
        app.workspace = Some(json!({"kind":"local"}));
        app.selected_id = Some("sess_other".into());
        app.receive_team(TeamOperation::Share,Ok(Data::Local(json!({"id":"share-a","status":"complete","source_session_id":"sess_shared","destination_session_id":"sess_shared","destination":{"connection_id":"connection","space_id":"space"}}))),&ctx);
        assert!(app.workspace_pending.is_none());
        assert!(app.cloud_session_to_open.is_none());
        assert_eq!(app.selected_id.as_deref(), Some("sess_other"));
        assert_eq!(app.team.saved_shares.len(), 1);
    }

    #[test]
    fn ambiguous_input_reuses_the_same_request_key() {
        let mut app = app("http://127.0.0.1:1".into());
        let ctx = egui::Context::default();
        let event = json!({"type":"agent.session.input.message","input":"hello"});
        app.send_events(
            "sess_shared",
            vec![event.clone()],
            Some("hello".into()),
            None,
            &ctx,
        );
        let key = app.submission_keys.values().next().unwrap().clone();
        app.mutation_pending = None;
        app.send_events("sess_shared", vec![event], Some("hello".into()), None, &ctx);
        assert_eq!(app.submission_keys.len(), 1);
        assert_eq!(app.submission_keys.values().next(), Some(&key));
    }
}
