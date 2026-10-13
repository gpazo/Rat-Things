//! Records a product walkthrough of the native console as numbered PNG frames.
//! Run: cargo test --test walkthrough_capture -- --ignored --nocapture
//! Frames stream into ffmpeg as raw RGBA; the video and chapter markers land in
//! test-results/walkthrough/.
mod support;
use egui::{Vec2, accesskit::Role};
use egui_kittest::{Harness, kittest::{NodeT, Queryable}};
use rat_things_desktop::ConsoleApp;
use reqwest::blocking::Client;
use serde_json::json;
use std::{
    io::Write as _,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
use support::*;

const FPS: f64 = 30.0;
const PPP: f32 = 1.2;
const SIZE: Vec2 = Vec2::new(1280.0, 768.0);

struct Frame {
    rgba: Vec<u8>,
    w: usize,
    h: usize,
}

struct Rec {
    dir: PathBuf,
    encoder: Option<Child>,
    frame: usize,
    t: f64,
    markers: Vec<(String, f64)>,
    clicks: Vec<f64>,
    cursor: (f32, f32),
    ripple: Option<(f32, f32, usize)>,
}

impl Rec {
    fn new(dir: PathBuf) -> Self {
        std::fs::create_dir_all(&dir).unwrap();
        Self {
            dir,
            encoder: None,
            frame: 0,
            t: 0.0,
            markers: Vec::new(),
            clicks: Vec::new(),
            cursor: (640.0, 420.0),
            ripple: None,
        }
    }

    fn mark(&mut self, name: &str) {
        self.markers.push((name.into(), self.t));
    }

    fn base(&self, app: &mut App) -> Frame {
        app.remove_cursor();
        app.run_steps(2);
        let image = app.render().expect("render frame");
        let (w, h) = (image.width() as usize, image.height() as usize);
        Frame { rgba: image.into_raw(), w, h }
    }

    fn emit(&mut self, mut image: Frame, frames: usize) {
        let (w, h) = (image.w, image.h);
        if let Some((x, y, age)) = self.ripple {
            draw_ripple(&mut image.rgba, w, h, x * PPP, y * PPP, age);
        }
        draw_cursor(&mut image.rgba, w, h, self.cursor.0 * PPP, self.cursor.1 * PPP);
        let encoder = self.encoder.get_or_insert_with(|| {
            Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s"])
                .arg(format!("{w}x{h}"))
                .args(["-r", "30", "-i", "-", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-crf", "12", "-preset", "fast", "-pix_fmt", "yuv420p"])
                .arg(self.dir.join("console.mp4"))
                .stdin(Stdio::piped())
                .spawn()
                .expect("start ffmpeg")
        });
        let stdin = encoder.stdin.as_mut().unwrap();
        for _ in 0..frames {
            stdin.write_all(&image.rgba).unwrap();
        }
        self.frame += frames;
        let seconds = frames as f64 / FPS;
        self.t += seconds;
        if let Some((x, y, age)) = self.ripple {
            self.ripple = (age + frames < 14).then_some((x, y, age + frames));
        }
    }

    /// Show the current UI for `seconds`, animating any click ripple.
    fn hold(&mut self, app: &mut App, seconds: f64) {
        let mut frames = (seconds * FPS).round() as usize;
        while frames > 0 {
            let step = if self.ripple.is_some() { 1 } else { frames };
            let image = self.base(app);
            self.emit(image, step);
            frames -= step;
        }
    }

    fn move_to(&mut self, app: &mut App, x: f32, y: f32, seconds: f64) {
        let image = self.base(app);
        let (x0, y0) = self.cursor;
        let n = ((seconds * FPS).round() as usize).max(1);
        for i in 1..=n {
            let p = i as f32 / n as f32;
            let e = if p < 0.5 { 4.0 * p * p * p } else { 1.0 - (-2.0 * p + 2.0).powi(3) / 2.0 };
            self.cursor = (x0 + (x - x0) * e, y0 + (y - y0) * e);
            self.emit(Frame { rgba: image.rgba.clone(), ..image }, 1);
        }
    }

    fn point_at(&mut self, app: &mut App, role: Option<Role>, label: &str) {
        let wait = format!("{label} to appear");
        until(app, &wait, |app| find(app, role, label).is_some());
        find(app, role, label).unwrap().scroll_to_me();
        tick(app);
        let rect = find(app, role, label).unwrap().rect();
        let distance = ((rect.center().x - self.cursor.0).powi(2) + (rect.center().y - self.cursor.1).powi(2)).sqrt();
        let seconds = (0.35 + distance as f64 / 1800.0).min(0.9);
        let x = rect.left() + (rect.width() * 0.5).min(60.0);
        self.move_to(app, x, rect.center().y + 2.0, seconds);
    }

    fn click(&mut self, app: &mut App, role: Option<Role>, label: &str) {
        self.point_at(app, role, label);
        self.hold(app, 0.12);
        find(app, role, label).unwrap().click();
        self.clicks.push(self.t);
        tick(app);
        self.ripple = Some((self.cursor.0, self.cursor.1, 0));
        self.hold(app, 0.4);
    }

    fn button(&mut self, app: &mut App, label: &str) {
        self.click(app, Some(Role::Button), label);
    }

    fn type_into(&mut self, app: &mut App, label: &str, text: &str, chars_per_frame: usize) {
        self.click(app, None, label);
        app.get_by_label(label).focus();
        tick(app);
        app.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::A);
        app.key_press(egui::Key::Backspace);
        tick(app);
        let chars: Vec<char> = text.chars().collect();
        for chunk in chars.chunks(chars_per_frame) {
            app.get_by_label(label).type_text(&chunk.iter().collect::<String>());
            app.run_steps(1);
            let image = self.base(app);
            self.emit(image, 1);
        }
        self.hold(app, 0.3);
    }

    fn choose(&mut self, app: &mut App, combo: &str, option: &str) {
        until(app, combo, |app| {
            app.query_by_role_and_label(Role::ComboBox, combo)
                .is_some_and(|node| !node.accesskit_node().is_disabled())
        });
        self.click(app, Some(Role::ComboBox), combo);
        self.hold(app, 0.35);
        self.button(app, option);
    }

    fn finish(&mut self) {
        let mut encoder = self.encoder.take().unwrap();
        drop(encoder.stdin.take());
        assert!(encoder.wait().unwrap().success(), "ffmpeg failed");
        let markers: Vec<_> = self.markers.iter().map(|(n, t)| json!({"name": n, "t": t})).collect();
        std::fs::write(
            self.dir.join("markers.json"),
            serde_json::to_string_pretty(&json!({"duration": self.t, "markers": markers, "clicks": self.clicks})).unwrap(),
        )
        .unwrap();
    }
}

fn find<'a>(app: &'a App, role: Option<Role>, label: &'a str) -> Option<egui_kittest::Node<'a>> {
    match role {
        Some(role) => app.query_by_role_and_label(role, label),
        None => app.query_by_label(label),
    }
}

fn blend(px: &mut [u8], rgb: [u8; 3], a: f32) {
    for c in 0..3 {
        px[c] = (px[c] as f32 * (1.0 - a) + rgb[c] as f32 * a).round() as u8;
    }
}

fn draw_cursor(buf: &mut [u8], w: usize, h: usize, x: f32, y: f32) {
    // Classic arrow, in logical points, tip at the origin.
    const ARROW: [(f32, f32); 7] = [(0.0, 0.0), (0.0, 17.0), (4.2, 13.2), (7.2, 19.8), (10.0, 18.6), (7.1, 12.2), (12.4, 12.2)];
    let s = PPP * 1.15;
    let pts: Vec<(f32, f32)> = ARROW.iter().map(|(px, py)| (x + px * s, y + py * s)).collect();
    let inside = |qx: f32, qy: f32| {
        let mut c = false;
        let mut j = pts.len() - 1;
        for i in 0..pts.len() {
            let (xi, yi) = pts[i];
            let (xj, yj) = pts[j];
            if (yi > qy) != (yj > qy) && qx < (xj - xi) * (qy - yi) / (yj - yi) + xi {
                c = !c;
            }
            j = i;
        }
        c
    };
    let edge = |qx: f32, qy: f32| {
        let mut best = f32::MAX;
        for i in 0..pts.len() {
            let (ax, ay) = pts[i];
            let (bx, by) = pts[(i + 1) % pts.len()];
            let (dx, dy) = (bx - ax, by - ay);
            let t = (((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
            best = best.min(((qx - ax - t * dx).powi(2) + (qy - ay - t * dy).powi(2)).sqrt());
        }
        best
    };
    let (x0, y0) = ((x - 4.0) as i32, (y - 4.0) as i32);
    let (x1, y1) = ((x + 16.0 * s) as i32, (y + 24.0 * s) as i32);
    for py in y0.max(0)..y1.min(h as i32) {
        for px in x0.max(0)..x1.min(w as i32) {
            let (mut black, mut white, mut shadow) = (0.0, 0.0, 0.0);
            for sy in 0..3 {
                for sx in 0..3 {
                    let qx = px as f32 + (sx as f32 + 0.5) / 3.0;
                    let qy = py as f32 + (sy as f32 + 0.5) / 3.0;
                    if inside(qx, qy) {
                        if edge(qx, qy) < 1.4 * PPP { black += 1.0 / 9.0 } else { white += 1.0 / 9.0 }
                    } else if inside(qx - 1.5, qy - 2.5) {
                        shadow += 1.0 / 9.0;
                    }
                }
            }
            let i = (py as usize * w + px as usize) * 4;
            let px = &mut buf[i..i + 4];
            if shadow > 0.0 { blend(px, [0, 0, 0], shadow * 0.35) }
            if black > 0.0 { blend(px, [12, 12, 14], black) }
            if white > 0.0 { blend(px, [255, 255, 255], white) }
        }
    }
}

fn draw_ripple(buf: &mut [u8], w: usize, h: usize, x: f32, y: f32, age: usize) {
    let p = age as f32 / 14.0;
    let radius = (8.0 + 26.0 * p) * PPP;
    let alpha = 0.85 * (1.0 - p);
    let width = 3.0 * PPP;
    let r = (radius + width + 2.0) as i32;
    for py in (y as i32 - r).max(0)..(y as i32 + r).min(h as i32) {
        for px in (x as i32 - r).max(0)..(x as i32 + r).min(w as i32) {
            let d = ((px as f32 + 0.5 - x).powi(2) + (py as f32 + 0.5 - y).powi(2)).sqrt();
            let ring = (1.0 - ((d - radius).abs() - width / 2.0).max(0.0)).clamp(0.0, 1.0);
            let fill = if d < radius { 0.18 } else { 0.0 };
            let a = (ring + fill).min(1.0) * alpha;
            if a > 0.0 {
                let i = (py as usize * w + px as usize) * 4;
                blend(&mut buf[i..i + 4], [53, 198, 244], a);
            }
        }
    }
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned()
}

fn dump(app: &App) {
    eprintln!("{:#?}", app.root());
}

#[test]
#[ignore = "records walkthrough frames"]
fn record_walkthrough() {
    let root = root();
    let upstream = Server::spawn(&root, "test-results/walkthrough/server.ts", &[]);
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
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
    let client = Client::builder().timeout(Duration::from_secs(10)).build().unwrap();
    let advance = |mode: &str| {
        client
            .post(format!("{}/__test/advance", upstream.url))
            .json(&json!({ "mode": mode }))
            .send()
            .unwrap()
            .error_for_status()
            .unwrap();
    };
    let app_for = || -> App {
        Harness::builder()
            .with_size(SIZE)
            .with_pixels_per_point(PPP)
            .build_eframe(|_| ConsoleApp::new(proxy.url.clone(), token.clone()).unwrap())
    };

    // Earlier work, so the workspace looks lived in. Not recorded.
    {
        let mut app = app_for();
        for (name, task) in [
            ("Audit IAM policies for least privilege", "Audit the worker IAM policies."),
            ("Weekly dependency upgrades", "Upgrade dependencies and run the checks."),
            ("Triage checkout error spike", "Investigate the checkout 500s."),
            ("Draft Q4 launch notes", "Draft the Q4 launch notes."),
        ] {
            click(&mut app, "New session");
            visible(&mut app, "Task");
            fill(&mut app, "Name", name);
            fill(&mut app, "Task", task);
            click(&mut app, "Create");
            until(&mut app, "session created", |app| app.query_by_label("Cancel").is_none());
        }
        advance("complete");
        tick(&mut app);
    }

    let mut app = app_for();
    let mut r = Rec::new(root.join("test-results/walkthrough"));
    visible(&mut app, "Weekly dependency upgrades");
    if std::env::var("WALKTHROUGH_DUMP").is_ok() {
        dump(&app);
    }

    r.mark("workspace");
    r.hold(&mut app, 1.2);
    r.point_at(&mut app, None, "Triage checkout error spike");
    r.hold(&mut app, 0.6);
    r.type_into(&mut app, "Search sessions", "IAM", 1);
    r.hold(&mut app, 1.0);
    app.get_by_label("Search sessions").focus();
    app.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::A);
    app.key_press(egui::Key::Backspace);
    tick(&mut app);
    r.hold(&mut app, 0.5);

    r.mark("agents");
    r.button(&mut app, "Agents");
    r.hold(&mut app, 0.6);
    r.button(&mut app, "New agent");
    r.hold(&mut app, 0.5);
    r.type_into(&mut app, "Name", "Release reviewer", 2);
    r.type_into(
        &mut app,
        "Instructions",
        "Review each release candidate. Check the diff, CI and deployment config, then write a ship / no-ship verdict with risks and next steps.",
        5,
    );
    r.choose(&mut app, "Model", "gpt-6-astra");
    r.hold(&mut app, 0.6);
    r.button(&mut app, "Create");
    until(&mut app, "agent saved", |app| app.query_by_label("Cancel").is_none());
    r.hold(&mut app, 1.4);

    r.mark("templates");
    r.button(&mut app, "Templates");
    r.hold(&mut app, 0.5);
    r.button(&mut app, "New environment template");
    r.hold(&mut app, 0.5);
    r.type_into(&mut app, "Name", "Node 22 release checks", 2);
    r.type_into(&mut app, "npm packages", "typescript, vitest, @playwright/test", 3);
    r.hold(&mut app, 0.6);
    r.button(&mut app, "Create");
    until(&mut app, "template saved", |app| app.query_by_label("Cancel").is_none());
    r.hold(&mut app, 1.4);

    r.mark("vaults");
    r.button(&mut app, "Vaults");
    r.hold(&mut app, 0.5);
    r.button(&mut app, "New vault");
    r.type_into(&mut app, "Name", "Release tooling", 2);
    r.button(&mut app, "Create");
    until(&mut app, "vault saved", |app| app.query_by_label("Cancel").is_none());
    r.hold(&mut app, 0.6);
    r.button(&mut app, "Add credential");
    r.type_into(&mut app, "Name", "GitHub MCP", 2);
    r.type_into(&mut app, "Server URL", "https://api.githubcopilot.com/mcp/", 3);
    r.type_into(&mut app, "Secret value", "ghp_walkthroughDemoTokenNotReal0000", 3);
    r.hold(&mut app, 0.6);
    r.button(&mut app, "Create");
    until(&mut app, "credential saved", |app| app.query_by_label("Cancel").is_none());
    r.hold(&mut app, 1.4);

    r.mark("session");
    r.button(&mut app, "Agents");
    r.hold(&mut app, 0.4);
    r.button(&mut app, "Release reviewer");
    r.hold(&mut app, 0.8);
    r.button(&mut app, "Start session");
    r.hold(&mut app, 0.5);
    r.type_into(
        &mut app,
        "Task",
        "Review the v2.4 release candidate and tell me if it's ready to ship.",
        3,
    );
    r.choose(&mut app, "Environment", "Node 22 release checks");
    r.hold(&mut app, 0.5);
    r.click(&mut app, None, "Session options");
    r.type_into(&mut app, "Name", "v2.4 release review", 2);
    r.button(&mut app, "Create");
    until(&mut app, "session started", |app| app.query_by_label("Cancel").is_none());
    contains(&mut app, "Turn in progress");
    r.hold(&mut app, 1.5);

    r.mark("steer");
    r.type_into(&mut app, "Message", "Also double-check the us-west-2 worker permissions.", 3);
    r.button(&mut app, "Steer");
    r.hold(&mut app, 1.6);

    r.mark("result");
    advance("complete");
    contains(&mut app, "Verdict");
    r.move_to(&mut app, 900.0, 600.0, 0.6);
    r.hold(&mut app, 4.0);

    r.mark("files");
    r.button(&mut app, "Files (1)");
    r.hold(&mut app, 3.0);
    r.mark("end");
    r.finish();
    eprintln!("Recorded {} frames, {:.1}s", r.frame, r.t);
}
