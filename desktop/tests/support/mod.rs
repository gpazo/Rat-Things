use egui::{Key, Modifiers, accesskit::Role};
use egui_kittest::{Harness, kittest::Queryable};
use rat_things_desktop::ConsoleApp;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};
pub type App = Harness<'static, ConsoleApp>;
pub struct Server {
    process: Child,
    pub url: String,
    pub diagnostics: Arc<Mutex<String>>,
}

impl Server {
    pub fn process_is_running(&mut self) -> bool {
        self.process
            .try_wait()
            .expect("read child process status")
            .is_none()
    }

    pub fn spawn(root: &Path, script: &str, environment: &[(&str, &str)]) -> Self {
        let mut process = Command::new(std::env::var_os("NODE").unwrap_or("node".into()))
            .args(["--import", "tsx", script])
            .current_dir(root)
            .env_remove("AGENT_RUNTIME_UNSIGNED")
            .env_remove("RAT_THINGS_LOCAL_OWNER")
            .envs(environment.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start local TypeScript service (run npm ci first)");
        let diagnostics = Arc::new(Mutex::new(String::new()));
        let errors = diagnostics.clone();
        let stderr = process.stderr.take().unwrap();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                errors.lock().unwrap().push_str(&format!("{line}\n"));
            }
        });
        let (tx, rx) = mpsc::channel();
        let stdout = process.stdout.take().unwrap();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line)
                    && let Some(port) = value["port"].as_u64()
                {
                    let _ = tx.send(port);
                }
            }
        });
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(port) => Self {
                process,
                url: format!("http://127.0.0.1:{port}"),
                diagnostics,
            },
            Err(error) => {
                let _ = process.kill();
                let _ = process.wait();
                panic!(
                    "{script} did not become ready: {error}\n{}",
                    diagnostics.lock().unwrap()
                );
            }
        }
    }
}

impl Server {
    pub fn stop(&mut self) {
        drop(self.process.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.process.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn tick(app: &mut App) {
    app.run_steps(3);
    thread::sleep(Duration::from_millis(25));
}

pub fn until(app: &mut App, description: &str, predicate: impl Fn(&App) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        tick(app);
        if predicate(app) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "Timed out waiting for {description}"
        );
    }
}

pub fn visible(app: &mut App, label: &str) {
    until(app, label, |app| app.query_by_label(label).is_some());
}

pub fn contains(app: &mut App, label: &str) {
    until(app, label, |app| {
        app.query_all_by_label_contains(label).next().is_some()
            || app
                .query_all_by_role(Role::TextRun)
                .filter_map(|node| node.value())
                .collect::<String>()
                .contains(label)
    });
}

pub fn click(app: &mut App, label: &str) {
    if label == "Refresh" && app.query_by_role_and_label(Role::Button, label).is_none() {
        click(app, "List options");
    }
    if matches!(
        label,
        "Delete session" | "Delete agent" | "Delete vault" | "Delete environment template"
    ) && app.query_by_role_and_label(Role::Button, label).is_none()
    {
        click(app, "Actions");
    }
    until(app, label, |app| {
        app.query_by_role_and_label(Role::Button, label).is_some()
    });
    app.get_by_role_and_label(Role::Button, label)
        .scroll_to_me();
    tick(app);
    app.get_by_role_and_label(Role::Button, label).click();
    tick(app);
}

pub fn fill(app: &mut App, label: &str, text: &str) {
    if label == "Name"
        && app.query_by_label(label).is_none()
        && app.query_by_label("Session options").is_some()
    {
        app.get_by_label("Session options").click();
        tick(app);
    }
    visible(app, label);
    app.get_by_label(label).focus();
    tick(app);
    app.key_press_modifiers(Modifiers::COMMAND, Key::A);
    app.key_press(Key::Backspace);
    tick(app);
    app.get_by_label(label).type_text(text);
    tick(app);
    assert_eq!(app.get_by_label(label).value().as_deref(), Some(text));
}

pub fn advanced_json(app: &mut App) {
    if app.query_by_label("Configuration JSON").is_none() {
        click(app, "Advanced JSON");
    }
    visible(app, "Configuration JSON");
}

pub fn editor(app: &mut App, value: Value, submit: &str) {
    advanced_json(app);
    fill(
        app,
        "Configuration JSON",
        &serde_json::to_string_pretty(&value).unwrap(),
    );
    click(app, submit);
    until(app, "editor to close after persistence", |app| {
        app.query_by_label("Configuration JSON").is_none()
    });
}
