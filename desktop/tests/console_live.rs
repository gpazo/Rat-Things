//! Explicit opt-in native UI probe against the deployed AWS API and real model.
//! Never runs during ordinary cargo test or npm run check.
mod support;

use egui::Vec2;
use egui_kittest::Harness;
use rat_things_desktop::ConsoleApp;
use reqwest::blocking::Client;
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

struct SessionCleanup {
    client: Client,
    base: String,
    token: String,
    id: Option<String>,
    marker: String,
    cleaned: bool,
}

impl SessionCleanup {
    fn get(&self, suffix: &str) -> Value {
        self.client
            .get(format!("{}/api/v1/agents/sessions{suffix}", self.base))
            .bearer_auth(&self.token)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    }

    fn delete(&mut self) {
        if let Some(id) = self.id.as_ref() {
            self.client
                .delete(format!("{}/api/v1/agents/sessions/{id}", self.base))
                .bearer_auth(&self.token)
                .header("x-rat-console-request", "1")
                .send()
                .expect("delete live probe Session")
                .error_for_status()
                .expect("live probe Session cleanup succeeds");
            self.id = None;
            self.cleaned = true;
        }
    }
}

impl Drop for SessionCleanup {
    fn drop(&mut self) {
        if self.cleaned {
            return;
        }
        // Recover the ID if the UI assertion failed just after the API committed creation.
        if self.id.is_none() {
            self.id = self
                .client
                .get(format!("{}/api/v1/agents/sessions?limit=100", self.base))
                .bearer_auth(&self.token)
                .send()
                .ok()
                .and_then(|response| response.error_for_status().ok())
                .and_then(|response| response.json::<Value>().ok())
                .and_then(|value| {
                    value["data"]
                        .as_array()?
                        .iter()
                        .find(|row| row["metadata"]["name"] == self.marker)?["id"]
                        .as_str()
                        .map(str::to_owned)
                });
        }
        if let Some(id) = self.id.as_ref()
            && let Err(error) = self
                .client
                .delete(format!("{}/api/v1/agents/sessions/{id}", self.base))
                .bearer_auth(&self.token)
                .header("x-rat-console-request", "1")
                .send()
                .and_then(|response| response.error_for_status())
        {
            eprintln!("Failed to clean live probe Session {id}: {error}");
        }
    }
}

fn wait_for_turns(app: &mut App, session: &SessionCleanup, count: usize, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    let id = session.id.as_ref().unwrap();
    loop {
        tick(app);
        let turns = session.get(&format!("/{id}/turns"));
        let turns = turns["data"].as_array().unwrap();
        assert!(
            !turns
                .iter()
                .any(|turn| turn["status"] == "failed" || turn["status"] == "cancelled"),
            "live probe failed or cancelled: {turns:?}"
        );
        if turns
            .iter()
            .filter(|turn| turn["status"] == "completed")
            .count()
            >= count
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "live probe timed out waiting for {count} completed Turns"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
#[ignore = "Requires AWS_E2E_CONSOLE=true, AWS_E2E_REAL_CODEX=true and the deployed AWS harness; invokes a real model"]
fn saves_and_restores_two_real_turns() {
    assert_eq!(
        required("AWS_E2E_CONSOLE"),
        "true",
        "explicit AWS console opt-in required"
    );
    assert_eq!(
        required("AWS_E2E_REAL_CODEX"),
        "true",
        "explicit real-model opt-in required"
    );
    let api = required("RAT_THINGS_AGENTS_API_URL");
    required("AWS_REGION");
    let model = required("AWS_E2E_CODEX_MODEL_ID");
    let timeout = Duration::from_millis(
        std::env::var("AWS_E2E_TIMEOUT_MS")
            .unwrap_or("420000".into())
            .parse()
            .unwrap(),
    );
    let root = std::env::var_os("RAT_THINGS_TEST_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_owned()
        });
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    // Server::spawn removes unsigned/local-owner settings before adding these values.
    // The production proxy signs the real API requests; the Rust UI receives only its nonce.
    let mut proxy = Server::spawn(
        &root,
        "scripts/console-server.ts",
        &[
            ("AGENTS_API_BASE_URL", &api),
            ("RAT_THINGS_CONSOLE_TOKEN", &token),
            ("RAT_THINGS_CONSOLE_PORT", "0"),
            ("RAT_THINGS_CONSOLE_LAUNCHER", "1"),
        ],
    );
    assert!(proxy.process_is_running());
    let make_app = || {
        Harness::builder()
            .with_size(Vec2::new(1280.0, 850.0))
            .build_eframe(|_| ConsoleApp::new(proxy.url.clone(), token.clone()).unwrap())
    };
    let marker = format!("native-console-{}", uuid::Uuid::new_v4());
    let mut session = SessionCleanup {
        client: Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap(),
        base: proxy.url.clone(),
        token: token.clone(),
        id: None,
        marker: marker.clone(),
        cleaned: false,
    };
    let mut app = make_app();
    click(&mut app, "New session");
    editor(
        &mut app,
        json!({"agent":{"model":model,"tools":[]},"environment":{"type":"none"},
        "input":format!("Reply with exactly {marker}"),"metadata":{"name":marker}}),
        "Create",
    );
    let resources = session.get("?limit=100");
    let resource = resources["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["metadata"]["name"] == marker)
        .expect("created Session must be visible in the real API");
    session.id = Some(resource["id"].as_str().unwrap().to_owned());
    wait_for_turns(&mut app, &session, 1, timeout);
    contains(&mut app, "Turn completed");
    contains(&mut app, &marker);
    fill(
        &mut app,
        "Message",
        &format!("Reply with exactly {marker}-CONTINUED"),
    );
    click(&mut app, "Send");
    wait_for_turns(&mut app, &session, 2, timeout);
    contains(&mut app, "Turn completed");
    drop(app);
    let mut app = make_app();
    click(&mut app, &marker);
    contains(&mut app, &format!("{marker}-CONTINUED"));
    let items = session.get(&format!("/{}/items", session.id.as_ref().unwrap()));
    for expected in [&marker, &format!("{marker}-CONTINUED")] {
        assert!(
            items["data"].as_array().unwrap().iter().any(|item| {
                item["role"] == "assistant"
                    && item["content"].as_array().is_some_and(|content| {
                        content.iter().any(|part| {
                            part["text"]
                                .as_str()
                                .is_some_and(|text| text.contains(expected))
                        })
                    })
            }),
            "saved assistant output must include {expected}"
        );
    }
    let output = root.join("test-results/native-console");
    std::fs::create_dir_all(&output).unwrap();
    app.remove_cursor();
    app.run_steps(3);
    app.render()
        .unwrap()
        .save(output.join("live-session-restored.png"))
        .unwrap();
    session.delete();
    assert!(
        !proxy
            .diagnostics
            .lock()
            .unwrap()
            .contains("ERR_HTTP_HEADERS_SENT"),
        "live proxy reported an unexpected error"
    );
}
