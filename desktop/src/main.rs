use std::io::{BufRead, BufReader, Read};
#[cfg(not(feature = "installed-runtime"))]
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rat_things_desktop::ConsoleApp;
use serde::Deserialize;

struct Signer {
    child: Child,
    ready: bool,
}
impl Drop for Signer {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if !self.ready {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(not(feature = "installed-runtime"))]
fn signer_command() -> Result<Command, String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let executable_dir = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or("Native executable has no directory")?
        .to_path_buf();
    let bundled_server = executable_dir.join("../Resources/console-server.mjs");
    let adjacent_server = executable_dir.join("console-server.mjs");
    let default_server = if bundled_server.is_file() {
        bundled_server
    } else if adjacent_server.is_file() {
        adjacent_server
    } else {
        root.join("scripts/console-server.ts")
    };
    let server = std::env::var_os("RAT_THINGS_CONSOLE_SERVER")
        .map(PathBuf::from)
        .unwrap_or(default_server);
    if !server.is_file() {
        return Err(
            "Console signer is missing. Run npm run build from a Rat Things checkout.".into(),
        );
    }
    let bundled_node = executable_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let node = std::env::var_os("RAT_THINGS_CONSOLE_NODE").unwrap_or_else(|| {
        if bundled_node.is_file() {
            bundled_node.into_os_string()
        } else {
            "node".into()
        }
    });
    let mut command = Command::new(node);
    let bundled_codex = executable_dir.join("../Resources/codex-runtime/bin/codex");
    if std::env::var_os("CODEX_BINARY").is_none() && bundled_codex.is_file() {
        command.env("CODEX_BINARY", bundled_codex);
        let mut paths = vec![executable_dir.join("../Resources/codex-runtime/codex-path")];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        command.env(
            "PATH",
            std::env::join_paths(paths).map_err(|error| error.to_string())?,
        );
    }
    if server
        .extension()
        .is_some_and(|extension| extension == "ts")
    {
        command.args(["--import", "tsx"]).current_dir(&root);
    }
    command.arg(server);
    Ok(command)
}

#[cfg(feature = "installed-runtime")]
fn signer_command() -> Result<Command, String> {
    use rat_things_desktop::installed_launch::{Script, plan, verify_bundle};
    let launch = plan(
        &std::env::current_exe().map_err(|error| error.to_string())?,
        Script::Console,
        std::env::vars_os(),
    )?;
    verify_bundle(&launch.bundle)?;
    let mut command = Command::new(launch.node);
    command
        .arg(launch.script)
        .env_clear()
        .envs(launch.environment);
    Ok(command)
}

fn start_signer() -> Result<(Signer, String, String), String> {
    let mut command = signer_command()?;
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| "Could not generate a private console token")?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    command
        .env("RAT_THINGS_CONSOLE_TOKEN", &token)
        .env("RAT_THINGS_CONSOLE_LAUNCHER", "1")
        .env(
            "RAT_THINGS_CONSOLE_PORT",
            std::env::var("RAT_THINGS_CONSOLE_PORT").unwrap_or_else(|_| "0".into()),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut signer = Signer {
        child: command
            .spawn()
            .map_err(|error| format!("Could not start console signer: {error}"))?,
        ready: false,
    };
    let stdout = signer
        .child
        .stdout
        .take()
        .ok_or("Console signer stdout is missing")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout.take(1025))
            .read_line(&mut line)
            .map_err(|_| "Could not read console signer readiness".to_string())
            .and_then(|_| {
                #[derive(Deserialize)]
                struct Ready {
                    port: u16,
                }
                if line.len() > 1024 || !line.ends_with('\n') {
                    return Err("Invalid console signer readiness".into());
                }
                let ready: Ready = serde_json::from_str(&line)
                    .map_err(|_| "Invalid console signer readiness".to_string())?;
                if ready.port == 0 {
                    return Err("Invalid console signer port".into());
                }
                Ok(ready.port)
            });
        let _ = sender.send(result);
    });
    let port = receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Console signer did not start within 10 seconds".to_string())??;
    signer.ready = true;
    Ok((signer, format!("http://127.0.0.1:{port}"), token))
}

struct Desktop {
    app: ConsoleApp,
    signer: Signer,
    ready: bool,
    check_at: Instant,
    error: Option<String>,
}
impl eframe::App for Desktop {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        ui.ctx().request_repaint_after(Duration::from_secs(1));
        if self.check_at.elapsed() > Duration::from_secs(1) {
            self.check_at = Instant::now();
            if let Ok(Some(_)) = self.signer.child.try_wait() {
                self.error = Some(
                    "The authentication helper stopped. Close and reopen the console to reconnect."
                        .into(),
                );
            }
        }
        self.app.show(ui);
        if let Some(error) = &self.error {
            egui::Modal::new(egui::Id::new("signer_failed")).show(ui.ctx(), |ui| {
                ui.heading("Connection stopped");
                ui.label(error);
                if ui.button("Close console").clicked() {
                    ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
                }
            });
        }
        if !self.ready {
            self.ready = true;
            if std::env::var("RAT_THINGS_CONSOLE_LAUNCHER").as_deref() == Ok("1") {
                println!("{{\"ready\":true}}");
            }
        }
    }
}

fn run() -> Result<(), String> {
    let (signer, endpoint, token) = start_signer()?;
    let app = ConsoleApp::new(endpoint, token)?;
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 850.0])
            .with_min_inner_size([760.0, 560.0])
            .with_icon(rat_things_desktop::brand::app_icon()),
        renderer: eframe::Renderer::Glow,
        ..Default::default()
    };
    let title = if std::env::var("RAT_THINGS_CONSOLE_DEMO").as_deref() == Ok("1") {
        "Rat Things — Demo (simulated)"
    } else {
        "Rat Things"
    };
    eframe::run_native(
        title,
        options,
        Box::new(move |_cc| {
            Ok(Box::new(Desktop {
                app,
                signer,
                ready: false,
                check_at: Instant::now(),
                error: None,
            }))
        }),
    )
    .map_err(|error| error.to_string())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Rat Things: {error}");
        std::process::exit(1);
    }
}
