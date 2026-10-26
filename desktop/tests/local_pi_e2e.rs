//! Opt-in shipped Rust controls, production proxy, subscription inference and isolated local worker.
#[path = "support/harness.rs"]
mod support;

use egui::{Vec2, accesskit::Role};
use egui_kittest::{
    Harness,
    kittest::{NodeT, Queryable},
};
use rat_things_desktop::ConsoleApp;
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use support::*;

fn required(name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| panic!("{name} is required"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    #[serde(rename = "baseURL")]
    base_url: String,
    token: String,
}

fn get(client: &Client, base: &str, token: &str, path: &str) -> Value {
    client
        .get(format!("{base}{path}"))
        .bearer_auth(token)
        .send()
        .expect("read local acceptance record")
        .error_for_status()
        .expect("local acceptance read succeeded")
        .json()
        .expect("local JSON response")
}

struct Created {
    client: Client,
    base: String,
    token: String,
    marker: String,
    agent: Option<String>,
    session: Option<String>,
    cleaned: bool,
}
impl Created {
    fn get(&self, path: &str) -> Value {
        get(&self.client, &self.base, &self.token, path)
    }
    fn find(&self, collection: &str, field: &str) -> Option<String> {
        self.get(&format!("/agents{collection}?limit=100"))["data"]
            .as_array()?
            .iter()
            .find(|row| row.pointer(field).and_then(Value::as_str) == Some(&self.marker))?["id"]
            .as_str()
            .map(str::to_owned)
    }
    fn remove(&self, suffix: &str) -> bool {
        self.client
            .delete(format!("{}/agents{suffix}", self.base))
            .bearer_auth(&self.token)
            .header("x-rat-console-request", "1")
            .send()
            .is_ok_and(|response| response.status().is_success())
    }
    fn cleanup(&mut self) -> bool {
        if self.cleaned {
            return true;
        }
        if self.session.is_none() {
            self.session = self.find("/sessions", "/metadata/name");
        }
        if self.agent.is_none() {
            self.agent = self.find("", "/name");
        }
        let session_removed = self
            .session
            .as_ref()
            .is_none_or(|id| self.remove(&format!("/sessions/{id}")));
        let agent_removed = session_removed
            && self
                .agent
                .as_ref()
                .is_none_or(|id| self.remove(&format!("/{id}")));
        self.cleaned = session_removed && agent_removed;
        self.cleaned
    }
}
impl Drop for Created {
    fn drop(&mut self) {
        if !self.cleaned
            && !std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.cleanup()))
                .unwrap_or(false)
        {
            eprintln!(
                "Local Pi UI acceptance cleanup was not confirmed for {}",
                self.marker
            );
        }
    }
}

fn choose(app: &mut App, field: &str, option: &str) {
    until(app, field, |app| {
        app.query_by_role_and_label(Role::ComboBox, field)
            .is_some_and(|node| !node.accesskit_node().is_disabled())
    });
    app.get_by_role_and_label(Role::ComboBox, field)
        .scroll_to_me();
    tick(app);
    app.get_by_role_and_label(Role::ComboBox, field).click();
    tick(app);
    click(app, option);
}

fn completed(app: &mut App, created: &Created, count: usize, timeout: Duration) -> Vec<Value> {
    let deadline = Instant::now() + timeout;
    loop {
        tick(app);
        let page = created.get(&format!(
            "/agents/sessions/{}/turns?limit=100",
            created.session.as_ref().unwrap()
        ));
        let turns = page["data"].as_array().expect("Turn list");
        assert!(
            !turns
                .iter()
                .any(|turn| turn["status"] == "failed" || turn["status"] == "cancelled"),
            "Local Pi UI Turn failed or cancelled"
        );
        if turns
            .iter()
            .filter(|turn| turn["status"] == "completed")
            .count()
            == count
        {
            return turns.clone();
        }
        assert!(
            Instant::now() < deadline,
            "Timed out waiting for {count} local Pi UI Turns"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn items(created: &Created) -> Vec<Value> {
    created.get(&format!(
        "/agents/sessions/{}/items?limit=100",
        created.session.as_ref().unwrap()
    ))["data"]
        .as_array()
        .expect("Session item list")
        .clone()
}
fn commands(items: &[Value]) -> Vec<&Value> {
    items
        .iter()
        .filter(|item| item["type"] == "command_execution")
        .collect()
}
fn arguments(item: &Value) -> Value {
    serde_json::from_str(item["command"].as_str().expect("Managed argument record"))
        .expect("Managed argument JSON")
}
fn require_operation<'a>(
    operations: &[&'a Value],
    expected: &Value,
    output: impl Fn(&str) -> bool,
) -> &'a Value {
    operations
        .iter()
        .copied()
        .find(|item| {
            let args = arguments(item);
            expected
                .as_object()
                .unwrap()
                .iter()
                .all(|(key, value)| args.get(key) == Some(value))
                && item["output"].as_str().is_some_and(&output)
        })
        .expect("Expected managed operation and its real output")
}
fn show_command(app: &mut App, item: &Value) {
    let title = item["command"].as_str().unwrap();
    let mut label = title.chars().take(120).collect::<String>();
    if label.len() < title.len() {
        label.push_str(" …");
    }
    visible(app, &label);
    app.get_by_label(&label).scroll_to_me();
    tick(app);
    app.get_by_label(&label).click();
    tick(app);
    contains(app, item["output"].as_str().unwrap().trim());
}
fn assistant_has(items: &[Value], marker: &str) -> bool {
    items.iter().any(|item| {
        item["type"] == "message"
            && item["role"] == "assistant"
            && item["content"].as_array().is_some_and(|parts| {
                parts.iter().any(|part| {
                    part["text"]
                        .as_str()
                        .is_some_and(|text| text.contains(marker))
                })
            })
    })
}
fn capture(app: &mut App, directory: &Path, name: &str) {
    app.remove_cursor();
    app.run_steps(3);
    let path = directory.join(name);
    app.render()
        .expect("render production Rust widgets")
        .save(&path)
        .expect("save rendered PNG");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[test]
#[ignore = "Requires LOCAL_E2E_CONSOLE=true and LOCAL_E2E_REAL_PI=true; uses a signed-in existing local KVM service and live subscription model"]
fn saved_pi_agent_runs_managed_tools_and_restores_in_rust_console() {
    assert_eq!(required("LOCAL_E2E_CONSOLE"), "true");
    assert_eq!(required("LOCAL_E2E_REAL_PI"), "true");
    let profile = PathBuf::from(required("RAT_THINGS_LOCAL_DIR"));
    assert!(
        profile.is_absolute() && profile.is_dir(),
        "Use an existing absolute local profile"
    );
    let connection_path = profile.join("connection.json");
    assert!(
        connection_path.is_file(),
        "Start the local service before this test"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [&profile, &connection_path] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o077,
                0,
                "The existing profile and connection receipt must be private"
            );
        }
    }
    let connection: Connection = serde_json::from_slice(&std::fs::read(&connection_path).unwrap())
        .expect("Existing local connection receipt");
    let url = reqwest::Url::parse(&connection.base_url).expect("Local service URL");
    assert!(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.path() == "/v1"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Only the authenticated loopback local service is allowed"
    );
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .unwrap();
    assert_eq!(
        get(
            &client,
            &connection.base_url,
            &connection.token,
            "/workspace"
        )["kind"],
        "local"
    );
    let runtime = get(
        &client,
        &connection.base_url,
        &connection.token,
        "/workspace/runtime",
    );
    assert_eq!(
        runtime["ready"], true,
        "Prepare the real isolated runtime before this test"
    );
    assert!(
        runtime["image"]
            .as_str()
            .is_some_and(|image| image.starts_with("linux-kvm-development:")),
        "This journey requires the real Linux KVM runtime"
    );
    assert_eq!(
        runtime["native"]["occupied"], false,
        "Close other managed Sessions before this opt-in journey"
    );
    assert_eq!(
        get(
            &client,
            &connection.base_url,
            &connection.token,
            "/workspace/subscription"
        )["signed_in"],
        true,
        "Sign in before this test; the test never starts login"
    );
    let existing_url = connection.base_url.clone();
    drop(connection);

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut proxy = Server::spawn(
        root,
        "scripts/console-server.ts",
        &[
            ("RAT_THINGS_AGENTS_API_URL", ""),
            ("AGENTS_API_BASE_URL", ""),
            ("RAT_THINGS_API_URL", ""),
            ("AGENT_RUNTIME_API_URL", ""),
            ("RAT_THINGS_LOCAL_DIR", profile.to_str().unwrap()),
            ("RAT_THINGS_CONSOLE_PORT", "0"),
            ("RAT_THINGS_CONSOLE_TOKEN", &token),
            ("RAT_THINGS_CONSOLE_LAUNCHER", "1"),
        ],
    );
    assert!(proxy.process_is_running());
    let marker = format!("local-pi-ui-{}", uuid::Uuid::new_v4().simple());
    let file = format!("/workspace/{marker}.txt");
    let first = format!("{marker}-FIRST");
    let second = format!("{marker}-SECOND");
    let evidence = root.join("test-results/local-pi-ui").join(&marker);
    std::fs::create_dir_all(&evidence).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&evidence, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut created = Created {
        client,
        base: format!("{}/api/v1", proxy.url),
        token: token.clone(),
        marker: marker.clone(),
        agent: None,
        session: None,
        cleaned: false,
    };
    assert_eq!(
        created.get("/workspace")["endpoint"],
        existing_url,
        "The production console must attach to the existing local service"
    );
    let current: Connection =
        serde_json::from_slice(&std::fs::read(&connection_path).unwrap()).unwrap();
    assert_eq!(
        current.base_url, existing_url,
        "The console must not replace the existing service"
    );
    drop(current);
    let make_app = || {
        Harness::builder()
            .with_size(Vec2::new(1440.0, 1000.0))
            .build_eframe(|_| ConsoleApp::new(proxy.url.clone(), token.clone()).unwrap())
    };
    let timeout = Duration::from_millis(
        std::env::var("LOCAL_E2E_TIMEOUT_MS")
            .unwrap_or("300000".into())
            .parse()
            .expect("Integer timeout"),
    );
    let mut app = make_app();
    click(&mut app, "Agents");
    click(&mut app, "New agent");
    fill(&mut app, "Name", &marker);
    choose(&mut app, "Runtime", "Pi");
    choose(&mut app, "Model", "gpt-6-luna");
    fill(
        &mut app,
        "Instructions",
        "Use the managed workspace tools to perform requested actions. Execute real tools and report their results. Do not spawn subagents. Never change files outside /workspace. Follow the exact requested verification sequence.",
    );
    capture(&mut app, &evidence, "saved-agent-form.png");
    click(&mut app, "Create");
    until(&mut app, "saved Pi Agent", |_| {
        created.find("", "/name").is_some()
    });
    created.agent = created.find("", "/name");
    let agent = created.get(&format!("/agents/{}", created.agent.as_ref().unwrap()));
    assert_eq!(agent["metadata"]["rat_things_runtime"], "pi");
    assert_eq!(agent["model"], "gpt-6-luna");
    click(&mut app, "Start session");
    visible(&mut app, "Pi · saved Agent");
    choose(&mut app, "Environment", "Linux on this computer");
    fill(&mut app, "Name", &marker);
    fill(
        &mut app,
        "Task",
        &format!(
            "Perform this exact managed workspace verification using all four tools: (1) write_file path {file} with content {first}; (2) read_file that path and confirm its exact content; (3) list_files /workspace and locate that file; (4) exec_command with command array [\"node\",\"--disable-warning=UNDICI-EHPA\",\"-e\",\"console.log('RUST_UI_WORKER '+process.getuid()+' '+process.platform)\"] and confirm it prints RUST_UI_WORKER 10001 linux. Then respond with exactly {first}."
        ),
    );
    capture(&mut app, &evidence, "managed-session-form.png");
    click(&mut app, "Create");
    until(&mut app, "created managed Pi Session", |_| {
        created.find("/sessions", "/metadata/name").is_some()
    });
    created.session = created.find("/sessions", "/metadata/name");
    let session = created.get(&format!(
        "/agents/sessions/{}",
        created.session.as_ref().unwrap()
    ));
    assert_eq!(session["agent"]["id"].as_str(), created.agent.as_deref());
    assert_eq!(session["environment"]["type"], "openai_hosted");
    assert_eq!(session["environment"]["network"]["access"], "disabled");
    let environment = session["environment"]["id"].as_str().unwrap().to_owned();
    let pin = created.get(&format!(
        "/agents/sessions/{}/runtime",
        created.session.as_ref().unwrap()
    ));
    assert_eq!(pin["runtime"], "pi");
    let first_turns = completed(&mut app, &created, 1, timeout);
    contains(&mut app, "Turn completed");
    contains(&mut app, &first);
    let first_items = items(&created);
    assert!(
        assistant_has(&first_items, &first),
        "First assistant response persisted"
    );
    let first_commands = commands(&first_items);
    assert!(
        first_commands.len() >= 4,
        "All four managed operations must be durable command items"
    );
    assert!(
        first_commands
            .iter()
            .all(|item| item["status"] == "completed" && item["exit_code"] == 0),
        "Managed tool operations succeeded"
    );
    require_operation(
        &first_commands,
        &json!({"path":file,"content":first}),
        |text| text.trim() == "Written",
    );
    require_operation(&first_commands, &json!({"path":file}), |text| text == first);
    require_operation(&first_commands, &json!({"path":"/workspace"}), |text| {
        serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|value| value.as_array().cloned())
            .is_some_and(|entries| {
                entries.iter().any(|entry| {
                    entry["name"] == format!("{marker}.txt") && entry["directory"] == false
                })
            })
    });
    let guest_command = require_operation(
        &first_commands,
        &json!({"command":["node","--disable-warning=UNDICI-EHPA","-e","console.log('RUST_UI_WORKER '+process.getuid()+' '+process.platform)"]}),
        |text| text.trim() == "RUST_UI_WORKER 10001 linux",
    );
    show_command(&mut app, guest_command);
    let files = created.get(&format!(
        "/agents/environments/{environment}/files?limit=100"
    ));
    assert!(
        files["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == file),
        "The real environment file API sees the written file"
    );
    capture(&mut app, &evidence, "managed-first-turn.png");
    drop(app);

    let mut app = make_app();
    fill(&mut app, "Search sessions", &marker);
    click(&mut app, &marker);
    contains(&mut app, &first);
    contains(&mut app, "Turn completed");
    capture(&mut app, &evidence, "restored-history.png");
    fill(
        &mut app,
        "Message",
        &format!(
            "Continue this same Session. Use read_file on {file} to confirm the existing content is {first}. Then use write_file to replace its content with exactly {second}, use read_file again to verify it, and use exec_command with command array [\"node\",\"--disable-warning=UNDICI-EHPA\",\"-e\",\"console.log('RUST_UI_CONTINUED '+process.getuid())\"]. Respond with exactly {second}."
        ),
    );
    click(&mut app, "Send");
    let turns = completed(&mut app, &created, 2, timeout);
    contains(&mut app, "Turn completed");
    contains(&mut app, &second);
    let final_items = items(&created);
    let final_commands = commands(&final_items);
    assert!(
        assistant_has(&final_items, &first) && assistant_has(&final_items, &second),
        "Both assistant messages survived reopening the console"
    );
    assert!(
        final_commands.len() >= 8
            && final_commands
                .iter()
                .all(|item| item["status"] == "completed" && item["exit_code"] == 0),
        "Both Turns used successful real managed tools"
    );
    let second_turn = turns
        .iter()
        .find(|turn| turn["id"] != first_turns[0]["id"])
        .unwrap();
    let continued_commands = final_commands
        .iter()
        .copied()
        .filter(|item| item["turn_id"] == second_turn["id"])
        .collect::<Vec<_>>();
    require_operation(&continued_commands, &json!({"path":file}), |text| {
        text == first
    });
    require_operation(
        &continued_commands,
        &json!({"path":file,"content":second}),
        |text| text.trim() == "Written",
    );
    require_operation(&continued_commands, &json!({"path":file}), |text| {
        text == second
    });
    let continued_command = require_operation(
        &continued_commands,
        &json!({"command":["node","--disable-warning=UNDICI-EHPA","-e","console.log('RUST_UI_CONTINUED '+process.getuid())"]}),
        |text| text.trim() == "RUST_UI_CONTINUED 10001",
    );
    show_command(&mut app, continued_command);
    capture(&mut app, &evidence, "restored-second-turn.png");
    drop(app);
    assert!(
        created.cleanup(),
        "Created acceptance Session and Agent cleanup must succeed"
    );
    proxy.stop();
    assert!(!proxy.process_is_running());
    assert!(
        !proxy.diagnostics.lock().unwrap().contains(&token),
        "Console diagnostics must not disclose its private launch token"
    );
    let report = json!({"completed":true,"cleanup_confirmed":true,"runtime":"pi","model":"gpt-6-luna","worker":"linux-kvm-development",
        "inference":"live ChatGPT subscription","marker":marker,"session_id":created.session,"agent_id":created.agent,
        "workspace_file":file,"turns":turns.iter().map(|turn| json!({"id":turn["id"],"status":turn["status"]})).collect::<Vec<_>>(),
        "managed_commands":final_commands.len(),"assertions":["saved Agent created through Rust runtime/model controls","managed environment selected through Rust controls","real guest UID10001 command","workspace file listed by real API","ConsoleApp reopened with saved history","second Turn sent through Rust composer"]});
    std::fs::write(
        evidence.join("evidence.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            evidence.join("evidence.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    println!("Local Pi Rust UI evidence: {}", evidence.display());
}
