//! Drives the shipped native application through AccessKit and real HTTP services.
//! Only the isolated worker/external secret store are deterministic fixture ports.
mod support;
use egui::{Key, Modifiers, Vec2, accesskit::Role};
use egui_kittest::{
    Harness,
    kittest::{NodeT, Queryable},
};
use rat_things_desktop::ConsoleApp;
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use support::*;

struct Fixture {
    // Drop the proxy before the upstream. Its stdin stays open while the app runs.
    proxy: Server,
    upstream: Server,
    token: String,
    client: Client,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::var_os("RAT_THINGS_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .to_owned()
            });
        let upstream = Server::spawn(&root, "testing/native-console/server.ts", &[]);
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let proxy = Server::spawn(
            &root,
            "scripts/console-server.ts",
            &[
                ("AGENTS_API_BASE_URL", &upstream.url),
                ("AGENT_RUNTIME_UNSIGNED", "true"),
                ("RAT_THINGS_LOCAL_OWNER", "console-owner"),
                ("RAT_THINGS_CONSOLE_PORT", "0"),
                ("RAT_THINGS_CONSOLE_TOKEN", &token),
                ("RAT_THINGS_CONSOLE_LAUNCHER", "1"),
            ],
        );
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        Self {
            proxy,
            upstream,
            token,
            client,
            root,
        }
    }

    fn app(&self) -> App {
        Harness::builder()
            .with_size(Vec2::new(1280.0, 850.0))
            .build_eframe(|_| ConsoleApp::new(self.proxy.url.clone(), self.token.clone()).unwrap())
    }

    fn control(&self, path: &str, body: Value) {
        self.client
            .post(format!("{}{path}", self.upstream.url))
            .json(&body)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap();
    }

    fn state(&self) -> Value {
        self.client
            .get(format!("{}/__test/state", self.upstream.url))
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    }

    fn get(&self, path: &str) -> Value {
        self.client
            .get(format!("{}/api{path}", self.proxy.url))
            .bearer_auth(&self.token)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    }

    fn post(&self, path: &str, body: Value) -> Value {
        self.client
            .post(format!("{}/api{path}", self.proxy.url))
            .bearer_auth(&self.token)
            .header("x-rat-console-request", "1")
            .json(&body)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    }

    fn screenshot(&self, app: &mut App, name: &str) {
        let directory = self.root.join("test-results/native-console");
        std::fs::create_dir_all(&directory).unwrap();
        app.remove_cursor();
        app.run_steps(3);
        app.render()
            .expect("render the real egui widgets with wgpu")
            .save(directory.join(name))
            .unwrap();
    }
}

fn assert_no_secret(app: &App, secret: &str) {
    assert!(
        !format!("{:#?}", app.root()).contains(secret),
        "Secret must not remain in the accessibility tree"
    );
    assert!(app.query_all_by_value(secret).next().is_none());
}

fn request_with_event(state: &Value, kind: &str) -> Value {
    state["received"]
        .as_array()
        .unwrap()
        .iter()
        .find(|request| {
            request["body"]["events"]
                .as_array()
                .is_some_and(|events| events.iter().any(|event| event["type"] == kind))
        })
        .unwrap_or_else(|| panic!("No request for event {kind}"))
        .clone()
}

fn choose_model(app: &mut App, option: &str) {
    until(app, "available model dropdown", |app| {
        app.query_by_role_and_label(Role::ComboBox, "Model")
            .is_some_and(|node| !node.accesskit_node().is_disabled())
    });
    app.get_by_role_and_label(Role::ComboBox, "Model")
        .scroll_to_me();
    tick(app);
    app.get_by_role_and_label(Role::ComboBox, "Model").click();
    tick(app);
    click(app, option);
}

#[test]
fn pi_session_selects_bedrock_model_rejects_unsupported_effort_and_reads_runtime_pin() {
    let f = Fixture::new();
    let mut app = f.app();
    click(&mut app, "New session");
    app.get_by_role_and_label(Role::ComboBox, "Runtime").click();
    tick(&mut app);
    click(&mut app, "Pi");
    choose_model(&mut app, "amazon.nova-2-lite-v1:0");
    visible(&mut app, "Reasoning effort: model default only");
    fill(&mut app, "Name", "Pi Bedrock review");
    fill(
        &mut app,
        "Task",
        "Review this task with the pinned Pi runtime",
    );
    f.screenshot(&mut app, "pi-session-form-1280x850.png");

    let mut draft = model_draft(&mut app);
    assert_eq!(draft["metadata"]["rat_things_runtime"], "pi");
    assert_eq!(draft["agent"]["model"], "amazon.nova-2-lite-v1:0");
    draft["agent"]["reasoning"] = json!({"effort":"high"});
    fill(&mut app, "Configuration JSON", &draft.to_string());
    click(&mut app, "Advanced JSON");
    click(&mut app, "Create");
    visible(
        &mut app,
        "The Pi model does not support this reasoning effort.",
    );
    assert_eq!(f.state()["sessionCount"], 0);
    assert!(
        !f.state()["received"]
            .as_array()
            .unwrap()
            .iter()
            .any(|request| {
                request["method"] == "POST" && request["path"] == "/v1/agents/sessions"
            })
    );
    f.screenshot(&mut app, "pi-unsupported-effort-1280x850.png");

    let rejected = f
        .client
        .post(format!("{}/api/v1/agents/sessions", f.proxy.url))
        .bearer_auth(&f.token)
        .header("x-rat-console-request", "1")
        .json(&draft)
        .send()
        .unwrap();
    assert_eq!(rejected.status(), 400);
    assert_eq!(
        rejected.json::<Value>().unwrap()["error"]["param"],
        "agent.reasoning.effort"
    );
    assert_eq!(f.state()["sessionCount"], 0);

    draft["agent"]["reasoning"] = json!({"effort":null});
    advanced_json(&mut app);
    fill(&mut app, "Configuration JSON", &draft.to_string());
    click(&mut app, "Advanced JSON");
    click(&mut app, "Create");
    visible(&mut app, "Message");
    visible(&mut app, "Runtime pi");
    let session = f.get("/v1/agents/sessions")["data"][0].clone();
    assert_eq!(session["agent"]["model"], "amazon.nova-2-lite-v1:0");
    let id = session["id"].as_str().unwrap();
    let runtime_path = format!("/v1/agents/sessions/{id}/runtime");
    let runtime = f.get(&runtime_path);
    assert_eq!(runtime["runtime"], "pi");
    assert_eq!(runtime["version"], "1.3.0");
    assert_eq!(runtime["model"], "amazon.nova-2-lite-v1:0");
    assert_eq!(runtime["catalog_digest"].as_str().unwrap().len(), 64);
    assert!(
        f.state()["received"]
            .as_array()
            .unwrap()
            .iter()
            .any(|request| { request["method"] == "GET" && request["path"] == runtime_path })
    );
    f.screenshot(&mut app, "pi-session-runtime-1280x850.png");

    let updated = f.post(
        &format!("/v1/agents/sessions/{id}"),
        json!({
            "metadata":{"name":"Pi Bedrock review"}
        }),
    );
    assert!(updated["metadata"].get("rat_things_runtime").is_none());
    assert_eq!(f.get(&runtime_path), runtime);
    drop(app);
    let mut reopened = f.app();
    click(&mut reopened, "Pi Bedrock review");
    visible(&mut reopened, "Runtime pi");
    f.screenshot(&mut reopened, "pi-session-reopened-1280x850.png");
}

#[test]
fn sidebar_keeps_long_titles_compact_and_names_new_conversations() {
    let f = Fixture::new();
    let long_title = "Review the deployment configuration and browser integration before publishing the next release";
    for (name, prompt) in [
        (Some(long_title), "Check the release"),
        (None, "Inspect the existing workspace files"),
    ] {
        f.client.post(format!("{}/api/v1/agents/sessions", f.proxy.url))
            .bearer_auth(&f.token)
            .header("x-rat-console-request", "1")
            .json(&json!({"agent":{"model":"fixture-model"}, "environment":{"type":"none"},
                "metadata":name.map(|name| json!({"name":name})).unwrap_or(json!({})), "input":prompt}))
            .send().unwrap().error_for_status().unwrap();
    }
    let mut app = f.app();
    click(&mut app, "Untitled session");
    until(&mut app, "history-derived sidebar title", |app| {
        app.query_by_role_and_label(Role::Button, "Inspect the existing workspace files")
            .is_some()
    });
    click(&mut app, "New session");
    choose_model(&mut app, "fixture-fast");
    fill(&mut app, "Task", "Summarize the release checklist");
    click(&mut app, "Create");
    until(&mut app, "prompt-derived title", |app| {
        app.query_by_role_and_label(Role::Button, "Summarize the release checklist")
            .is_some()
    });
    assert!(
        f.get("/v1/agents/sessions")["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["metadata"]["name"] == "Summarize the release checklist")
    );
    for size in [Vec2::new(1280.0, 850.0), Vec2::new(900.0, 650.0)] {
        app.set_size(size);
        tick(&mut app);
        for label in [
            long_title,
            "Inspect the existing workspace files",
            "Summarize the release checklist",
        ] {
            let rect = app.get_by_role_and_label(Role::Button, label).rect();
            assert!(
                rect.height() <= 32.0,
                "sidebar title must not wrap: {rect:?}"
            );
            assert!(
                rect.min.x >= 0.0 && rect.max.x <= 232.0,
                "sidebar title must fit: {rect:?}"
            );
        }
        f.screenshot(
            &mut app,
            &format!("sidebar-{}x{}.png", size.x as u32, size.y as u32),
        );
    }
    drop(app);
    let mut reopened = f.app();
    visible(&mut reopened, "Summarize the release checklist");
}

#[test]
fn refresh_preserves_visible_content_drafts_and_selection() {
    let f = Fixture::new();
    let mut app = f.app();
    click(&mut app, "New session");
    choose_model(&mut app, "fixture-fast");
    fill(&mut app, "Name", "Refresh continuity");
    fill(&mut app, "Task", "Keep this conversation visible");
    click(&mut app, "Create");
    visible(&mut app, "Message");
    fill(&mut app, "Message", "Keep my unsent draft");
    let message_rect = app.get_by_label("Message").rect();
    f.control("/__test/reads", json!({"hold":true}));
    // The very first frame after Refresh must retain the transcript/composer,
    // without inserting a loading indicator for a near-immediate request.
    click(&mut app, "List options");
    app.get_by_role_and_label(Role::Button, "Refresh").click();
    app.run_steps(2);
    assert!(app.query_all_by_label_contains("Loading").next().is_none());
    assert!(app.query_by_label("Updating…").is_none());
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Keep my unsent draft")
    );
    assert_eq!(app.get_by_label("Message").rect(), message_rect);
    visible(&mut app, "Updating…");
    assert!(
        app.query_by_label("Keep this conversation visible")
            .is_some()
    );
    assert_eq!(app.get_by_label("Message").rect(), message_rect);
    click(&mut app, "Refresh continuity");
    click(&mut app, "Sessions");
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Keep my unsent draft")
    );
    f.screenshot(&mut app, "refresh-pending-1280x850.png");
    // Failure must preserve the old content too, and a later refresh recovers.
    f.control("/__test/reads", json!({"fail":true}));
    visible(&mut app, "Dismiss error");
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Keep my unsent draft")
    );
    f.control("/__test/reads", json!({}));
    click(&mut app, "Refresh");
    until(&mut app, "refresh recovery", |app| {
        app.query_by_label("Updating…").is_none() && app.query_by_label("Dismiss error").is_none()
    });
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Keep my unsent draft")
    );

    f.control("/__test/seed", json!({}));
    click(&mut app, "Agents");
    click(&mut app, "Load more");
    click(&mut app, "Agent 0");
    visible(&mut app, "Edit agent");
    f.control("/__test/reads", json!({"hold":true}));
    click(&mut app, "Refresh");
    visible(&mut app, "Updating…");
    assert!(
        app.query_by_role_and_label(Role::Button, "Edit agent")
            .is_some()
    );
    assert!(app.query_by_label("Loading resource details…").is_none());
    // Navigate while old responses are held; they must never overwrite the new selection.
    click(&mut app, "Sessions");
    f.control("/__test/reads", json!({}));
    click(&mut app, "Refresh continuity");
    visible(&mut app, "Message");
    assert!(
        app.query_by_role_and_label(Role::Button, "Edit agent")
            .is_none()
    );
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Keep my unsent draft")
    );
    click(&mut app, "New session");
    choose_model(&mut app, "fixture-fast");
    f.control("/__test/reads", json!({"hold":true}));
    app.get_by_role_and_label(Role::Button, "Refresh models")
        .click();
    app.run_steps(2);
    assert!(app.query_by_label("Loading available models…").is_none());
    assert!(
        !app.get_by_role_and_label(Role::ComboBox, "Model")
            .accesskit_node()
            .is_disabled()
    );
    visible(&mut app, "Loading available models…");
    choose_model(&mut app, "fixture-model");
    click(&mut app, "Cancel");
    f.control("/__test/reads", json!({}));
}

fn session_context_menu(app: &mut App, title: &str, action: &str) {
    until(app, title, |app| {
        app.query_by_role_and_label(Role::Button, title).is_some()
    });
    app.get_by_role_and_label(Role::Button, title)
        .scroll_to_me();
    tick(app);
    app.get_by_role_and_label(Role::Button, title)
        .click_secondary();
    visible(app, action);
}

#[test]
fn sessions_archive_from_context_menu_and_restore_after_reopening() {
    let f = Fixture::new();
    let mut ids = Vec::new();
    for title in ["Keep open", "Archive this"] {
        let session = f.post("/v1/agents/sessions", json!({
            "agent":{"model":"fixture-model"}, "environment":{"type":"none"},
            "metadata":{"name":title,"project":"preserved"}, "input":"Saved conversation history"
        }));
        ids.push(session["id"].as_str().unwrap().to_owned());
    }
    let mut app = f.app();
    click(&mut app, "Keep open");
    fill(
        &mut app,
        "Message",
        "Unsent draft survives archiving another session",
    );
    // Update metadata independently after the sidebar loaded; archive must merge
    // the current server record rather than overwrite it with cached metadata.
    f.post(
        &format!("/v1/agents/sessions/{}", ids[1]),
        json!({"metadata":{
            "name":"Archive this","project":"preserved","external":"new value"
        }}),
    );
    session_context_menu(&mut app, "Archive this", "Archive session");
    f.screenshot(&mut app, "session-archive-context-menu.png");
    click(&mut app, "Archive session");
    until(&mut app, "archived row hidden", |app| {
        app.query_by_role_and_label(Role::Button, "Archive this")
            .is_none()
    });
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Unsent draft survives archiving another session")
    );
    let archived = f.get(&format!("/v1/agents/sessions/{}", ids[1]));
    assert_eq!(
        archived["metadata"],
        json!({"name":"Archive this","project":"preserved","external":"new value","rat_things_archived":"true"})
    );
    assert_eq!(f.state()["sessionCount"], 2);
    assert!(
        !f.get(&format!("/v1/agents/sessions/{}/items", ids[1]))["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // Failure leaves the visible session in place and keeps its draft.
    f.control("/__test/reads", json!({"fail":true}));
    session_context_menu(&mut app, "Keep open", "Archive session");
    click(&mut app, "Archive session");
    visible(&mut app, "Dismiss error");
    assert!(
        app.query_by_role_and_label(Role::Button, "Keep open")
            .is_some()
    );
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Unsent draft survives archiving another session")
    );
    f.control("/__test/reads", json!({}));
    drop(app);

    let mut reopened = f.app();
    visible(&mut reopened, "Keep open");
    assert!(
        reopened
            .query_by_role_and_label(Role::Button, "Archive this")
            .is_none()
    );
    click(&mut reopened, "Archived sessions");
    click(&mut reopened, "Archive this");
    visible(&mut reopened, "Message");
    contains(&mut reopened, "Saved conversation history");
    session_context_menu(&mut reopened, "Archive this", "Unarchive session");
    click(&mut reopened, "Unarchive session");
    until(
        &mut reopened,
        "unarchived row removed from archive",
        |app| {
            app.query_by_role_and_label(Role::Button, "Archive this")
                .is_none()
        },
    );
    assert!(
        reopened.query_by_label("Message").is_none(),
        "archiving/unarchiving the selected row clears only that selection"
    );
    click(&mut reopened, "Back to sessions");
    click(&mut reopened, "Archive this");
    visible(&mut reopened, "Message");
    let restored = f.get(&format!("/v1/agents/sessions/{}", ids[1]));
    assert!(restored["metadata"].get("rat_things_archived").is_none());
    assert_eq!(restored["metadata"]["external"], "new value");
    assert!(
        !f.state()["received"]
            .as_array()
            .unwrap()
            .iter()
            .any(|request| request["method"] == "DELETE"
                || request["body"]
                    .to_string()
                    .contains("agent.session.input.cancel"))
    );
}

#[test]
fn session_index_includes_later_pages_and_preserves_archive_filter() {
    let f = Fixture::new();
    for index in 0..26 {
        f.post("/v1/agents/sessions", json!({"agent":{"model":"fixture-model"},
            "environment":{"type":"none"}, "input":"Archived conversation", "metadata":{"name":format!("Archived {index}"),"rat_things_archived":"true"}}));
    }
    let sessions = f.get("/v1/agents/sessions?limit=100&order=desc");
    let oldest = sessions["data"].as_array().unwrap().last().unwrap();
    f.post(
        &format!("/v1/agents/sessions/{}", oldest["id"].as_str().unwrap()),
        json!({"metadata":{"name":"Older active session"}}),
    );
    let mut app = f.app();
    visible(&mut app, "Older active session");
    assert_eq!(
        app.query_all_by_label_contains("Archived ")
            .filter(|node| node.accesskit_node().role() == Role::Button)
            .count(),
        1
    );
    click(&mut app, "Archived sessions");
    assert!(
        app.query_by_role_and_label(Role::Button, "Older active session")
            .is_none()
    );
    assert_eq!(
        app.query_all_by_label_contains("Archived ")
            .filter(|node| node.accesskit_node().role() == Role::Button)
            .count(),
        25
    );
}

#[test]
fn session_environment_picker_uses_templates_and_preserves_custom_configuration() {
    let f = Fixture::new();
    let template = f.post(
        "/v1/agents/environments/templates",
        json!({
            "name":"Rust workspace", "packages":{"npm":["typescript"]},
            "network":{"access":"disabled"}, "capability_directories":["/workspace/tools"]
        }),
    );
    let template_id = template["id"].as_str().unwrap();
    let mut app = f.app();
    click(&mut app, "New session");
    choose_model(&mut app, "fixture-fast");
    until(&mut app, "templates loaded", |app| {
        !app.get_by_role_and_label(Role::Button, "Refresh templates")
            .accesskit_node()
            .is_disabled()
    });
    app.get_by_role_and_label(Role::ComboBox, "Environment")
        .click();
    tick(&mut app);
    click(&mut app, "Rust workspace");
    fill(&mut app, "Task", "Inspect the prepared workspace");
    f.screenshot(&mut app, "session-environment-template.png");
    click(&mut app, "Create");
    visible(&mut app, "Message");
    let session = f.get("/v1/agents/sessions")["data"][0].clone();
    assert_eq!(session["environment"]["type"], "openai_hosted");
    click(&mut app, "Details");
    visible(&mut app, "Rat Things managed");
    app.key_press(Key::Escape);
    tick(&mut app);
    assert!(
        app.query_all_by_label_contains("openai hosted")
            .next()
            .is_none()
    );
    assert!(
        app.query_all_by_label_contains(session["environment"]["id"].as_str().unwrap())
            .next()
            .is_none()
    );
    f.screenshot(&mut app, "session-rat-things-environment.png");
    assert_eq!(
        session["environment"]["packages"]["npm"],
        json!(["typescript"])
    );
    assert_eq!(session["environment"]["network"]["access"], "disabled");
    assert_eq!(
        session["environment"]["capability_directories"],
        json!(["/workspace/tools"])
    );
    assert!(
        f.state()["received"]
            .as_array()
            .unwrap()
            .iter()
            .any(|request| request["path"] == "/v1/agents/sessions"
                && request["method"] == "POST"
                && request["body"]["environment"]
                    == json!({"type":"openai_hosted","environment_template_id":template_id}))
    );

    click(&mut app, "Templates");
    click(&mut app, "Rust workspace");
    click(&mut app, "Start session");
    assert_eq!(
        model_draft(&mut app)["environment"]["environment_template_id"],
        template_id
    );
    click(&mut app, "Advanced JSON");
    f.control("/__test/reads", json!({"hold":true}));
    click(&mut app, "Refresh templates");
    visible(&mut app, "Loading environment templates…");
    assert!(
        !app.get_by_role_and_label(Role::ComboBox, "Environment")
            .accesskit_node()
            .is_disabled()
    );
    f.control("/__test/reads", json!({"fail":true}));
    visible(&mut app, "Could not load environment templates.");
    f.control("/__test/reads", json!({}));
    click(&mut app, "Retry templates");
    until(&mut app, "template refresh recovery", |app| {
        app.query_by_label("Could not load environment templates.")
            .is_none()
    });
    let mut custom = model_draft(&mut app);
    custom["environment"]["env"] = json!({"WORKSPACE_MODE":"review"});
    fill(&mut app, "Configuration JSON", &custom.to_string());
    click(&mut app, "Advanced JSON");
    fill(&mut app, "Name", "Keep inline overrides");
    assert_eq!(model_draft(&mut app)["environment"], custom["environment"]);
    custom["environment"] =
        json!({"type":"self_hosted","workspace_directory":"/workspace/project"});
    fill(&mut app, "Configuration JSON", &custom.to_string());
    click(&mut app, "Advanced JSON");
    fill(&mut app, "Name", "Keep self-hosted configuration");
    assert_eq!(model_draft(&mut app)["environment"], custom["environment"]);
    click(&mut app, "Cancel");
}

#[test]
fn native_console_real_service_journey() {
    let mut f = Fixture::new();
    assert!(f.proxy.process_is_running());
    assert!(f.upstream.process_is_running());
    let mut app = f.app();
    click(&mut app, "New session");
    visible(&mut app, "Task");
    assert!(
        app.query_by_label("Configuration JSON").is_none(),
        "creating a Session should start with a usable form"
    );
    fill(&mut app, "Name", "Release review");
    choose_model(&mut app, "fixture-fast");
    fill(
        &mut app,
        "Task",
        "Review the deployment plan and check whether this release is ready. Highlight any risks and the next steps.",
    );
    app.get_by_role_and_label(Role::ComboBox, "Model")
        .scroll_to_me();
    tick(&mut app);
    app.get_by_role_and_label(Role::ComboBox, "Model").click();
    tick(&mut app);
    f.screenshot(&mut app, "model-options-1280x850.png");
    click(&mut app, "fixture-fast");
    f.screenshot(&mut app, "new-session-form-1280x850.png");
    click(&mut app, "Create");
    until(&mut app, "Session form to close after persistence", |app| {
        app.query_by_label("Cancel").is_none()
    });
    contains(&mut app, "Release review");
    contains(&mut app, "Turn in progress");
    let session = f.get("/v1/agents/sessions")["data"][0].clone();
    let session_id = session["id"].as_str().unwrap();
    assert_eq!(f.state()["sessionCount"], 1);
    assert_eq!(session["agent"]["model"], "fixture-fast");
    assert_eq!(session["metadata"]["name"], "Release review");
    contains(&mut app, "Review the deployment plan");
    f.screenshot(&mut app, "session-active-1280x850.png");
    app.set_size(Vec2::new(900.0, 650.0));
    f.screenshot(&mut app, "session-active-900x650.png");
    app.set_size(Vec2::new(1280.0, 850.0));
    tick(&mut app);

    fill(&mut app, "Message", "Include the deployment configuration.");
    click(&mut app, "Steer");
    until(&mut app, "steering request", |_| {
        f.state()["received"]
            .as_array()
            .unwrap()
            .iter()
            .any(|request| {
                request["body"]
                    .to_string()
                    .contains("Include the deployment configuration.")
            })
    });
    let steer = request_with_event(&f.state(), "agent.session.input.message");
    assert!(steer["key"].as_str().is_some_and(|key| !key.is_empty()));

    f.control("/__test/advance", json!({"mode":"question"}));
    visible(&mut app, "Result for lookup");
    assert_eq!(
        app.get_by_label("Result for lookup").value().as_deref(),
        Some("")
    );
    click(&mut app, "Send tool result");
    until(&mut app, "tool result consumed", |app| {
        app.query_by_label("Result for lookup").is_none()
    });
    let result = request_with_event(&f.state(), "agent.session.input.tool_result");
    assert_eq!(result["body"]["events"][0]["output"], "");
    assert_eq!(result["body"]["events"][0]["success"], true);
    assert_eq!(result["body"]["events"][0]["call_id"], "call-lookup");
    assert!(result["key"].as_str().is_some_and(|key| !key.is_empty()));

    f.control("/__test/advance", json!({"mode":"complete"}));
    contains(&mut app, "Review complete.");
    contains(&mut app, "npm run check");
    f.screenshot(&mut app, "session-1280x850.png");
    drop(app);
    let mut app = f.app();
    click(&mut app, "Release review");
    contains(&mut app, "Review complete.");
    contains(&mut app, "npm run check");
    assert!(
        app.query_by_role_and_label(Role::Link, "Unsafe").is_none(),
        "unsafe URL must not be an actionable link"
    );
    assert!(
        app.query_all_by_role(Role::Image).next().is_none(),
        "transcript must not fetch remote images"
    );
    app.get_by_role_and_label(Role::Link, "Runbook")
        .scroll_to_me();
    tick(&mut app);
    app.get_by_role_and_label(Role::Link, "Runbook").click();
    app.step();
    assert!(
        app.output()
            .platform_output
            .commands
            .iter()
            .any(|command| matches!(command,
        egui::OutputCommand::OpenUrl(url) if url.url == "https://example.com/runbook")),
        "clicking a safe link must emit its exact browser destination"
    );
    visible(&mut app, "Files (1)");
    assert!(
        app.query_by_label("Save report.txt").is_none(),
        "file actions stay out of the conversation until requested"
    );
    assert!(app.query_by_label("Artifacts").is_none());
    fill(&mut app, "Message", "Keep this unsent draft.");
    app.get_by_role_and_label(Role::Button, "Files (1)").focus();
    tick(&mut app);
    app.key_press(Key::Space);
    visible(&mut app, "Save report.txt");
    f.screenshot(&mut app, "files-open-1280x850.png");
    app.set_size(Vec2::new(900.0, 650.0));
    tick(&mut app);
    visible(&mut app, "Save report.txt");
    f.screenshot(&mut app, "files-open-900x650.png");
    for label in ["Files (1)", "Save report.txt", "Message"] {
        let rect = app.get_by_label(label).rect();
        assert!(
            rect.min.x >= 0.0 && rect.min.y >= 0.0 && rect.max.x <= 900.0 && rect.max.y <= 650.0,
            "{label} remains within the narrow viewport: {rect:?}"
        );
    }
    let file_name_position = app
        .get_by_role_and_label(Role::Label, "report.txt")
        .rect()
        .center();
    app.hover_at(file_name_position);
    for pressed in [true, false] {
        app.event(egui::Event::PointerButton {
            pos: file_name_position,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: Modifiers::NONE,
        });
        tick(&mut app);
    }
    assert!(
        app.query_by_label("Save report.txt").is_some(),
        "interacting inside the file list keeps it open"
    );
    app.key_press(Key::Escape);
    tick(&mut app);
    assert!(app.query_by_label("Save report.txt").is_none());
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Keep this unsent draft.")
    );
    assert!(
        app.get_by_role_and_label(Role::Button, "Files (1)")
            .is_focused(),
        "Escape returns keyboard focus to the files trigger"
    );
    app.set_size(Vec2::new(1280.0, 850.0));
    tick(&mut app);
    click(&mut app, "Files (1)");
    visible(&mut app, "Save report.txt");
    click(&mut app, "Agents");
    assert!(app.query_by_label("Files (1)").is_none());
    assert!(app.query_by_label("Save report.txt").is_none());
    click(&mut app, "Sessions");
    click(&mut app, "Release review");
    visible(&mut app, "Files (1)");
    assert!(
        app.query_by_label("Save report.txt").is_none(),
        "returning to a session leaves files closed"
    );
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Keep this unsent draft.")
    );
    fill(&mut app, "Message", "");

    let artifacts = f.get(&format!("/v1/agents/sessions/{session_id}/artifacts"));
    let artifact_id = artifacts["data"][0]["id"].as_str().unwrap();
    let downloads = tempfile::tempdir().unwrap();
    let destination = downloads.path().join("report.txt");
    let ctx = app.ctx.clone();
    // The only non-widget interaction supplies the OS file-picker result. It calls
    // the production asynchronous download path and never changes app data directly.
    app.state_mut()
        .save_artifact_to(&ctx, session_id, artifact_id, destination.clone())
        .unwrap();
    until(&mut app, "artifact saved", |_| destination.exists());
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"Native console artifact"
    );
    assert_eq!(
        std::fs::read_dir(downloads.path()).unwrap().count(),
        1,
        "atomic-save temporary file was removed"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&destination)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    contains(&mut app, "Saved artifact to");
    click(&mut app, "Dismiss notice");
    app.set_size(Vec2::new(900.0, 650.0));
    tick(&mut app);
    app.get_by_role_and_label(Role::Label, "Review complete.")
        .scroll_to_me();
    tick(&mut app);
    f.screenshot(&mut app, "session-900x650.png");
    app.set_size(Vec2::new(1280.0, 850.0));
    tick(&mut app);

    fill(&mut app, "Message", "Start another review.");
    click(&mut app, "Send");
    until(&mut app, "second durable turn", |_| {
        f.get(&format!("/v1/agents/sessions/{session_id}/turns"))["data"]
            .as_array()
            .unwrap()
            .len()
            == 2
    });
    contains(&mut app, "Turn in progress");
    click(&mut app, "Cancel turn");
    contains(&mut app, "cancelled");
    let cancel = request_with_event(&f.state(), "agent.session.input.cancel");
    assert!(cancel["key"].as_str().is_some_and(|key| !key.is_empty()));

    f.control("/__test/seed", json!({}));
    click(&mut app, "Agents");
    visible(&mut app, "Load more");
    click(&mut app, "Load more");
    until(&mut app, "all 26 agents loaded", |app| {
        app.query_by_label("Load more").is_none()
    });
    click(&mut app, "Agent 0");
    click(&mut app, "Edit agent");
    editor(
        &mut app,
        json!({"name":"Review agent", "instructions":"Inspect changes."}),
        "Save",
    );
    contains(&mut app, "Review agent");
    let agents = f.get("/v1/agents?limit=100");
    let edited = agents["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["name"] == "Review agent")
        .unwrap();
    assert_eq!(edited["instructions"], "Inspect changes.");
    click(&mut app, "Start session");
    advanced_json(&mut app);
    let mut saved_agent_request: Value =
        serde_json::from_str(&app.get_by_label("Configuration JSON").value().unwrap()).unwrap();
    assert!(
        saved_agent_request["agent_id"].as_str().is_some(),
        "saved-agent action must prefill its ID"
    );
    saved_agent_request["environment"] = json!({"type":"none"});
    saved_agent_request["input"] = json!("Use saved agent");
    saved_agent_request["metadata"] = json!({"name":"Saved agent run"});
    editor(&mut app, saved_agent_request, "Create");
    contains(&mut app, "Saved agent run");
    assert_eq!(f.state()["sessionCount"], 2);

    click(&mut app, "Templates");
    click(&mut app, "New environment template");
    fill(&mut app, "Name", "Draft environment");
    fill(&mut app, "npm packages", "typescript");
    let mut package_input = String::from("typescript");
    for character in ", vitest".chars() {
        app.get_by_label("npm packages")
            .type_text(&character.to_string());
        tick(&mut app);
        package_input.push(character);
        assert_eq!(
            app.get_by_label("npm packages").value().as_deref(),
            Some(package_input.as_str()),
            "separators must remain while typing a package list"
        );
    }
    advanced_json(&mut app);
    let mut template_request: Value =
        serde_json::from_str(&app.get_by_label("Configuration JSON").value().unwrap()).unwrap();
    assert_eq!(
        template_request["packages"]["npm"],
        json!(["typescript", "vitest"])
    );
    template_request["network"] =
        json!({"access":"restricted", "allowed_domains":["api.example.com"]});
    // This valid API field has no basic-form control. Editing basic fields must retain it.
    template_request["capability_directories"] = json!(["/workspace/tools"]);
    fill(
        &mut app,
        "Configuration JSON",
        &serde_json::to_string_pretty(&template_request).unwrap(),
    );
    click(&mut app, "Advanced JSON");
    fill(&mut app, "Name", "Review environment");
    assert_eq!(
        app.get_by_label("npm packages").value().as_deref(),
        Some("typescript, vitest")
    );
    advanced_json(&mut app);
    let round_trip: Value =
        serde_json::from_str(&app.get_by_label("Configuration JSON").value().unwrap()).unwrap();
    assert_eq!(
        round_trip["capability_directories"],
        json!(["/workspace/tools"])
    );
    assert_eq!(
        round_trip["packages"]["npm"],
        json!(["typescript", "vitest"])
    );
    assert_eq!(round_trip["network"], template_request["network"]);
    click(&mut app, "Create");
    until(
        &mut app,
        "template editor to close after persistence",
        |app| app.query_by_label("Cancel").is_none(),
    );
    let saved_template = f.get("/v1/agents/environments/templates")["data"][0].clone();
    assert_eq!(
        saved_template["packages"]["npm"],
        json!(["typescript", "vitest"])
    );
    assert_eq!(
        saved_template["capability_directories"],
        json!(["/workspace/tools"])
    );
    contains(&mut app, "Review environment");
    click(&mut app, "Edit environment template");
    editor(
        &mut app,
        json!({"name":"Updated environment", "packages":{"npm":[]}}),
        "Save",
    );
    contains(&mut app, "Updated environment");
    assert_eq!(
        f.get("/v1/agents/environments/templates")["data"][0]["packages"]["npm"],
        json!([])
    );
    click(&mut app, "Delete environment template");
    click(&mut app, "Confirm delete");
    until(&mut app, "template deleted", |_| {
        f.get("/v1/agents/environments/templates")["data"] == json!([])
    });

    click(&mut app, "Vaults");
    click(&mut app, "New vault");
    visible(&mut app, "Name");
    assert!(
        app.query_by_label("Configuration JSON").is_none(),
        "creating a Vault should start with a name field"
    );
    fill(&mut app, "Name", "Service tools");
    click(&mut app, "Create");
    until(&mut app, "Vault form to close after persistence", |app| {
        app.query_by_label("Cancel").is_none()
    });
    assert_eq!(
        f.get("/v1/vaults?status=active")["data"][0]["name"],
        "Service tools"
    );
    click(&mut app, "Add credential");
    visible(&mut app, "Secret value");
    assert!(app.query_by_label("Configuration JSON").is_none());
    fill(&mut app, "Name", "Internal MCP");
    fill(&mut app, "Server URL", "https://mcp.example.com");
    app.get_by_label("Secret value").focus();
    tick(&mut app);
    app.key_press_modifiers(Modifiers::COMMAND, Key::A);
    app.key_press(Key::Backspace);
    tick(&mut app);
    app.get_by_label("Secret value")
        .type_text("write-only-initial");
    tick(&mut app);
    assert_no_secret(&app, "write-only-initial");
    f.screenshot(&mut app, "new-credential-form-1280x850.png");
    click(&mut app, "Create");
    until(
        &mut app,
        "credential form to close after persistence",
        |app| app.query_by_label("Cancel").is_none(),
    );
    contains(&mut app, "Internal MCP");
    assert_eq!(f.state()["secretCount"], 1);
    assert_no_secret(&app, "write-only-initial");
    click(&mut app, "Rotate credential");
    assert_no_secret(&app, "write-only-initial");
    editor(
        &mut app,
        json!({"auth":{"type":"static_bearer", "token":"write-only-replacement"}}),
        "Save",
    );
    assert_eq!(f.state()["secretCount"], 1);
    assert_no_secret(&app, "write-only-replacement");
    assert!(
        f.state()["received"]
            .as_array()
            .unwrap()
            .iter()
            .any(|request| request["method"] == "POST"
                && request["body"]["auth"]["token"] == "write-only-replacement")
    );
    f.screenshot(&mut app, "vault-1280x850.png");
    click(&mut app, "Add credential");
    advanced_json(&mut app);
    assert_no_secret(&app, "write-only-replacement");
    fill(
        &mut app,
        "Configuration JSON",
        "{\"auth\": {\"token\": \"abandoned-secret\"}}",
    );
    click(&mut app, "Cancel");
    assert_no_secret(&app, "abandoned-secret");
    click(&mut app, "Add credential");
    advanced_json(&mut app);
    assert_no_secret(&app, "abandoned-secret");
    click(&mut app, "Cancel");
    click(&mut app, "Delete credential");
    until(&mut app, "credential revoked", |_| {
        f.state()["secretCount"] == 0
    });
    click(&mut app, "Delete vault");
    click(&mut app, "Confirm delete");
    until(&mut app, "vault deleted", |_| {
        f.get("/v1/vaults?status=active")["data"] == json!([])
    });

    // Exercise local JSON validation and the real API's error envelope in the editor.
    click(&mut app, "Agents");
    click(&mut app, "New agent");
    advanced_json(&mut app);
    fill(&mut app, "Configuration JSON", "{");
    click(&mut app, "Create");
    contains(&mut app, "Invalid JSON at line");
    visible(&mut app, "Configuration JSON");
    fill(&mut app, "Configuration JSON", "{}");
    click(&mut app, "Create");
    until(&mut app, "server validation error", |app| {
        app.query_all_by_label_contains("Invalid AgentCreate")
            .next()
            .is_some()
            || app
                .query_all_by_label_contains("model is required")
                .next()
                .is_some()
    });
    assert_eq!(
        f.get("/v1/agents?limit=100")["data"]
            .as_array()
            .unwrap()
            .len(),
        26
    );

    let denied = f
        .client
        .get(format!("{}/api/v1/agents", f.proxy.url))
        .send()
        .unwrap();
    assert_eq!(denied.status(), 403);
    click(&mut app, "Cancel");
    click(&mut app, "Sessions");
    click(&mut app, "New session");
    advanced_json(&mut app);
    fill(
        &mut app,
        "Configuration JSON",
        &json!({"agent":{"model":"fixture-model"},"environment":{"type":"none"},"stream":true})
            .to_string(),
    );
    click(&mut app, "Create");
    contains(&mut app, "Omit stream from this request.");
    visible(&mut app, "Configuration JSON");
    click(&mut app, "Cancel");
    assert_eq!(
        f.state()["sessionCount"],
        2,
        "rejected streaming request must not create a session"
    );
    assert!(
        f.state()["received"]
            .as_array()
            .unwrap()
            .iter()
            .all(|request| {
                let path = request["path"].as_str().unwrap();
                path.starts_with("/v1/agents")
                    || path.starts_with("/v1/vaults")
                    || path == "/v1/models"
            })
    );
    click(&mut app, "Release review");
    fill(
        &mut app,
        "Message",
        "Keep this draft if the signer disconnects.",
    );
    f.proxy.stop();
    click(&mut app, "Send");
    contains(&mut app, "The local signer is unavailable");
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Keep this draft if the signer disconnects.")
    );
    for server in [&f.proxy, &f.upstream] {
        let diagnostics = server.diagnostics.lock().unwrap();
        assert!(!diagnostics.contains("ERR_HTTP_HEADERS_SENT"));
        for secret in [
            "write-only-initial",
            "write-only-replacement",
            "abandoned-secret",
        ] {
            assert!(!diagnostics.contains(secret));
        }
    }
}

fn model_draft(app: &mut App) -> Value {
    advanced_json(app);
    serde_json::from_str(&app.get_by_label("Configuration JSON").value().unwrap()).unwrap()
}

#[test]
fn model_catalog_recovers_from_errors_and_retains_saved_values() {
    let f = Fixture::new();
    f.control("/__test/models", json!({"mode":"error"}));
    let mut app = f.app();
    click(&mut app, "New session");
    contains(&mut app, "Could not load available models.");
    fill(&mut app, "Name", "Keep my draft");
    fill(&mut app, "Task", "Review the release notes.");
    click(&mut app, "Create");
    visible(&mut app, "Cancel");
    assert_eq!(f.state()["sessionCount"], 0);
    assert!(
        app.query_by_role_and_label(Role::TextInput, "Model")
            .is_none(),
        "model selection must not fall back to a free-text field"
    );
    f.control("/__test/models", json!({"mode":"available"}));
    click(&mut app, "Retry models");
    until(&mut app, "recovered model catalog", |app| {
        app.query_by_role_and_label(Role::ComboBox, "Model")
            .is_some_and(|node| !node.accesskit_node().is_disabled())
    });
    let recovered = model_draft(&mut app);
    assert_eq!(
        recovered["agent"]["model"], "fixture-model",
        "only the advertised default should be chosen automatically"
    );
    assert_eq!(recovered["metadata"]["name"], "Keep my draft");
    assert_eq!(recovered["input"], "Review the release notes.");
    click(&mut app, "Cancel");
    drop(app);

    // The deployed API rejects an empty configured catalog; the UI exposes a retry.
    f.control("/__test/models", json!({"mode":"empty"}));
    let mut app = f.app();
    click(&mut app, "New session");
    contains(&mut app, "Could not load available models.");
    visible(&mut app, "Retry models");
    click(&mut app, "Cancel");
    drop(app);

    // Also tolerate an adverse successful response containing no options.
    f.control("/__test/models", json!({"mode":"empty-response"}));
    let mut app = f.app();
    click(&mut app, "New session");
    contains(&mut app, "No models are available for this deployment.");
    fill(&mut app, "Task", "Review without guessing a model.");
    click(&mut app, "Create");
    visible(&mut app, "Cancel");
    assert_eq!(f.state()["sessionCount"], 0);
    f.control("/__test/models", json!({"mode":"no-default"}));
    click(&mut app, "Refresh models");
    until(&mut app, "catalog without a default", |app| {
        app.query_by_role_and_label(Role::ComboBox, "Model")
            .is_some_and(|node| !node.accesskit_node().is_disabled())
    });
    let no_default = model_draft(&mut app);
    assert_eq!(
        no_default["agent"]["model"].as_str().unwrap_or_default(),
        "",
        "do not guess a model when the deployment advertises no default"
    );
    click(&mut app, "Advanced JSON");
    choose_model(&mut app, "fixture-model");
    assert_eq!(model_draft(&mut app)["agent"]["model"], "fixture-model");
    click(&mut app, "Cancel");
    drop(app);

    f.control("/__test/seed", json!({}));
    f.control("/__test/models", json!({"mode":"retired"}));
    let mut app = f.app();
    click(&mut app, "Agents");
    click(&mut app, "Load more");
    click(&mut app, "Agent 0");
    click(&mut app, "Edit agent");
    contains(
        &mut app,
        "This saved model is not available in this deployment. Choose another model to continue.",
    );
    let original = model_draft(&mut app);
    assert_eq!(
        original["model"], "fixture-model",
        "catalog refresh must not silently replace a saved model"
    );
    click(&mut app, "Advanced JSON");
    choose_model(&mut app, "fixture-fast");
    fill(&mut app, "Name", "Updated model agent");
    click(&mut app, "Save");
    until(&mut app, "updated Agent form to close", |app| {
        app.query_by_label("Cancel").is_none()
    });
    let agents = f.get("/v1/agents?limit=100");
    let edited = agents["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["name"] == "Updated model agent")
        .unwrap();
    assert_eq!(edited["model"], "fixture-fast");
    let edited_id = edited["id"].as_str().unwrap().to_owned();

    // A name-only advanced update must not swap an existing nondefault model
    // for the deployment default when the user returns to the normal form.
    f.control("/__test/models", json!({"mode":"available"}));
    assert_eq!(f.get("/v1/models")["default_model"], "fixture-model");
    click(&mut app, "Edit agent");
    click(&mut app, "Refresh models");
    until(
        &mut app,
        "refreshed catalog for partial Agent edit",
        |app| {
            app.query_by_role_and_label(Role::ComboBox, "Model")
                .is_some_and(|node| !node.accesskit_node().is_disabled())
        },
    );
    advanced_json(&mut app);
    fill(&mut app, "Configuration JSON", r#"{"name":"Renamed"}"#);
    click(&mut app, "Advanced JSON");
    visible(&mut app, "Name");
    assert_eq!(app.get_by_label("Name").value().as_deref(), Some("Renamed"));
    assert_eq!(
        model_draft(&mut app)["model"],
        "fixture-fast",
        "switching a partial update back to the form must restore the saved model, not inject the deployment default"
    );
    click(&mut app, "Advanced JSON");
    click(&mut app, "Save");
    until(&mut app, "partial Agent update to persist", |app| {
        app.query_by_label("Cancel").is_none()
    });
    let renamed = f.get(&format!("/v1/agents/{edited_id}"));
    assert_eq!(renamed["name"], "Renamed");
    assert_eq!(renamed["model"], "fixture-fast");
    assert!(
        f.state()["received"]
            .as_array()
            .unwrap()
            .iter()
            .any(|request| request["path"] == "/v1/models" && request["method"] == "GET")
    );
}

#[test]
fn session_workspace_search_pin_rename_undo_and_draft_navigation() {
    let f = Fixture::new();
    let session = f.post("/v1/agents/sessions", json!({"agent":{"model":"fixture-model"},
        "environment":{"type":"none"}, "input":"Review the latest changes", "metadata":{"name":"Workspace review","project":"keep"}}));
    let id = session["id"].as_str().unwrap();
    for index in 0..26 {
        f.post(
            "/v1/agents/sessions",
            json!({"agent":{"model":"fixture-model"},
            "environment":{"type":"none"},"input":"Review this workspace", "metadata":{"name":format!("Other session {index}")}}),
        );
    }
    let mut app = f.app();
    visible(&mut app, "Search sessions");
    app.key_press_modifiers(Modifiers::COMMAND, Key::K);
    tick(&mut app);
    app.get_by_label("Search sessions")
        .type_text("Workspace review");
    visible(&mut app, "Workspace review");
    app.key_press(Key::Enter);
    visible(&mut app, "Message");
    fill(&mut app, "Message", "Retain this unsent message");
    assert!(
        app.query_by_label("fixture-model").is_none(),
        "model belongs in Details"
    );
    click(&mut app, "Details");
    visible(&mut app, "fixture-model");
    app.key_press(Key::Escape);
    tick(&mut app);

    click(&mut app, "Actions");
    click(&mut app, "Pin session");
    until(&mut app, "persistent pin", |_| {
        f.get(&format!("/v1/agents/sessions/{id}"))["metadata"]["rat_things_pinned"] == "true"
    });
    click(&mut app, "Actions");
    click(&mut app, "Rename session");
    fill(&mut app, "Session name", "Workspace release review");
    click(&mut app, "Save name");
    until(&mut app, "rename saved", |app| {
        app.query_by_label("Session name").is_none()
    });
    assert_eq!(
        f.get(&format!("/v1/agents/sessions/{id}"))["metadata"]["project"],
        "keep"
    );
    fill(&mut app, "Search sessions", "");
    until(&mut app, "renamed session row", |app| {
        app.query_by_role_and_label(Role::Button, "Workspace release review")
            .is_some()
    });
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Retain this unsent message")
    );

    app.key_press_modifiers(Modifiers::COMMAND, Key::N);
    visible(&mut app, "Task");
    fill(&mut app, "Task", "Draft a new release plan");
    click(&mut app, "Workspace release review");
    visible(&mut app, "Message");
    app.key_press_modifiers(Modifiers::COMMAND, Key::N);
    visible(&mut app, "Task");
    assert_eq!(
        app.get_by_label("Task").value().as_deref(),
        Some("Draft a new release plan")
    );
    click(&mut app, "Cancel");
    visible(&mut app, "Message");

    let composer_rect = app.get_by_label("Message").rect();
    click(&mut app, "Actions");
    click(&mut app, "Archive session");
    visible(&mut app, "Undo");
    click(&mut app, "Undo");
    until(&mut app, "renamed session row", |app| {
        app.query_by_role_and_label(Role::Button, "Workspace release review")
            .is_some()
    });
    click(&mut app, "Workspace release review");
    visible(&mut app, "Message");
    assert_eq!(app.get_by_label("Message").rect(), composer_rect);
    assert_eq!(
        app.get_by_label("Message").value().as_deref(),
        Some("Retain this unsent message")
    );
    click(&mut app, "Dismiss notice");
    fill(&mut app, "Message", &"A long draft line\n".repeat(30));
    for size in [Vec2::new(1280.0, 850.0), Vec2::new(900.0, 650.0)] {
        app.set_size(size);
        tick(&mut app);
        let send = app
            .query_by_role_and_label(Role::Button, "Send")
            .or_else(|| app.query_by_role_and_label(Role::Button, "Steer"))
            .unwrap()
            .rect();
        assert!(
            send.bottom() < size.y && send.left() > 232.0,
            "composer actions remain in the window"
        );
        f.screenshot(
            &mut app,
            &format!("workspace-{}x{}.png", size.x as u32, size.y as u32),
        );
    }
    drop(app);
    let mut reopened = f.app();
    fill(&mut reopened, "Search sessions", "Workspace release review");
    visible(&mut reopened, "Pinned");
    click(&mut reopened, "Workspace release review");
    click(&mut reopened, "Actions");
    visible(&mut reopened, "Unpin session");
}

#[test]
fn local_workspace_welcome_starters_and_failed_cloud_connection() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let proxy = Server::spawn(
        root,
        "scripts/console-server.ts",
        &[
            ("RAT_THINGS_AGENTS_API_URL", ""),
            ("RAT_THINGS_API_URL", ""),
            ("RAT_THINGS_LOCAL_DIR", directory.path().to_str().unwrap()),
            ("RAT_THINGS_MODEL", "local-fixture"),
            ("RAT_THINGS_CONSOLE_PORT", "0"),
            ("RAT_THINGS_CONSOLE_TOKEN", &token),
            ("RAT_THINGS_CONSOLE_LAUNCHER", "1"),
        ],
    );
    let mut app = Harness::builder()
        .with_size(Vec2::new(1280.0, 850.0))
        .build_eframe(|_| ConsoleApp::new(proxy.url.clone(), token.clone()).unwrap());
    visible(&mut app, "A little help, right at home.");
    let output = root.join("test-results/native-console");
    std::fs::create_dir_all(&output).unwrap();
    app.render()
        .unwrap()
        .save(output.join("local-welcome.png"))
        .unwrap();
    click(&mut app, "This computer");
    visible(&mut app, "A home for your work");
    app.render()
        .unwrap()
        .save(output.join("local-workspace.png"))
        .unwrap();
    fill(&mut app, "Agents API URL", "http://insecure.example/v1");
    until(&mut app, "local setup request to finish", |app| {
        !app.get_by_role_and_label(Role::Button, "Check setup")
            .accesskit_node()
            .is_disabled()
    });
    click(&mut app, "Connect AWS workspace");
    contains(&mut app, "Your current workspace is still selected.");
    click(&mut app, "Done");
    visible(&mut app, "A little help, right at home.");
    click(&mut app, "Untangle an idea");
    contains(&mut app, "Help me turn a rough idea");
    choose_model(&mut app, "local-fixture");
    assert_eq!(model_draft(&mut app)["agent"]["model"], "local-fixture");
    assert_eq!(model_draft(&mut app)["environment"]["type"], "none");
    assert!(
        app.query_by_role_and_label(Role::Button, "Templates")
            .is_some()
    );
    assert!(
        app.query_by_role_and_label(Role::Button, "Vaults")
            .is_none()
    );
    drop(app);
    drop(proxy);
    assert!(directory.path().join("agents.sqlite").is_file());
    assert!(!directory.path().join("connection.json").exists());
}

#[test]
fn workspace_switch_preserves_current_work_during_slow_failure_and_recovers() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let server = Server::spawn(
        root,
        "testing/native-console/server.ts",
        &[("RAT_THINGS_WORKSPACE_FIXTURE", "1")],
    );
    let client = Client::new();
    let control = |body: Value| {
        client
            .post(format!("{}/__test/reads", server.url))
            .json(&body)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap();
    };
    let mut app = Harness::builder()
        .with_size(Vec2::new(1280.0, 850.0))
        .build_eframe(|_| ConsoleApp::new(server.url.clone(), "a".repeat(64)).unwrap());
    visible(&mut app, "A little help, right at home.");
    click(&mut app, "This computer");
    fill(&mut app, "Agents API URL", "https://workspace.example/v1");
    visible(&mut app, "Ready · Linux VM is running.");
    control(json!({"hold": true}));
    click(&mut app, "Connect AWS workspace");
    // The first pending frame keeps the current workspace and has no loading flash.
    assert!(
        app.query_by_label("Connecting to your workspace…")
            .is_none()
    );
    assert!(
        app.get_by_role_and_label(Role::Button, "Done")
            .accesskit_node()
            .is_disabled()
    );
    visible(&mut app, "Connecting to your workspace…");
    assert!(
        app.query_by_label("A little help, right at home.")
            .is_some()
    );
    app.key_press_modifiers(Modifiers::COMMAND, Key::N);
    tick(&mut app);
    assert!(
        app.query_by_label("Task").is_none(),
        "navigation cannot launch a draft during the switch"
    );
    control(json!({"fail": true}));
    contains(&mut app, "your current workspace is still selected.");
    assert_eq!(
        app.get_by_label("Agents API URL").value().as_deref(),
        Some("https://workspace.example/v1")
    );
    control(json!({}));
    click(&mut app, "Connect AWS workspace");
    visible(&mut app, "Your AWS workspace");
    visible(&mut app, "What are we working on?");
    click(&mut app, "Your AWS workspace");
    click(&mut app, "Use this computer");
    visible(&mut app, "A little help, right at home.");
    click(&mut app, "Untangle an idea");
    visible(&mut app, "Task");
    let draft = app.get_by_label("Task").value();
    click(&mut app, "This computer");
    assert!(
        app.get_by_role_and_label(Role::Button, "Connect AWS workspace")
            .accesskit_node()
            .is_disabled()
    );
    click(&mut app, "Done");
    assert_eq!(app.get_by_label("Task").value(), draft);
}

#[test]
fn local_setup_retains_inputs_through_slow_failure_and_retry() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let server = Server::spawn(
        root,
        "testing/native-console/server.ts",
        &[("RAT_THINGS_WORKSPACE_FIXTURE", "1")],
    );
    let client = Client::new();
    let control = |body: Value| {
        client
            .post(format!("{}/__test/local", server.url))
            .json(&body)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap();
    };
    let mut app = Harness::builder()
        .with_size(Vec2::new(1280.0, 850.0))
        .build_eframe(|_| ConsoleApp::new(server.url.clone(), "a".repeat(64)).unwrap());
    visible(&mut app, "A little help, right at home.");
    control(json!({"hold": true}));
    let first_frame = std::time::Instant::now();
    app.get_by_role_and_label(Role::Button, "This computer")
        .click();
    app.run_steps(1);
    // Under parallel rendering a frame can itself exceed the feedback delay.
    // A fast frame must have no flash; elapsed slow frames may show feedback.
    if first_frame.elapsed() < Duration::from_millis(300) {
        assert!(app.query_by_label("Checking your workspace…").is_none());
    }
    fill(&mut app, "Agents API URL", "https://retained.example/v1");
    visible(&mut app, "Checking your workspace…");
    control(json!({"fail": true}));
    contains(&mut app, "Local setup check failed");
    assert_eq!(
        app.get_by_label("Agents API URL").value().as_deref(),
        Some("https://retained.example/v1")
    );
    control(json!({}));
    click(&mut app, "Check setup");
    visible(&mut app, "Ready · Linux VM is running.");
    contains(&mut app, "fixture@example.test");
    control(json!({"runtime_fail": true}));
    click(&mut app, "Check setup");
    contains(&mut app, "Local runtime status is unavailable.");
    contains(&mut app, "fixture@example.test");
    control(json!({"account_fail": true}));
    click(&mut app, "Check setup");
    contains(&mut app, "ChatGPT account status is unavailable.");
    visible(&mut app, "Ready · Linux VM is running.");
    control(json!({}));
    click(&mut app, "Check setup");
    contains(&mut app, "fixture@example.test");
    let output = root.join("test-results/native-console");
    std::fs::create_dir_all(&output).unwrap();
    app.render()
        .unwrap()
        .save(output.join("local-setup-ready.png"))
        .unwrap();
    click(&mut app, "Done");
    visible(&mut app, "A little help, right at home.");
}

struct WorkspaceFixture {
    server: Server,
    client: Client,
}

impl WorkspaceFixture {
    fn new(control: Value) -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let fixture = Self {
            server: Server::spawn(
                root,
                "testing/native-console/server.ts",
                &[("RAT_THINGS_WORKSPACE_FIXTURE", "1")],
            ),
            client: Client::new(),
        };
        fixture.control(control);
        fixture
    }

    fn control(&self, body: Value) {
        self.client
            .post(format!("{}/__test/local", self.server.url))
            .json(&body)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap();
    }

    fn state(&self) -> Value {
        self.client
            .get(format!("{}/__test/state", self.server.url))
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    }

    fn requests(&self, path: &str) -> Vec<Value> {
        self.state()["received"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|request| request["path"] == path)
            .cloned()
            .collect()
    }

    fn copy_control(&self, body: Value) {
        self.client
            .post(format!("{}/__test/copies", self.server.url))
            .json(&body)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap();
    }

    fn copy_source(&self) -> Value {
        self.client
            .post(format!("{}/api/v1/agents/sessions", self.server.url))
            .json(&json!({"agent":{"model":"fixture-model"},
                "environment":{"type":"openai_hosted"}, "metadata":{"name":"Copy source"}}))
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    }

    fn app(&self) -> App {
        let mut app = Harness::builder()
            .with_size(Vec2::new(1280.0, 850.0))
            .build_eframe(|_| ConsoleApp::new(self.server.url.clone(), "a".repeat(64)).unwrap());
        enabled(&mut app, "This computer");
        click(&mut app, "This computer");
        app
    }
}

fn enabled(app: &mut App, label: &str) {
    until(app, label, |app| {
        app.query_by_role_and_label(Role::Button, label)
            .is_some_and(|button| !button.accesskit_node().is_disabled())
    });
}

#[test]
fn native_setup_retries_uncertain_requests_and_stops_polling_at_restart() {
    let f = WorkspaceFixture::new(json!({"native":true, "signed_in":false, "change_hold":true}));
    let mut app = f.app();
    enabled(&mut app, "Set up this computer");
    assert!(app.query_by_label("Copy runtime setup command").is_none());
    let setup_bounds = std::cell::Cell::new(
        app.get_by_role_and_label(Role::Button, "Set up this computer")
            .rect(),
    );
    until(&mut app, "setup button to settle", |app| {
        let bounds = app
            .get_by_role_and_label(Role::Button, "Set up this computer")
            .rect();
        setup_bounds.replace(bounds) == bounds
    });
    let first_frame = std::time::Instant::now();
    app.get_by_role_and_label(Role::Button, "Set up this computer")
        .click();
    app.run_steps(1);
    if first_frame.elapsed() < Duration::from_millis(300) {
        assert!(app.query_by_label("Starting setup…").is_none());
    }
    visible(&mut app, "Starting setup…");
    f.control(json!({"drop_change_response":true}));
    enabled(&mut app, "Retry setup request");
    assert!(
        app.query_by_role_and_label(Role::Button, "Dismiss")
            .is_none()
    );
    let first = f.requests("/api/v1/workspace/runtime/setup");
    assert_eq!(first.len(), 1);
    let first_id = first[0]["body"]["id"].clone();
    assert_eq!(first[0]["body"].as_object().unwrap().len(), 1);
    click(&mut app, "Retry setup request");
    visible(&mut app, "Setup queued");
    let retried = f.requests("/api/v1/workspace/runtime/setup");
    assert_eq!(retried.len(), 2);
    assert_eq!(retried[1]["body"]["id"], first_id);
    assert_eq!(f.state()["runtimeChanges"].as_array().unwrap().len(), 1);
    f.control(json!({"change_state":{"status":"working", "phase":"verifying"}}));
    visible(&mut app, "Setup · Verifying the runtime");
    f.control(json!({"change_poll_fail":true}));
    contains(&mut app, "Runtime progress is temporarily unavailable.");
    visible(&mut app, "Setup · Verifying the runtime");
    f.control(json!({"change_state":{"status":"failed", "failure":"probe"}}));
    enabled(&mut app, "Retry setup");
    click(&mut app, "Retry setup");
    visible(&mut app, "Setup queued");
    let restarted = f.requests("/api/v1/workspace/runtime/setup");
    assert_eq!(restarted.len(), 3);
    let next_id = restarted[2]["body"]["id"].as_str().unwrap();
    assert_ne!(next_id, first_id.as_str().unwrap());
    f.control(json!({"change_state":{"status":"awaiting_restart"}}));
    visible(&mut app, "Setup is ready to finish.");
    contains(&mut app, "Quit and reopen Rat Things to finish.");
    assert!(
        app.query_by_role_and_label(Role::Button, "Restart")
            .is_none()
    );
    let change_path = format!("/api/v1/workspace/runtime/changes/{next_id}");
    let polls = f.requests(&change_path).len();
    std::thread::sleep(Duration::from_millis(2200));
    tick(&mut app);
    assert_eq!(f.requests(&change_path).len(), polls);
    assert_eq!(f.requests("/api/v1/workspace/runtime/setup").len(), 3);
}

#[test]
fn rejected_native_setup_can_be_dismissed_without_retrying_another_owners_work() {
    let f = WorkspaceFixture::new(json!({"native":true, "signed_in":false}));
    let owner_id = uuid::Uuid::new_v4().to_string();
    f.client
        .post(format!("{}/api/v1/workspace/runtime/setup", f.server.url))
        .json(&json!({"id": owner_id}))
        .send()
        .unwrap()
        .error_for_status()
        .unwrap();
    let mut app = f.app();
    enabled(&mut app, "Set up this computer");
    click(&mut app, "Set up this computer");
    visible(&mut app, "Setup was not started.");
    contains(&mut app, "A runtime change is already active.");
    enabled(&mut app, "Dismiss");
    click(&mut app, "Dismiss");
    fill(&mut app, "Agents API URL", "https://workspace.example/v1");
    enabled(&mut app, "Connect AWS workspace");
    click(&mut app, "Connect AWS workspace");
    visible(&mut app, "What are we working on?");
    let state = f.state();
    assert_eq!(state["runtimeChanges"].as_array().unwrap().len(), 1);
    assert_eq!(state["runtimeChanges"][0]["id"], owner_id);
    assert_eq!(f.requests("/api/v1/workspace/runtime/setup").len(), 2);
}

#[test]
fn server_failure_after_native_acceptance_keeps_the_id_and_cannot_be_dismissed() {
    let f = WorkspaceFixture::new(
        json!({"native":true, "signed_in":false, "fail_change_response":true}),
    );
    let mut app = f.app();
    enabled(&mut app, "Set up this computer");
    click(&mut app, "Set up this computer");
    enabled(&mut app, "Retry setup request");
    assert!(
        app.query_by_role_and_label(Role::Button, "Dismiss")
            .is_none()
    );
    fill(&mut app, "Agents API URL", "https://workspace.example/v1");
    assert!(
        app.get_by_role_and_label(Role::Button, "Connect AWS workspace")
            .accesskit_node()
            .is_disabled()
    );
    let first = f.requests("/api/v1/workspace/runtime/setup")[0]["body"]["id"].clone();
    click(&mut app, "Retry setup request");
    visible(&mut app, "Setup queued");
    let requests = f.requests("/api/v1/workspace/runtime/setup");
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["body"]["id"], first);
    assert_eq!(f.state()["runtimeChanges"].as_array().unwrap().len(), 1);
}

#[test]
fn native_progress_continues_while_account_and_login_requests_are_held() {
    let f = WorkspaceFixture::new(
        json!({"native":true, "signed_in":false, "account_hold":true, "login_hold":true,
        "installation":{"state":"ready", "active":"runtime-current", "previous":"runtime-previous"}}),
    );
    let mut app = f.app();
    enabled(&mut app, "Sign in with ChatGPT");
    click(&mut app, "Sign in with ChatGPT");
    visible(&mut app, "Updating ChatGPT sign-in…");
    click(&mut app, "Update this computer");
    visible(&mut app, "Setup queued");
    f.control(json!({"account_hold":true, "login_hold":true, "change_state":{"status":"working", "phase":"probing"}}));
    visible(&mut app, "Setup · Testing the Linux workspace");
    assert!(
        app.query_by_label("ChatGPT connected · fixture@example.test")
            .is_none()
    );
    visible(&mut app, "Updating ChatGPT sign-in…");
    f.control(
        json!({"account_hold":true, "login_hold":true, "change_state":{"status":"complete"}}),
    );
    visible(&mut app, "This computer is ready.");
    assert_eq!(f.requests("/api/v1/workspace/runtime/setup").len(), 1);
    f.control(json!({"signed_in":true}));
    contains(&mut app, "ChatGPT connected · fixture@example.test");
}

#[test]
fn chatgpt_sign_in_retries_one_flow_and_cancels_only_its_saved_id() {
    let f = WorkspaceFixture::new(
        json!({"native":true, "signed_in":false, "drop_login_response":true,
        "installation":{"state":"ready", "active":"runtime-current"}}),
    );
    let mut app = f.app();
    enabled(&mut app, "Sign in with ChatGPT");
    click(&mut app, "Sign in with ChatGPT");
    enabled(&mut app, "Retry sign-in");
    let first_id = f.state()["loginFlow"]["id"].clone();
    click(&mut app, "Retry sign-in");
    contains(&mut app, "Finish signing in in your browser.");
    let requests = f.requests("/api/v1/workspace/subscription/login");
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request["body"]["id"] == first_id
                && request["body"].as_object().unwrap().len() == 1)
    );
    click(&mut app, "Cancel sign-in");
    enabled(&mut app, "Sign in with ChatGPT");
    assert!(f.state()["loginFlow"].is_null());
    let cancelled = f.requests(&format!(
        "/api/v1/workspace/subscription/login/{}",
        first_id.as_str().unwrap()
    ));
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0]["method"], "DELETE");
    click(&mut app, "Sign in with ChatGPT");
    contains(&mut app, "Finish signing in in your browser.");
    assert_ne!(f.state()["loginFlow"]["id"], first_id);
    f.control(json!({"signed_in":true}));
    contains(&mut app, "ChatGPT connected · fixture@example.test");
    assert!(app.query_by_label("Cancel sign-in").is_none());
}

#[test]
fn rollback_uses_its_own_action_and_development_keeps_the_setup_command() {
    let f = WorkspaceFixture::new(json!({"native":true,
        "installation":{"state":"ready", "active":"runtime-current", "previous":"runtime-previous"}}));
    let mut app = f.app();
    enabled(&mut app, "Use previous runtime");
    click(&mut app, "Use previous runtime");
    visible(&mut app, "Rollback queued");
    f.control(json!({"change_state":{"status":"working", "phase":"selecting"}}));
    visible(&mut app, "Rollback · Selecting the runtime");
    f.control(json!({"change_state":{"status":"complete"}}));
    visible(&mut app, "The previous runtime is ready.");
    assert_eq!(f.requests("/api/v1/workspace/runtime/rollback").len(), 1);
    assert!(f.requests("/api/v1/workspace/runtime/setup").is_empty());
    let development = WorkspaceFixture::new(json!({}));
    let mut app = development.app();
    enabled(&mut app, "Copy runtime setup command");
    assert!(
        app.query_by_role_and_label(Role::Button, "Set up this computer")
            .is_none()
    );
    assert!(
        app.query_by_role_and_label(Role::Button, "Use previous runtime")
            .is_none()
    );
}

fn open_copy_source(f: &WorkspaceFixture) -> App {
    let mut app = f.app();
    visible(&mut app, "Ready · Linux VM is running.");
    contains(&mut app, "ChatGPT connected");
    click(&mut app, "Done");
    until(&mut app, "workspace window to close", |app| {
        app.query_by_label("A home for your work").is_none()
    });
    click(&mut app, "Copy source");
    click(&mut app, "This computer");
    visible(&mut app, "Local model: fixture-model");
    fill(&mut app, "Agents API URL", "https://copy-first.example/v1");
    fill(&mut app, "AWS region", "us-west-2");
    app
}

fn copy_posts(state: &Value) -> Vec<Value> {
    state["copies"]["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|request| request["method"] == "POST")
        .cloned()
        .collect()
}

fn assert_copy_review_disabled(app: &App) {
    assert!(
        app.get_by_role_and_label(Role::Button, "Review Session copy")
            .accesskit_node()
            .is_disabled()
    );
}

fn copy_screenshot(app: &mut App, name: &str) {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("test-results/native-console");
    std::fs::create_dir_all(&directory).unwrap();
    app.remove_cursor();
    app.run_steps(3);
    app.render().unwrap().save(directory.join(name)).unwrap();
}

#[test]
fn native_copy_requires_a_destination_model_and_recovers_the_saved_review_after_restart() {
    let f = WorkspaceFixture::new(json!({"native":true,
        "installation":{"state":"ready", "active":"runtime-current"}}));
    let source = f.copy_source();
    let mut app = open_copy_source(&f);
    assert_copy_review_disabled(&app);
    click(&mut app, "Load AWS models");
    visible(
        &mut app,
        "Choose the model that will continue this Session in AWS.",
    );
    // The destination default is fixture-fast, but the absent source model requires an explicit choice.
    assert_copy_review_disabled(&app);
    assert!(f.state()["copies"]["plans"].as_array().unwrap().is_empty());
    choose_model(&mut app, "fixture-fast");
    enabled(&mut app, "Review Session copy");
    click(&mut app, "Review Session copy");
    enabled(&mut app, "Copy to AWS");
    visible(&mut app, "Copy status: Ready");
    app.get_by_role_and_label(Role::Button, "Copy to AWS")
        .scroll_to_me();
    tick(&mut app);
    copy_screenshot(&mut app, "session-copy-reviewed-1280x850.png");
    app.set_size(Vec2::new(900.0, 650.0));
    tick(&mut app);
    app.get_by_role_and_label(Role::Button, "Copy to AWS")
        .scroll_to_me();
    tick(&mut app);
    copy_screenshot(&mut app, "session-copy-reviewed-900x650.png");
    app.set_size(Vec2::new(1280.0, 850.0));
    tick(&mut app);
    let ready = f.state();
    let plan = ready["copies"]["plans"][0].clone();
    let id = plan["id"].as_str().unwrap();
    let execute_path = format!("/api/v1/workspace/transfers/{id}");
    assert_eq!(plan["source_session_id"], source["id"]);
    assert_eq!(plan["source_model"], "fixture-model");
    assert_eq!(plan["model"], "fixture-fast");
    assert_eq!(
        plan["destination"],
        json!({"baseURL":"https://copy-first.example/v1", "region":"us-west-2"})
    );
    assert_eq!(plan["files"], 1);
    assert!(
        copy_posts(&ready).is_empty(),
        "Review must not upload or import"
    );
    assert!(
        f.requests(&execute_path)
            .iter()
            .all(|request| request["method"] == "GET")
    );
    assert!(ready["executionStarts"].as_array().unwrap().is_empty());

    // Editing the next draft must neither erase nor rewrite the existing review.
    f.copy_control(json!({"models":["fixture-model", "fixture-fast"]}));
    fill(&mut app, "Agents API URL", "https://copy-second.example/v1");
    fill(&mut app, "AWS region", "eu-west-1");
    click(&mut app, "Load AWS models");
    visible(&mut app, "AWS model: fixture-model");
    visible(
        &mut app,
        "Your edits apply to a new copy. This saved copy keeps the destination and model shown here.",
    );
    visible(&mut app, "AWS model: fixture-fast");
    enabled(&mut app, "Copy to AWS");
    assert_eq!(f.state()["copies"]["plans"][0], plan);
    assert!(copy_posts(&f.state()).is_empty());
    assert_eq!(
        f.requests("/api/v1/workspace/transfers")
            .iter()
            .filter(|request| request["method"] == "POST")
            .count(),
        1
    );

    // The real destination import commits, then its injected transport loses the response.
    f.copy_control(json!({"lose_import_response":true}));
    click(&mut app, "Copy to AWS");
    enabled(&mut app, "Retry transfer");
    assert_eq!(
        f.state()["copies"]["destinationSessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(app);
    f.copy_control(json!({"restart":true}));
    let mut reopened = f.app();
    enabled(&mut reopened, "Open saved copy");
    assert!(
        reopened
            .query_by_role_and_label(Role::Button, "Retry transfer")
            .is_none()
    );
    click(&mut reopened, "Open saved copy");
    enabled(&mut reopened, "Retry transfer");
    visible(&mut reopened, "AWS model: fixture-fast");
    visible(&mut reopened, "AWS region: us-west-2");
    assert_eq!(
        f.requests(&execute_path)
            .iter()
            .filter(|request| request["method"] == "POST")
            .count(),
        1
    );
    click(&mut reopened, "Retry transfer");
    visible(&mut reopened, "Copy status: Complete");
    reopened
        .get_by_role_and_label(Role::Button, "Open cloud Session")
        .scroll_to_me();
    tick(&mut reopened);
    copy_screenshot(&mut reopened, "session-copy-complete-1280x850.png");
    assert!(
        reopened
            .query_all_by_label_contains("Interrupted or failed")
            .next()
            .is_none()
    );
    let state = f.state();
    let requests = copy_posts(&state);
    let uploads: Vec<_> = requests
        .iter()
        .filter(|request| request["url"].as_str().unwrap().ends_with("/files"))
        .collect();
    let imports: Vec<_> = requests
        .iter()
        .filter(|request| request["url"].as_str().unwrap().ends_with("/import"))
        .collect();
    assert_eq!(uploads.len(), 1, "Retry reuses the uploaded snapshot");
    assert_eq!(imports.len(), 2);
    assert!(imports.iter().all(|request| request["url"] == "https://copy-first.example/v1/agents/sessions/import"));
    assert_eq!(imports[0]["body"], imports[1]["body"]);
    assert_eq!(imports[1]["body"]["transfer_id"], id);
    assert_eq!(
        imports[1]["body"]["session"]["agent"]["model"],
        "fixture-fast"
    );
    assert_eq!(state["copies"]["snapshots"], json!([source["id"]]));
    assert_eq!(
        state["copies"]["destinationSessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(state["copies"]["destinationSessions"][0]["status"], "idle");
    assert_eq!(
        state["sessionCount"], 1,
        "The local source remains available"
    );
    assert!(state["executionStarts"].as_array().unwrap().is_empty());
    assert_eq!(
        f.requests(&execute_path)
            .iter()
            .filter(|request| request["method"] == "POST")
            .count(),
        2
    );
}

#[test]
fn native_copy_controls_wait_for_a_workspace_switch_to_finish() {
    let f = WorkspaceFixture::new(json!({"native":true,
        "installation":{"state":"ready", "active":"runtime-current"}}));
    f.copy_source();
    let mut app = open_copy_source(&f);
    click(&mut app, "Load AWS models");
    visible(
        &mut app,
        "Choose the model that will continue this Session in AWS.",
    );
    choose_model(&mut app, "fixture-fast");
    click(&mut app, "Review Session copy");
    enabled(&mut app, "Copy to AWS");
    enabled(&mut app, "Open saved copy");
    let before = f.state()["received"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|request| {
            request["path"]
                .as_str()
                .unwrap()
                .starts_with("/api/v1/workspace/transfers")
        })
        .count();
    f.client
        .post(format!("{}/__test/reads", f.server.url))
        .json(&json!({"hold":true}))
        .send()
        .unwrap()
        .error_for_status()
        .unwrap();
    enabled(&mut app, "Connect AWS workspace");
    click(&mut app, "Connect AWS workspace");
    visible(&mut app, "Connecting to your workspace…");
    for label in [
        "Copy to AWS",
        "Review Session copy",
        "Refresh models",
        "Reload saved copies",
        "Open saved copy",
    ] {
        assert!(
            app.get_by_role_and_label(Role::Button, label)
                .accesskit_node()
                .is_disabled(),
            "{label}"
        );
    }
    let after = f.state()["received"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|request| {
            request["path"]
                .as_str()
                .unwrap()
                .starts_with("/api/v1/workspace/transfers")
        })
        .count();
    assert_eq!(after, before);
    f.client
        .post(format!("{}/__test/reads", f.server.url))
        .json(&json!({"fail":true}))
        .send()
        .unwrap()
        .error_for_status()
        .unwrap();
    contains(&mut app, "your current workspace is still selected.");
    enabled(&mut app, "Copy to AWS");
    assert!(copy_posts(&f.state()).is_empty());
}

#[test]
fn native_copy_ignores_old_models_and_keeps_polling_after_the_window_closes() {
    let f = WorkspaceFixture::new(json!({"native":true,
        "installation":{"state":"ready", "active":"runtime-current"}}));
    f.copy_source();
    let mut app = open_copy_source(&f);
    f.copy_control(json!({"hold_models":"https://copy-first.example/v1"}));
    click(&mut app, "Load AWS models");
    until(&mut app, "held first catalog request", |_| {
        f.state()["copies"]["models"].as_array().unwrap().len() == 1
    });
    visible(&mut app, "Loading available models…");
    assert_copy_review_disabled(&app);
    f.copy_control(json!({"models":["fixture-model"]}));
    fill(&mut app, "Agents API URL", "https://copy-second.example/v1");
    click(&mut app, "Load AWS models");
    visible(&mut app, "AWS model: fixture-model");
    f.copy_control(json!({"release_models":"https://copy-first.example/v1"}));
    until(&mut app, "old response delivered", |_| {
        f.state()["copies"]["models"][0]["complete"] == true
    });
    for _ in 0..5 {
        tick(&mut app);
    }
    visible(&mut app, "AWS model: fixture-model");
    enabled(&mut app, "Review Session copy");
    click(&mut app, "Review Session copy");
    enabled(&mut app, "Copy to AWS");
    let id = f.state()["copies"]["plans"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/v1/workspace/transfers/{id}");
    f.copy_control(json!({"upload_hold":true, "lose_execute_response":true}));
    click(&mut app, "Copy to AWS");
    visible(&mut app, "Checking whether the copy started…");
    assert!(
        app.get_by_role_and_label(Role::Button, "Connect AWS workspace")
            .accesskit_node()
            .is_disabled()
    );
    visible(&mut app, "Copy status: Uploading");
    assert!(
        app.get_by_role_and_label(Role::Button, "Connect AWS workspace")
            .accesskit_node()
            .is_disabled()
    );
    click(&mut app, "Done");
    assert!(app.query_by_label("A home for your work").is_none());
    let polls = f
        .requests(&path)
        .iter()
        .filter(|request| request["method"] == "GET")
        .count();
    until(
        &mut app,
        "copy polling while workspace window is closed",
        |_| {
            f.requests(&path)
                .iter()
                .filter(|request| request["method"] == "GET")
                .count()
                > polls
        },
    );
    f.copy_control(json!({"upload_hold":false}));
    until(&mut app, "real import completion", |_| {
        f.state()["copies"]["plans"][0]["status"] == "complete"
    });
    click(&mut app, "This computer");
    visible(&mut app, "Copy status: Complete");
    assert!(f.state()["executionStarts"].as_array().unwrap().is_empty());
}
