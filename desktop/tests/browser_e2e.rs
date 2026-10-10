//! Real Playwright MCP + Chromium through the native console, with deterministic decisions.
mod support;
use egui::Vec2;
use egui_kittest::{Harness, kittest::Queryable};
use rat_things_desktop::ConsoleApp;
use reqwest::blocking::Client;
use serde_json::Value;
use std::{
    path::Path,
    time::{Duration, Instant},
};
use support::*;

#[test]
#[ignore = "Requires installed Chromium; run npm run test:e2e:browser"]
fn real_browser_output_reaches_native_files() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut upstream = Server::spawn(
        root,
        "testing/native-console/server.ts",
        &[("RAT_THINGS_BROWSER_FIXTURE", "1")],
    );
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut proxy = Server::spawn(
        root,
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
    let evidence = || -> Value {
        client
            .get(format!("{}/__test/browser", upstream.url))
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    };
    let get = |path: &str| -> Value {
        client
            .get(format!("{}/api{path}", proxy.url))
            .bearer_auth(&token)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    };
    let mut app = Harness::builder()
        .with_size(Vec2::new(1280.0, 850.0))
        .build_eframe(|_| ConsoleApp::new(proxy.url.clone(), token.clone()).unwrap());
    click(&mut app, "New session");
    editor(&mut app, evidence()["request"].clone(), "Create");
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        tick(&mut app);
        let state = evidence();
        assert_eq!(
            state["evidence"]["error"],
            "",
            "{}",
            upstream.diagnostics.lock().unwrap()
        );
        if state["evidence"]["closed"] == true {
            break;
        }
        assert!(Instant::now() < deadline, "Real browser timed out: {state}");
    }
    contains(&mut app, "Browser validation passed.");
    contains(&mut app, "Turn completed");
    let state = evidence()["evidence"].clone();
    assert_eq!(state["denied"], true);
    assert_eq!(state["forbiddenRequests"], 0);
    assert_eq!(state["submitted"][0], state["marker"]);
    assert_eq!(
        state["calls"],
        serde_json::json!([
            "browser_navigate",
            "browser_type",
            "browser_click",
            "browser_snapshot",
            "browser_take_screenshot",
            "browser_close"
        ])
    );
    let session = get("/v1/agents/sessions")["data"][0].clone();
    let id = session["id"].as_str().unwrap();
    let saved = get(&format!("/v1/agents/sessions/{id}/artifacts"))["data"][0].clone();
    assert_eq!(saved["path"], "/workspace/outputs/browser.png");
    let transcript = get(&format!("/v1/agents/sessions/{id}/items"));
    assert!(
        transcript["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["type"] == "mcp_call"
                && item["name"] == "browser_click"
                && item["status"] == "completed")
    );
    assert!(app.query_by_label("Save browser.png").is_none());
    click(&mut app, "Files (1)");
    visible(&mut app, "Save browser.png");
    let directory = root.join("test-results/native-console");
    std::fs::create_dir_all(&directory).unwrap();
    app.render()
        .unwrap()
        .save(directory.join("browser-files-1280x850.png"))
        .unwrap();
    let destination = directory.join("browser-output.png");
    let _ = std::fs::remove_file(&destination);
    let ctx = app.ctx.clone();
    app.state_mut()
        .save_artifact_to(&ctx, id, saved["id"].as_str().unwrap(), destination.clone())
        .unwrap();
    until(&mut app, "saved browser screenshot", |_| {
        destination.exists()
    });
    let downloaded = std::fs::read(&destination).unwrap();
    assert_eq!(&downloaded[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(
        downloaded.len() as u64,
        saved["size_bytes"].as_u64().unwrap()
    );
    let digest = std::process::Command::new(std::env::var_os("NODE").unwrap_or("node".into()))
        .args(["--input-type=module", "-e", "import{readFileSync}from'node:fs';import{createHash}from'node:crypto';process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))"])
        .arg(&destination).output().unwrap();
    assert!(digest.status.success());
    assert_eq!(
        String::from_utf8(digest.stdout).unwrap(),
        state["screenshotSha256"].as_str().unwrap()
    );
    // Also check a fresh authorized content request after the live file was removed.
    let original = client
        .get(format!(
            "{}/api/v1/agents/sessions/{id}/artifacts/{}/content",
            proxy.url,
            saved["id"].as_str().unwrap()
        ))
        .bearer_auth(&token)
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .unwrap();
    assert_eq!(downloaded, original);
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
    drop(app);
    let mut reopened = Harness::builder()
        .with_size(Vec2::new(900.0, 650.0))
        .build_eframe(|_| ConsoleApp::new(proxy.url.clone(), token.clone()).unwrap());
    click(&mut reopened, "Browser validation");
    contains(&mut reopened, "Browser validation passed.");
    visible(&mut reopened, "Files (1)");
    reopened
        .render()
        .unwrap()
        .save(directory.join("browser-restored-900x650.png"))
        .unwrap();
    std::fs::write(
        directory.join("browser-evidence.json"),
        serde_json::to_vec_pretty(&state).unwrap(),
    )
    .unwrap();
    drop(reopened);
    proxy.stop();
    upstream.stop();
    assert!(!proxy.process_is_running());
    assert!(!upstream.process_is_running());
}
